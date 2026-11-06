import { mat4 } from '../core/math';
import type { FullscreenPass } from '../render/fullscreen';
import type { PostInputs, PostProcessor, Renderer } from '../render/renderer';
import type { SceneTargetViewport } from '../render/scene-target';
import { AO_BLUR_WGSL, AO_WGSL } from './ao';
import { type Ease, easeInOut, PostBlender } from './blend';
import { DepthPass } from './depth-pass';
import { DOF_WGSL } from './dof';
import {
  applyPostPatch,
  defaultPostQuality,
  defaultPostSettings,
  POST_UNIFORM_FLOATS,
  type PostDepthInfo,
  type PostQuality,
  type PostSettings,
  type PostSettingsPatch,
  packPostUniforms,
} from './settings';
import {
  COMPOSITE_WGSL,
  DOWN_WGSL,
  FXAA_WGSL,
  OUTLINE_WGSL,
  PREFILTER_WGSL,
  RAYS_WGSL,
  UP_WGSL,
} from './shaders';

const HDR: GPUTextureFormat = 'rgba16float';
const AO: GPUTextureFormat = 'r8unorm';
const COMPOSITE_CLEAR: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
/** The composite's texture slots: colour, emissive, bloom, rays, AO, DoF, outline, LUT (3D). */
const COMPOSITE_DIMS: GPUTextureViewDimension[] = ['2d', '2d', '2d', '2d', '2d', '2d', '2d', '3d'];

/**
 * The painterly post stack: bloom (mip chain), floor mist, god rays, ACES tonemap, colour
 * grade, vignette, dither, plus ambient occlusion and depth of field over the scene depth when
 * the frame has one (ws/post-depth; off by default), and the finishing passes (ws/post-2, all
 * off by default): a depth/normal outline, chromatic aberration, sharpen, a 3D LUT, film grain
 * in the composite, and FXAA as one extra pass after it. Plug it into a renderer with
 * `renderer.post = new PostStack(r)`.
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
  /** Depth passes (ws/post-depth): run only on frames with `inputs.depth` and the pass enabled. */
  private readonly ao: DepthPass;
  private readonly aoBlur: DepthPass;
  private readonly dof: DepthPass;
  /** Finishing passes (ws/post-2): FXAA after the composite, the outline mask before it. */
  private readonly fxaa: FullscreenPass;
  private readonly outline: DepthPass;

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
  private boundDepth: GPUTextureView | null = null;
  /** Half-res AO (raw and blurred) and DoF targets, made on the first frame that needs them. */
  private aoTex: GPUTexture | null = null;
  private aoView: GPUTextureView | null = null;
  private aoBlurTex: GPUTexture | null = null;
  private aoBlurView: GPUTextureView | null = null;
  private dofTex: GPUTexture | null = null;
  private dofView: GPUTextureView | null = null;
  private aoGroup: GPUBindGroup | null = null;
  private aoBlurGroup: GPUBindGroup | null = null;
  private dofGroup: GPUBindGroup | null = null;
  /** Scene-size outline mask, made on the first frame that needs it; freed on resize. */
  private outlineTex: GPUTexture | null = null;
  private outlineView: GPUTextureView | null = null;
  private outlineGroup: GPUBindGroup | null = null;
  private warnedOutline = false;
  /** Output-size FXAA input (the composite's result), made on the first frame that needs it. */
  private fxaaTex: GPUTexture | null = null;
  private fxaaView: GPUTextureView | null = null;
  private fxaaGroup: GPUBindGroup | null = null;
  private fxaaWidth = 0;
  private fxaaHeight = 0;
  /** The 1×1×1 LUT bound while `lut.texture` is null, and the view of the bound LUT. */
  private readonly lutPlaceholder: GPUTexture;
  private readonly lutPlaceholderView: GPUTextureView;
  private boundLut: GPUTexture | null = null;
  private lutView: GPUTextureView;
  /** Seconds of frame time while `grain.animated`: the grain's seed. */
  private grainSeed = 0;
  private readonly depthInfo: PostDepthInfo = {
    near: 0,
    far: 0,
    invProj: new Float32Array(16),
    projX: 1,
    projY: 1,
    outputWidth: 1,
  };

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
      textures: COMPOSITE_DIMS.length,
      viewDimension: COMPOSITE_DIMS,
    });
    this.fxaa = renderer.createFullscreenPass({
      label: 'post-fxaa',
      wgsl: FXAA_WGSL,
      targets: [renderer.format],
      uniformBytes: bytes,
      textures: 1,
    });
    this.outline = new DepthPass(renderer, {
      label: 'post-outline',
      wgsl: OUTLINE_WGSL,
      format: AO,
      textures: 0,
    });
    this.lutPlaceholder = renderer.device.createTexture({
      label: 'post-lut-none',
      size: [1, 1, 1],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.lutPlaceholderView = this.lutPlaceholder.createView({ dimension: '3d' });
    this.lutView = this.lutPlaceholderView;
    this.ao = new DepthPass(renderer, { label: 'post-ao', wgsl: AO_WGSL, format: AO, textures: 0 });
    this.aoBlur = new DepthPass(renderer, {
      label: 'post-ao-blur',
      wgsl: AO_BLUR_WGSL,
      format: AO,
      textures: 1,
    });
    this.dof = new DepthPass(renderer, {
      label: 'post-dof',
      wgsl: DOF_WGSL,
      format: HDR,
      textures: 1,
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
    // Depth targets and the FXAA input come back on the next frame that needs them, at the new size.
    this.freeDepthTargets();
    this.freeFxaa();
    this.boundColor = null;
    this.boundEmissive = null;
    this.boundDepth = null;
  }

  /**
   * Record the stack from `inputs` into `output`. With `viewport` (ws/xr-post: one eye of a
   * shared XR layer) the composite covers that rect only and loads the rest of the output;
   * otherwise it clears and covers the whole output. Inputs of another size than the last
   * `resize` (an eye-sized target through `renderer.resolve`) resize the stack first, so the
   * same stack serves the screen and a headset in turn.
   */
  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    this.advanceBlend(inputs.time);
    const s = this.settings;
    const r = this.renderer;
    const iw = inputs.color.width;
    const ih = inputs.color.height;
    if (iw !== this.width || ih !== this.height || this.wantLevels() !== this.requestedLevels) {
      this.resize(iw, ih);
    }
    const outW = viewport ? viewport.width : r.outputWidth;
    const outH = viewport ? viewport.height : r.outputHeight;
    const clear = viewport ? this.noClear : COMPOSITE_CLEAR;

    // Depth passes only on a frame that rendered depth (never the 2D path).
    const proj = inputs.projection;
    const depth = proj && inputs.depth ? inputs.depth : null;
    const wantAo = depth !== null && s.ao.enabled;
    const wantDof = depth !== null && s.dof.enabled;
    const wantOutline = depth !== null && s.outline.enabled && this.quality.outline;
    if (s.outline.enabled && depth === null && !this.warnedOutline) {
      this.warnedOutline = true;
      console.warn('[post] outline needs the scene depth; this frame has none, so it is off');
    }
    const wantFxaa = s.fxaa.enabled && this.quality.fxaa;
    if (wantAo && !this.aoTex) this.allocAo();
    if (wantDof && !this.dofTex) this.allocDof();
    if (wantOutline && !this.outlineTex) this.allocOutline();
    if (wantFxaa && (outW !== this.fxaaWidth || outH !== this.fxaaHeight))
      this.allocFxaa(outW, outH);
    this.bindLut(s.lut.texture);
    this.bindInputs(inputs.color.view, inputs.emissive.view, depth ? depth.view : null);
    if (s.grain.animated && s.grain.intensity > 0)
      this.grainSeed += Math.min(0.1, Math.max(0, inputs.dt));
    let depthInfo: PostDepthInfo | null = null;
    if (depth && proj) {
      depthInfo = this.depthInfo;
      depthInfo.near = proj.near;
      depthInfo.far = proj.far;
      depthInfo.projX = proj.proj[0]!;
      depthInfo.projY = proj.proj[5]!;
      depthInfo.outputWidth = outW;
      if (!mat4.invert(depthInfo.invProj as Float32Array, proj.proj)) depthInfo = null;
    }

    packPostUniforms(
      this.uniforms,
      s,
      inputs.time,
      this.width,
      this.height,
      r.logicalWidth,
      r.logicalHeight,
      this.quality,
      depthInfo,
      this.grainSeed,
    );
    const needBloomChain = s.bloom.enabled || (s.godRays.enabled && s.godRays.bloomSource > 0);
    this.composite.setUniforms(this.uniforms);
    // GPU timing labels (undefined unless this frame is sampled; see Renderer.gpuTimer).
    const timer = r.gpuTimer;

    if (wantOutline && depthInfo) {
      this.outline.setUniforms(this.uniforms);
      this.outline.encode(encoder, this.outlineView!, this.outlineGroup!, timer?.pass('outline'));
    }
    if (wantAo && depthInfo) {
      this.ao.setUniforms(this.uniforms);
      this.aoBlur.setUniforms(this.uniforms);
      this.ao.encode(encoder, this.aoView!, this.aoGroup!, timer?.pass('ao'));
      this.aoBlur.encode(encoder, this.aoBlurView!, this.aoBlurGroup!, timer?.pass('ao'));
    }
    if (wantDof && depthInfo) {
      this.dof.setUniforms(this.uniforms);
      this.dof.encode(encoder, this.dofView!, this.dofGroup!, timer?.pass('dof'));
    }

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

    // With FXAA the composite (or its upscale) lands in an output-size texture the FXAA pass
    // then resolves into the real output; without it, nothing changes.
    const final = wantFxaa ? this.fxaaView! : output;
    const finalClear = wantFxaa ? COMPOSITE_CLEAR : clear;
    const finalViewport = wantFxaa ? undefined : viewport;
    if (this.quality.compositeAtScene && (this.width < outW || this.height < outH)) {
      if (!this.ldrView) this.allocLdr();
      this.composite.encode(encoder, this.ldrView!, {
        bindGroup: this.compositeGroup!,
        clear: COMPOSITE_CLEAR,
        timestampWrites: timer?.pass('composite'),
      });
      this.upscale.encode(encoder, final, {
        bindGroup: this.upscaleGroup!,
        clear: finalClear,
        viewport: finalViewport,
        timestampWrites: timer?.pass('upscale'),
      });
    } else {
      this.composite.encode(encoder, final, {
        bindGroup: this.compositeGroup!,
        clear: finalClear,
        viewport: finalViewport,
        timestampWrites: timer?.pass('composite'),
      });
    }
    if (wantFxaa) {
      this.fxaa.setUniforms(this.uniforms);
      this.fxaa.encode(encoder, output, {
        bindGroup: this.fxaaGroup!,
        clear,
        viewport,
        timestampWrites: timer?.pass('fxaa'),
      });
    }
  }

  /** Scene-size outline mask. Forces the bind groups to be rebuilt. */
  private allocOutline(): void {
    this.outlineTex = this.renderer.device.createTexture({
      label: 'post-outline',
      size: [this.width, this.height],
      format: AO,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.outlineView = this.outlineTex.createView();
    this.boundColor = null;
  }

  /** Output-size FXAA input, remade when the output size changes (a resize, or an XR eye). */
  private allocFxaa(width: number, height: number): void {
    this.fxaaTex?.destroy();
    this.fxaaWidth = width;
    this.fxaaHeight = height;
    this.fxaaTex = this.renderer.device.createTexture({
      label: 'post-fxaa',
      size: [width, height],
      format: this.renderer.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.fxaaView = this.fxaaTex.createView();
    this.fxaaGroup = this.fxaa.createBindGroup([this.fxaaView]);
  }

  private freeFxaa(): void {
    this.fxaaTex?.destroy();
    this.fxaaTex = null;
    this.fxaaView = null;
    this.fxaaGroup = null;
    this.fxaaWidth = 0;
    this.fxaaHeight = 0;
  }

  /** Point the composite at `lut.texture` (or the placeholder); a change rebuilds the group. */
  private bindLut(texture: GPUTexture | null): void {
    if (texture === this.boundLut) return;
    this.boundLut = texture;
    this.lutView = texture ? texture.createView({ dimension: '3d' }) : this.lutPlaceholderView;
    this.boundColor = null;
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

  /** Half-res AO targets (raw and blurred). Forces the bind groups to be rebuilt. */
  private allocAo(): void {
    const device = this.renderer.device;
    const size = [Math.max(1, this.width >> 1), Math.max(1, this.height >> 1)];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.aoTex = device.createTexture({ label: 'post-ao', size, format: AO, usage });
    this.aoView = this.aoTex.createView();
    this.aoBlurTex = device.createTexture({ label: 'post-ao-blur', size, format: AO, usage });
    this.aoBlurView = this.aoBlurTex.createView();
    this.boundColor = null;
  }

  /** Half-res DoF target: blurred colour, CoC in alpha. Forces the bind groups to be rebuilt. */
  private allocDof(): void {
    const device = this.renderer.device;
    const size = [Math.max(1, this.width >> 1), Math.max(1, this.height >> 1)];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.dofTex = device.createTexture({ label: 'post-dof', size, format: HDR, usage });
    this.dofView = this.dofTex.createView();
    this.boundColor = null;
  }

  private freeDepthTargets(): void {
    this.aoTex?.destroy();
    this.aoBlurTex?.destroy();
    this.dofTex?.destroy();
    this.outlineTex?.destroy();
    this.aoTex = this.aoBlurTex = this.dofTex = this.outlineTex = null;
    this.aoView = this.aoBlurView = this.dofView = this.outlineView = null;
    this.aoGroup = this.aoBlurGroup = this.dofGroup = this.outlineGroup = null;
  }

  private bindInputs(
    color: GPUTextureView,
    emissive: GPUTextureView,
    depth: GPUTextureView | null,
  ): void {
    if (color === this.boundColor && emissive === this.boundEmissive && depth === this.boundDepth) {
      return;
    }
    this.boundColor = color;
    this.boundEmissive = emissive;
    this.boundDepth = depth;
    this.prefilterGroup = this.prefilter.createBindGroup([color, emissive]);
    const mip0 = this.mipViews[0]!;
    this.compositeGroup = this.composite.createBindGroup([
      color,
      emissive,
      mip0,
      this.raysView!,
      this.aoBlurView ?? mip0,
      this.dofView ?? mip0,
      this.outlineView ?? mip0,
      this.lutView,
    ]);
    if (depth) {
      this.aoGroup = this.aoView ? this.ao.createBindGroup(depth, []) : null;
      this.aoBlurGroup = this.aoView ? this.aoBlur.createBindGroup(depth, [this.aoView]) : null;
      this.dofGroup = this.dofView ? this.dof.createBindGroup(depth, [color]) : null;
      this.outlineGroup = this.outlineView ? this.outline.createBindGroup(depth, []) : null;
    } else {
      this.aoGroup = this.aoBlurGroup = this.dofGroup = this.outlineGroup = null;
    }
  }

  destroy(): void {
    this.bloomTex?.destroy();
    this.raysTex?.destroy();
    this.freeDepthTargets();
    this.freeFxaa();
    this.lutPlaceholder.destroy();
    this.ao.destroy();
    this.aoBlur.destroy();
    this.dof.destroy();
    this.outline.destroy();
    this.fxaa.destroy();
    this.prefilter.destroy();
    this.rays.destroy();
    this.composite.destroy();
    this.freeLdr();
    this.upscale.destroy();
  }
}
