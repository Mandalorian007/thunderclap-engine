import type { BindingSet } from './bindings';
import { ALL_LAYERS, CAMERA_BLOCK_FLOATS, Camera, type CameraRect } from './camera';
import { installGpuErrorLogging } from './diagnostics';
import {
  type Drawable,
  type DrawParams,
  Frame,
  type FrameSink,
  type InstanceParams,
} from './frame';
import { FullscreenPass, type FullscreenPassDesc } from './fullscreen';
import { type GpuPassTimes, GpuTimer, supportsTimestamps } from './gpu-timer';
import { LIGHTS_BLOCK_FLOATS } from './lights';
import {
  DEPTH_FORMAT,
  type DepthMode,
  INSTANCE_FLOATS,
  INSTANCE_STRIDE,
  Material,
  type MaterialDesc,
  SPRITE_WGSL,
} from './material';
import { Mesh, type MeshDesc, quadGeometry } from './mesh';
import { PingPong } from './ping-pong';
import { SCENE_FORMAT, SceneTarget, type SceneTargetDesc } from './scene-target';
import {
  bytesPerTexel,
  createSamplers,
  type PixelData,
  type SamplerKind,
  Texture,
  type TextureDesc,
  type TextureLike,
  type TextureSource,
} from './texture';
import { type Transform, writeMatrix2d } from './transform';

export interface PostInputs {
  color: TextureLike;
  emissive: TextureLike;
  time: number;
  dt: number;
}

/** The final stage: turns the HDR scene into swapchain pixels. See `@thunderclap/engine/post`. */
export interface PostProcessor {
  resize(width: number, height: number): void;
  encode(encoder: GPUCommandEncoder, inputs: PostInputs, output: GPUTextureView): void;
}

export interface RendererOptions {
  logicalWidth?: number;
  logicalHeight?: number;
  /** Initial instance capacity (grows by doubling). Default 4096. */
  initialInstances?: number;
}

export interface RendererGpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export interface RenderStats {
  drawCalls: number;
  instances: number;
  drawables: number;
}

/**
 * Internal resolution of the scene targets relative to the output (the canvas backbuffer).
 * The post stack (or the built-in present pass) upscales to the full output, so DOM UI and
 * the final composite stay at native resolution.
 */
export interface ResolutionOptions {
  /** Linear scale of the scene targets vs the output, 0.25..1. Default 1. */
  scale?: number;
  /** Cap on scene-target pixels (width × height). Default unlimited. */
  maxPixels?: number;
}

/**
 * Frame timing, filled in when `Renderer.timingEvery > 0`.
 *
 * With `timestamp-query` (`source: 'timestamp'`), `gpuMs` is the GPU time from the frame's
 * first pass to its last, and `passes` splits it by pass label (`pre`, `scene`, plus whatever
 * the post processor labels, e.g. `bloom`, `rays`, `composite`).
 *
 * Without it (`source: 'queue'`), `gpuMs` is the time from submit to
 * `queue.onSubmittedWorkDone()`. With vsync the queue is normally idle at submit, so this
 * approximates the GPU cost of the frame; when the GPU falls behind it also includes
 * queueing, which still reads as "over budget". `passes` stays empty.
 */
export interface FrameTiming {
  /** Last GPU sample (ms). */
  gpuMs: number;
  /** Where `gpuMs` comes from. */
  source: 'timestamp' | 'queue';
  /** Per-pass GPU ms of the last timestamp sample (empty on `queue`). */
  passes: GpuPassTimes;
  /** CPU time of the last frame, `beginFrame` → `endFrame` returning (ms). */
  cpuMs: number;
  /** GPU samples taken so far. */
  samples: number;
}

/** Smallest scale `setResolution` accepts (a quarter of the output in each direction). */
export const MIN_RESOLUTION_SCALE = 0.25;

/**
 * Effective scene-target size for an output size and resolution options. Pure (unit-tested).
 * Sizes are rounded to even numbers so the half-res bloom/ray targets stay pixel aligned.
 */
export function sceneSize(
  outW: number,
  outH: number,
  opts: Required<ResolutionOptions>,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, Math.floor(outW));
  const h = Math.max(1, Math.floor(outH));
  let k = Math.min(1, Math.max(MIN_RESOLUTION_SCALE, opts.scale));
  const px = w * h * k * k;
  if (px > opts.maxPixels) k *= Math.sqrt(opts.maxPixels / px);
  if (k >= 0.999) return { width: w, height: h, scale: 1 };
  const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
  const width = Math.min(w, even(w * k));
  const height = Math.min(h, even(h * k));
  return { width, height, scale: width / w };
}

interface DrawCmd {
  material: Material | null;
  mesh: Mesh | null;
  drawable: Drawable | null;
  /** Pipeline for (material, mesh layout, depth mode); null for drawables. */
  pipeline: GPURenderPipeline | null;
  first: number;
  count: number;
  /** Dynamic uniform offset for per-draw materials, else -1. */
  offset: number;
}

/** Globals block (binding 0) floats: logicalSize, targetSize, time, dt, pad. */
const GLOBALS_FLOATS = 8;
/** The camera block (binding 1) starts at this float offset (256 bytes: uniform alignment). */
const CAMERA_OFFSET_FLOATS = 64;
/** The lighting block (binding 2) starts at this float offset (512 bytes, after the camera). */
const LIGHTS_OFFSET_FLOATS = CAMERA_OFFSET_FLOATS + CAMERA_BLOCK_FLOATS;
/** One upload covers all three blocks. */
const ENGINE_UNIFORM_FLOATS = LIGHTS_OFFSET_FLOATS + LIGHTS_BLOCK_FLOATS;

/** The engine uniforms (globals, camera and lights) and their bind group for one view of a frame. */
interface ViewSlot {
  buffer: GPUBuffer;
  group: GPUBindGroup;
}

/** One recorded draw (instance or drawable), kept until `endFrame` sorts and batches them. */
interface DrawRec {
  material: Material | null;
  mesh: Mesh | null;
  drawable: Drawable | null;
  /** Dynamic uniform offset for per-draw materials, else -1. */
  offset: number;
  /** Instance index in `instanceData` (submission order), -1 for drawables. */
  inst: number;
  order: number;
  layers: number;
  /** Depth sort: 0 = opaque, 1 = blended (drawables count as blended). */
  group: number;
  /** Depth sort: clip-space depth of the instance origin (larger = farther). */
  dist: number;
}

/**
 * WebGPU renderer: owns the HDR scene targets, instanced batch, materials and the hand-off to
 * the post stack. One per canvas.
 *
 * ```ts
 * const r = new Renderer(gpu);
 * r.resize(w, h);
 * const f = r.beginFrame(time, dt);
 * f.sprite(myMaterial, { x: 960, y: 540, w: 200, h: 200 });
 * r.endFrame();                      // = r.render(f, r.camera) into r.target, then post + present
 * ```
 *
 * A frame is `beginFrame` → record → `render(frame, camera, target?, viewport?)` any number of
 * times → `endFrame`. Each `render` runs the recorded draw lists through one camera (its layer
 * mask, sort and depth) into a `SceneTarget` (default `renderer.target`, what the surface
 * shows); `endFrame` renders through `renderer.camera` when nothing called `render`, then runs
 * the post stack (or the built-in present) from `renderer.target` to the swapchain and submits.
 */
export class Renderer implements FrameSink {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  /** Swapchain format. */
  readonly format: GPUTextureFormat;
  readonly sceneFormats: readonly GPUTextureFormat[] = [SCENE_FORMAT, SCENE_FORMAT];
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  /**
   * The camera the scene pass draws through, uploaded to the camera block each frame.
   * Default `Camera.ortho2d(logicalWidth, logicalHeight)`; its `x`, `y`, `zoom` and
   * `rotation` pan the 2D view. Assign another `Camera` to swap presets.
   */
  camera: Camera;
  readonly samplers: Record<SamplerKind, GPUSampler>;
  readonly globalsLayout: GPUBindGroupLayout;
  /** The engine uniforms of the frame's first view (`@group(0)`: globals and camera block). */
  readonly globalsBindGroup: GPUBindGroup;
  readonly quad: Mesh;
  /** 1×1 white texture (default for unbound texture slots). */
  readonly white: Texture;
  /** Built-in sprite material bound to `white` (solid colour quads via tint). */
  readonly defaultSprite: Material;
  readonly stats: RenderStats = { drawCalls: 0, instances: 0, drawables: 0 };
  /** See `FrameTiming`. Only updated while `timingEvery > 0`. */
  readonly timing: FrameTiming = { gpuMs: 0, source: 'queue', passes: {}, cpuMs: 0, samples: 0 };
  /**
   * Pass timer when the device has `timestamp-query`, else null. Passes encoded during
   * `endFrame` (the post processor's included) label themselves with `gpuTimer.pass(label)`;
   * it returns undefined except on sampled frames.
   */
  readonly gpuTimer: GpuTimer | null;
  /**
   * Sample GPU time every N frames (0 = off). One sample is in flight at a time; each costs one
   * `onSubmittedWorkDone` promise.
   */
  timingEvery = 0;

  /** Final stage. Defaults to a plain tonemap + sRGB present; set to a `PostStack`. */
  post: PostProcessor | null = null;

  /** Scene-target size (internal resolution). The post stack reads these. */
  width = 1;
  height = 1;
  /** Output (canvas backbuffer) size, as passed to `resize`. */
  outputWidth = 1;
  outputHeight = 1;
  /**
   * The default `SceneTarget`, at the scene resolution: what `render` draws into unless given
   * another, what the post stack reads and what the surface shows.
   */
  readonly target: SceneTarget;

  private readonly views: ViewSlot[] = [];
  private viewCount = 0;
  private readonly globalsData = new Float32Array(ENGINE_UNIFORM_FLOATS);
  private readonly globalsU32 = new Uint32Array(this.globalsData.buffer);
  private readonly viewRect: CameraRect = { x: 0, y: 0, width: 1, height: 1 };
  /** Targets rendered into so far this frame, and whether their depth was cleared. */
  private readonly usedTargets: SceneTarget[] = [];
  private readonly usedDepth: boolean[] = [];
  private usedCount = 0;
  private instanceData: Float32Array;
  private instanceBuffer: GPUBuffer;
  /** Byte offset in `instanceBuffer` where the next view's instances go. */
  private instanceBase = 0;
  /** Instance buffers outgrown this frame, destroyed after submit (passes still reference them). */
  private readonly retired: GPUBuffer[] = [];
  private instanceCount = 0;
  private readonly cmds: DrawCmd[] = [];
  private cmdCount = 0;
  private readonly recs: DrawRec[] = [];
  private recCount = 0;
  /** True while every draw this frame had `order` >= the previous draw's. */
  private ordered = true;
  private lastOrder = Number.NEGATIVE_INFINITY;
  private sortIdx = new Uint32Array(256);
  private sortTmp = new Uint32Array(256);
  private sortDepth = false;
  /** Instance data in draw order, used when sorting or layer culling reorders draws. */
  private sortedData = new Float32Array(0);
  /** The array `endFrame` uploads: `instanceData` (submission order) or `sortedData`. */
  private uploadData: Float32Array;
  /** Instances `endFrame` uploads (layer-culled draws excluded). */
  private uploadCount = 0;
  private readonly prePasses: ((encoder: GPUCommandEncoder) => void)[] = [];
  private readonly prepared = new Set<Drawable>();
  /** Per-draw uniform sets with blocks staged this frame. */
  private readonly drawUniformSets: BindingSet[] = [];
  private readonly dynamicOffsets = [0];
  private readonly frame: Frame;
  private readonly present: FullscreenPass;
  private presentGroup: GPUBindGroup | null = null;
  private readonly postInputs: PostInputs;
  /** The frame's command encoder, opened by the first `render`, submitted by `endFrame`. */
  private encoder: GPUCommandEncoder | null = null;
  private sampled = false;
  private readonly resizeListeners = new Set<(w: number, h: number) => void>();
  private readonly resolution: Required<ResolutionOptions> = {
    scale: 1,
    maxPixels: Number.POSITIVE_INFINITY,
  };
  private inFrame = false;
  private destroyed = false;
  private frameStart = 0;
  private timingFrame = 0;
  private timingPending = false;
  private timingSubmit = 0;
  private readonly timingListeners = new Set<(gpuMs: number) => void>();
  private readonly onTimingDone = (): void => {
    this.timingPending = false;
    if (this.destroyed) return;
    this.emitGpuTime(performance.now() - this.timingSubmit);
  };
  private readonly onTimerResult = (): void => {
    if (this.destroyed || !this.gpuTimer) return;
    const r = this.gpuTimer.result;
    if (r.totalMs > 0) this.emitGpuTime(r.totalMs);
  };

  constructor(gpu: RendererGpu, opts: RendererOptions = {}) {
    this.device = gpu.device;
    this.context = gpu.context;
    this.format = gpu.format;
    this.logicalWidth = opts.logicalWidth ?? 1920;
    this.logicalHeight = opts.logicalHeight ?? 1080;
    this.camera = Camera.ortho2d(this.logicalWidth, this.logicalHeight);
    const device = this.device;
    installGpuErrorLogging(device);
    this.gpuTimer = supportsTimestamps(device) ? new GpuTimer(device) : null;
    if (this.gpuTimer) {
      this.timing.source = 'timestamp';
      this.timing.passes = this.gpuTimer.result.passes;
      this.gpuTimer.onResult(this.onTimerResult);
    }

    this.samplers = createSamplers(device);
    this.globalsLayout = device.createBindGroupLayout({
      label: 'engine-globals-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: {},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: {},
        },
      ],
    });
    this.globalsBindGroup = this.viewSlot(0).group;

    const cap = opts.initialInstances ?? 4096;
    this.instanceData = new Float32Array(cap * INSTANCE_FLOATS);
    this.uploadData = this.instanceData;
    this.instanceBuffer = this.makeInstanceBuffer(cap);

    this.quad = new Mesh(device, { label: 'quad', ...quadGeometry() });
    this.white = new Texture(device, { width: 1, height: 1, label: 'white' });
    device.queue.writeTexture(
      { texture: this.white.texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.defaultSprite = this.createSpriteMaterial(this.white, 'sprite-default');

    this.present = this.createFullscreenPass({
      label: 'present-basic',
      targets: [this.format],
      textures: 2,
      wgsl: /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var emissiveTex: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let c = textureSample(colorTex, samp, in.uv).rgb + textureSample(emissiveTex, samp, in.uv).rgb;
  let t = c / (1.0 + c);
  return vec4f(pow(t, vec3f(1.0 / 2.2)), 1.0);
}`,
    });

    this.frame = new Frame(this, this.logicalWidth, this.logicalHeight);
    this.target = new SceneTarget(device, { width: 1, height: 1 });
    this.postInputs = {
      color: this.target.color,
      emissive: this.target.emissive,
      time: 0,
      dt: 0,
    };
    this.resize(1, 1);
  }

  /** The default target's HDR colour texture (`target.color`). */
  get sceneColor(): Texture {
    return this.target.color;
  }

  /** The default target's HDR emissive texture (`target.emissive`). */
  get sceneEmissive(): Texture {
    return this.target.emissive;
  }

  /**
   * Set the output size (canvas backbuffer pixels). The HDR scene targets follow it, scaled
   * by `setResolution`. Cheap no-op when nothing changes.
   */
  resize(width: number, height: number): void {
    this.outputWidth = Math.max(1, Math.floor(width));
    this.outputHeight = Math.max(1, Math.floor(height));
    this.applyResolution();
  }

  /**
   * Render the scene below output resolution: `scale` (0.25..1, linear) and/or a `maxPixels`
   * budget. The final pass upscales to the canvas. Only the given fields change. Changing it
   * reallocates the scene and post targets, so do it rarely (a resolution controller should
   * step, not track every frame).
   */
  setResolution(opts: ResolutionOptions): void {
    if (opts.scale !== undefined) this.resolution.scale = opts.scale;
    if (opts.maxPixels !== undefined) this.resolution.maxPixels = opts.maxPixels;
    this.applyResolution();
  }

  /** Current resolution settings (scale as requested, before the pixel budget). */
  get resolutionOptions(): Readonly<Required<ResolutionOptions>> {
    return this.resolution;
  }

  /** Effective linear scale of the scene targets vs the output (after the pixel budget). */
  get resolutionScale(): number {
    return this.width / this.outputWidth;
  }

  private applyResolution(): void {
    const { width: w, height: h } = sceneSize(this.outputWidth, this.outputHeight, this.resolution);
    const changed = this.target.resize(w, h);
    if (!changed && this.presentGroup) return;
    this.width = w;
    this.height = h;
    this.presentGroup = this.present.createBindGroup([
      this.target.color.view,
      this.target.emissive.view,
    ]);
    this.postInputs.color = this.target.color;
    this.postInputs.emissive = this.target.emissive;
    this.post?.resize(w, h);
    for (const fn of this.resizeListeners) fn(w, h);
  }

  /** Called with every GPU time sample (see `timingEvery`). Returns unsubscribe. */
  onGpuTime(fn: (gpuMs: number) => void): () => void {
    this.timingListeners.add(fn);
    return () => this.timingListeners.delete(fn);
  }

  /** Called after the scene targets change size, with the scene size. Returns unsubscribe. */
  onResize(fn: (width: number, height: number) => void): () => void {
    this.resizeListeners.add(fn);
    return () => this.resizeListeners.delete(fn);
  }

  // ---------------------------------------------------------------- resources

  createMaterial(desc: MaterialDesc): Material {
    return new Material(
      this.device,
      desc,
      this.globalsLayout,
      this.sceneFormats,
      this.samplers[desc.sampler ?? 'linear-clamp'],
      this.white.view,
    );
  }

  /** Built-in textured sprite material for `texture`. */
  createSpriteMaterial(
    texture: TextureLike,
    label = 'sprite',
    opts: { blend?: MaterialDesc['blend']; sampler?: SamplerKind } = {},
  ): Material {
    const m = this.createMaterial({
      label,
      wgsl: SPRITE_WGSL,
      textures: 1,
      blend: opts.blend,
      sampler: opts.sampler,
    });
    m.setTexture(0, texture);
    return m;
  }

  createMesh(desc: MeshDesc): Mesh {
    return new Mesh(this.device, desc);
  }

  createTexture(desc: TextureDesc): Texture {
    return new Texture(this.device, desc);
  }

  /**
   * A scene target of its own size for `render` to draw a view into offscreen (a portal, a
   * minimap, a picture-in-picture camera). Its `color`/`emissive` are sampleable textures;
   * it is not resized with the surface. The caller destroys it.
   */
  createSceneTarget(desc: SceneTargetDesc): SceneTarget {
    return new SceneTarget(this.device, desc);
  }

  /** Offscreen render target (sampleable). Default format is the HDR scene format. */
  createRenderTarget(desc: TextureDesc): Texture {
    return new Texture(this.device, {
      format: SCENE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
      ...desc,
    });
  }

  createFullscreenPass(desc: FullscreenPassDesc): FullscreenPass {
    return new FullscreenPass(
      this.device,
      desc,
      this.samplers[desc.sampler ?? 'linear-clamp'],
      this.white.view,
    );
  }

  /**
   * Upload an image/canvas/ImageData. By default it is an sRGB colour texture (sampled as
   * linear). Pass `{ linear: true }` for data (masks, normals, lookup tables): the bytes are
   * stored as `rgba8unorm` and sampled exactly as written, with no sRGB decode.
   */
  textureFromSource(
    source: TextureSource,
    label = 'image',
    opts: { linear?: boolean } = {},
  ): Texture {
    const width = source.width;
    const height = source.height;
    const format: GPUTextureFormat = opts.linear ? 'rgba8unorm' : 'rgba8unorm-srgb';
    const tex = this.createTexture({ width, height, label, format });
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      this.device.queue.writeTexture(
        { texture: tex.texture },
        source.data,
        { bytesPerRow: width * 4 },
        [width, height],
      );
    } else {
      this.device.queue.copyExternalImageToTexture(
        { source: source as Exclude<TextureSource, ImageData> },
        { texture: tex.texture },
        [width, height],
      );
    }
    return tex;
  }

  /**
   * Upload raw texels. Default format `rgba8unorm` (linear data, no sRGB decode); any format
   * from `bytesPerTexel` works, e.g. `r8unorm` masks or `rgba32float` lookup tables. `data`
   * holds `width × height` tightly packed texels.
   */
  textureFromPixels(desc: {
    width: number;
    height: number;
    data: PixelData;
    format?: GPUTextureFormat;
    label?: string;
    usage?: GPUTextureUsageFlags;
  }): Texture {
    const tex = this.createTexture({
      width: desc.width,
      height: desc.height,
      format: desc.format ?? 'rgba8unorm',
      label: desc.label ?? 'pixels',
      usage: desc.usage,
    });
    this.writePixels(tex, desc.data);
    return tex;
  }

  /** Overwrite a whole texture with tightly packed texels (e.g. a CPU-updated data texture). */
  writePixels(tex: Texture, data: PixelData): void {
    const bpt = bytesPerTexel(tex.format);
    const need = tex.width * tex.height * bpt;
    if (data.byteLength < need) {
      throw new Error(
        `writePixels: ${data.byteLength} bytes, ${tex.width}×${tex.height} needs ${need}`,
      );
    }
    this.device.queue.writeTexture(
      { texture: tex.texture },
      data,
      { bytesPerRow: tex.width * bpt, rowsPerImage: tex.height },
      [tex.width, tex.height],
    );
  }

  /**
   * Two render targets for feedback passes (see `PingPong`). Default format is the HDR
   * scene format.
   */
  createPingPong(desc: TextureDesc): PingPong {
    return new PingPong(this.device, {
      format: SCENE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
      ...desc,
    });
  }

  /**
   * Generate a texture procedurally on the GPU. `wgsl` must define
   * `fn shade(uv: vec2f) -> vec4f` returning **linear** colour (uv 0..1, top-left origin).
   * Engine noise helpers (`engine_fbm` …) are available. Optional uniforms at
   * `@group(0) @binding(0)`.
   */
  textureFromShader(opts: {
    width: number;
    height: number;
    wgsl: string;
    label?: string;
    format?: GPUTextureFormat;
    uniforms?: Float32Array<ArrayBuffer>;
  }): Texture {
    const format = opts.format ?? 'rgba8unorm-srgb';
    const label = opts.label ?? 'procedural';
    const tex = this.createTexture({ width: opts.width, height: opts.height, format, label });
    const pass = this.createFullscreenPass({
      label: `gen:${label}`,
      targets: [format],
      uniformBytes: opts.uniforms?.byteLength ?? 0,
      wgsl: `${opts.wgsl}
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f { return shade(in.uv); }`,
    });
    if (opts.uniforms) pass.setUniforms(opts.uniforms);
    const enc = this.device.createCommandEncoder({ label: `gen:${label}` });
    pass.encode(enc, tex.view);
    this.device.queue.submit([enc.finish()]);
    pass.destroy();
    return tex;
  }

  // ---------------------------------------------------------------- frame

  /** Start recording a frame. `time`/`dt` in seconds are exposed to shaders via `globals`. */
  beginFrame(time: number, dt: number): Frame {
    if (this.inFrame) throw new Error('beginFrame called twice without endFrame');
    this.inFrame = true;
    if (this.timingEvery > 0) this.frameStart = performance.now();
    this.instanceCount = 0;
    this.cmdCount = 0;
    this.recCount = 0;
    this.ordered = true;
    this.lastOrder = Number.NEGATIVE_INFINITY;
    this.prePasses.length = 0;
    this.prepared.clear();
    for (const b of this.drawUniformSets) b.discardDrawUniforms();
    this.drawUniformSets.length = 0;
    this.stats.drawCalls = 0;
    this.stats.instances = 0;
    this.stats.drawables = 0;
    const f = this.frame;
    f.time = time;
    f.dt = dt;
    return f;
  }

  /**
   * Run the draw lists recorded in `frame` through `camera` into `target` (default: the
   * renderer's own, which the surface shows). Call it any number of times between
   * `beginFrame` and `endFrame`; `endFrame` calls it with `renderer.camera` when nothing did.
   *
   * Each call is one scene pass: the camera's layer mask culls, its depth flags pick the sort
   * and the depth attachment, and its `screen` rect is the viewport. A `screen` in logical
   * units (the `ortho2d` default is the whole design space) maps onto the target in
   * proportion; one inside the unit square (the perspective default `0,0,1,1`) is a fraction
   * of it. The first view into a target this frame clears it (`frame.clearColor`); later ones
   * draw over it, so a UI camera over a world camera or two half-screen cameras just work.
   * The first call opens the frame's command encoder and runs the pre-passes and drawable
   * `prepare` hooks (once per frame). No allocation in steady state.
   */
  render(frame: Frame, camera: Camera, target: SceneTarget = this.target): void {
    if (!this.inFrame) throw new Error('render outside beginFrame/endFrame');
    if (frame !== this.frame) throw new Error("render: frame is not this renderer's");
    if (this.destroyed) return;
    const device = this.device;
    const timer = this.gpuTimer;
    let enc = this.encoder;
    if (!enc) {
      enc = this.encoder = device.createCommandEncoder({ label: 'frame' });
      this.sampled = this.timingEvery > 0 && this.wantSample();
      if (timer && this.sampled && timer.begin()) timer.mark(enc);
      for (const fn of this.prePasses) fn(enc);
      for (const b of this.drawUniformSets) b.flushDrawUniforms();
      this.drawUniformSets.length = 0;
    }

    const depth = this.buildDraws(camera);
    for (let i = 0; i < this.cmdCount; i++) {
      const d = this.cmds[i]!.drawable;
      if (d?.prepare && !this.prepared.has(d)) {
        this.prepared.add(d);
        d.prepare(enc, frame);
      }
    }

    // Instances of this view go after the previous views' in the shared buffer.
    const base = this.instanceBase;
    const uploadCount = this.uploadCount;
    if (uploadCount > 0) {
      const needed = uploadCount * INSTANCE_STRIDE;
      if (base + needed > this.instanceBuffer.size) {
        this.retired.push(this.instanceBuffer);
        let cap = this.instanceData.length / INSTANCE_FLOATS;
        while (cap * INSTANCE_STRIDE < base + needed) cap *= 2;
        this.instanceBuffer = this.makeInstanceBuffer(cap);
      }
      device.queue.writeBuffer(this.instanceBuffer, base, this.uploadData.buffer, 0, needed);
      this.instanceBase = base + needed;
    }

    // Viewport: camera.screen in target pixels (see the doc comment).
    const vp = this.viewRect;
    const sc = camera.screen;
    const tw = target.width;
    const th = target.height;
    if (sc.x >= 0 && sc.y >= 0 && sc.x + sc.width <= 1 && sc.y + sc.height <= 1) {
      vp.x = sc.x * tw;
      vp.y = sc.y * th;
      vp.width = sc.width * tw;
      vp.height = sc.height * th;
    } else {
      const kx = tw / frame.logicalWidth;
      const ky = th / frame.logicalHeight;
      vp.x = sc.x * kx;
      vp.y = sc.y * ky;
      vp.width = sc.width * kx;
      vp.height = sc.height * ky;
    }
    const full = vp.x === 0 && vp.y === 0 && vp.width === tw && vp.height === th;

    const slot = this.viewSlot(this.viewCount);
    this.writeView(frame, camera, target, slot);
    this.viewCount++;

    // First view into this target clears it; later ones draw over.
    let used = -1;
    for (let i = 0; i < this.usedCount; i++) {
      if (this.usedTargets[i] === target) {
        used = i;
        break;
      }
    }
    const first = used < 0;
    if (first) {
      used = this.usedCount++;
      this.usedTargets[used] = target;
      this.usedDepth[used] = false;
    }
    target.colorAtt.clearValue = frame.clearColor;
    target.colorAtt.loadOp = first ? 'clear' : 'load';
    target.emissiveAtt.loadOp = first ? 'clear' : 'load';
    const desc = target.passDesc;
    desc.timestampWrites = timer?.pass('scene');
    if (depth) {
      const att = target.depthAttachment();
      att.depthLoadOp = this.usedDepth[used] ? 'load' : 'clear';
      this.usedDepth[used] = true;
      desc.depthStencilAttachment = att;
    } else {
      desc.depthStencilAttachment = undefined;
    }

    const pass = enc.beginRenderPass(desc);
    if (!full) {
      pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
      pass.setScissorRect(
        Math.floor(vp.x),
        Math.floor(vp.y),
        Math.ceil(vp.width),
        Math.ceil(vp.height),
      );
    }
    pass.setBindGroup(0, slot.group);
    let curPipeline: GPURenderPipeline | null = null;
    let curMaterial: Material | null = null;
    let curOffset = -1;
    let curMesh: Mesh | null = null;
    let drawCalls = 0;
    let drawables = 0;
    for (let i = 0; i < this.cmdCount; i++) {
      const c = this.cmds[i]!;
      if (c.drawable) {
        c.drawable.draw(pass, frame);
        drawables++;
        curPipeline = null;
        curMaterial = null;
        curOffset = -1;
        curMesh = null;
        pass.setBindGroup(0, slot.group);
        continue;
      }
      const m = c.material!;
      const mesh = c.mesh!;
      if (c.pipeline !== curPipeline) {
        pass.setPipeline(c.pipeline!);
        curPipeline = c.pipeline;
      }
      if (m !== curMaterial || c.offset !== curOffset) {
        if (c.offset >= 0) {
          this.dynamicOffsets[0] = c.offset;
          pass.setBindGroup(1, m.bindings!.bindGroup, this.dynamicOffsets);
        } else if (m.bindings) {
          pass.setBindGroup(1, m.bindings.bindGroup);
        }
        curMaterial = m;
        curOffset = c.offset;
      }
      if (mesh !== curMesh) {
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setVertexBuffer(1, this.instanceBuffer, base);
        if (mesh.indexBuffer) pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
        curMesh = mesh;
      }
      if (mesh.indexBuffer) {
        // An indexed mesh with no indices (e.g. a streamed chunk that is empty) draws nothing.
        if (mesh.indexCount === 0) continue;
        pass.drawIndexed(mesh.indexCount, c.count, 0, 0, c.first);
      } else {
        pass.draw(mesh.vertexCount, c.count, 0, c.first);
      }
      drawCalls++;
    }
    pass.end();
    this.stats.drawCalls += drawCalls;
    this.stats.instances += uploadCount;
    this.stats.drawables += drawables;
  }

  /**
   * Finish the frame: `render(frame, renderer.camera)` when nothing rendered yet, then the
   * post stack (or the built-in present) from `renderer.target` to the swapchain, and submit.
   */
  endFrame(): void {
    if (!this.inFrame) throw new Error('endFrame without beginFrame');
    if (this.destroyed) {
      this.inFrame = false;
      return;
    }
    if (!this.encoder) this.render(this.frame, this.camera);
    this.inFrame = false;
    const enc = this.encoder!;
    this.encoder = null;
    const timer = this.gpuTimer;
    const sampled = this.sampled;

    const out = this.context.getCurrentTexture().createView();
    if (this.post) {
      const inputs = this.postInputs;
      inputs.time = this.frame.time;
      inputs.dt = this.frame.dt;
      this.post.encode(enc, inputs, out);
    } else {
      this.present.encode(enc, out, {
        bindGroup: this.presentGroup!,
        clear: { r: 0, g: 0, b: 0, a: 1 },
      });
    }
    timer?.resolve(enc);
    this.device.queue.submit([enc.finish()]);
    this.viewCount = 0;
    this.usedCount = 0;
    this.instanceBase = 0;
    if (this.retired.length > 0) {
      for (const b of this.retired) b.destroy();
      this.retired.length = 0;
    }
    if (this.timingEvery > 0) {
      const now = performance.now();
      this.timing.cpuMs = now - this.frameStart;
      if (timer) timer.afterSubmit();
      else if (sampled) {
        this.timingPending = true;
        this.timingSubmit = now;
        this.device.queue.onSubmittedWorkDone().then(this.onTimingDone, this.onTimingDone);
      }
    }
  }

  /** Every `timingEvery` frames, when no sample is in flight. */
  private wantSample(): boolean {
    if (this.gpuTimer ? this.gpuTimer.busy : this.timingPending) return false;
    if (++this.timingFrame < this.timingEvery) return false;
    this.timingFrame = 0;
    return true;
  }

  private emitGpuTime(ms: number): void {
    this.timing.gpuMs = ms;
    this.timing.samples++;
    for (const fn of this.timingListeners) fn(ms);
  }

  destroy(): void {
    this.destroyed = true;
    this.gpuTimer?.destroy();
    this.target.destroy();
    this.instanceBuffer.destroy();
    for (const b of this.retired) b.destroy();
    this.retired.length = 0;
    for (const v of this.views) v.buffer.destroy();
    this.views.length = 0;
    this.quad.destroy();
    this.white.destroy();
  }

  // ---------------------------------------------------------------- FrameSink

  pushInstance(
    material: Material,
    mesh: Mesh,
    tr: Transform | null,
    p: DrawParams | InstanceParams,
  ): void {
    let offset = -1;
    const b = material.bindings;
    if (b?.perDraw) {
      if (p.uniforms) {
        if (b.drawCount === 0) this.drawUniformSets.push(b);
        offset = b.pushDrawUniforms(p.uniforms);
      } else {
        offset = 0;
      }
    } else if (p.uniforms) {
      throw new Error(`material ${material.label}: DrawParams.uniforms needs perDrawUniforms`);
    }

    const idx = this.instanceCount++;
    if (this.instanceCount * INSTANCE_FLOATS > this.instanceData.length) this.growInstances();
    const d = this.instanceData;
    let o = idx * INSTANCE_FLOATS;
    let sx: number;
    let sy: number;
    if (tr) {
      d.set(tr.world, o);
      sx = tr.scale.x;
      sy = tr.scale.y;
    } else {
      const dp = p as DrawParams;
      sx = dp.w ?? 1;
      sy = dp.h ?? 1;
      writeMatrix2d(d, o, dp.x, dp.y, sx, sy, dp.rotation ?? 0);
    }
    o += 12;
    const uv = p.uv;
    d[o++] = uv ? uv[0]! : 0;
    d[o++] = uv ? uv[1]! : 0;
    d[o++] = uv ? uv[2]! : 1;
    d[o++] = uv ? uv[3]! : 1;
    const t = p.tint;
    d[o++] = t ? t[0]! : 1;
    d[o++] = t ? t[1]! : 1;
    d[o++] = t ? t[2]! : 1;
    d[o++] = t ? (t[3] ?? 1) : 1;
    const q = p.params;
    d[o++] = q ? q[0]! : 0;
    d[o++] = q ? (q[1] ?? 0) : 0;
    d[o++] = q ? (q[2] ?? 0) : 0;
    d[o++] = q ? (q[3] ?? 0) : 0;
    d[o++] = p.emissive ?? 0;
    d[o++] = 0; // flags (reserved)
    d[o++] = sx;
    d[o] = sy;

    const r = this.nextRec(p.order ?? 0, p.layers ?? 1);
    r.material = material;
    r.mesh = mesh;
    r.drawable = null;
    r.offset = offset;
    r.inst = idx;
  }

  pushDrawable(d: Drawable, order: number, layers: number): void {
    const r = this.nextRec(order, layers);
    r.material = null;
    r.mesh = null;
    r.drawable = d;
    r.offset = -1;
    r.inst = -1;
  }

  pushPrePass(fn: (encoder: GPUCommandEncoder) => void): void {
    this.prePasses.push(fn);
  }

  // ---------------------------------------------------------------- draw list

  private nextRec(order: number, layers: number): DrawRec {
    if (order < this.lastOrder) this.ordered = false;
    this.lastOrder = order;
    if (this.recCount === this.recs.length) {
      this.recs.push({
        material: null,
        mesh: null,
        drawable: null,
        offset: -1,
        inst: -1,
        order: 0,
        layers: 1,
        group: 0,
        dist: 0,
      });
    }
    const r = this.recs[this.recCount++]!;
    r.order = order;
    r.layers = layers;
    return r;
  }

  /**
   * Turn this frame's draw records into batched commands. Draws whose `layers` miss the
   * camera's mask are dropped. Without depth, draws sort by `order` then submission index;
   * when every `order` is already non-decreasing (the default) nothing moves and the instance
   * data uploads as recorded. With `camera.depthTest`, the keys are `order`, then opaque
   * before blended, then depth (opaque front-to-back, blended back-to-front), then submission
   * index. Sets `uploadData` / `uploadCount`; returns whether depth is on.
   */
  private buildDraws(cam: Camera): boolean {
    const camLayers = cam.layers >>> 0;
    const depth = cam.depthTest;
    const depthWrite = cam.depthWrite;
    this.frame.depthFormat = depth ? DEPTH_FORMAT : null;
    const recs = this.recs;
    const n = this.recCount;
    this.cmdCount = 0;

    let visible = n;
    if (camLayers !== ALL_LAYERS) {
      visible = 0;
      for (let i = 0; i < n; i++) if ((recs[i]!.layers & camLayers) !== 0) visible++;
    }
    if (!depth && this.ordered && visible === n) {
      for (let i = 0; i < n; i++) {
        const r = recs[i]!;
        this.batch(r, r.inst, 0);
      }
      this.uploadData = this.instanceData;
      this.uploadCount = this.instanceCount;
      return false;
    }

    if (this.sortIdx.length < n) {
      this.sortIdx = new Uint32Array(n * 2);
      this.sortTmp = new Uint32Array(n * 2);
    }
    const idx = this.sortIdx;
    const src = this.instanceData;
    // Clip-space z of the instance origin (row 2 of view_proj, before the w divide): what the
    // depth buffer compares, up to a monotonic map, for any projection (ortho2d looks down +z,
    // perspective down -z).
    const v = depth ? cam.viewProjection : null;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i]!;
      if ((r.layers & camLayers) === 0) continue;
      idx[k++] = i;
      if (!depth) continue;
      if (r.drawable) {
        // No position: sorts as the nearest blended draw of its order (drawn after the rest).
        r.group = 1;
        r.dist = Number.NEGATIVE_INFINITY;
        continue;
      }
      r.group = r.material!.blend === 'opaque' ? 0 : 1;
      const o = r.inst * INSTANCE_FLOATS;
      const x = src[o + 3]!;
      const y = src[o + 7]!;
      const z = src[o + 11]!;
      r.dist = v![2]! * x + v![6]! * y + v![10]! * z + v![14]!;
    }
    this.sortDepth = depth;
    if (depth || !this.ordered) this.sortDraws(k);

    if (this.sortedData.length < src.length) this.sortedData = new Float32Array(src.length);
    const dst = this.sortedData;
    let inst = 0;
    for (let j = 0; j < k; j++) {
      const r = recs[idx[j]!]!;
      if (r.drawable) {
        this.batch(r, 0, 0);
        continue;
      }
      const from = r.inst * INSTANCE_FLOATS;
      const to = inst * INSTANCE_FLOATS;
      for (let f = 0; f < INSTANCE_FLOATS; f++) dst[to + f] = src[from + f]!;
      const mode: DepthMode = !depth ? 0 : r.group === 0 && depthWrite ? 2 : 1;
      this.batch(r, inst, mode);
      inst++;
    }
    this.uploadData = dst;
    this.uploadCount = inst;
    return depth;
  }

  /** Append a record as a command, merging into the previous one when it continues it. */
  private batch(r: DrawRec, first: number, depth: DepthMode): void {
    if (r.drawable) {
      const c = this.nextCmd();
      c.material = null;
      c.mesh = null;
      c.drawable = r.drawable;
      c.pipeline = null;
      c.first = 0;
      c.count = 0;
      c.offset = -1;
      return;
    }
    const material = r.material!;
    const mesh = r.mesh!;
    const pipeline = material.pipelineFor(mesh.layout, depth);
    const last = this.cmdCount > 0 ? this.cmds[this.cmdCount - 1]! : null;
    if (
      last &&
      !last.drawable &&
      last.pipeline === pipeline &&
      last.material === material &&
      last.mesh === mesh &&
      last.offset === r.offset &&
      last.first + last.count === first
    ) {
      last.count++;
      return;
    }
    const c = this.nextCmd();
    c.material = material;
    c.mesh = mesh;
    c.drawable = null;
    c.pipeline = pipeline;
    c.first = first;
    c.count = 1;
    c.offset = r.offset;
  }

  /** True when record `a` draws before record `b` (a total order: ties go by index). */
  private drawsBefore(a: number, b: number): boolean {
    const ra = this.recs[a]!;
    const rb = this.recs[b]!;
    if (ra.order !== rb.order) return ra.order < rb.order;
    if (this.sortDepth) {
      if (ra.group !== rb.group) return ra.group < rb.group;
      if (ra.dist !== rb.dist) return ra.group === 0 ? ra.dist < rb.dist : ra.dist > rb.dist;
    }
    return a < b;
  }

  /** Bottom-up merge sort of `sortIdx[0..n)` with `drawsBefore`; no allocation. */
  private sortDraws(n: number): void {
    let src = this.sortIdx;
    let dst = this.sortTmp;
    for (let width = 1; width < n; width *= 2) {
      for (let lo = 0; lo < n; lo += 2 * width) {
        const mid = Math.min(lo + width, n);
        const hi = Math.min(lo + 2 * width, n);
        let i = lo;
        let j = mid;
        let k = lo;
        while (i < mid && j < hi) {
          dst[k++] = this.drawsBefore(src[j]!, src[i]!) ? src[j++]! : src[i++]!;
        }
        while (i < mid) dst[k++] = src[i++]!;
        while (j < hi) dst[k++] = src[j++]!;
      }
      const t = src;
      src = dst;
      dst = t;
    }
    if (src !== this.sortIdx) {
      for (let i = 0; i < n; i++) this.sortIdx[i] = src[i]!;
    }
  }

  // ---------------------------------------------------------------- internals

  private nextCmd(): DrawCmd {
    if (this.cmdCount === this.cmds.length) {
      this.cmds.push({
        material: null,
        mesh: null,
        drawable: null,
        pipeline: null,
        first: 0,
        count: 0,
        offset: -1,
      });
    }
    return this.cmds[this.cmdCount++]!;
  }

  private growInstances(): void {
    const next = new Float32Array(this.instanceData.length * 2);
    next.set(this.instanceData);
    this.instanceData = next;
  }

  private makeInstanceBuffer(count: number): GPUBuffer {
    return this.device.createBuffer({
      label: 'instances',
      size: count * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /** The engine uniform slot for view `i` of a frame, made on first use (slot 0 at startup). */
  private viewSlot(i: number): ViewSlot {
    let slot = this.views[i];
    if (slot) return slot;
    const device = this.device;
    const suffix = i === 0 ? '' : `-${i}`;
    const buffer = device.createBuffer({
      label: `engine-globals${suffix}`,
      size: ENGINE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const group = device.createBindGroup({
      label: `engine-globals-group${suffix}`,
      layout: this.globalsLayout,
      entries: [
        { binding: 0, resource: { buffer, size: GLOBALS_FLOATS * 4 } },
        {
          binding: 1,
          resource: { buffer, offset: CAMERA_OFFSET_FLOATS * 4, size: CAMERA_BLOCK_FLOATS * 4 },
        },
        {
          binding: 2,
          resource: { buffer, offset: LIGHTS_OFFSET_FLOATS * 4, size: LIGHTS_BLOCK_FLOATS * 4 },
        },
      ],
    });
    slot = { buffer, group };
    this.views[i] = slot;
    return slot;
  }

  /**
   * Upload the globals, camera and lighting blocks of one view (`viewRect` holds its viewport;
   * `view_index` is `camera.viewIndex`).
   */
  private writeView(frame: Frame, camera: Camera, target: SceneTarget, slot: ViewSlot): void {
    const g = this.globalsData;
    g[0] = this.logicalWidth;
    g[1] = this.logicalHeight;
    g[2] = target.width;
    g[3] = target.height;
    g[4] = frame.time;
    g[5] = frame.dt;
    camera.writeBlock(g, this.globalsU32, CAMERA_OFFSET_FLOATS, this.viewRect);
    frame.lights.writeBlock(g, this.globalsU32, LIGHTS_OFFSET_FLOATS);
    this.device.queue.writeBuffer(slot.buffer, 0, g);
  }
}
