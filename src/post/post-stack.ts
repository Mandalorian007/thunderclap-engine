import type { FullscreenPass } from '../render/fullscreen';
import type { PostInputs, PostProcessor, Renderer } from '../render/renderer';
import { type Ease, easeInOut, PostBlender } from './blend';
import {
  applyPostPatch,
  defaultPostQuality,
  defaultPostSettings,
  POST_UNIFORM_FLOATS,
  type PostQuality,
  type PostSettings,
  type PostSettingsPatch,
  packPostUniforms,
} from './settings';
import { COMPOSITE_WGSL, DOWN_WGSL, PREFILTER_WGSL, RAYS_WGSL, UP_WGSL } from './shaders';

const HDR: GPUTextureFormat = 'rgba16float';
const COMPOSITE_CLEAR: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };

/**
 * The painterly post stack: bloom (mip chain), floor mist, god rays, ACES tonemap, colour
 * grade, vignette, dither. Plug it into a renderer with `renderer.post = new PostStack(r)`.
 *
 * Settings are plain objects you can mutate at runtime (`post.settings.bloom.intensity = 2`)
 * or patch with `post.set({ fog: { density: 0.4 } })`. Disabled passes are skipped entirely.
 * `post.blendTo(patch, seconds, ease?)` eases numeric settings over time instead.
 */
export class PostStack implements PostProcessor {
  readonly settings: PostSettings;
  /**
   * Cost caps (bloom levels, ray samples, fog octaves). Independent of `settings`, so scene
   * presets and blends keep working under a lower quality tier. Change with `setQuality`.
   */
  readonly quality: PostQuality = defaultPostQuality();

  private readonly renderer: Renderer;
  private readonly uniforms = new Float32Array(POST_UNIFORM_FLOATS);
  private readonly prefilter: FullscreenPass;
  private readonly down: FullscreenPass;
  private readonly up: FullscreenPass;
  private readonly rays: FullscreenPass;
  private readonly composite: FullscreenPass;
  /** Bilinear upscale of the scene-resolution composite (`quality.compositeAtScene`). */
  private readonly upscale: FullscreenPass;

  private bloomTex: GPUTexture | null = null;
  private mipViews: GPUTextureView[] = [];
  private raysTex: GPUTexture | null = null;
  private raysView: GPUTextureView | null = null;
  private levels = 0;
  /** Levels asked for at the last resize (before the size clamp), to detect real changes. */
  private requestedLevels = 0;
  private width = 0;
  private height = 0;
  private boundColor: GPUTextureView | null = null;
  private boundEmissive: GPUTextureView | null = null;

  private prefilterGroup: GPUBindGroup | null = null;
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  private raysGroup: GPUBindGroup | null = null;
  private compositeGroup: GPUBindGroup | null = null;
  /** Scene-size composite target (display-encoded, swapchain format) and its upscale group. */
  private ldrTex: GPUTexture | null = null;
  private ldrView: GPUTextureView | null = null;
  private upscaleGroup: GPUBindGroup | null = null;
  private readonly blendConstant: GPUColorDict = { r: 1, g: 1, b: 1, a: 1 };
  private readonly noClear = null;
  private readonly blender = new PostBlender();
  private lastTime: number | null = null;

  constructor(renderer: Renderer, patch: PostSettingsPatch = {}) {
    this.renderer = renderer;
    this.settings = applyPostPatch(defaultPostSettings(), patch);
    const bytes = POST_UNIFORM_FLOATS * 4;
    this.prefilter = renderer.createFullscreenPass({
      label: 'post-bloom-prefilter',
      wgsl: PREFILTER_WGSL,
      targets: [HDR],
      uniformBytes: bytes,
      textures: 2,
    });
    this.down = renderer.createFullscreenPass({
      label: 'post-bloom-down',
      wgsl: DOWN_WGSL,
      targets: [HDR],
      textures: 1,
    });
    this.up = renderer.createFullscreenPass({
      label: 'post-bloom-up',
      wgsl: UP_WGSL,
      targets: [HDR],
      textures: 1,
      blend: {
        color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      },
    });
    this.rays = renderer.createFullscreenPass({
      label: 'post-godrays',
      wgsl: RAYS_WGSL,
      targets: [HDR],
      uniformBytes: bytes,
      textures: 1,
    });
    this.composite = renderer.createFullscreenPass({
      label: 'post-composite',
      wgsl: COMPOSITE_WGSL,
      targets: [renderer.format],
      uniformBytes: bytes,
      textures: 4,
    });
    this.upscale = renderer.createFullscreenPass({
      label: 'post-upscale',
      targets: [renderer.format],
      textures: 1,
      wgsl: /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, in.uv, 0.0).rgb, 1.0);
}`,
    });
    this.resize(renderer.width, renderer.height);
  }

  /** Change the cost caps. Bloom level changes reallocate the mip chain on the next frame. */
  setQuality(patch: Partial<PostQuality>): this {
    Object.assign(this.quality, patch);
    return this;
  }

  /** Bloom levels actually used: the setting, capped by quality, clamped to 2..8. */
  private wantLevels(): number {
    const want = Math.min(this.settings.bloom.levels, this.quality.maxBloomLevels);
    return Math.max(2, Math.min(8, Math.floor(want)));
  }

  /** Patch settings section by section. */
  set(patch: PostSettingsPatch): this {
    this.blender.cancel(patch);
    applyPostPatch(this.settings, patch);
    return this;
  }

  /**
   * Ease settings toward `patch` over `seconds` of frame time (default ease: smoothstep).
   * Numbers and RGB colours interpolate from their current values. `enabled: true` applies
   * at once, so set the pass's strength to 0 first to fade it in. `enabled: false`, `tonemap`,
   * `dither` and `bloom.levels` switch at the end. A later `set` or `blendTo` on the same
   * key takes over from wherever the blend is. `seconds <= 0` behaves like `set`.
   */
  blendTo(patch: PostSettingsPatch, seconds: number, ease: Ease = easeInOut): this {
    this.blender.blendTo(this.settings, patch, seconds, ease);
    return this;
  }

  /** True while a `blendTo` is still running. */
  get blending(): boolean {
    return this.blender.active;
  }

  /** Jump every running blend to its end value. */
  finishBlend(): this {
    this.blender.finish(this.settings);
    return this;
  }

  /**
   * Advance running blends to frame time `time` (seconds). `encode` calls this; call it
   * yourself only when driving the stack without rendering. Steps are capped at 0.1 s, so
   * a hidden tab or long hitch slows a blend rather than skipping it.
   */
  advanceBlend(time: number): void {
    const dt = this.lastTime === null ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    if (this.blender.active) this.blender.advance(this.settings, dt);
  }

  resize(width: number, height: number): void {
    const levels = this.wantLevels();
    if (width === this.width && height === this.height && levels === this.requestedLevels) return;
    this.requestedLevels = levels;
    this.width = width;
    this.height = height;
    const device = this.renderer.device;
    this.bloomTex?.destroy();
    this.raysTex?.destroy();

    const bw = Math.max(1, width >> 1);
    const bh = Math.max(1, height >> 1);
    const maxLevels = Math.max(1, Math.floor(Math.log2(Math.min(bw, bh))) - 1);
    this.levels = Math.max(1, Math.min(levels, maxLevels));
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.bloomTex = device.createTexture({
      label: 'post-bloom',
      size: [bw, bh],
      format: HDR,
      mipLevelCount: this.levels,
      usage,
    });
    this.mipViews = [];
    for (let i = 0; i < this.levels; i++) {
      this.mipViews.push(this.bloomTex.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    }
    this.raysTex = device.createTexture({ label: 'post-rays', size: [bw, bh], format: HDR, usage });
    this.raysView = this.raysTex.createView();

    this.downGroups = [];
    this.upGroups = [];
    for (let i = 1; i < this.levels; i++) {
      this.downGroups[i] = this.down.createBindGroup([this.mipViews[i - 1]!]);
    }
    for (let i = 0; i < this.levels - 1; i++) {
      this.upGroups[i] = this.up.createBindGroup([this.mipViews[i + 1]!]);
    }
    this.raysGroup = this.rays.createBindGroup([this.mipViews[0]!]);
    this.freeLdr();
    this.boundColor = null;
    this.boundEmissive = null;
  }

  encode(encoder: GPUCommandEncoder, inputs: PostInputs, output: GPUTextureView): void {
    this.advanceBlend(inputs.time);
    const s = this.settings;
    const r = this.renderer;
    if (this.wantLevels() !== this.requestedLevels) {
      this.resize(this.width, this.height);
    }
    this.bindInputs(inputs.color.view, inputs.emissive.view);

    packPostUniforms(
      this.uniforms,
      s,
      inputs.time,
      this.width,
      this.height,
      r.logicalWidth,
      r.logicalHeight,
      this.quality,
    );
    const needBloomChain = s.bloom.enabled || (s.godRays.enabled && s.godRays.bloomSource > 0);
    this.composite.setUniforms(this.uniforms);
    // GPU timing labels (undefined unless this frame is sampled; see Renderer.gpuTimer).
    const timer = r.gpuTimer;

    if (needBloomChain) {
      this.prefilter.setUniforms(this.uniforms);
      this.prefilter.encode(encoder, this.mipViews[0]!, {
        bindGroup: this.prefilterGroup!,
        timestampWrites: timer?.pass('bloom'),
      });
      for (let i = 1; i < this.levels; i++) {
        this.down.encode(encoder, this.mipViews[i]!, {
          bindGroup: this.downGroups[i]!,
          timestampWrites: timer?.pass('bloom'),
        });
      }
      const k = Math.min(Math.max(s.bloom.scatter, 0), 1);
      this.blendConstant.r = k;
      this.blendConstant.g = k;
      this.blendConstant.b = k;
      for (let i = this.levels - 2; i >= 0; i--) {
        this.up.encode(encoder, this.mipViews[i]!, {
          bindGroup: this.upGroups[i]!,
          clear: this.noClear,
          blendConstant: this.blendConstant,
          timestampWrites: timer?.pass('bloom'),
        });
      }
    }
    // When the chain is skipped, mip 0 is stale or zero; composite/rays ignore it then.

    if (s.godRays.enabled) {
      this.rays.setUniforms(this.uniforms);
      this.rays.encode(encoder, this.raysView!, {
        bindGroup: this.raysGroup!,
        timestampWrites: timer?.pass('rays'),
      });
    }

    if (
      this.quality.compositeAtScene &&
      (this.width < r.outputWidth || this.height < r.outputHeight)
    ) {
      if (!this.ldrView) this.allocLdr();
      this.composite.encode(encoder, this.ldrView!, {
        bindGroup: this.compositeGroup!,
        clear: COMPOSITE_CLEAR,
        timestampWrites: timer?.pass('composite'),
      });
      this.upscale.encode(encoder, output, {
        bindGroup: this.upscaleGroup!,
        clear: COMPOSITE_CLEAR,
        timestampWrites: timer?.pass('upscale'),
      });
      return;
    }
    this.composite.encode(encoder, output, {
      bindGroup: this.compositeGroup!,
      clear: COMPOSITE_CLEAR,
      timestampWrites: timer?.pass('composite'),
    });
  }

  /** Scene-size composite target, made on first use (a resize or tier change frees it). */
  private allocLdr(): void {
    this.ldrTex = this.renderer.device.createTexture({
      label: 'post-composite-scene',
      size: [this.width, this.height],
      format: this.renderer.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.ldrView = this.ldrTex.createView();
    this.upscaleGroup = this.upscale.createBindGroup([this.ldrView]);
  }

  private freeLdr(): void {
    this.ldrTex?.destroy();
    this.ldrTex = null;
    this.ldrView = null;
    this.upscaleGroup = null;
  }

  private bindInputs(color: GPUTextureView, emissive: GPUTextureView): void {
    if (color === this.boundColor && emissive === this.boundEmissive) return;
    this.boundColor = color;
    this.boundEmissive = emissive;
    this.prefilterGroup = this.prefilter.createBindGroup([color, emissive]);
    this.compositeGroup = this.composite.createBindGroup([
      color,
      emissive,
      this.mipViews[0]!,
      this.raysView!,
    ]);
  }

  destroy(): void {
    this.bloomTex?.destroy();
    this.raysTex?.destroy();
    this.prefilter.destroy();
    this.rays.destroy();
    this.composite.destroy();
    this.freeLdr();
    this.upscale.destroy();
  }
}
