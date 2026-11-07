import type { BindingSet } from './bindings';
import { ALL_LAYERS, CAMERA_BLOCK_FLOATS, Camera, type CameraRect, FRUSTUM_FLOATS } from './camera';
import { type RendererCaps, rendererCaps } from './compressed';
import { installGpuErrorLogging } from './diagnostics';
import {
  type Drawable,
  type DrawParams,
  Frame,
  type FrameSink,
  INSTANCE_PARAM_FLOATS,
  type InstanceBatch,
  type InstanceParams,
  type ViewInfo,
  writeInstanceParams,
} from './frame';
import { FullscreenPass, type FullscreenPassDesc } from './fullscreen';
import { type GpuPassTimes, GpuTimer, supportsTimestamps } from './gpu-timer';
import { InstanceList, type InstanceListOptions } from './instance-list';
import { LIGHTS_BLOCK_FLOATS, packInstanceFlags, type ShadowUniforms } from './lights';
import {
  DEFAULT_LOD_HYSTERESIS,
  lodSizePx,
  type MeshLod,
  type MeshLodChain,
  type MeshLodDesc,
  pickLodLevel,
} from './lod';
import {
  DEPTH_FORMAT,
  type DepthMode,
  INSTANCE_FLOATS,
  INSTANCE_STRIDE,
  Material,
  type MaterialDesc,
  SPRITE_WGSL,
} from './material';
import { Mesh, type MeshBounds, type MeshDesc, quadGeometry, VERTEX_LAYOUT_2D } from './mesh';
import { PingPong } from './ping-pong';
import {
  SCENE_FORMAT,
  SceneTarget,
  type SceneTargetAux,
  type SceneTargetDesc,
  type SceneTargetViewport,
} from './scene-target';
import { DEFAULT_SHADOW_SIZE, SHADOW_FORMAT, ShadowMap } from './shadow';
import {
  bytesPerTexel,
  createSamplers,
  defaultTextures,
  loadTexture,
  type PixelData,
  type SamplerKind,
  Texture,
  type TextureDesc,
  type TextureLike,
  type TextureSource,
} from './texture';
import { MATRIX3X4_FLOATS, type Transform, writeMatrix2d } from './transform';

/** `InstanceParams` of a batch without `params`: the defaults. */
const NO_PARAMS: InstanceParams = Object.freeze({});

export interface PostInputs {
  color: TextureLike;
  emissive: TextureLike;
  time: number;
  dt: number;
  /**
   * The target's depth buffer when a depth camera rendered into it this frame (ws/post-depth),
   * else `null` (the 2D path). Same size as `color`; `depth24plus`, bind it as `texture_depth_2d`.
   */
  depth: TextureLike | null;
  /** The last depth camera's projection, with `depth`; `null` without it. */
  projection: PostProjection | null;
  /**
   * The matrices of the last camera that rendered into the target this frame (ws/render-4):
   * what a reprojecting pass (TAA, motion blur) needs. `null` before any view.
   */
  view: PostView | null;
  /** The target's `rg8unorm` roughness/metalness attachment (`SceneTargetDesc.aux`), else null. */
  roughMetal: TextureLike | null;
  /** The target's `rg16float` screen-space velocity attachment (`SceneTargetDesc.aux`), else null. */
  velocity: TextureLike | null;
}

/** A view's matrices for post passes: this frame's (with jitter) and last frame's (without). */
export interface PostView {
  viewProj: Float32Array;
  invViewProj: Float32Array;
  previousViewProj: Float32Array;
  previousView: Float32Array;
  /** The sub-pixel jitter applied this frame, in target pixels; `[0, 0]` without. */
  jitter: [number, number];
}

/** A frame's projection for depth-reading post passes: clip planes and the column-major matrix. */
export interface PostProjection {
  near: number;
  /** `Infinity` for an infinite far plane. */
  far: number;
  proj: Float32Array;
}

/**
 * The final stage: turns the HDR scene into swapchain pixels. See `@thunderclap/engine/post`.
 * `viewport` (ws/xr-post) asks for the result in that part of `output` only (texture px, so an
 * eye of a shared XR layer), loading the rest; without it the whole output is written. The
 * inputs may be smaller or larger than the last `resize`: a processor sizes itself to them.
 */
export interface PostProcessor {
  /**
   * The processor reads `PostInputs.view.jitter` and reprojects (TAA): the renderer then applies
   * each camera's `setJitter` offset to its projection. Without it no camera is ever jittered,
   * whatever `setJitter` was given, so existing pages never move.
   */
  wantsJitter?: boolean;
  resize(width: number, height: number): void;
  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void;
}

/** Arguments to `Renderer.createSpriteMaterial`. */
export interface SpriteMaterialOptions {
  /** The sprite texture (an atlas, a `Texture`, `defaultTextures(device).white`). */
  texture: TextureLike;
  /** Debug label. Default `'sprite'`. */
  label?: string;
  /** Default `'alpha'`. */
  blend?: MaterialDesc['blend'];
  /** Default `'linear-clamp'`; pixel art wants `'nearest-clamp'`. */
  sampler?: SamplerKind;
}

export interface RendererOptions {
  logicalWidth?: number;
  logicalHeight?: number;
  /** Initial instance capacity (grows by doubling). Default 4096. */
  initialInstances?: number;
  /** Aux attachments of the default `target` (`SceneTargetDesc.aux`); none by default. */
  aux?: SceneTargetAux;
}

export interface RendererGpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export interface RenderStats {
  drawCalls: number;
  /**
   * Triangles the scene passes asked the GPU for, summed over views: each draw's indices (or
   * vertices, non-indexed) / 3 × its instance count. Drawables and the shadow pass are not
   * counted (a drawable issues its own draws).
   */
  triangles: number;
  /** Instances the scene passes drew (`frame.mesh` / `sprite` draws and batch instances), summed over views. */
  instances: number;
  drawables: number;
  /** Batches (`frame.meshes`) and lists (`frame.list`) the scene passes drew, summed over views. */
  batches: number;
  /** Mesh draws skipped by frustum culling (`camera.cull`), summed over the frame's views. */
  culled: number;
  /**
   * Instances drawn into the sun's shadow map, summed over the frame's views: the opaque
   * casters inside the sun's box, whether or not the view's frustum sees them.
   */
  shadowDraws: number;
  /**
   * Scene render passes encoded this frame: one per view, two for a view that split at the
   * opaque/blended boundary for a `readsDepth` drawable (ws/render-hooks). Shadow and post
   * passes are not counted.
   */
  passes: number;
  /**
   * Instances drawn per LOD level (`frame.mesh` with a `MeshLod`, ws/render-5), summed over the
   * scene passes of the frame: `lodCounts[i]` drew level `i`. Grows to the longest chain drawn;
   * zeroed by `beginFrame`.
   */
  lodCounts: number[];
}

/** Options of `Renderer.textureFromSource`. */
export interface TextureFromSourceOptions {
  /** Store the bytes as `rgba8unorm` (no sRGB decode) for data maps. Default false (sRGB colour). */
  linear?: boolean;
  /** Allocate and fill the full mip chain. Default false (one level). */
  mips?: boolean;
  /** Texture label when the options object replaces the label argument. Default `'image'`. */
  label?: string;
}

/** A batched command list (`DrawCmd`s reused frame to frame) with its live length. */
interface CmdList {
  cmds: DrawCmd[];
  count: number;
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
  /**
   * Resolves once the first GPU sample has landed (`samples` > 0; immediately when one already
   * has), so a bench or demo can wait for a real `gpuMs` instead of polling. Set `timingEvery`
   * before (or right after) calling it: with timing off, no sample is ever taken. Resolves at
   * once when GPU timing is unsupported (a device with neither `timestamp-query` nor
   * `queue.onSubmittedWorkDone`) or the renderer is destroyed before a sample arrives.
   */
  ready(): Promise<void>;
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
  /** The instances cast the sun's shadow (see `DrawParams.castShadow`). */
  castShadow: boolean;
  /** Instance buffer of a retained list (`frame.list`); null: the shared buffer at this view's base. */
  buffer: GPUBuffer | null;
  /** The list's previous-matrix lane (vertex slot 2), when the pipeline reads one. */
  prevBuffer: GPUBuffer | null;
  /**
   * The instances' previous matrices are in the renderer's shared lane (`laneBuffer`, at this
   * view's base), copied from a batch's `prevMatrices` (ws/render-7).
   */
  lane: boolean;
  /** Index range (`InstanceParams.range`): `firstIndex`, `indexCount` (-1: the whole mesh). */
  firstIndex: number;
  indexCount: number;
}

/** Bytes per instance of the previous-matrix lane (a 3×4 matrix). */
const LANE_STRIDE = 48;

/** What `resolve`'s built-in present clears to when it covers the whole output. */
const PRESENT_CLEAR: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
/** Globals block (binding 0) floats: logicalSize, targetSize, time, dt, pad. */
const GLOBALS_FLOATS = 8;
/** The camera block (binding 1) starts at this float offset (256 bytes: uniform alignment). */
const CAMERA_OFFSET_FLOATS = 64;
/** The lighting block (binding 2) starts at this float offset (768 bytes, after the camera). */
const LIGHTS_OFFSET_FLOATS = CAMERA_OFFSET_FLOATS + CAMERA_BLOCK_FLOATS;
/** One upload covers all three blocks. */
const ENGINE_UNIFORM_FLOATS = LIGHTS_OFFSET_FLOATS + LIGHTS_BLOCK_FLOATS;

/** The engine uniforms (globals, camera and lights) and their bind group for one view of a frame. */
interface ViewSlot {
  buffer: GPUBuffer;
  group: GPUBindGroup;
}

/**
 * One view's LOD level memory (ws/render-6): the level each `frame.mesh` key (its `Transform`
 * or params object) drew last through this camera, and per batch or list the level of each
 * instance index. Kept per camera, so two eyes or two split-screen views each hold their own
 * hysteresis.
 */
interface LodMemory {
  keyed: WeakMap<object, number>;
  indexed: WeakMap<object, LodSlots>;
}

/**
 * One view's per-instance levels for a batch or list: `levels[i]` the level instance `i` drew
 * last (-1: none), `spare` the remap scratch, and `flush` the list's `flushCount` the levels
 * belong to (a keyed list remaps them through `previousIndex` at its next flush).
 */
interface LodSlots {
  levels: Int8Array;
  spare: Int8Array;
  flush: number;
}

/**
 * One view's object-motion memory for `frame.mesh` draws (ws/render-8): per `Transform`, the
 * world matrix it held at this camera's last view and the one before. `view` counts the
 * camera's views that drew with a velocity lane; a slot updated at `view - 1` is continuous.
 */
interface MotionMemory {
  view: number;
  slots: WeakMap<Transform, MotionSlot>;
}

/**
 * `prev`/`cur`: the transform's 3×4 world matrix at the view before `view` and at `view`.
 * `shared`: the transform was drawn with two different matrices in one view (a scratch
 * transform), so its draws report camera motion only.
 */
interface MotionSlot {
  prev: Float32Array;
  cur: Float32Array;
  view: number;
  shared: boolean;
}

/** The per-frame jitter hook of `Renderer.setJitter`: pixels `[x, y]` for frame `frame`. */
export type JitterFn = (frame: number) => readonly [number, number];

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
  /** World-space bounding sphere for frustum culling; `br` < 0 means never culled. */
  bx: number;
  by: number;
  bz: number;
  br: number;
  /** Drawn into the sun's shadow map (`DrawParams.castShadow`; default: not a 2D-layout mesh). */
  castShadow: boolean;
  /** Shadow sort keys (`Renderer.keyOf` of the mesh and the material), set by `buildShadowDraws`. */
  mk: number;
  tk: number;
  /** A `frame.meshes` batch or `frame.list` list; null for single instances and drawables. */
  batch: InstanceBatch | null;
  /** The list, when `batch` is one (drawn from its own buffer). */
  list: InstanceList | null;
  /** Mesh-space sphere a batch without `bounds` is culled by per instance; null: never. */
  mb: MeshBounds | null;
  /** Index range of the draw (`InstanceParams.range`); `rangeCount` -1: the whole mesh. */
  rangeFirst: number;
  rangeCount: number;
  /** The LOD chain `mesh` is picked from per view (`frame.mesh` with a `MeshLod`), else null. */
  lod: MeshLod | null;
  /** What the LOD hysteresis is keyed on: the draw's `Transform` or params object. */
  lodKey: object | null;
  /** The level picked for this view; -1 without a chain. */
  lodLevel: number;
  /**
   * A LOD batch's per-instance levels for this view (the view's memory for the batch, index
   * by index), set by `pickLods`; null for every other draw.
   */
  lodLevels: Int8Array | null;
  /** Scene sort keys grouping opaque LOD draws per (mesh, material); -1 for every other draw. */
  lk: number;
  lt: number;
  /**
   * A copied batch's previous matrices (`InstanceBatch.prevMatrices`, a LOD list's
   * `prevMatrices`), else null (ws/render-7).
   */
  prev: Float32Array | null;
  /** This view draws the batch with the shared previous-matrix lane (`buildDraws`). */
  lane: boolean;
  /**
   * A `frame.mesh` / `frame.sprite` draw's `Transform`, else null: its world matrix at the
   * view's previous frame feeds the lane (ws/render-8).
   */
  xf: Transform | null;
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
  /**
   * What the device can do beyond core WebGPU, read from its features at construction
   * (ws/render-5): `caps.compressed.bc` / `.etc2` / `.astc` are the block-compression families
   * `uploadKtx2` can upload. A device gets them only when created with them
   * (`compressionFeatures(adapter)` in `requiredFeatures`).
   */
  readonly caps: RendererCaps;
  readonly globalsLayout: GPUBindGroupLayout;
  /**
   * The engine uniforms of the frame's first view (`@group(0)`: globals, camera and lights
   * blocks, the sun's shadow map and its sampler). Replaced when the shadow map is (re)created.
   */
  globalsBindGroup: GPUBindGroup;
  readonly quad: Mesh;
  /**
   * @deprecated (E-036) Use `defaultTextures(renderer.device).white`, the same texture (1×1
   * sRGB white, the unbound-slot default). Removed next minor.
   */
  get white(): Texture {
    return defaultTextures(this.device).white;
  }
  /** Built-in sprite material bound to the default white texture (solid colour quads via tint). */
  readonly defaultSprite: Material;
  readonly stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    instances: 0,
    drawables: 0,
    batches: 0,
    culled: 0,
    shadowDraws: 0,
    passes: 0,
    lodCounts: [],
  };
  /**
   * The band around each LOD threshold an instance must cross before it changes level, as a
   * fraction of the threshold (default 0.1): see `pickLodLevel`. 0 turns it off.
   */
  lodHysteresis = DEFAULT_LOD_HYSTERESIS;
  /** See `FrameTiming`. Only updated while `timingEvery > 0`. */
  readonly timing: FrameTiming = {
    gpuMs: 0,
    source: 'queue',
    passes: {},
    cpuMs: 0,
    samples: 0,
    ready: () => this.timingReady(),
  };
  /** Resolvers of `timing.ready()` promises waiting on the first GPU sample. */
  private readonly readyWaiters: (() => void)[] = [];
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
  /** The sun's shadow map and its pipelines (see `shadow.ts`). */
  private readonly shadow: ShadowMap;
  /** Engine uniform slots for the shadow passes of a frame (the sun camera in the camera block). */
  private readonly shadowSlots: ViewSlot[] = [];
  private shadowCount = 0;
  private readonly shadowRect: CameraRect = { x: 0, y: 0, width: 1, height: 1 };
  private readonly globalsData = new Float32Array(ENGINE_UNIFORM_FLOATS);
  private readonly globalsU32 = new Uint32Array(this.globalsData.buffer);
  private readonly viewRect: CameraRect = { x: 0, y: 0, width: 1, height: 1 };
  /** Targets rendered into so far this frame, and whether their depth was cleared. */
  private readonly usedTargets: SceneTarget[] = [];
  private readonly usedDepth: boolean[] = [];
  /** The last depth camera into each used target (ws/post-depth: `PostInputs.projection`). */
  private readonly usedCamera: Camera[] = [];
  /** The target `buildDraws` is building for (its aux set keys the pipelines). */
  private drawTarget: SceneTarget | null = null;
  private readonly postProjection: PostProjection = { near: 0, far: 0, proj: new Float32Array(16) };
  /** `PostInputs.view` storage, one per inputs object (`postInputs`, `resolveInputs`). */
  private readonly postView: PostView = newPostView();
  private readonly resolveView: PostView = newPostView();
  private usedCount = 0;
  private instanceData: Float32Array;
  private instanceBuffer: GPUBuffer;
  /** Byte offset in `instanceBuffer` where the next view's instances go. */
  private instanceBase = 0;
  /** Instance buffers outgrown this frame, destroyed after submit (passes still reference them). */
  private readonly retired: GPUBuffer[] = [];
  /**
   * The shared previous-matrix lane (ws/render-7): 12 floats per instance, indexed like the
   * view's upload, for batches with `prevMatrices` drawn into a velocity target by an aux
   * material. Made on first use; `laneBase` is the current view's byte offset in it.
   */
  private laneData = new Float32Array(0);
  private laneBuffer: GPUBuffer | null = null;
  private laneBase = 0;
  /** The previous matrices `copyBatch` / `copyBatchLod` copy into `laneData`, else null. */
  private laneSrc: Float32Array | null = null;
  /** Batch records with `prev` this frame, and whether the current view drew one with the lane. */
  private laneRecs = 0;
  private laneUsed = false;
  private instanceCount = 0;
  /** Instances in this frame's batches (`pushBatch`), excluding lists; they take the sort path. */
  private batchInstances = 0;
  /** Batch records this frame (lists included). */
  private batchRecs = 0;
  /** Records with a LOD chain this frame. */
  private lodRecs = 0;
  /** The camera `pickLods` is picking for. */
  private lodCam: Camera | null = null;
  /** The LOD level memory of each camera (view) that drew a LOD record. */
  private readonly lodMemory = new WeakMap<Camera, LodMemory>();
  /** Per camera: each single draw's Transform history for the velocity lane (ws/render-8). */
  private readonly motionMemory = new WeakMap<Camera, MotionMemory>();
  /** Per-instance level scratch of `copyBatchLod` (-1: culled). */
  private lodScratch = new Int8Array(256);
  /** `copyBatchLod`'s buckets: first instance, count and write cursor per level. */
  private bucketFirst = new Int32Array(8);
  private bucketCount = new Int32Array(8);
  private bucketAt = new Int32Array(8);
  /** `setJitter`'s hook, the frames it has run and this frame's offset. */
  private jitterFn: JitterFn | null = null;
  private jitterFrame = 0;
  private jitterX = 0;
  private jitterY = 0;
  /** Cameras the hook has jittered (cleared when it is removed). */
  private readonly jitterCams: Camera[] = [];
  /** Batch or list draws of the current view's scene pass, and instances `copyBatch` dropped. */
  private sceneBatches = 0;
  private batchCulled = 0;
  /** Instances of the lists the current view's scene pass draws (not in the upload). */
  private sceneListInstances = 0;
  /** This view's scene commands (`buildDraws`). */
  private readonly scene: CmdList = { cmds: [], count: 0 };
  /** This view's shadow-pass commands (`buildShadowDraws`): opaque casters inside the sun box. */
  private readonly shadowCmds: CmdList = { cmds: [], count: 0 };
  private readonly recs: DrawRec[] = [];
  private recCount = 0;
  /** True while every draw this frame had `order` >= the previous draw's. */
  private ordered = true;
  private lastOrder = Number.NEGATIVE_INFINITY;
  private sortIdx = new Uint32Array(256);
  private sortTmp = new Uint32Array(256);
  private sortDepth = false;
  /** Record indices of the shadow list, sorted by mesh then material (`sortShadow`). */
  private shadowIdx = new Uint32Array(256);
  private shadowTmp = new Uint32Array(256);
  /** True while `sortDraws` orders the shadow list (mesh, material, index) instead of the scene. */
  private sortShadow = false;
  /** Stable numeric keys for meshes and materials, for the shadow sort; grows per new object. */
  private readonly keys = new WeakMap<object, number>();
  private nextKey = 0;
  /** Instance data in draw order, used when sorting or layer culling reorders draws. */
  private sortedData = new Float32Array(0);
  /** The array `endFrame` uploads: `instanceData` (submission order) or `sortedData`. */
  private uploadData: Float32Array;
  /** Instances `render` uploads for this view: the scene's, then the shadow list's copies. */
  private uploadCount = 0;
  /** Instances the scene pass draws this view (layer- and frustum-culled draws excluded). */
  private sceneCount = 0;
  /** Draws the last `buildDraws` dropped by the frustum test. */
  private culledCount = 0;
  private readonly prePasses: ((encoder: GPUCommandEncoder) => void)[] = [];
  private readonly prepared = new Set<Drawable>();
  /**
   * Where the last `buildDraws` would split the scene commands for a `readsDepth` drawable:
   * the index of the first blended command at or above the lowest hooked order; -1 when no
   * visible drawable asked (or the camera has no depth test).
   */
  private splitAt = -1;
  /** Drawables whose `afterOpaque` ran for the current view (once each). */
  private readonly hooked = new Set<Drawable>();
  /** The `ViewInfo` handed to `afterOpaque`, reused across views. */
  private readonly viewInfo: ViewInfo = {
    camera: undefined as unknown as Camera,
    target: undefined as unknown as SceneTarget,
    depthCopy: undefined as unknown as GPUTexture,
    depthView: undefined as unknown as GPUTextureView,
    viewport: { x: 0, y: 0, width: 0, height: 0 },
  };
  /** Per-draw uniform sets with blocks staged this frame. */
  private readonly drawUniformSets: BindingSet[] = [];
  private readonly dynamicOffsets = [0];
  private readonly frame: Frame;
  private readonly present: FullscreenPass;
  private presentGroup: GPUBindGroup | null = null;
  private readonly postInputs: PostInputs;
  /** `resolve` (ws/xr-post): inputs for an explicit target and the present group cached for it. */
  private readonly resolveInputs: PostInputs;
  private resolveTarget: SceneTarget | null = null;
  private resolveColor: GPUTextureView | null = null;
  private resolveGroup: GPUBindGroup | null = null;
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
    this.caps = rendererCaps(device);
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
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          sampler: { type: 'comparison' },
        },
      ],
    });
    this.shadow = new ShadowMap(device, this.globalsLayout);
    this.globalsBindGroup = this.viewSlot(0).group;

    const cap = opts.initialInstances ?? 4096;
    this.instanceData = new Float32Array(cap * INSTANCE_FLOATS);
    this.uploadData = this.instanceData;
    this.instanceBuffer = this.makeInstanceBuffer(cap);

    this.quad = new Mesh(device, { label: 'quad', ...quadGeometry() });
    this.defaultSprite = this.createSpriteMaterial({
      texture: defaultTextures(device).white,
      label: 'sprite-default',
    });

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
    this.target = new SceneTarget(device, { width: 1, height: 1, aux: opts.aux });
    this.postInputs = {
      color: this.target.color,
      emissive: this.target.emissive,
      time: 0,
      dt: 0,
      depth: null,
      projection: null,
      view: null,
      roughMetal: null,
      velocity: null,
    };
    this.resolveInputs = { ...this.postInputs };
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
    this.postInputs.roughMetal = this.target.roughMetal;
    this.postInputs.velocity = this.target.velocity;
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
      defaultTextures(this.device).white.view,
    );
  }

  /**
   * The built-in textured sprite material (`texture × vertex colour × tint`; emissive is the
   * colour × `emissive`): `createSpriteMaterial({ texture, label, blend, sampler })`, the same
   * option-object shape as `createMaterial`. `label` defaults to `'sprite'`, `blend` to
   * `'alpha'` and `sampler` to `'linear-clamp'`.
   */
  createSpriteMaterial(opts: SpriteMaterialOptions): Material;
  /**
   * @deprecated (ws/api-render) Positional form; pass one `SpriteMaterialOptions` object
   * (`{ texture, label, blend, sampler }`). Removed next minor.
   */
  createSpriteMaterial(
    texture: TextureLike,
    label?: string,
    opts?: { blend?: MaterialDesc['blend']; sampler?: SamplerKind },
  ): Material;
  createSpriteMaterial(
    a: SpriteMaterialOptions | TextureLike,
    label?: string,
    opts: { blend?: MaterialDesc['blend']; sampler?: SamplerKind } = {},
  ): Material {
    // A texture always has a `view`; the options object never does.
    const o: SpriteMaterialOptions =
      'view' in a ? { texture: a, label, blend: opts.blend, sampler: opts.sampler } : a;
    const m = this.createMaterial({
      label: o.label ?? 'sprite',
      wgsl: SPRITE_WGSL,
      textures: 1,
      blend: o.blend,
      sampler: o.sampler,
    });
    m.setTexture(0, o.texture);
    return m;
  }

  createMesh(desc: MeshDesc): Mesh {
    return new Mesh(this.device, desc);
  }

  /**
   * Upload a LOD chain (ws/api-render): one mesh per `geometries` entry, labelled
   * `<label>-lod<i>`, returned with the thresholds and the geometries as a `MeshLod` that
   * `frame.mesh` takes in place of a mesh. geom's `createLodChain(g, ratios)` builds the
   * geometries (level 0 is `g`, so `ratios.length + 1` levels and `ratios.length` thresholds).
   * Throws on an empty chain or more thresholds than levels.
   */
  createMeshLod(desc: MeshLodDesc): MeshLodChain {
    const n = desc.geometries.length;
    if (n === 0) throw new Error('createMeshLod: the chain has no geometries');
    if (desc.thresholdsPx.length > n) {
      throw new Error(
        `createMeshLod: ${desc.thresholdsPx.length} thresholds for ${n} levels (at most one per level)`,
      );
    }
    const label = desc.label ?? 'lod';
    const meshes = desc.geometries.map((g, i) =>
      this.createMesh({ ...g, label: `${label}-lod${i}` }),
    );
    return { meshes, thresholdsPx: [...desc.thresholdsPx], geometries: desc.geometries };
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
      defaultTextures(this.device).white.view,
    );
  }

  /**
   * Upload an image/canvas/ImageData. By default it is an sRGB colour texture (sampled as
   * linear). Pass `{ linear: true }` for data (masks, normals, lookup tables): the bytes are
   * stored as `rgba8unorm` and sampled exactly as written, with no sRGB decode. `{ mips: true }`
   * allocates the full mip chain and fills it on the GPU (`generateMipmaps`), the same as
   * `loadTexture`; the default is one level. The options object may replace the label
   * (`textureFromSource(src, { mips: true })`), or follow it.
   */
  textureFromSource(
    source: TextureSource,
    label: string | TextureFromSourceOptions = 'image',
    opts: TextureFromSourceOptions = {},
  ): Texture {
    if (typeof label !== 'string') {
      opts = label;
      label = opts.label ?? 'image';
    }
    return loadTexture(this.device, source, {
      label,
      format: opts.linear ? 'rgba8unorm' : 'rgba8unorm-srgb',
      mips: opts.mips ?? false,
    });
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

  /**
   * The renderer's jitter hook (ws/render-6): `fn(frame)` runs once per `beginFrame` (`frame`
   * counts from 0 since the hook was set) and its `[x, y]` (target pixels, +x right, +y down)
   * goes to every camera `render` draws this frame, XR eyes included, through
   * `camera.setJitter`, with the jitter target set per view as when the post processor
   * `wantsJitter`. The renderer keeps each camera's history (`recordHistory`), so
   * `previousViewProj` and `previousView` stay unjittered. `null` removes the hook and clears
   * the jitter of every camera it reached. Without a hook `Camera.setJitter` works as before.
   * Return a reused tuple to keep the frame allocation-free.
   */
  setJitter(fn: JitterFn | null): void {
    if (fn === this.jitterFn) return;
    this.jitterFn = fn;
    this.jitterFrame = 0;
    this.jitterX = 0;
    this.jitterY = 0;
    if (fn) return;
    for (const c of this.jitterCams) c.clearJitter();
    this.jitterCams.length = 0;
  }

  /**
   * The jitter hook installed by `setJitter`, or null when none is (ws/render-8). Read-only:
   * compare it by identity, so a post stack can check whether the renderer still holds the
   * hook it installed (`renderer.jitter === myHook`) before clearing it, and leave another
   * owner's hook alone.
   */
  get jitter(): JitterFn | null {
    return this.jitterFn;
  }

  /**
   * The LOD level instance `index` of a LOD batch or list (`frame.meshes` / `frame.list` on a
   * `MeshLod`) drew at for `camera` (default `this.camera`) in the last frame that drew it,
   * or -1 when it has none (ws/render-7). For probes and debug overlays: it reads the view's
   * level memory, which a keyed `InstanceList` carries by key across flushes.
   */
  lodLevelOf(batch: object, index: number, camera: Camera = this.camera): number {
    const slots = this.lodMemory.get(camera)?.indexed.get(batch);
    if (!slots || index < 0 || index >= slots.levels.length) return -1;
    return slots.levels[index]!;
  }

  /** Start recording a frame. `time`/`dt` in seconds are exposed to shaders via `globals`. */
  beginFrame(time: number, dt: number): Frame {
    if (this.inFrame) throw new Error('beginFrame called twice without endFrame');
    this.inFrame = true;
    if (this.timingEvery > 0) this.frameStart = performance.now();
    this.instanceCount = 0;
    this.batchInstances = 0;
    this.batchRecs = 0;
    this.lodRecs = 0;
    this.laneRecs = 0;
    this.scene.count = 0;
    this.shadowCmds.count = 0;
    this.recCount = 0;
    this.ordered = true;
    this.lastOrder = Number.NEGATIVE_INFINITY;
    this.prePasses.length = 0;
    this.prepared.clear();
    for (const b of this.drawUniformSets) b.discardDrawUniforms();
    this.drawUniformSets.length = 0;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.instances = 0;
    this.stats.drawables = 0;
    this.stats.batches = 0;
    this.stats.culled = 0;
    this.stats.shadowDraws = 0;
    this.stats.passes = 0;
    const lc = this.stats.lodCounts;
    for (let i = 0; i < lc.length; i++) lc[i] = 0;
    const jf = this.jitterFn;
    if (jf) {
      const j = jf(this.jitterFrame++);
      this.jitterX = j[0];
      this.jitterY = j[1];
    }
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

    // History first, before anything reads the camera: last frame's matrices are what the
    // camera held at its previous view. Jitter applies only when the post stack asks for it.
    camera.recordHistory();
    if (this.jitterFn) {
      camera.setJitter(this.jitterX, this.jitterY);
      if (!this.jitterCams.includes(camera)) this.jitterCams.push(camera);
    }
    if (this.jitterFn || this.post?.wantsJitter) camera.setJitterTarget(vp.width, vp.height);
    else camera.setJitterTarget(0, 0);

    // The sun box is placed before the draw lists are built: the shadow list culls against it.
    const shadowCfg = frame.lights.sun.shadow;
    if (shadowCfg) {
      const size = shadowCfg.size ?? DEFAULT_SHADOW_SIZE;
      this.shadow.place(camera.position, frame.lights.sun.direction, shadowCfg, size);
    }
    const depth = this.buildDraws(camera, target);
    this.stats.culled += this.culledCount;
    const scene = this.scene;
    for (let i = 0; i < scene.count; i++) {
      const d = scene.cmds[i]!.drawable;
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
    if (this.laneUsed) this.uploadLane(base);

    const shadow = this.encodeShadow(enc, frame, camera, base);
    const slot = this.viewSlot(this.viewCount);
    this.writeView(frame, camera, target, slot, shadow);
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
    target.setAuxLoadOp(first ? 'clear' : 'load');
    this.usedCamera[used] = camera;
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

    // A view with a `readsDepth` drawable splits here: opaque draws, a copy of the depth
    // attachment, the drawables' `afterOpaque`, then the blended draws loading everything.
    const split = depth && this.splitAt >= 0 && target.canCopyDepth ? this.splitAt : -1;
    const pass = enc.beginRenderPass(desc);
    this.setViewRect(pass, vp, full);
    pass.setBindGroup(0, slot.group);
    this.encodeDraws(pass, frame, slot, base, 0, split >= 0 ? split : scene.count);
    pass.end();
    this.stats.passes++;
    if (split >= 0) {
      const copy = target.copyDepth(enc)!;
      const info = this.viewInfo;
      info.camera = camera;
      info.target = target;
      info.depthCopy = copy.texture;
      info.depthView = copy.view;
      info.viewport.x = vp.x;
      info.viewport.y = vp.y;
      info.viewport.width = vp.width;
      info.viewport.height = vp.height;
      const hooked = this.hooked;
      hooked.clear();
      for (let i = split; i < scene.count; i++) {
        const d = scene.cmds[i]!.drawable;
        if (d?.readsDepth && d.afterOpaque && !hooked.has(d)) {
          hooked.add(d);
          d.afterOpaque(enc, info);
        }
      }
      const blendDesc = target.blendPassDesc;
      blendDesc.timestampWrites = timer?.pass('scene-blend');
      const blend = enc.beginRenderPass(blendDesc);
      this.setViewRect(blend, vp, full);
      blend.setBindGroup(0, slot.group);
      this.encodeDraws(blend, frame, slot, base, split, scene.count);
      blend.end();
      this.stats.passes++;
    }
    this.stats.instances += this.sceneCount + this.sceneListInstances;
    this.stats.batches += this.sceneBatches;
  }

  /** Viewport and scissor of a view that does not cover its target. */
  private setViewRect(pass: GPURenderPassEncoder, vp: CameraRect, full: boolean): void {
    if (full) return;
    pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
    pass.setScissorRect(
      Math.floor(vp.x),
      Math.floor(vp.y),
      Math.ceil(vp.width),
      Math.ceil(vp.height),
    );
  }

  /**
   * Encode scene commands `[from, to)` into `pass` (group 0 already bound to `slot.group`),
   * counting draw calls and drawables into `stats`.
   */
  private encodeDraws(
    pass: GPURenderPassEncoder,
    frame: Frame,
    slot: ViewSlot,
    base: number,
    from: number,
    to: number,
  ): void {
    const scene = this.scene;
    let curPipeline: GPURenderPipeline | null = null;
    let curMaterial: Material | null = null;
    let curOffset = -1;
    let curMesh: Mesh | null = null;
    let curBuffer: GPUBuffer | null = null;
    let curPrev: GPUBuffer | null = null;
    let drawCalls = 0;
    let triangles = 0;
    let drawables = 0;
    for (let i = from; i < to; i++) {
      const c = scene.cmds[i]!;
      if (c.drawable) {
        c.drawable.draw(pass, frame);
        drawables++;
        curPipeline = null;
        curMaterial = null;
        curOffset = -1;
        curMesh = null;
        curBuffer = null;
        curPrev = null;
        pass.setBindGroup(0, slot.group);
        continue;
      }
      const m = c.material!;
      const mesh = c.mesh!;
      if (c.pipeline !== curPipeline) {
        pass.setPipeline(c.pipeline!);
        curPipeline = c.pipeline;
      }
      if (c.lane) {
        const lane = this.laneBuffer!;
        if (lane !== curPrev) {
          pass.setVertexBuffer(2, lane, this.laneBase);
          curPrev = lane;
        }
      } else if (c.prevBuffer && c.prevBuffer !== curPrev) {
        pass.setVertexBuffer(2, c.prevBuffer, 0);
        curPrev = c.prevBuffer;
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
      if (mesh !== curMesh || c.buffer !== curBuffer) {
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        if (c.buffer) pass.setVertexBuffer(1, c.buffer, 0);
        else pass.setVertexBuffer(1, this.instanceBuffer, base);
        if (mesh.indexBuffer) pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
        curMesh = mesh;
        curBuffer = c.buffer;
      }
      if (mesh.indexBuffer) {
        // An indexed mesh with no indices (e.g. a streamed chunk that is empty) draws nothing.
        const indices = c.indexCount >= 0 ? c.indexCount : mesh.indexCount;
        if (indices === 0) continue;
        pass.drawIndexed(indices, c.count, c.firstIndex, 0, c.first);
        triangles += ((indices / 3) | 0) * c.count;
      } else {
        pass.draw(mesh.vertexCount, c.count, 0, c.first);
        triangles += ((mesh.vertexCount / 3) | 0) * c.count;
      }
      drawCalls++;
    }
    this.stats.drawCalls += drawCalls;
    this.stats.triangles += triangles;
    this.stats.drawables += drawables;
  }

  /**
   * Run the post stack (or the built-in present) from `target` into `out` now, inside the frame
   * (ws/xr-post): what `endFrame` does from `renderer.target` to the swapchain, for any target
   * and any output. `viewport` confines the result to that part of `out` (texture px) and loads
   * the rest, so two eyes resolve into one XR layer texture one after the other. The target is
   * consumed: the next `render` into it this frame clears it again, so one HDR target serves
   * every eye in turn. Needs a `render` before it this frame (the encoder is open then).
   */
  resolve(target: SceneTarget, out: GPUTextureView, viewport?: SceneTargetViewport): void {
    if (!this.inFrame) throw new Error('resolve outside beginFrame/endFrame');
    if (this.destroyed) return;
    const enc = this.encoder;
    if (!enc) throw new Error('resolve before any render this frame');
    if (this.post) {
      const inputs = this.resolveInputs;
      inputs.color = target.color;
      inputs.emissive = target.emissive;
      inputs.time = this.frame.time;
      inputs.dt = this.frame.dt;
      this.fillDepthInputs(inputs, target);
      this.post.encode(enc, inputs, out, viewport);
    } else {
      if (
        !this.resolveGroup ||
        this.resolveTarget !== target ||
        this.resolveColor !== target.color.view
      ) {
        this.resolveTarget = target;
        this.resolveColor = target.color.view;
        this.resolveGroup = this.present.createBindGroup([target.color.view, target.emissive.view]);
      }
      this.present.encode(enc, out, {
        bindGroup: this.resolveGroup,
        clear: viewport ? null : PRESENT_CLEAR,
        viewport,
      });
    }
    // Consumed: forget the target so its next view this frame clears colour and depth.
    for (let i = 0; i < this.usedCount; i++) {
      if (this.usedTargets[i] === target) {
        const last = --this.usedCount;
        this.usedTargets[i] = this.usedTargets[last]!;
        this.usedDepth[i] = this.usedDepth[last]!;
        this.usedCamera[i] = this.usedCamera[last]!;
        break;
      }
    }
  }

  /**
   * `PostInputs.depth` / `projection` (ws/post-depth): the target's depth and the last depth
   * camera's projection when one rendered into it this frame, else `null`. No allocation.
   */
  private fillDepthInputs(inputs: PostInputs, target: SceneTarget): void {
    inputs.depth = null;
    inputs.projection = null;
    inputs.view = null;
    inputs.roughMetal = target.roughMetal;
    inputs.velocity = target.velocity;
    for (let i = 0; i < this.usedCount; i++) {
      if (this.usedTargets[i] !== target) continue;
      const cam = this.usedCamera[i]!;
      const view = inputs === this.postInputs ? this.postView : this.resolveView;
      view.viewProj.set(cam.viewProjection);
      view.invViewProj.set(cam.invViewProj);
      view.previousViewProj.set(cam.previousViewProj);
      view.previousView.set(cam.previousView);
      cam.getJitter(view.jitter);
      inputs.view = view;
      if (!this.usedDepth[i]) return;
      const depth = target.depth;
      if (!depth) return;
      const p = this.postProjection;
      p.proj.set(this.usedCamera[i]!.projection);
      // near = p14 / p10 for both kinds; far = p14 / (p10 + 1) for perspective (∞ when
      // p10 = -1), (p14 - 1) / p10 for an orthographic matrix (p11 = 0).
      const p10 = p.proj[10]!;
      const p14 = p.proj[14]!;
      p.near = p14 / p10;
      if (p.proj[11] === 0) {
        p.far = (p14 - 1) / p10;
      } else {
        const k = p10 + 1;
        p.far = Math.abs(k) < 1e-7 ? Number.POSITIVE_INFINITY : p14 / k;
      }
      inputs.depth = depth;
      inputs.projection = p;
      return;
    }
  }

  /**
   * Finish the frame: `render(frame, renderer.camera)` when nothing rendered yet, then the
   * post stack (or the built-in present) from `renderer.target` to the swapchain, and submit.
   * `{ present: false }` skips the post stack and the swapchain (no `getCurrentTexture`): the
   * frame's views went to their own targets, as an XR session's eyes do (ws/xr), resolved into
   * the layer with `resolve` (ws/xr-post).
   */
  endFrame(opts?: { present?: boolean }): void {
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

    if (opts?.present !== false) {
      const out = this.context.getCurrentTexture().createView();
      if (this.post) {
        const inputs = this.postInputs;
        inputs.time = this.frame.time;
        inputs.dt = this.frame.dt;
        this.fillDepthInputs(inputs, this.target);
        this.post.encode(enc, inputs, out);
      } else {
        this.present.encode(enc, out, {
          bindGroup: this.presentGroup!,
          clear: { r: 0, g: 0, b: 0, a: 1 },
        });
      }
    }
    timer?.resolve(enc);
    this.device.queue.submit([enc.finish()]);
    this.viewCount = 0;
    this.shadowCount = 0;
    this.usedCount = 0;
    this.instanceBase = 0;
    this.shadow.flush();
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
    this.resolveReady();
  }

  /** `timing.ready()`: a settled promise once a sample exists, else one kept until the first. */
  private timingReady(): Promise<void> {
    // Unsupported: no timer and no `onSubmittedWorkDone` (a stub device); nothing ever samples.
    const unsupported =
      !this.gpuTimer && typeof this.device.queue.onSubmittedWorkDone !== 'function';
    if (this.timing.samples > 0 || this.destroyed || unsupported) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
    });
  }

  private resolveReady(): void {
    if (this.readyWaiters.length === 0) return;
    for (const fn of this.readyWaiters) fn();
    this.readyWaiters.length = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.resolveReady();
    this.gpuTimer?.destroy();
    this.target.destroy();
    this.instanceBuffer.destroy();
    this.laneBuffer?.destroy();
    this.laneBuffer = null;
    for (const b of this.retired) b.destroy();
    this.retired.length = 0;
    for (const v of this.views) v.buffer.destroy();
    this.views.length = 0;
    for (const v of this.shadowSlots) v.buffer.destroy();
    this.shadowSlots.length = 0;
    this.shadow.destroy();
    this.quad.destroy();
    // `white` belongs to the device's `defaultTextures` registry and outlives the renderer.
  }

  // ---------------------------------------------------------------- FrameSink

  pushInstance(
    material: Material,
    mesh: Mesh,
    tr: Transform | null,
    p: DrawParams | InstanceParams,
    bounds: MeshBounds | null,
    lod: MeshLod | null = null,
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
    d[o++] = packInstanceFlags(p.receiveShadow !== false, p.layers ?? 1); // flags: bit 0 = no shadow, bits 1.. = layers
    d[o++] = sx;
    d[o] = sy;

    const r = this.nextRec(p.order ?? 0, p.layers ?? 1);
    r.material = material;
    r.mesh = mesh;
    r.drawable = null;
    r.offset = offset;
    r.inst = idx;
    if (tr) {
      r.xf = tr;
      // Only an aux material can write object motion: the lane is built for those alone.
      if (material.aux) this.laneRecs++;
    }
    if (bounds && bounds.radius !== Number.POSITIVE_INFINITY) {
      // The sphere through the 3×4 instance matrix: centre by the matrix, radius by the largest
      // axis scale (column length), which bounds any rotation and non-uniform scale.
      const m = idx * INSTANCE_FLOATS;
      const c = bounds.center;
      const cx = c[0];
      const cy = c[1];
      const cz = c[2];
      r.bx = d[m]! * cx + d[m + 1]! * cy + d[m + 2]! * cz + d[m + 3]!;
      r.by = d[m + 4]! * cx + d[m + 5]! * cy + d[m + 6]! * cz + d[m + 7]!;
      r.bz = d[m + 8]! * cx + d[m + 9]! * cy + d[m + 10]! * cz + d[m + 11]!;
      const s0 = d[m]! * d[m]! + d[m + 4]! * d[m + 4]! + d[m + 8]! * d[m + 8]!;
      const s1 = d[m + 1]! * d[m + 1]! + d[m + 5]! * d[m + 5]! + d[m + 9]! * d[m + 9]!;
      const s2 = d[m + 2]! * d[m + 2]! + d[m + 6]! * d[m + 6]! + d[m + 10]! * d[m + 10]!;
      r.br = bounds.radius * Math.sqrt(Math.max(s0, s1, s2));
    } else {
      r.br = -1;
    }
    r.castShadow = p.castShadow ?? mesh.layout !== VERTEX_LAYOUT_2D;
    const range = p.range;
    if (range) {
      r.rangeFirst = range.first;
      r.rangeCount = range.count;
    }
    if (lod) {
      r.lod = lod;
      r.lodKey = tr ?? p;
      this.lodRecs++;
    }
  }

  pushBatch(
    material: Material,
    mesh: Mesh,
    batch: InstanceBatch,
    bounds: MeshBounds | null,
    list: InstanceList | null,
    lod: MeshLod | null = null,
  ): void {
    if (material.bindings?.perDraw) {
      throw new Error(`material ${material.label}: a batch cannot use perDrawUniforms`);
    }
    if (list) list.flush(this.device.queue);
    // A LOD list is copied into the upload bucketed per level, like a batch.
    if (!list || lod) this.batchInstances += batch.count;
    this.batchRecs++;
    const r = this.nextRec(batch.order ?? 0, batch.layerBits ?? 1);
    r.material = material;
    r.mesh = mesh;
    r.drawable = null;
    r.offset = -1;
    r.inst = -1;
    r.batch = batch;
    r.list = lod ? null : list;
    if (lod) {
      r.lod = lod;
      this.lodRecs++;
    }
    // A copied batch (not a list drawn from its own buffer) brings its previous matrices.
    const prev = !r.list ? (batch.prevMatrices ?? null) : null;
    if (prev) {
      if (prev.length < batch.count * MATRIX3X4_FLOATS) {
        throw new Error(
          `frame.meshes: prevMatrices holds ${prev.length} floats for ${batch.count} instances`,
        );
      }
      r.prev = prev;
      this.laneRecs++;
    }
    const bb = batch.bounds;
    if (bb) {
      r.bx = bb.center[0];
      r.by = bb.center[1];
      r.bz = bb.center[2];
      r.br = bb.radius;
      r.mb = null;
    } else {
      r.br = -1;
      r.mb = bounds && bounds.radius !== Number.POSITIVE_INFINITY ? bounds : null;
    }
    // A LOD list is copied per instance anyway, so its instances are culled one by one too.
    if (lod && list) {
      const lb = lod.meshes[0]!.bounds;
      r.mb = lb.radius !== Number.POSITIVE_INFINITY ? lb : null;
    }
    r.castShadow = batch.castShadow ?? mesh.layout !== VERTEX_LAYOUT_2D;
  }

  /**
   * A retained `InstanceList` of up to `capacity` instances of `mesh` with `material`, drawn
   * with `frame.list(list)`. Owns a GPU buffer; `list.destroy()` releases it. A `MeshLod`
   * (ws/render-6) makes a list whose instances pick their level per view.
   */
  createInstanceList(
    mesh: Mesh | MeshLod,
    material: Material,
    capacity: number,
    opts?: InstanceListOptions,
  ): InstanceList {
    if (material.bindings?.perDraw) {
      throw new Error(`material ${material.label}: an InstanceList cannot use perDrawUniforms`);
    }
    return new InstanceList(this.device, mesh, material, capacity, opts);
  }

  pushDrawable(d: Drawable, order: number, layers: number): void {
    const r = this.nextRec(order, layers);
    r.material = null;
    r.mesh = null;
    r.drawable = d;
    r.offset = -1;
    r.inst = -1;
    r.br = -1;
    r.castShadow = false;
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
        bx: 0,
        by: 0,
        bz: 0,
        br: -1,
        castShadow: false,
        mk: 0,
        tk: 0,
        batch: null,
        list: null,
        mb: null,
        rangeFirst: 0,
        rangeCount: -1,
        lod: null,
        lodKey: null,
        lodLevel: -1,
        lodLevels: null,
        lk: -1,
        lt: -1,
        prev: null,
        lane: false,
        xf: null,
      });
    }
    const r = this.recs[this.recCount++]!;
    r.prev = null;
    r.lane = false;
    r.xf = null;
    r.lod = null;
    r.lodKey = null;
    r.lodLevel = -1;
    r.lodLevels = null;
    r.lk = -1;
    r.lt = -1;
    r.batch = null;
    r.list = null;
    r.mb = null;
    r.rangeFirst = 0;
    r.rangeCount = -1;
    r.order = order;
    r.layers = layers;
    return r;
  }

  /**
   * Turn this frame's draw records into batched commands. Draws whose `layers` miss the
   * camera's mask are dropped; with `camera.cull`, so are mesh draws whose world bounding
   * sphere lies outside any plane of `camera.frustum` (counted in `culledCount`). Without
   * depth or culling, draws sort by `order` then submission index; when every `order` is
   * already non-decreasing (the default) nothing moves and the instance data uploads as
   * recorded. With `camera.depthTest`, the keys are `order`, then opaque before blended, then
   * depth (opaque front-to-back, blended back-to-front), then submission index. Sets
   * `uploadData` / `uploadCount`; returns whether depth is on. With `frame.lights.sun.shadow`
   * set, `buildShadowDraws` then appends the shadow list's instances to the same upload.
   */
  private buildDraws(cam: Camera, target: SceneTarget): boolean {
    this.drawTarget = target;
    const camLayers = cam.layers >>> 0;
    const depth = cam.depthTest;
    const depthWrite = cam.depthWrite;
    const cull = cam.cull;
    const shadowCfg = this.frame.lights.sun.shadow;
    this.frame.depthFormat = depth ? DEPTH_FORMAT : null;
    const recs = this.recs;
    const n = this.recCount;
    this.scene.count = 0;
    this.shadowCmds.count = 0;
    this.culledCount = 0;
    this.splitAt = -1;

    let visible = n;
    if (camLayers !== ALL_LAYERS) {
      visible = 0;
      for (let i = 0; i < n; i++) if ((recs[i]!.layers & camLayers) !== 0) visible++;
    }
    this.sceneBatches = 0;
    this.sceneListInstances = 0;
    const lods = this.lodRecs > 0;
    if (lods) this.pickLods(cam);
    if (
      !depth &&
      !cull &&
      !lods &&
      this.ordered &&
      visible === n &&
      !shadowCfg &&
      this.batchRecs === 0 &&
      this.laneRecs === 0
    ) {
      for (let i = 0; i < n; i++) {
        const r = recs[i]!;
        this.batch(this.scene, r, r.drawable ? null : this.scenePipeline(r, 0), r.inst);
      }
      this.uploadData = this.instanceData;
      this.uploadCount = this.sceneCount = this.instanceCount;
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
    const planes = cull ? cam.frustum : null;
    let culled = 0;
    let k = 0;
    // The lowest `order` of a visible drawable that reads depth: the view splits before the
    // first blended draw of that order (ws/render-hooks).
    let hookOrder = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const r = recs[i]!;
      if ((r.layers & camLayers) === 0) continue;
      if (planes && r.br >= 0 && outside(planes, r.bx, r.by, r.bz, r.br)) {
        // A batch with bounds is culled as one: all its instances count.
        culled += r.batch ? r.batch.count : 1;
        continue;
      }
      idx[k++] = i;
      if (r.lod && !r.batch) this.countLod(r.lodLevel, 1);
      if (!depth) continue;
      if (r.drawable) {
        // No position: sorts as the nearest blended draw of its order (drawn after the rest).
        r.group = 1;
        r.dist = Number.NEGATIVE_INFINITY;
        if (r.drawable.readsDepth && r.order < hookOrder) hookOrder = r.order;
        continue;
      }
      r.group = r.material!.blend === 'opaque' ? 0 : 1;
      let x: number;
      let y: number;
      let z: number;
      if (r.batch) {
        // A batch sorts by its sphere's centre, or its first instance's origin.
        if (r.br >= 0) {
          x = r.bx;
          y = r.by;
          z = r.bz;
        } else {
          const m = r.batch.matrices;
          x = m[3]!;
          y = m[7]!;
          z = m[11]!;
        }
      } else {
        const o = r.inst * INSTANCE_FLOATS;
        x = src[o + 3]!;
        y = src[o + 7]!;
        z = src[o + 11]!;
      }
      r.dist = v![2]! * x + v![6]! * y + v![10]! * z + v![14]!;
    }
    this.culledCount = culled;
    this.sortDepth = depth;
    this.sortShadow = false;
    if (depth || !this.ordered || lods) this.sortDraws(this.sortIdx, this.sortTmp, k);

    // The shadow list's instances follow the scene's in the same upload: room for both.
    const total = (this.instanceCount + this.batchInstances) * INSTANCE_FLOATS;
    const need = shadowCfg ? total * 2 : total;
    if (this.sortedData.length < need) {
      this.sortedData = new Float32Array(Math.max(need, this.sortedData.length * 2));
    }
    const dst = this.sortedData;
    // The shared previous-matrix lane: only into a velocity target, for batches that bring one.
    const laneOn = this.laneRecs > 0 && (target.auxKey & 2) !== 0;
    this.laneUsed = false;
    if (laneOn) {
      const laneNeed = (this.instanceCount + this.batchInstances) * MATRIX3X4_FLOATS;
      if (this.laneData.length < laneNeed) {
        this.laneData = new Float32Array(Math.max(laneNeed, this.laneData.length * 2));
      }
    }
    // Every view of a camera advances its motion memory once single draws could use it, so a
    // view into a target without velocity breaks the history like a skipped frame.
    const motionMem = this.laneRecs > 0 ? this.motionView(cam) : null;
    const motion = laneOn ? motionMem : null;
    let inst = 0;
    let batches = 0;
    let listInst = 0;
    for (let j = 0; j < k; j++) {
      const r = recs[idx[j]!]!;
      if (this.splitAt < 0 && r.group === 1 && r.order >= hookOrder) {
        this.splitAt = this.scene.count;
      }
      if (r.drawable) {
        this.batch(this.scene, r, null, 0);
        continue;
      }
      const mode: DepthMode = !depth ? 0 : r.group === 0 && depthWrite ? 2 : 1;
      if (r.batch) {
        r.lane = laneOn && r.prev !== null && r.material!.aux;
        this.laneSrc = r.lane ? r.prev : null;
        if (r.lane) this.laneUsed = true;
        const list = r.list;
        if (list) {
          batches++;
          listInst += list.count;
          this.batch(this.scene, r, this.scenePipeline(r, mode), 0, list.count, list.buffer);
          continue;
        }
        if (r.lod) {
          // One command per non-empty level, the instances bucketed by level (ws/render-6).
          const written = this.copyBatchLod(r, dst, inst, planes);
          culled += this.batchCulled;
          if (written === 0) continue;
          batches++;
          const meshes = r.lod.meshes;
          for (let l = 0; l < meshes.length; l++) {
            const c = this.bucketCount[l]!;
            if (c === 0) continue;
            r.mesh = meshes[l]!;
            this.batch(this.scene, r, this.scenePipeline(r, mode), this.bucketFirst[l]!, c);
            this.countLod(l, c);
          }
          r.mesh = meshes[0]!;
          inst += written;
          continue;
        }
        const written = this.copyBatch(r, dst, inst, planes);
        culled += this.batchCulled;
        if (written === 0) continue;
        batches++;
        this.batch(this.scene, r, this.scenePipeline(r, mode), inst, written);
        inst += written;
        continue;
      }
      const from = r.inst * INSTANCE_FLOATS;
      const to = inst * INSTANCE_FLOATS;
      for (let f = 0; f < INSTANCE_FLOATS; f++) dst[to + f] = src[from + f]!;
      // A single draw's previous matrix: its Transform's, kept per view (ws/render-8).
      r.lane = motion !== null && r.xf !== null && r.material!.aux;
      if (r.lane) {
        this.writeMotion(motion!, r.xf!, src, from, inst);
        this.laneUsed = true;
      }
      this.batch(this.scene, r, this.scenePipeline(r, mode), inst);
      inst++;
    }
    this.laneSrc = null;
    this.culledCount = culled;
    this.sceneBatches = batches;
    this.sceneListInstances = listInst;
    this.uploadData = dst;
    this.sceneCount = inst;
    this.uploadCount = shadowCfg ? this.buildShadowDraws(camLayers, dst, inst) : inst;
    return depth;
  }

  /** `cam`'s motion memory, advanced to a new view (one per `render` with lane records). */
  private motionView(cam: Camera): MotionMemory {
    let m = this.motionMemory.get(cam);
    if (!m) {
      m = { view: 0, slots: new WeakMap() };
      this.motionMemory.set(cam, m);
    }
    m.view++;
    return m;
  }

  /**
   * Write the previous world matrix of a single draw's `tr` into lane slot `slot`: the matrix
   * `tr` held at this view's last frame, or the current one (zero motion) when the view did
   * not draw it then (first seen, or culled or skipped last frame). The current matrix is
   * `src[from..from+12]`, as recorded. A transform drawn twice with different matrices in one
   * view is a scratch transform: it reports no motion of its own from then on. Allocates only
   * on a transform's first draw in a view.
   */
  private writeMotion(
    memory: MotionMemory,
    tr: Transform,
    src: Float32Array,
    from: number,
    slot: number,
  ): void {
    const now = memory.view;
    let s = memory.slots.get(tr);
    if (!s) {
      s = {
        prev: new Float32Array(MATRIX3X4_FLOATS),
        cur: new Float32Array(MATRIX3X4_FLOATS),
        view: -1,
        shared: false,
      };
      memory.slots.set(tr, s);
    }
    const prev = s.prev;
    const cur = s.cur;
    if (s.view === now) {
      // Drawn again in this view: the same matrix keeps its history; a different one is a
      // scratch transform.
      if (!s.shared) {
        for (let f = 0; f < MATRIX3X4_FLOATS; f++) {
          if (cur[f] !== src[from + f]) {
            s.shared = true;
            break;
          }
        }
      }
    } else {
      const continuous = s.view === now - 1;
      if (continuous) prev.set(cur);
      for (let f = 0; f < MATRIX3X4_FLOATS; f++) cur[f] = src[from + f]!;
      if (!continuous) prev.set(cur);
      s.view = now;
    }
    const lane = this.laneData;
    const lo = slot * MATRIX3X4_FLOATS;
    const hist = s.shared ? src : prev;
    const ho = s.shared ? from : 0;
    for (let f = 0; f < MATRIX3X4_FLOATS; f++) lane[lo + f] = hist[ho + f]!;
  }

  /**
   * Pick this view's level of every LOD record (`frame.mesh` with a `MeshLod`): the projected
   * height of its world sphere through `cam` on the view's viewport (`lodSizePx`) times
   * `cam.lodBias`, against the chain's thresholds with `lodHysteresis` around the level its key
   * drew last (`pickLodLevel`). Sets the record's `mesh` (so the scene and shadow lists draw the
   * level) and, for opaque materials, the sort keys that group a level's instances into one
   * draw. No allocation.
   */
  private pickLods(cam: Camera): void {
    const recs = this.recs;
    const n = this.recCount;
    const proj = cam.projection;
    const eye = cam.position;
    const ex = eye[0]!;
    const ey = eye[1]!;
    const ez = eye[2]!;
    const vpH = this.viewRect.height;
    const bias = cam.lodBias;
    const h = this.lodHysteresis;
    const camLayers = cam.layers >>> 0;
    this.lodCam = cam;
    let memory = this.lodMemory.get(cam);
    if (!memory) {
      memory = { keyed: new WeakMap(), indexed: new WeakMap() };
      this.lodMemory.set(cam, memory);
    }
    const levels = memory.keyed;
    for (let i = 0; i < n; i++) {
      const r = recs[i]!;
      const lod = r.lod;
      if (!lod) continue;
      if (r.batch) {
        if ((r.layers & camLayers) !== 0) this.pickBatchLods(r, lod, memory, ex, ey, ez, vpH);
        continue;
      }
      const meshes = lod.meshes;
      let level = 0;
      if (meshes.length > 1) {
        const dist = Math.hypot(r.bx - ex, r.by - ey, r.bz - ez);
        const size = r.br >= 0 ? lodSizePx(r.br, dist, proj, vpH) * bias : Number.POSITIVE_INFINITY;
        const key = r.lodKey!;
        const prev = levels.get(key) ?? -1;
        level = pickLodLevel(size, lod.thresholdsPx, meshes.length, prev, h);
        if (level !== prev) levels.set(key, level);
      }
      const mesh = meshes[level]!;
      r.mesh = mesh;
      r.lodLevel = level;
      if (r.material!.blend === 'opaque') {
        r.lk = this.keyOf(mesh);
        r.lt = this.keyOf(r.material!);
      } else {
        r.lk = -1;
        r.lt = -1;
      }
    }
  }

  /**
   * `pickLods` for a batch or list record: every instance's level for this view, from the
   * sphere of `meshes[0].bounds` through its matrix (as `pushInstance` places it), with the
   * hysteresis held per instance index in the view's memory for the batch. The levels land in
   * `r.lodLevels` (that memory), read by the scene and the shadow copy alike, so a shadow pass
   * draws the level the view picked. Grows the memory only when the batch does.
   */
  private pickBatchLods(
    r: DrawRec,
    lod: MeshLod,
    memory: LodMemory,
    ex: number,
    ey: number,
    ez: number,
    vpH: number,
  ): void {
    const b = r.batch!;
    const n = b.count;
    let slots = memory.indexed.get(b);
    if (!slots) {
      const size = Math.max(n, 16);
      slots = { levels: new Int8Array(size).fill(-1), spare: new Int8Array(size), flush: -1 };
      memory.indexed.set(b, slots);
    } else if (slots.levels.length < n) {
      const next = new Int8Array(Math.max(n, slots.levels.length * 2)).fill(-1);
      next.set(slots.levels);
      slots.levels = next;
      slots.spare = new Int8Array(next.length);
    }
    // A keyed list (ws/render-7): carry each level from the index its key held at the last
    // flush, so a removal or reorder moves no other instance's level.
    if (b instanceof InstanceList && b.keyed) {
      const now = b.flushCount;
      if (slots.flush !== now) {
        const pi = b.previousIndex!;
        const old = slots.levels;
        const spare = slots.spare;
        const remap = slots.flush === now - 1;
        for (let i = 0; i < n; i++) {
          const j = remap ? pi[i]! : -1;
          spare[i] = j >= 0 ? old[j]! : -1;
        }
        slots.levels = spare;
        slots.spare = old;
      }
      slots.flush = now;
    }
    const mem = slots.levels;
    r.lodLevels = mem;
    const meshes = lod.meshes;
    const count = meshes.length;
    const mb = meshes[0]!.bounds;
    if (count <= 1 || !(mb.radius < Number.POSITIVE_INFINITY)) {
      mem.fill(0, 0, n);
      return;
    }
    const cam = this.lodCam!;
    const proj = cam.projection;
    const bias = cam.lodBias;
    const h = this.lodHysteresis;
    const th = lod.thresholdsPx;
    const m = b.matrices;
    const cx = mb.center[0];
    const cy = mb.center[1];
    const cz = mb.center[2];
    for (let i = 0; i < n; i++) {
      const mo = i * MATRIX3X4_FLOATS;
      const x = m[mo]! * cx + m[mo + 1]! * cy + m[mo + 2]! * cz + m[mo + 3]!;
      const y = m[mo + 4]! * cx + m[mo + 5]! * cy + m[mo + 6]! * cz + m[mo + 7]!;
      const z = m[mo + 8]! * cx + m[mo + 9]! * cy + m[mo + 10]! * cz + m[mo + 11]!;
      const s0 = m[mo]! * m[mo]! + m[mo + 4]! * m[mo + 4]! + m[mo + 8]! * m[mo + 8]!;
      const s1 = m[mo + 1]! * m[mo + 1]! + m[mo + 5]! * m[mo + 5]! + m[mo + 9]! * m[mo + 9]!;
      const s2 = m[mo + 2]! * m[mo + 2]! + m[mo + 6]! * m[mo + 6]! + m[mo + 10]! * m[mo + 10]!;
      const radius = mb.radius * Math.sqrt(Math.max(s0, s1, s2));
      const dist = Math.hypot(x - ex, y - ey, z - ez);
      const size = lodSizePx(radius, dist, proj, vpH) * bias;
      mem[i] = pickLodLevel(size, th, count, mem[i]!, h);
    }
  }

  /** Count `n` scene instances of LOD level `level` in `stats.lodCounts`. */
  private countLod(level: number, n: number): void {
    const lc = this.stats.lodCounts;
    while (lc.length <= level) lc.push(0);
    lc[level]! += n;
  }

  /**
   * Copy the instances of batch record `r` into `dst` from instance `inst` on, in the instance
   * format (matrices, then `params` or the defaults with the matrix columns' lengths as size).
   * With `planes` and a batch without bounds (`r.mb` set), each instance is tested the way
   * `pushInstance` places a mesh sphere and the ones outside are skipped, counted in
   * `batchCulled`. Returns the instances written. No allocation.
   */
  private copyBatch(
    r: DrawRec,
    dst: Float32Array,
    inst: number,
    planes: Float32Array | null,
  ): number {
    const b = r.batch!;
    const n = b.count;
    const m = b.matrices;
    const p = b.params ?? null;
    const mb = planes ? r.mb : null;
    const cx = mb ? mb.center[0] : 0;
    const cy = mb ? mb.center[1] : 0;
    const cz = mb ? mb.center[2] : 0;
    const cr = mb ? mb.radius : 0;
    const lane = this.laneSrc;
    const laneDst = this.laneData;
    let written = 0;
    let culled = 0;
    for (let i = 0; i < n; i++) {
      const mo = i * MATRIX3X4_FLOATS;
      if (mb) {
        const x = m[mo]! * cx + m[mo + 1]! * cy + m[mo + 2]! * cz + m[mo + 3]!;
        const y = m[mo + 4]! * cx + m[mo + 5]! * cy + m[mo + 6]! * cz + m[mo + 7]!;
        const z = m[mo + 8]! * cx + m[mo + 9]! * cy + m[mo + 10]! * cz + m[mo + 11]!;
        const s0 = m[mo]! * m[mo]! + m[mo + 4]! * m[mo + 4]! + m[mo + 8]! * m[mo + 8]!;
        const s1 = m[mo + 1]! * m[mo + 1]! + m[mo + 5]! * m[mo + 5]! + m[mo + 9]! * m[mo + 9]!;
        const s2 = m[mo + 2]! * m[mo + 2]! + m[mo + 6]! * m[mo + 6]! + m[mo + 10]! * m[mo + 10]!;
        if (outside(planes!, x, y, z, cr * Math.sqrt(Math.max(s0, s1, s2)))) {
          culled++;
          continue;
        }
      }
      const to = (inst + written) * INSTANCE_FLOATS;
      for (let f = 0; f < MATRIX3X4_FLOATS; f++) dst[to + f] = m[mo + f]!;
      if (lane) {
        const lo = (inst + written) * MATRIX3X4_FLOATS;
        for (let f = 0; f < MATRIX3X4_FLOATS; f++) laneDst[lo + f] = lane[mo + f]!;
      }
      if (p) {
        const po = i * INSTANCE_PARAM_FLOATS;
        for (let f = 0; f < INSTANCE_PARAM_FLOATS; f++) {
          dst[to + MATRIX3X4_FLOATS + f] = p[po + f]!;
        }
      } else {
        const sx = Math.hypot(m[mo]!, m[mo + 4]!, m[mo + 8]!);
        const sy = Math.hypot(m[mo + 1]!, m[mo + 5]!, m[mo + 9]!);
        writeInstanceParams(dst, to + MATRIX3X4_FLOATS, NO_PARAMS, sx, sy);
      }
      written++;
    }
    this.batchCulled = culled;
    return written;
  }

  /**
   * `copyBatch` for a LOD batch or list: the instances that pass the same per-instance test,
   * written bucketed by the level `pickLods` chose for this view (`r.lodLevels`), level 0
   * first. Sets `bucketFirst` / `bucketCount` per level and `batchCulled`; returns the
   * instances written. Grows its scratch only when a batch outgrows it.
   */
  private copyBatchLod(
    r: DrawRec,
    dst: Float32Array,
    inst: number,
    planes: Float32Array | null,
  ): number {
    const b = r.batch!;
    const n = b.count;
    const m = b.matrices;
    const p = b.params ?? null;
    const levels = r.lodLevels;
    const count = r.lod!.meshes.length;
    if (this.bucketCount.length < count) {
      const c = Math.max(count, this.bucketCount.length * 2);
      this.bucketFirst = new Int32Array(c);
      this.bucketCount = new Int32Array(c);
      this.bucketAt = new Int32Array(c);
    }
    if (this.lodScratch.length < n) {
      this.lodScratch = new Int8Array(Math.max(n, this.lodScratch.length * 2));
    }
    const lv = this.lodScratch;
    const bc = this.bucketCount;
    const bf = this.bucketFirst;
    const at = this.bucketAt;
    bc.fill(0, 0, count);
    const mb = planes ? r.mb : null;
    const cx = mb ? mb.center[0] : 0;
    const cy = mb ? mb.center[1] : 0;
    const cz = mb ? mb.center[2] : 0;
    const cr = mb ? mb.radius : 0;
    let culled = 0;
    for (let i = 0; i < n; i++) {
      if (mb) {
        const mo = i * MATRIX3X4_FLOATS;
        const x = m[mo]! * cx + m[mo + 1]! * cy + m[mo + 2]! * cz + m[mo + 3]!;
        const y = m[mo + 4]! * cx + m[mo + 5]! * cy + m[mo + 6]! * cz + m[mo + 7]!;
        const z = m[mo + 8]! * cx + m[mo + 9]! * cy + m[mo + 10]! * cz + m[mo + 11]!;
        const s0 = m[mo]! * m[mo]! + m[mo + 4]! * m[mo + 4]! + m[mo + 8]! * m[mo + 8]!;
        const s1 = m[mo + 1]! * m[mo + 1]! + m[mo + 5]! * m[mo + 5]! + m[mo + 9]! * m[mo + 9]!;
        const s2 = m[mo + 2]! * m[mo + 2]! + m[mo + 6]! * m[mo + 6]! + m[mo + 10]! * m[mo + 10]!;
        if (outside(planes!, x, y, z, cr * Math.sqrt(Math.max(s0, s1, s2)))) {
          lv[i] = -1;
          culled++;
          continue;
        }
      }
      const l = levels ? Math.min(Math.max(levels[i]!, 0), count - 1) : 0;
      lv[i] = l;
      bc[l]!++;
    }
    const lane = this.laneSrc;
    const laneDst = this.laneData;
    let next = inst;
    for (let l = 0; l < count; l++) {
      bf[l] = next;
      at[l] = next;
      next += bc[l]!;
    }
    for (let i = 0; i < n; i++) {
      const l = lv[i]!;
      if (l < 0) continue;
      const mo = i * MATRIX3X4_FLOATS;
      const slot = at[l]!++;
      const to = slot * INSTANCE_FLOATS;
      for (let f = 0; f < MATRIX3X4_FLOATS; f++) dst[to + f] = m[mo + f]!;
      if (lane) {
        const lo = slot * MATRIX3X4_FLOATS;
        for (let f = 0; f < MATRIX3X4_FLOATS; f++) laneDst[lo + f] = lane[mo + f]!;
      }
      if (p) {
        const po = i * INSTANCE_PARAM_FLOATS;
        for (let f = 0; f < INSTANCE_PARAM_FLOATS; f++) {
          dst[to + MATRIX3X4_FLOATS + f] = p[po + f]!;
        }
      } else {
        const sx = Math.hypot(m[mo]!, m[mo + 4]!, m[mo + 8]!);
        const sy = Math.hypot(m[mo + 1]!, m[mo + 5]!, m[mo + 9]!);
        writeInstanceParams(dst, to + MATRIX3X4_FLOATS, NO_PARAMS, sx, sy);
      }
    }
    this.batchCulled = culled;
    return next - inst;
  }

  /** The shadow pipeline of a caster record (its current `mesh`). */
  private shadowPipeline(r: DrawRec): GPURenderPipeline {
    const layout = r.mesh!.layout;
    const material = r.material!;
    // A material with a shadow fragment (alpha mask, dissolve) discards in the shadow pass too;
    // every other caster takes the depth-only pipeline.
    return material.shadowFragment
      ? material.shadowPipelineFor(layout, SHADOW_FORMAT)
      : this.shadow.pipelineFor(layout, layout.skinned ? material.bindings?.layout : undefined);
  }

  /**
   * Build this view's shadow-pass commands: every opaque mesh draw with `castShadow` on the
   * camera's layers whose bounding sphere touches the sun's box (`ShadowMap.sunCamera.frustum`,
   * placed by `render` before the lists are built), whether or not the view's own frustum sees
   * it. The casters are sorted by mesh, then material, then submission index, their instance
   * data copied into `dst` from `inst` on (after the scene's), and batched into `shadowCmds`
   * with the scene's keys, so one `(mesh, material)` is one instanced draw. Returns the new
   * instance count of the upload. No allocation in steady state.
   */
  private buildShadowDraws(camLayers: number, dst: Float32Array, inst: number): number {
    const recs = this.recs;
    const n = this.recCount;
    if (this.shadowIdx.length < n) {
      this.shadowIdx = new Uint32Array(n * 2);
      this.shadowTmp = new Uint32Array(n * 2);
    }
    const idx = this.shadowIdx;
    const planes = this.shadow.sunCamera.frustum;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i]!;
      if (!r.castShadow || r.drawable || r.material!.blend !== 'opaque') continue;
      if ((r.layers & camLayers) === 0) continue;
      if (r.br >= 0 && outside(planes, r.bx, r.by, r.bz, r.br)) continue;
      r.mk = this.keyOf(r.mesh!);
      r.tk = this.keyOf(r.material!);
      idx[k++] = i;
    }
    if (k === 0) return inst;
    this.sortShadow = true;
    this.sortDraws(idx, this.shadowTmp, k);
    const src = this.instanceData;
    for (let j = 0; j < k; j++) {
      const r = recs[idx[j]!]!;
      if (r.batch && r.lod) {
        // The levels the view picked, bucketed: one shadow draw per non-empty level.
        const written = this.copyBatchLod(r, dst, inst, planes);
        if (written === 0) continue;
        const meshes = r.lod.meshes;
        for (let l = 0; l < meshes.length; l++) {
          const c = this.bucketCount[l]!;
          if (c === 0) continue;
          r.mesh = meshes[l]!;
          this.batch(this.shadowCmds, r, this.shadowPipeline(r), this.bucketFirst[l]!, c);
        }
        r.mesh = meshes[0]!;
        inst += written;
        continue;
      }
      const pipeline = this.shadowPipeline(r);
      if (r.batch) {
        const list = r.list;
        if (list) {
          this.batch(this.shadowCmds, r, pipeline, 0, list.count, list.buffer);
          continue;
        }
        // Per-instance casters are tested against the sun box, not the view.
        const written = this.copyBatch(r, dst, inst, planes);
        if (written === 0) continue;
        this.batch(this.shadowCmds, r, pipeline, inst, written);
        inst += written;
        continue;
      }
      const from = r.inst * INSTANCE_FLOATS;
      const to = inst * INSTANCE_FLOATS;
      for (let f = 0; f < INSTANCE_FLOATS; f++) dst[to + f] = src[from + f]!;
      this.batch(this.shadowCmds, r, pipeline, inst);
      inst++;
    }
    return inst;
  }

  /** A stable small integer for a mesh or material (assigned on first sight). */
  private keyOf(o: object): number {
    let k = this.keys.get(o);
    if (k === undefined) {
      k = this.nextKey++;
      this.keys.set(o, k);
    }
    return k;
  }

  /** The scene pipeline of a mesh record for `depth` into the view's target. */
  private scenePipeline(r: DrawRec, depth: DepthMode): GPURenderPipeline {
    return r.material!.pipelineFor(
      r.mesh!.layout,
      depth,
      this.drawTarget,
      r.lane || (r.list !== null && r.list.prevBuffer !== null),
    );
  }

  /**
   * Append a record to `list` as a command drawn with `pipeline`, merging into the previous
   * one when it continues it (same pipeline, material, mesh, offset and shadow flag, and its
   * instances follow on). Drawables pass `pipeline` null.
   */
  private batch(
    list: CmdList,
    r: DrawRec,
    pipeline: GPURenderPipeline | null,
    first: number,
    count = 1,
    buffer: GPUBuffer | null = null,
  ): void {
    if (r.drawable) {
      const c = this.nextCmd(list);
      c.material = null;
      c.mesh = null;
      c.drawable = r.drawable;
      c.pipeline = null;
      c.first = 0;
      c.count = 0;
      c.offset = -1;
      c.castShadow = false;
      c.buffer = null;
      c.prevBuffer = null;
      c.lane = false;
      c.firstIndex = 0;
      c.indexCount = -1;
      return;
    }
    const material = r.material!;
    const mesh = r.mesh!;
    const last = list.count > 0 ? list.cmds[list.count - 1]! : null;
    if (
      last &&
      !last.drawable &&
      last.pipeline === pipeline &&
      last.material === material &&
      last.mesh === mesh &&
      last.offset === r.offset &&
      last.castShadow === r.castShadow &&
      last.buffer === null &&
      buffer === null &&
      last.firstIndex === r.rangeFirst &&
      last.indexCount === r.rangeCount &&
      last.first + last.count === first
    ) {
      last.count += count;
      return;
    }
    const c = this.nextCmd(list);
    c.material = material;
    c.mesh = mesh;
    c.drawable = null;
    c.pipeline = pipeline;
    c.first = first;
    c.count = count;
    c.offset = r.offset;
    c.castShadow = r.castShadow;
    c.buffer = buffer;
    // The lane is read only by a pipeline built for it (an aux material into a velocity target).
    c.prevBuffer = list === this.scene && r.list ? r.list.prevBuffer : null;
    c.lane = list === this.scene && r.lane;
    c.firstIndex = r.rangeFirst;
    c.indexCount = r.rangeCount;
  }

  /**
   * True when record `a` draws before record `b` (a total order: ties go by index). For the
   * scene list: `order`, then (with depth) group and depth; for the shadow list
   * (`sortShadow`): mesh key, then material key.
   */
  private drawsBefore(a: number, b: number): boolean {
    const ra = this.recs[a]!;
    const rb = this.recs[b]!;
    if (this.sortShadow) {
      if (ra.mk !== rb.mk) return ra.mk < rb.mk;
      if (ra.tk !== rb.tk) return ra.tk < rb.tk;
      return a < b;
    }
    if (ra.order !== rb.order) return ra.order < rb.order;
    if (this.sortDepth && ra.group !== rb.group) return ra.group < rb.group;
    // Opaque LOD draws group per (level mesh, material) so each level is one instanced call;
    // every other draw has -1 here, so a frame without LOD sorts as before.
    if (ra.lk !== rb.lk) return ra.lk < rb.lk;
    if (ra.lt !== rb.lt) return ra.lt < rb.lt;
    if (this.sortDepth && ra.dist !== rb.dist) {
      return ra.group === 0 ? ra.dist < rb.dist : ra.dist > rb.dist;
    }
    return a < b;
  }

  /** Bottom-up merge sort of `idx[0..n)` with `drawsBefore`, `tmp` as scratch; no allocation. */
  private sortDraws(idx: Uint32Array, tmp: Uint32Array, n: number): void {
    let src = idx;
    let dst = tmp;
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
    if (src !== idx) {
      for (let i = 0; i < n; i++) idx[i] = src[i]!;
    }
  }

  // ---------------------------------------------------------------- internals

  private nextCmd(list: CmdList): DrawCmd {
    if (list.count === list.cmds.length) {
      list.cmds.push({
        material: null,
        mesh: null,
        drawable: null,
        pipeline: null,
        first: 0,
        count: 0,
        offset: -1,
        castShadow: false,
        buffer: null,
        prevBuffer: null,
        lane: false,
        firstIndex: 0,
        indexCount: -1,
      });
    }
    return list.cmds[list.count++]!;
  }

  private growInstances(): void {
    const next = new Float32Array(this.instanceData.length * 2);
    next.set(this.instanceData);
    this.instanceData = next;
  }

  /**
   * Upload this view's scene instances of the shared previous-matrix lane at the byte offset
   * matching `base` in the instance buffer (48 bytes per instance where it has 112), growing
   * the lane buffer when the frame outgrows it (the old one retires after submit).
   */
  private uploadLane(base: number): void {
    const first = base / INSTANCE_STRIDE;
    const laneBase = first * LANE_STRIDE;
    const bytes = this.sceneCount * LANE_STRIDE;
    let buf = this.laneBuffer;
    if (!buf || laneBase + bytes > buf.size) {
      if (buf) this.retired.push(buf);
      let cap = Math.max(256, buf ? buf.size / LANE_STRIDE : 0);
      while (cap * LANE_STRIDE < laneBase + bytes) cap *= 2;
      buf = this.laneBuffer = this.device.createBuffer({
        label: 'instance-lane',
        size: cap * LANE_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.laneBase = laneBase;
    if (bytes > 0) this.device.queue.writeBuffer(buf, laneBase, this.laneData.buffer, 0, bytes);
  }

  private makeInstanceBuffer(count: number): GPUBuffer {
    return this.device.createBuffer({
      label: 'instances',
      size: count * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * The engine uniform slot for view `i` of a frame, made on first use (slot 0 at startup).
   * Its bind group carries the sun's shadow map at binding 3 (the 1×1 placeholder until a
   * shadow pass has rendered; `encodeShadow` rebuilds the groups when the map changes).
   */
  private viewSlot(i: number): ViewSlot {
    let slot = this.views[i];
    if (slot) return slot;
    const buffer = this.device.createBuffer({
      label: `engine-globals${i === 0 ? '' : `-${i}`}`,
      size: ENGINE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    slot = { buffer, group: this.globalsGroup(buffer, i, false) };
    this.views[i] = slot;
    return slot;
  }

  /** The uniform slot for shadow pass `i` of a frame; binds the placeholder, not the map. */
  private shadowSlot(i: number): ViewSlot {
    let slot = this.shadowSlots[i];
    if (slot) return slot;
    const buffer = this.device.createBuffer({
      label: `engine-shadow-globals-${i}`,
      size: ENGINE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    slot = { buffer, group: this.globalsGroup(buffer, i, true) };
    this.shadowSlots[i] = slot;
    return slot;
  }

  /** A `globalsLayout` bind group over `buffer`, with the shadow map (or its placeholder) at 3. */
  private globalsGroup(buffer: GPUBuffer, i: number, placeholder: boolean): GPUBindGroup {
    const label = placeholder
      ? `engine-shadow-globals-group-${i}`
      : `engine-globals-group${i === 0 ? '' : `-${i}`}`;
    return this.device.createBindGroup({
      label,
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
        { binding: 3, resource: placeholder ? this.shadow.placeholder : this.shadow.view },
        { binding: 4, resource: this.shadow.sampler },
      ],
    });
  }

  /**
   * When `frame.lights.sun.shadow` is set and this view has opaque shadow casters inside the
   * sun's box, encode one depth-only pass into the sun's shadow map (through
   * `ShadowMap.sunCamera`, an ortho box centred on `camera.position`, placed by `render`) over
   * `shadowCmds` (built by `buildShadowDraws`: casters the view frustum culled included), before
   * its scene pass. Returns what `writeView` puts in the lights block, or null when no shadow
   * was rendered.
   */
  private encodeShadow(
    enc: GPUCommandEncoder,
    frame: Frame,
    camera: Camera,
    base: number,
  ): ShadowUniforms | null {
    const cfg = frame.lights.sun.shadow;
    if (!cfg) return null;
    const cmds = this.shadowCmds.cmds;
    const n = this.shadowCmds.count;
    if (n === 0) return null;
    const shadow = this.shadow;
    const size = cfg.size ?? DEFAULT_SHADOW_SIZE;
    if (shadow.ensure(size)) {
      // The map is new: every view's bind group must point at it.
      for (let i = 0; i < this.views.length; i++) {
        const v = this.views[i]!;
        v.group = this.globalsGroup(v.buffer, i, false);
      }
      this.globalsBindGroup = this.views[0]!.group;
    }
    const slot = this.shadowSlot(this.shadowCount++);
    const g = this.globalsData;
    g[0] = this.logicalWidth;
    g[1] = this.logicalHeight;
    g[2] = size;
    g[3] = size;
    g[4] = frame.time;
    g[5] = frame.dt;
    const rect = this.shadowRect;
    rect.width = size;
    rect.height = size;
    shadow.sunCamera.writeBlock(g, this.globalsU32, CAMERA_OFFSET_FLOATS, rect, camera.viewIndex);
    frame.lights.writeBlock(g, this.globalsU32, LIGHTS_OFFSET_FLOATS, null);
    this.device.queue.writeBuffer(slot.buffer, 0, g);

    const desc = shadow.passDesc;
    desc.timestampWrites = this.gpuTimer?.pass('shadow');
    const pass = enc.beginRenderPass(desc);
    pass.setBindGroup(0, slot.group);
    let curPipeline: GPURenderPipeline | null = null;
    let curMesh: Mesh | null = null;
    let curBuffer: GPUBuffer | null = null;
    let curMaterial: Material | null = null;
    let curOffset = -1;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const c = cmds[i]!;
      const mesh = c.mesh!;
      const pipeline = c.pipeline!;
      if (pipeline !== curPipeline) {
        pass.setPipeline(pipeline);
        curPipeline = pipeline;
      }
      // A skinned caster's pipeline has the material group (its joint palette) as group 1, as
      // does a material's own shadow pipeline (`shadowFragmentEntry`).
      const m = c.material!;
      if (
        (mesh.layout.skinned || m.shadowFragment) &&
        m.bindings &&
        (m !== curMaterial || c.offset !== curOffset)
      ) {
        if (c.offset >= 0) {
          this.dynamicOffsets[0] = c.offset;
          pass.setBindGroup(1, m.bindings.bindGroup, this.dynamicOffsets);
        } else {
          pass.setBindGroup(1, m.bindings.bindGroup);
        }
        curMaterial = m;
        curOffset = c.offset;
      }
      if (mesh !== curMesh || c.buffer !== curBuffer) {
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        if (c.buffer) pass.setVertexBuffer(1, c.buffer, 0);
        else pass.setVertexBuffer(1, this.instanceBuffer, base);
        if (mesh.indexBuffer) pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
        curMesh = mesh;
        curBuffer = c.buffer;
      }
      if (mesh.indexBuffer) {
        const indices = c.indexCount >= 0 ? c.indexCount : mesh.indexCount;
        if (indices === 0) continue;
        pass.drawIndexed(indices, c.count, c.firstIndex, 0, c.first);
      } else {
        pass.draw(mesh.vertexCount, c.count, 0, c.first);
      }
      drawn += c.count;
    }
    pass.end();
    this.stats.shadowDraws += drawn;
    return shadow.uniforms;
  }

  /**
   * Upload the globals, camera and lighting blocks of one view (`viewRect` holds its viewport;
   * `view_index` is `camera.viewIndex`; `shadow` is this view's shadow pass, if any).
   */
  private writeView(
    frame: Frame,
    camera: Camera,
    target: SceneTarget,
    slot: ViewSlot,
    shadow: ShadowUniforms | null,
  ): void {
    const g = this.globalsData;
    g[0] = this.logicalWidth;
    g[1] = this.logicalHeight;
    g[2] = target.width;
    g[3] = target.height;
    g[4] = frame.time;
    g[5] = frame.dt;
    camera.writeBlock(g, this.globalsU32, CAMERA_OFFSET_FLOATS, this.viewRect);
    frame.lights.writeBlock(g, this.globalsU32, LIGHTS_OFFSET_FLOATS, shadow);
    this.device.queue.writeBuffer(slot.buffer, 0, g);
  }
}

function newPostView(): PostView {
  return {
    viewProj: new Float32Array(16),
    invViewProj: new Float32Array(16),
    previousViewProj: new Float32Array(16),
    previousView: new Float32Array(16),
    jitter: [0, 0],
  };
}

/** Is the sphere `(x, y, z, r)` wholly outside one of the six `planes` (`Camera.frustum`)? */
function outside(planes: Float32Array, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
    if (planes[i]! * x + planes[i + 1]! * y + planes[i + 2]! * z + planes[i + 3]! < -r) {
      return true;
    }
  }
  return false;
}
