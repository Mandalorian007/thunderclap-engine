import type { BindingSet } from './bindings';
import { installGpuErrorLogging } from './diagnostics';
import { type Drawable, type DrawParams, Frame, type FrameSink } from './frame';
import { FullscreenPass, type FullscreenPassDesc } from './fullscreen';
import { type GpuPassTimes, GpuTimer, supportsTimestamps } from './gpu-timer';
import {
  INSTANCE_FLOATS,
  INSTANCE_STRIDE,
  Material,
  type MaterialDesc,
  SPRITE_WGSL,
} from './material';
import { Mesh, type MeshDesc, quadGeometry } from './mesh';
import { PingPong } from './ping-pong';
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

/** HDR scene targets: [0] colour, [1] emissive (feeds bloom). */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';

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

/** 2D camera over the logical space. Offsets in logical px; zoom about the view centre. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
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
  first: number;
  count: number;
  /** Dynamic uniform offset for per-draw materials, else -1. */
  offset: number;
}

const GLOBALS_FLOATS = 24;

/**
 * WebGPU renderer: owns the HDR scene targets, instanced batch, materials and the hand-off to
 * the post stack. One per canvas.
 *
 * ```ts
 * const r = new Renderer(gpu);
 * r.resize(w, h);
 * const f = r.beginFrame(time, dt);
 * f.sprite(myMaterial, { x: 960, y: 540, w: 200, h: 200 });
 * r.endFrame();
 * ```
 */
export class Renderer implements FrameSink {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  /** Swapchain format. */
  readonly format: GPUTextureFormat;
  readonly sceneFormats: readonly GPUTextureFormat[] = [SCENE_FORMAT, SCENE_FORMAT];
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly camera: Camera = { x: 0, y: 0, zoom: 1, rotation: 0 };
  readonly samplers: Record<SamplerKind, GPUSampler>;
  readonly globalsLayout: GPUBindGroupLayout;
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
  sceneColor!: Texture;
  sceneEmissive!: Texture;

  private readonly globalsBuffer: GPUBuffer;
  private readonly globalsData = new Float32Array(GLOBALS_FLOATS);
  private instanceData: Float32Array;
  private instanceBuffer: GPUBuffer;
  private instanceCount = 0;
  private readonly cmds: DrawCmd[] = [];
  private cmdCount = 0;
  private readonly prePasses: ((encoder: GPUCommandEncoder) => void)[] = [];
  private readonly prepared = new Set<Drawable>();
  /** Per-draw uniform sets with blocks staged this frame. */
  private readonly drawUniformSets: BindingSet[] = [];
  private readonly dynamicOffsets = [0];
  private readonly frame: Frame;
  private readonly present: FullscreenPass;
  private presentGroup: GPUBindGroup | null = null;
  private readonly scenePassDesc: GPURenderPassDescriptor;
  private readonly colorAtt: GPURenderPassColorAttachment;
  private readonly emissiveAtt: GPURenderPassColorAttachment;
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
      ],
    });
    this.globalsBuffer = device.createBuffer({
      label: 'engine-globals',
      size: GLOBALS_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.globalsBindGroup = device.createBindGroup({
      label: 'engine-globals-group',
      layout: this.globalsLayout,
      entries: [{ binding: 0, resource: { buffer: this.globalsBuffer } }],
    });

    const cap = opts.initialInstances ?? 4096;
    this.instanceData = new Float32Array(cap * INSTANCE_FLOATS);
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

    this.colorAtt = {
      view: this.white.view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.emissiveAtt = {
      view: this.white.view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    this.scenePassDesc = { label: 'scene', colorAttachments: [this.colorAtt, this.emissiveAtt] };
    this.frame = new Frame(this, this.logicalWidth, this.logicalHeight);
    this.colorAtt.clearValue = this.frame.clearColor;
    this.resize(1, 1);
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
    if (this.sceneColor && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneColor?.destroy();
    this.sceneEmissive?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.sceneColor = new Texture(this.device, {
      width: w,
      height: h,
      format: SCENE_FORMAT,
      usage,
      label: 'scene-color',
    });
    this.sceneEmissive = new Texture(this.device, {
      width: w,
      height: h,
      format: SCENE_FORMAT,
      usage,
      label: 'scene-emissive',
    });
    this.colorAtt.view = this.sceneColor.view;
    this.emissiveAtt.view = this.sceneEmissive.view;
    this.presentGroup = this.present.createBindGroup([
      this.sceneColor.view,
      this.sceneEmissive.view,
    ]);
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
    this.prePasses.length = 0;
    this.prepared.clear();
    for (const b of this.drawUniformSets) b.discardDrawUniforms();
    this.drawUniformSets.length = 0;
    const f = this.frame;
    f.time = time;
    f.dt = dt;
    return f;
  }

  /** Encode and submit: pre-passes, drawable prepare, scene pass, post, present. */
  endFrame(): void {
    if (!this.inFrame) throw new Error('endFrame without beginFrame');
    this.inFrame = false;
    if (this.destroyed) return;
    const device = this.device;
    this.writeGlobals();

    if (this.instanceCount > 0) {
      const needed = this.instanceCount * INSTANCE_STRIDE;
      if (needed > this.instanceBuffer.size) {
        this.instanceBuffer.destroy();
        this.instanceBuffer = this.makeInstanceBuffer(this.instanceData.length / INSTANCE_FLOATS);
      }
      device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData.buffer, 0, needed);
    }
    for (const b of this.drawUniformSets) b.flushDrawUniforms();
    this.drawUniformSets.length = 0;

    const enc = device.createCommandEncoder({ label: 'frame' });
    const timer = this.gpuTimer;
    const sampled = this.timingEvery > 0 && this.wantSample();
    if (timer && sampled && timer.begin()) timer.mark(enc);
    for (const fn of this.prePasses) fn(enc);
    for (let i = 0; i < this.cmdCount; i++) {
      const d = this.cmds[i]!.drawable;
      if (d?.prepare && !this.prepared.has(d)) {
        this.prepared.add(d);
        d.prepare(enc, this.frame);
      }
    }

    this.scenePassDesc.timestampWrites = timer?.pass('scene');
    const pass = enc.beginRenderPass(this.scenePassDesc);
    pass.setBindGroup(0, this.globalsBindGroup);
    let curPipeline: GPURenderPipeline | null = null;
    let curMaterial: Material | null = null;
    let curOffset = -1;
    let curMesh: Mesh | null = null;
    let drawCalls = 0;
    let drawables = 0;
    for (let i = 0; i < this.cmdCount; i++) {
      const c = this.cmds[i]!;
      if (c.drawable) {
        c.drawable.draw(pass, this.frame);
        drawables++;
        curPipeline = null;
        curMaterial = null;
        curOffset = -1;
        curMesh = null;
        pass.setBindGroup(0, this.globalsBindGroup);
        continue;
      }
      const m = c.material!;
      const mesh = c.mesh!;
      if (m.pipeline !== curPipeline) {
        pass.setPipeline(m.pipeline);
        curPipeline = m.pipeline;
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
        pass.setVertexBuffer(1, this.instanceBuffer);
        if (mesh.indexBuffer) pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
        curMesh = mesh;
      }
      if (mesh.indexBuffer && mesh.indexCount > 0) {
        pass.drawIndexed(mesh.indexCount, c.count, 0, 0, c.first);
      } else {
        pass.draw(mesh.vertexCount, c.count, 0, c.first);
      }
      drawCalls++;
    }
    pass.end();
    this.stats.drawCalls = drawCalls;
    this.stats.instances = this.instanceCount;
    this.stats.drawables = drawables;

    const out = this.context.getCurrentTexture().createView();
    if (this.post) {
      this.post.encode(
        enc,
        {
          color: this.sceneColor,
          emissive: this.sceneEmissive,
          time: this.frame.time,
          dt: this.frame.dt,
        },
        out,
      );
    } else {
      this.present.encode(enc, out, {
        bindGroup: this.presentGroup!,
        clear: { r: 0, g: 0, b: 0, a: 1 },
      });
    }
    timer?.resolve(enc);
    device.queue.submit([enc.finish()]);
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
    this.sceneColor?.destroy();
    this.sceneEmissive?.destroy();
    this.instanceBuffer.destroy();
    this.globalsBuffer.destroy();
    this.quad.destroy();
    this.white.destroy();
  }

  // ---------------------------------------------------------------- FrameSink

  pushInstance(material: Material, mesh: Mesh, p: DrawParams): void {
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
    d[o++] = p.x;
    d[o++] = p.y;
    d[o++] = p.w ?? 1;
    d[o++] = p.h ?? 1;
    d[o++] = p.rotation ?? 0;
    d[o++] = p.emissive ?? 0;
    d[o++] = 0;
    d[o++] = 0;
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

    const last = this.cmdCount > 0 ? this.cmds[this.cmdCount - 1]! : null;
    if (
      last &&
      !last.drawable &&
      last.material === material &&
      last.mesh === mesh &&
      last.offset === offset
    ) {
      last.count++;
      return;
    }
    const c = this.nextCmd();
    c.material = material;
    c.mesh = mesh;
    c.drawable = null;
    c.first = idx;
    c.count = 1;
    c.offset = offset;
  }

  pushDrawable(d: Drawable): void {
    const c = this.nextCmd();
    c.material = null;
    c.mesh = null;
    c.drawable = d;
    c.first = 0;
    c.count = 0;
    c.offset = -1;
  }

  pushPrePass(fn: (encoder: GPUCommandEncoder) => void): void {
    this.prePasses.push(fn);
  }

  // ---------------------------------------------------------------- internals

  private nextCmd(): DrawCmd {
    if (this.cmdCount === this.cmds.length) {
      this.cmds.push({
        material: null,
        mesh: null,
        drawable: null,
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

  private writeGlobals(): void {
    const g = this.globalsData;
    const W = this.logicalWidth;
    const H = this.logicalHeight;
    const cam = this.camera;
    const sx = 2 / W;
    const sy = 2 / H;
    const c = Math.cos(-cam.rotation) * cam.zoom;
    const s = Math.sin(-cam.rotation) * cam.zoom;
    const cx = W / 2 + cam.x;
    const cy = H / 2 + cam.y;
    g.fill(0);
    g[0] = c * sx;
    g[1] = -s * sy;
    g[4] = -s * sx;
    g[5] = -c * sy;
    g[10] = 1;
    g[12] = -c * sx * cx + s * sx * cy;
    g[13] = s * sy * cx + c * sy * cy;
    g[15] = 1;
    g[16] = W;
    g[17] = H;
    g[18] = this.width;
    g[19] = this.height;
    g[20] = this.frame.time;
    g[21] = this.frame.dt;
    this.device.queue.writeBuffer(this.globalsBuffer, 0, g);
  }
}
