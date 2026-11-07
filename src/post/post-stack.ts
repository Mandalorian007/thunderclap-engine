import { mat4 } from '../core/math';
import type { FullscreenPass } from '../render/fullscreen';
import type { JitterFn, PostInputs, PostProcessor, PostView, Renderer } from '../render/renderer';
import type { SceneTargetViewport } from '../render/scene-target';
import { AO_BLUR_WGSL, AO_WGSL } from './ao';
import { type Ease, easeInOut, PostBlender } from './blend';
import { DepthPass } from './depth-pass';
import { DOF_WGSL } from './dof';
import { adaptExposure, ExposurePasses, exposureTarget } from './exposure';
import { MOTION_BLUR_WGSL } from './motion-blur';
import {
  applyPostPatch,
  cinematicPostSettings,
  defaultPostQuality,
  POST_UNIFORM_FLOATS,
  type PostDepthInfo,
  type PostFrameState,
  type PostQuality,
  type PostSettings,
  type PostSettingsPatch,
  packPostUniforms,
  resolveGodRays,
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
import { SSR_WGSL } from './ssr';
import { TAA_AUX_FORMAT, TAA_WGSL, Taa, taaReprojection } from './taa';

const HDR: GPUTextureFormat = 'rgba16float';
const AO: GPUTextureFormat = 'r8unorm';
const COMPOSITE_CLEAR: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
/** The composite's texture slots: colour, emissive, bloom, rays, AO, DoF, outline, LUT (3D), SSR, dirt. */
const COMPOSITE_DIMS: GPUTextureViewDimension[] = [
  '2d',
  '2d',
  '2d',
  '2d',
  '2d',
  '2d',
  '2d',
  '3d',
  '2d',
  '2d',
];

/**
 * The bind groups that read one scene-colour view (the raw colour, a TAA history or the
 * motion-blur result), built on demand and dropped together when any other input changes.
 */
interface InputGroups {
  prefilter: GPUBindGroup | null;
  composite: GPUBindGroup | null;
  dof: GPUBindGroup | null;
  ssr: GPUBindGroup | null;
  motionBlur: GPUBindGroup | null;
  /**
   * TAA resolve groups (only on the raw colour's groups): `taa[slot * 2 + read]` reads history
   * `read` of TAA history slot `slot` (ws/xr-taa: one slot per eye).
   */
  taa: (GPUBindGroup | null)[];
}

/** The jitter a detached stack's hook returns on the frame it clears itself (ws/post-7). */
const NO_JITTER: readonly [number, number] = [0, 0];
/**
 * Uniform staging slots for encodes with a viewport (ws/render-12): XR eyes resolved in one
 * submit, each reading its own. Four covers a headset's two eyes and a quad-view layout.
 */
const EYE_UNIFORM_SLOTS = 4;
/**
 * TAA history slots (ws/xr-taa): the screen's plus one per eye viewport, so each XR eye
 * reprojects against its own previous frame. Past this many views the least recently used
 * slot is reset and reused.
 */
const TAA_HISTORY_SLOTS = EYE_UNIFORM_SLOTS + 1;

/**
 * One TAA history (ws/xr-taa): the scene-size resolve pair, the aux pair beside it (ws/post-5)
 * and which of the pair was last written. Keyed by the encode's viewport: the screen (no
 * viewport) has one, each XR eye (its rect of the shared layer) its own.
 */
interface TaaHistory {
  /** False for the screen's slot (an encode without a viewport). */
  hasViewport: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  tex: [GPUTexture, GPUTexture] | null;
  views: [GPUTextureView, GPUTextureView] | null;
  auxTex: [GPUTexture, GPUTexture] | null;
  auxViews: [GPUTextureView, GPUTextureView] | null;
  /** The pair entry last written. */
  index: number;
  /** False until the slot's first resolve (and after a resize or a frame without TAA). */
  valid: boolean;
  /** `PostStack.taaUse` when the slot last resolved: the least recent is reused. */
  used: number;
}

/**
 * The painterly post stack: bloom (mip chain), floor mist, god rays, ACES tonemap, colour
 * grade, vignette, dither, plus ambient occlusion and depth of field over the scene depth when
 * the frame has one (ws/post-depth; off by default), the finishing passes (ws/post-2, all
 * off by default): a depth/normal outline, chromatic aberration, sharpen, a 3D LUT, film grain
 * in the composite, and FXAA as one extra pass after it, and the third pass (ws/post-3, all
 * off by default): TAA, screen-space reflections, auto-exposure, white balance, motion blur
 * (camera, or per object from a velocity target since ws/post-4) and lens dirt. Plug it into a renderer with `renderer.post = new PostStack(r)`.
 *
 * Every pass reads the frame from `PostInputs` alone (ws/post-4): the view matrices and the
 * jitter from `view`, the projection from `projection`, per-surface roughness and metalness
 * from `roughMetal`, per-pixel motion from `velocity`. While TAA runs the stack declares
 * `wantsJitter` and drives the Halton jitter through `renderer.setJitter` (ws/post-6), so every
 * camera the renderer draws is jittered, XR eyes and offscreen views included.
 *
 * Settings are plain objects you can mutate at runtime (`post.settings.bloom.intensity = 2`)
 * or patch with `post.set({ mist: { density: 0.4 } })`. Disabled passes are skipped entirely.
 * `post.blendTo(patch, seconds, ease?)` eases numeric settings over time instead.
 */
export class PostStack implements PostProcessor {
  readonly settings: PostSettings;
  /**
   * Cost caps (bloom levels, ray samples, fog octaves). Independent of `settings`, so scene
   * presets and blends keep working under a lower quality tier. Change with `setQuality`.
   */
  readonly quality: PostQuality = defaultPostQuality();
  /**
   * The TAA jitter sequence (ws/post-3): `post.taa.jitter(i)` is the `i`-th offset. While TAA
   * runs the stack hands it to `renderer.setJitter` (ws/post-6).
   */
  readonly taa = new Taa(8);
  /**
   * How many times a TAA history was reset (first frame, resize, re-enable). In XR each eye
   * keeps its own history (ws/xr-taa), so each eye's reset counts.
   */
  historyResets = 0;

  private readonly renderer: Renderer;
  private readonly uniforms = new Float32Array(POST_UNIFORM_FLOATS);
  /**
   * XR eyes (ws/render-12): every eye resolves on the frame's one encoder, so a `writeBuffer`
   * per eye would leave each pass reading the last eye's uniforms at submit. An encode with a
   * `viewport` writes its block into its own slot of this staging ring and copies it into each
   * pass's buffer on the encoder, just before the pass. Made on the first such encode.
   */
  private eyeUniforms: GPUBuffer | null = null;
  /** The staging slot of the encode under way, or -1: write the passes' buffers directly. */
  private eyeSlot = -1;
  private eyeNext = 0;
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
  /** Post 3 (ws/post-3): the TAA resolve, the half-res SSR march and the motion-blur gather. */
  private readonly taaPass: DepthPass;
  private readonly ssrPass: DepthPass;
  private readonly motionBlurPass: DepthPass;
  /** The auto-exposure compute passes, made on the first frame in `'auto'` mode. */
  private exposurePasses: ExposurePasses | null = null;

  private bloomTex: GPUTexture | null = null;
  private mipViews: GPUTextureView[] = [];
  private raysTex: GPUTexture | null = null;
  private raysView: GPUTextureView | null = null;
  private levels = 0;
  /** Levels asked for at the last resize (before the size clamp), to detect real changes. */
  private requestedLevels = 0;
  private width = 0;
  private height = 0;
  private boundEmissive: GPUTextureView | null = null;
  private boundDepth: GPUTextureView | null = null;
  /** Bind groups per scene-colour view; cleared whenever any other input or target changes. */
  private readonly groups = new Map<GPUTextureView, InputGroups>();
  /** Half-res AO (raw and blurred) and DoF targets, made on the first frame that needs them. */
  private aoTex: GPUTexture | null = null;
  private aoView: GPUTextureView | null = null;
  private aoBlurTex: GPUTexture | null = null;
  private aoBlurView: GPUTextureView | null = null;
  private dofTex: GPUTexture | null = null;
  private dofView: GPUTextureView | null = null;
  private aoGroup: GPUBindGroup | null = null;
  private aoBlurGroup: GPUBindGroup | null = null;
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
  /** The bound lens-dirt texture and its view (`null` → bloom mip 0 as a placeholder). */
  private boundDirt: GPUTexture | null = null;
  private dirtView: GPUTextureView | null = null;
  /** Seconds of frame time while `grain.animated`: the grain's seed. */
  private grainSeed = 0;
  /**
   * TAA history slots (ws/post-3; per view since ws/xr-taa): the screen's, and one per XR eye
   * viewport, each with its scene-size history pair and aux pair (ws/post-5), made on the
   * view's first TAA frame. At most `TAA_HISTORY_SLOTS`; no allocation once every view has one.
   */
  private readonly histories: TaaHistory[] = [];
  /** Counts TAA resolves: `TaaHistory.used`. */
  private taaUse = 0;
  /** `encode`'s extra target, reused (no allocation per frame). */
  private readonly taaExtra: GPUTextureView[] = [];
  /** Half-res SSR term and scene-size motion-blur result, made on the first frame that needs them. */
  private ssrTex: GPUTexture | null = null;
  private ssrView: GPUTextureView | null = null;
  private motionBlurTex: GPUTexture | null = null;
  private motionBlurView: GPUTextureView | null = null;
  private readonly frameState: PostFrameState = {
    jitterX: 0,
    jitterY: 0,
    reset: 1,
    reproj: mat4.create(),
    autoExposure: 1,
    roughMetal: 0,
    objectVelocity: 0,
    taaVelocity: 0,
  };
  /** The current EV (`exposure`), eased in auto mode, `log2(grade.exposure)` in manual. */
  private ev = 0;
  private taaOn = false;
  private taaVelocityOn = false;
  private ssrOn = false;
  private motionBlurOn = false;
  private readonly depthInfo: PostDepthInfo = {
    near: 0,
    far: 0,
    invProj: new Float32Array(16),
    projX: 1,
    projY: 1,
    outputWidth: 1,
    ortho: false,
  };

  private raysGroup: GPUBindGroup | null = null;
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  /** Scene-size composite target (display-encoded, swapchain format) and its upscale group. */
  private ldrTex: GPUTexture | null = null;
  private ldrView: GPUTextureView | null = null;
  private upscaleGroup: GPUBindGroup | null = null;
  private readonly blendConstant: GPUColorDict = { r: 1, g: 1, b: 1, a: 1 };
  private readonly noClear = null;
  private readonly blender = new PostBlender();
  private lastTime: number | null = null;
  /**
   * The hook the stack gives `renderer.setJitter` while TAA runs (made once: no per-frame
   * closure). It runs in `beginFrame`, so only while it is installed, and checks there that the
   * stack is still attached (ws/post-7): a stack whose TAA resolve did not run during the last
   * frame, or a renderer with no post processor, has been detached, and the hook clears itself
   * before the frame draws.
   */
  private readonly jitterFn: JitterFn = (i) => {
    if (this.jitterResolved && this.renderer.post !== null) {
      this.jitterResolved = false;
      return this.taa.jitter(i);
    }
    this.releaseJitter();
    return NO_JITTER;
  };
  /** True while the stack has set `renderer.setJitter` (cleared once TAA stops or on `destroy`). */
  private jitterHooked = false;
  /** A TAA resolve ran since the hook last ran (ws/post-7: the stack is still attached). */
  private jitterResolved = false;
  /** The resolved god-ray source (x, y, visibility) when `godRays.direction` placed it. */
  private readonly raySrc = new Float32Array(3);
  private boundRoughMetal: GPUTextureView | null = null;
  private boundVelocity: GPUTextureView | null = null;
  private boundTaaVelocity: GPUTextureView | null = null;

  /** `godRays.direction` through the frame's view, or null when `x`/`y` place the rays. */
  private raySource(
    s: PostSettings,
    view: PostView | null,
    logicalWidth: number,
    logicalHeight: number,
  ): Float32Array | null {
    const g = s.godRays;
    if (!g.direction || !view) return null;
    resolveGodRays(g, view.viewProj, logicalWidth, logicalHeight, this.raySrc);
    return this.raySrc;
  }

  constructor(renderer: Renderer, patch: PostSettingsPatch = {}) {
    this.renderer = renderer;
    this.settings = applyPostPatch(cinematicPostSettings(), patch);
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
    this.taaPass = new DepthPass(renderer, {
      label: 'post-taa',
      wgsl: TAA_WGSL,
      format: [HDR, TAA_AUX_FORMAT],
      textures: 4,
    });
    this.ssrPass = new DepthPass(renderer, {
      label: 'post-ssr',
      wgsl: SSR_WGSL,
      format: HDR,
      textures: 2,
    });
    this.motionBlurPass = new DepthPass(renderer, {
      label: 'post-motion-blur',
      wgsl: MOTION_BLUR_WGSL,
      format: HDR,
      textures: 2,
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
   * The current exposure in EV (ws/post-3): the eased auto-exposure value while
   * `exposure.mode` is `'auto'`, else `log2(grade.exposure)`. The multiplier is `2^EV`.
   */
  get exposure(): number {
    return this.ev;
  }

  /**
   * The renderer reads this before each view (`PostProcessor.wantsJitter`): true while TAA is
   * enabled and allowed by `quality.taa`, so the cameras' `setJitter` reaches their projection.
   */
  get wantsJitter(): boolean {
    return this.settings.taa.enabled && this.quality.taa;
  }

  /** True when the last `encode` ran the TAA resolve (depth present, enabled, allowed). */
  get taaActive(): boolean {
    return this.taaOn;
  }

  /**
   * True when the last TAA resolve reprojected by the velocity target (ws/post-5):
   * `taa.reprojection` `'velocity'` and the frame had one.
   */
  get taaVelocityActive(): boolean {
    return this.taaVelocityOn;
  }

  /** True when the last `encode` ran the SSR march. */
  get ssrActive(): boolean {
    return this.ssrOn;
  }

  /** True when the last `encode` ran the motion-blur gather. */
  get motionBlurActive(): boolean {
    return this.motionBlurOn;
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
    // Depth targets, the FXAA input and the temporal targets come back on the next frame that
    // needs them, at the new size. The TAA history is gone with them.
    this.freeDepthTargets();
    this.freeFxaa();
    this.freeTemporal();
    this.invalidateGroups();
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
    const q = this.quality;
    const r = this.renderer;
    const iw = inputs.color.width;
    const ih = inputs.color.height;
    if (iw !== this.width || ih !== this.height || this.wantLevels() !== this.requestedLevels) {
      this.resize(iw, ih);
    }
    const outW = viewport ? viewport.width : r.outputWidth;
    const outH = viewport ? viewport.height : r.outputHeight;
    const clear = viewport ? this.noClear : COMPOSITE_CLEAR;
    const dt = Math.min(0.1, Math.max(0, inputs.dt));

    // Depth passes only on a frame that rendered depth (never the 2D path).
    const proj = inputs.projection;
    const depth = proj && inputs.depth ? inputs.depth : null;
    const wantAo = depth !== null && s.ao.enabled;
    const wantDof = depth !== null && s.dof.enabled;
    const wantOutline = depth !== null && s.outline.enabled && q.outline;
    if (s.outline.enabled && depth === null && !this.warnedOutline) {
      this.warnedOutline = true;
      console.warn('[post] outline needs the scene depth; this frame has none, so it is off');
    }
    // Post 3: the temporal passes need the depth; they reproject through `inputs.view` (an
    // unknown view reprojects to itself).
    const view = inputs.view;
    const wantTaa = depth !== null && s.taa.enabled && q.taa;
    const wantMotionBlur = depth !== null && s.motionBlur.enabled && q.motionBlur;
    const wantSsr = depth !== null && s.ssr.enabled && q.ssr;
    const wantAuto = s.exposure.mode === 'auto' && q.autoExposure;
    const wantFxaa = s.fxaa.enabled && q.fxaa && !wantTaa;
    if (wantAo && !this.aoTex) this.allocAo();
    if (wantDof && !this.dofTex) this.allocDof();
    if (wantOutline && !this.outlineTex) this.allocOutline();
    if (wantFxaa && (outW !== this.fxaaWidth || outH !== this.fxaaHeight))
      this.allocFxaa(outW, outH);
    const hist = wantTaa ? this.historyFor(viewport) : null;
    if (hist && !hist.tex) this.allocHistory(hist);
    if (wantSsr && !this.ssrTex) this.allocSsr();
    if (wantMotionBlur && !this.motionBlurTex) this.allocMotionBlur();
    if (wantAuto && !this.exposurePasses) this.exposurePasses = new ExposurePasses(r);
    this.bindLut(s.lut.texture);
    this.bindDirt(s.bloom.dirt?.texture ?? null);
    // Per-surface inputs (ws/post-4): bound only while a pass that reads them runs.
    const roughMetal = wantSsr && inputs.roughMetal ? inputs.roughMetal.view : null;
    const objectVelocity =
      wantMotionBlur && s.motionBlur.mode === 'object' && inputs.velocity
        ? inputs.velocity.view
        : null;
    const taaVelocity =
      wantTaa && s.taa.reprojection === 'velocity' && inputs.velocity ? inputs.velocity.view : null;
    this.bindInputs(
      inputs.emissive.view,
      depth ? depth.view : null,
      roughMetal,
      objectVelocity,
      taaVelocity,
    );
    if (s.grain.animated && s.grain.intensity > 0) this.grainSeed += dt;
    let depthInfo: PostDepthInfo | null = null;
    if (depth && proj) {
      depthInfo = this.depthInfo;
      depthInfo.near = proj.near;
      depthInfo.far = proj.far;
      depthInfo.projX = proj.proj[0]!;
      depthInfo.projY = proj.proj[5]!;
      depthInfo.outputWidth = outW;
      depthInfo.ortho = proj.proj[11] === 0;
      if (!mat4.invert(depthInfo.invProj as Float32Array, proj.proj)) depthInfo = null;
    }

    // Post 3 frame state, from the view (ws/post-4): this frame's (jittered) clip → the previous
    // frame's clip, the jitter the camera drew with, the EV, the per-surface input flags.
    const fs = this.frameState;
    if (!wantTaa) this.invalidateHistories();
    if (depthInfo && view) {
      taaReprojection(fs.reproj as Float32Array, view.previousViewProj, view.invViewProj);
    } else {
      mat4.identity(fs.reproj as Float32Array);
    }
    const reset = hist !== null && !hist.valid;
    if (reset) this.historyResets++;
    fs.reset = reset ? 1 : 0;
    fs.jitterX = wantTaa && view ? view.jitter[0] / iw : 0;
    fs.jitterY = wantTaa && view ? view.jitter[1] / ih : 0;
    fs.roughMetal = roughMetal ? 1 : 0;
    fs.objectVelocity = objectVelocity ? 1 : 0;
    fs.taaVelocity = taaVelocity ? 1 : 0;
    this.updateExposure(wantAuto, dt);

    packPostUniforms(
      this.uniforms,
      s,
      inputs.time,
      this.width,
      this.height,
      r.logicalWidth,
      r.logicalHeight,
      q,
      depthInfo,
      this.grainSeed,
      fs,
      this.raySource(s, view, r.logicalWidth, r.logicalHeight),
    );
    this.beginUploads(viewport);
    const needBloomChain = s.bloom.enabled || (s.godRays.enabled && s.godRays.bloomSource > 0);
    this.upload(encoder, this.composite.bindings!.uniformBuffer!, this.composite);
    // GPU timing labels (undefined unless this frame is sampled; see Renderer.gpuTimer).
    const timer = r.gpuTimer;

    if (wantOutline && depthInfo) {
      this.upload(encoder, this.outline.uniformBuffer, this.outline);
      this.outline.encode(encoder, this.outlineView!, this.outlineGroup!, timer?.pass('outline'));
    }
    if (wantAo && depthInfo) {
      this.upload(encoder, this.ao.uniformBuffer, this.ao);
      this.upload(encoder, this.aoBlur.uniformBuffer, this.aoBlur);
      this.ao.encode(encoder, this.aoView!, this.aoGroup!, timer?.pass('ao'));
      this.aoBlur.encode(encoder, this.aoBlurView!, this.aoBlurGroup!, timer?.pass('ao'));
    }

    // The scene colour the rest of the stack reads: the raw colour, the TAA resolve, or the
    // motion-blur gather over either.
    const raw = inputs.color.view;
    let scene = raw;
    const depthView = depth ? depth.view : null;
    this.taaOn = wantTaa && depthInfo !== null;
    if (this.taaOn && depthView && hist) {
      // This view's own history (ws/xr-taa): each eye reads and writes its slot's pair only.
      const read = hist.index;
      const write = 1 - read;
      const group = this.taaGroup(raw, depthView, hist, read);
      this.upload(encoder, this.taaPass.uniformBuffer, this.taaPass);
      this.taaExtra[0] = hist.auxViews![write]!;
      this.taaPass.encode(encoder, hist.views![write]!, group, timer?.pass('taa'), this.taaExtra);
      hist.index = write;
      hist.valid = true;
      hist.used = ++this.taaUse;
      scene = hist.views![write]!;
    }
    this.taaVelocityOn = this.taaOn && taaVelocity !== null;
    this.syncJitter(this.taaOn);
    this.motionBlurOn = wantMotionBlur && depthInfo !== null;
    if (this.motionBlurOn && depthView) {
      const group = this.motionBlurGroup(scene, depthView);
      this.upload(encoder, this.motionBlurPass.uniformBuffer, this.motionBlurPass);
      this.motionBlurPass.encode(encoder, this.motionBlurView!, group, timer?.pass('motion-blur'));
      scene = this.motionBlurView!;
    }
    const groups = this.groupsFor(scene);

    if (wantDof && depthInfo && depthView) {
      this.upload(encoder, this.dof.uniformBuffer, this.dof);
      this.dof.encode(
        encoder,
        this.dofView!,
        this.dofGroup(groups, scene, depthView),
        timer?.pass('dof'),
      );
    }
    this.ssrOn = wantSsr && depthInfo !== null;
    if (this.ssrOn && depthView) {
      this.upload(encoder, this.ssrPass.uniformBuffer, this.ssrPass);
      this.ssrPass.encode(
        encoder,
        this.ssrView!,
        this.ssrGroup(groups, scene, depthView),
        timer?.pass('ssr'),
      );
    }
    if (wantAuto && this.exposurePasses) {
      this.exposurePasses.encode(
        encoder,
        scene,
        this.width,
        this.height,
        s.exposure.histogramLow,
        s.exposure.histogramHigh,
      );
    }

    if (needBloomChain) {
      this.upload(encoder, this.prefilter.bindings!.uniformBuffer!, this.prefilter);
      this.prefilter.encode(encoder, this.mipViews[0]!, {
        bindGroup: this.prefilterGroup(groups, scene),
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
      this.upload(encoder, this.rays.bindings!.uniformBuffer!, this.rays);
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
    const compositeGroup = this.compositeGroup(groups, scene);
    if (this.quality.compositeAtScene && (this.width < outW || this.height < outH)) {
      if (!this.ldrView) this.allocLdr();
      this.composite.encode(encoder, this.ldrView!, {
        bindGroup: compositeGroup,
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
        bindGroup: compositeGroup,
        clear: finalClear,
        viewport: finalViewport,
        timestampWrites: timer?.pass('composite'),
      });
    }
    if (wantFxaa) {
      this.upload(encoder, this.fxaa.bindings!.uniformBuffer!, this.fxaa);
      this.fxaa.encode(encoder, output, {
        bindGroup: this.fxaaGroup!,
        clear,
        viewport,
        timestampWrites: timer?.pass('fxaa'),
      });
    }
  }

  /**
   * Pick how this encode's uniform block reaches the passes (ws/render-12). Without a viewport
   * (the screen, one encode per submit) each pass's buffer is written directly, as before.
   * With one (an XR eye; the eyes share a submit) the block goes into the next slot of a ring of
   * `EYE_UNIFORM_SLOTS` and `upload` copies it on the encoder, so each eye's passes read that
   * eye's reprojection, jitter and ray source. No allocation after the first eye.
   */
  private beginUploads(viewport: SceneTargetViewport | undefined): void {
    if (!viewport) {
      this.eyeSlot = -1;
      return;
    }
    const bytes = this.uniforms.byteLength;
    if (!this.eyeUniforms) {
      this.eyeUniforms = this.renderer.device.createBuffer({
        label: 'post-eye-uniforms',
        size: bytes * EYE_UNIFORM_SLOTS,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    }
    this.eyeSlot = this.eyeNext;
    this.eyeNext = (this.eyeNext + 1) % EYE_UNIFORM_SLOTS;
    const u = this.uniforms;
    this.renderer.device.queue.writeBuffer(
      this.eyeUniforms,
      this.eyeSlot * bytes,
      u.buffer,
      u.byteOffset,
      bytes,
    );
  }

  /** This encode's uniform block into `buffer` (the pass's): see `beginUploads`. */
  private upload(
    encoder: GPUCommandEncoder,
    buffer: GPUBuffer,
    pass: { setUniforms(data: Float32Array<ArrayBuffer>): void },
  ): void {
    if (this.eyeSlot < 0 || !this.eyeUniforms) {
      pass.setUniforms(this.uniforms);
      return;
    }
    const bytes = this.uniforms.byteLength;
    encoder.copyBufferToBuffer(this.eyeUniforms, this.eyeSlot * bytes, buffer, 0, bytes);
  }

  /**
   * After the first TAA frame, hand the Halton sequence to `renderer.setJitter` (the renderer
   * runs it from frame 0 at the next `beginFrame`, so the sequence restarts each time TAA
   * starts); once TAA stops, clear the hook with `null`, once. Only on those edges: a hook set
   * by someone else in between is left alone. Ownership is read from the renderer (ws/post-8):
   * the hook is this stack's while `renderer.jitter === this.jitterFn`. Another stack (or the
   * page) that sets its hook on the same renderer takes it over: this one then never clears
   * it, and sets its own again once the renderer has none.
   */
  private syncJitter(taa: boolean): void {
    if (taa) {
      this.jitterResolved = true;
      if (this.jitterHooked && this.renderer.jitter !== null) return;
      this.jitterHooked = true;
      this.renderer.setJitter(this.jitterFn);
    } else if (this.jitterHooked) {
      this.releaseJitter();
    }
  }

  /** Drop the hook: clear it with `null` if it is still this stack's, else leave it alone. */
  private releaseJitter(): void {
    this.jitterHooked = false;
    this.jitterResolved = false;
    if (this.renderer.jitter !== this.jitterFn) return;
    this.renderer.setJitter(null);
  }

  /** Ease the EV toward the metered target in auto mode; mirror the manual value otherwise. */
  private updateExposure(auto: boolean, dt: number): void {
    const ex = this.settings.exposure;
    if (!auto || !this.exposurePasses) {
      this.ev = Math.log2(Math.max(1e-6, this.settings.grade.exposure));
      this.frameState.autoExposure = 2 ** this.ev;
      return;
    }
    const passes = this.exposurePasses;
    passes.poll();
    // Hold until the first histogram has been read back, then ease toward the metered target.
    if (passes.readbacks > 0) {
      const target = exposureTarget(passes.averageLog, ex.keyValue, ex.minEv, ex.maxEv);
      this.ev = adaptExposure(this.ev, target, dt, ex.speedUp, ex.speedDown);
    }
    this.frameState.autoExposure = 2 ** this.ev;
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
    this.invalidateGroups();
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

  /**
   * The TAA history slot of the view `viewport` names (ws/xr-taa): the screen's without one,
   * else the eye whose rect it is. A new view takes a free slot, or past `TAA_HISTORY_SLOTS`
   * the least recently used one (reset). No allocation once every view has a slot.
   */
  private historyFor(viewport: SceneTargetViewport | undefined): TaaHistory {
    const list = this.histories;
    const has = viewport !== undefined;
    for (let i = 0; i < list.length; i++) {
      const h = list[i]!;
      if (h.hasViewport !== has) continue;
      if (
        !viewport ||
        (h.x === viewport.x &&
          h.y === viewport.y &&
          h.width === viewport.width &&
          h.height === viewport.height)
      ) {
        return h;
      }
    }
    let h: TaaHistory;
    if (list.length < TAA_HISTORY_SLOTS) {
      h = {
        hasViewport: has,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        tex: null,
        views: null,
        auxTex: null,
        auxViews: null,
        index: 0,
        valid: false,
        used: 0,
      };
      list.push(h);
    } else {
      h = list[0]!;
      for (let i = 1; i < list.length; i++) if (list[i]!.used < h.used) h = list[i]!;
      h.index = 0;
      h.valid = false;
    }
    h.hasViewport = has;
    h.x = viewport ? viewport.x : 0;
    h.y = viewport ? viewport.y : 0;
    h.width = viewport ? viewport.width : 0;
    h.height = viewport ? viewport.height : 0;
    return h;
  }

  /**
   * The two scene-size TAA history textures of `h` (ws/post-3) and their aux pair. The first
   * slot keeps the ws/post-3 labels (`post-taa-history-0/1`); slot `n` appends `-v<n>`.
   */
  private allocHistory(h: TaaHistory): void {
    const device = this.renderer.device;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const size = [this.width, this.height];
    const n = this.histories.indexOf(h);
    const tag = n > 0 ? `-v${n}` : '';
    const tex = (label: string, format: GPUTextureFormat): GPUTexture =>
      device.createTexture({ label: label + tag, size, format, usage });
    const a = tex('post-taa-history-0', HDR);
    const b = tex('post-taa-history-1', HDR);
    h.tex = [a, b];
    h.views = [a.createView(), b.createView()];
    const auxA = tex('post-taa-aux-0', TAA_AUX_FORMAT);
    const auxB = tex('post-taa-aux-1', TAA_AUX_FORMAT);
    h.auxTex = [auxA, auxB];
    h.auxViews = [auxA.createView(), auxB.createView()];
    h.index = 0;
    h.valid = false;
    this.invalidateGroups();
  }

  /** Mark every TAA history invalid: the next resolve of each view copies its frame. */
  private invalidateHistories(): void {
    for (let i = 0; i < this.histories.length; i++) this.histories[i]!.valid = false;
  }

  /** Half-res SSR term (premultiplied colour, fade in alpha). */
  private allocSsr(): void {
    this.ssrTex = this.renderer.device.createTexture({
      label: 'post-ssr',
      size: [Math.max(1, this.width >> 1), Math.max(1, this.height >> 1)],
      format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.ssrView = this.ssrTex.createView();
    this.invalidateGroups();
  }

  /** Scene-size motion-blur result. */
  private allocMotionBlur(): void {
    this.motionBlurTex = this.renderer.device.createTexture({
      label: 'post-motion-blur',
      size: [this.width, this.height],
      format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.motionBlurView = this.motionBlurTex.createView();
    this.invalidateGroups();
  }

  private freeTemporal(): void {
    for (let i = 0; i < this.histories.length; i++) {
      const h = this.histories[i]!;
      h.tex?.[0].destroy();
      h.tex?.[1].destroy();
      h.auxTex?.[0].destroy();
      h.auxTex?.[1].destroy();
      h.tex = null;
      h.views = null;
      h.auxTex = null;
      h.auxViews = null;
      h.valid = false;
    }
    this.ssrTex?.destroy();
    this.ssrTex = null;
    this.ssrView = null;
    this.motionBlurTex?.destroy();
    this.motionBlurTex = null;
    this.motionBlurView = null;
    this.exposurePasses?.invalidate();
  }

  /** Point the composite at `lut.texture` (or the placeholder); a change rebuilds the group. */
  private bindLut(texture: GPUTexture | null): void {
    if (texture === this.boundLut) return;
    this.boundLut = texture;
    this.lutView = texture ? texture.createView({ dimension: '3d' }) : this.lutPlaceholderView;
    this.invalidateGroups();
  }

  /** Point the composite at the lens-dirt texture (or bloom mip 0 as a placeholder). */
  private bindDirt(texture: GPUTexture | null): void {
    if (texture === this.boundDirt) return;
    this.boundDirt = texture;
    this.dirtView = texture ? texture.createView() : null;
    this.invalidateGroups();
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
    this.invalidateGroups();
  }

  /** Half-res DoF target: blurred colour, CoC in alpha. Forces the bind groups to be rebuilt. */
  private allocDof(): void {
    const device = this.renderer.device;
    const size = [Math.max(1, this.width >> 1), Math.max(1, this.height >> 1)];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.dofTex = device.createTexture({ label: 'post-dof', size, format: HDR, usage });
    this.dofView = this.dofTex.createView();
    this.invalidateGroups();
  }

  private freeDepthTargets(): void {
    this.aoTex?.destroy();
    this.aoBlurTex?.destroy();
    this.dofTex?.destroy();
    this.outlineTex?.destroy();
    this.aoTex = this.aoBlurTex = this.dofTex = this.outlineTex = null;
    this.aoView = this.aoBlurView = this.dofView = this.outlineView = null;
    this.aoGroup = this.aoBlurGroup = this.outlineGroup = null;
  }

  /** Drop every cached bind group: the next frame rebuilds the ones it uses. */
  private invalidateGroups(): void {
    this.groups.clear();
    this.boundEmissive = null;
    this.boundDepth = null;
    this.boundRoughMetal = null;
    this.boundVelocity = null;
    this.boundTaaVelocity = null;
    this.exposurePasses?.invalidate();
  }

  /** Track the emissive and depth views; a change drops the cached groups and rebuilds the depth-only ones. */
  private bindInputs(
    emissive: GPUTextureView,
    depth: GPUTextureView | null,
    roughMetal: GPUTextureView | null,
    velocity: GPUTextureView | null,
    taaVelocity: GPUTextureView | null,
  ): void {
    if (
      emissive === this.boundEmissive &&
      depth === this.boundDepth &&
      roughMetal === this.boundRoughMetal &&
      velocity === this.boundVelocity &&
      taaVelocity === this.boundTaaVelocity
    ) {
      return;
    }
    this.groups.clear();
    this.boundEmissive = emissive;
    this.boundDepth = depth;
    this.boundRoughMetal = roughMetal;
    this.boundVelocity = velocity;
    this.boundTaaVelocity = taaVelocity;
    if (depth) {
      this.aoGroup = this.aoView ? this.ao.createBindGroup(depth, []) : null;
      this.aoBlurGroup = this.aoView ? this.aoBlur.createBindGroup(depth, [this.aoView]) : null;
      this.outlineGroup = this.outlineView ? this.outline.createBindGroup(depth, []) : null;
    } else {
      this.aoGroup = this.aoBlurGroup = this.outlineGroup = null;
    }
  }

  /** The cached groups for a scene-colour view (an empty set on first use). */
  private groupsFor(scene: GPUTextureView): InputGroups {
    let g = this.groups.get(scene);
    if (!g) {
      g = {
        prefilter: null,
        composite: null,
        dof: null,
        ssr: null,
        motionBlur: null,
        taa: new Array<GPUBindGroup | null>(TAA_HISTORY_SLOTS * 2).fill(null),
      };
      this.groups.set(scene, g);
    }
    return g;
  }

  private prefilterGroup(g: InputGroups, scene: GPUTextureView): GPUBindGroup {
    if (!g.prefilter) g.prefilter = this.prefilter.createBindGroup([scene, this.boundEmissive!]);
    return g.prefilter;
  }

  private compositeGroup(g: InputGroups, scene: GPUTextureView): GPUBindGroup {
    if (!g.composite) {
      const mip0 = this.mipViews[0]!;
      g.composite = this.composite.createBindGroup([
        scene,
        this.boundEmissive!,
        mip0,
        this.raysView!,
        this.aoBlurView ?? mip0,
        this.dofView ?? mip0,
        this.outlineView ?? mip0,
        this.lutView,
        this.ssrView ?? mip0,
        this.dirtView ?? mip0,
      ]);
    }
    return g.composite;
  }

  private dofGroup(g: InputGroups, scene: GPUTextureView, depth: GPUTextureView): GPUBindGroup {
    if (!g.dof) g.dof = this.dof.createBindGroup(depth, [scene]);
    return g.dof;
  }

  private ssrGroup(g: InputGroups, scene: GPUTextureView, depth: GPUTextureView): GPUBindGroup {
    // Without the rough-metal target the scene colour stands in (the shader does not read it).
    if (!g.ssr) g.ssr = this.ssrPass.createBindGroup(depth, [scene, this.boundRoughMetal ?? scene]);
    return g.ssr;
  }

  private motionBlurGroup(scene: GPUTextureView, depth: GPUTextureView): GPUBindGroup {
    const g = this.groupsFor(scene);
    // Without object velocity the scene colour stands in (the shader does not read it).
    if (!g.motionBlur) {
      g.motionBlur = this.motionBlurPass.createBindGroup(depth, [
        scene,
        this.boundVelocity ?? scene,
      ]);
    }
    return g.motionBlur;
  }

  /** The TAA resolve group reading the raw colour, history `read` of `h` and its aux. */
  private taaGroup(
    raw: GPUTextureView,
    depth: GPUTextureView,
    h: TaaHistory,
    read: number,
  ): GPUBindGroup {
    const g = this.groupsFor(raw);
    const key = this.histories.indexOf(h) * 2 + read;
    let group = g.taa[key];
    if (!group) {
      // Without a velocity target the raw colour stands in (the shader does not read it).
      group = this.taaPass.createBindGroup(depth, [
        raw,
        h.views![read]!,
        this.boundTaaVelocity ?? raw,
        h.auxViews![read]!,
      ]);
      g.taa[key] = group;
    }
    return group;
  }

  /**
   * Free the stack's GPU resources and clear the `renderer.setJitter` hook if TAA had set it
   * (ws/post-6). The stack is not usable afterwards.
   */
  destroy(): void {
    this.syncJitter(false);
    this.bloomTex?.destroy();
    this.raysTex?.destroy();
    this.freeDepthTargets();
    this.freeFxaa();
    this.freeTemporal();
    this.exposurePasses?.destroy();
    this.lutPlaceholder.destroy();
    this.ao.destroy();
    this.aoBlur.destroy();
    this.dof.destroy();
    this.outline.destroy();
    this.taaPass.destroy();
    this.ssrPass.destroy();
    this.motionBlurPass.destroy();
    this.fxaa.destroy();
    this.prefilter.destroy();
    this.rays.destroy();
    this.composite.destroy();
    this.eyeUniforms?.destroy();
    this.eyeUniforms = null;
    this.freeLdr();
    this.upscale.destroy();
  }
}
