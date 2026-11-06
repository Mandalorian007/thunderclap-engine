import type { Drawable, Frame, ViewInfo } from '../render/frame';
import type { Renderer } from '../render/renderer';
import type { SceneTarget } from '../render/scene-target';
import type { Texture, TextureLike } from '../render/texture';
import { createShaderModule } from '../render/wgsl';
import { buildEmitSurface, type EmitSurface } from './emit-surface';
import {
  COLOR_CURVE_FLOATS,
  FX_PARTICLE_FLOATS,
  FX_REQUEST_FLOATS,
  FX_SIM_FLOATS,
  FX_SPAWN_FLOATS,
  MAX_FORCES,
  PARTICLE_COLLIDE_WGSL,
  PARTICLE_COMPUTE_WGSL,
  PARTICLE_COUNT_WGSL,
  PARTICLE_DEPTH_COPY_WGSL,
  PARTICLE_EXT_COMPUTE_WGSL,
  PARTICLE_EXT_RENDER_WGSL,
  PARTICLE_RENDER_WGSL,
  PARTICLE_WORLD_COMPUTE_WGSL,
  PARTICLE_WORLD_RENDER_WGSL,
  SIZE_CURVE_FLOATS,
  SURFACE_TRI_FLOATS,
} from './particles-wgsl';

const PARTICLE_BYTES = 80;
const SPAWN_FLOATS = 28;
const SIM_FLOATS = 8;
const FX_PARTICLE_BYTES = FX_PARTICLE_FLOATS * 4;
/** Floats of the collision uniform: two mat4, viewport, params. */
const COLLIDE_FLOATS = 40;
/** The soft-particle depth copy's format (sampleable as `texture_depth_2d`). */
const SOFT_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** Most stops a `sizeCurve`/`colorCurve` may have. */
export const MAX_CURVE_STOPS = 8;

/** A `[min, max]` pair. */
export type Range = readonly [number, number];

export type EmitShape =
  | { kind: 'point' }
  /** Disc of `radius` in the XY plane. */
  | { kind: 'circle'; radius: number }
  /** Rectangle centred on (x, y) in the XY plane. */
  | { kind: 'rect'; width: number; height: number }
  /** Segment from (x, y, z) to (x + dx, y + dy, z + dz). `dz` is world space only. */
  | { kind: 'line'; dx: number; dy: number; dz?: number }
  /** Box centred on (x, y, z). In 2D it is a `rect` of `width × height`. */
  | { kind: 'box'; width: number; height: number; depth: number }
  /** Ball of `radius` around (x, y, z). In 2D it is a `circle`. */
  | { kind: 'sphere'; radius: number }
  /**
   * The surface of a triangle mesh (area-weighted), offset by (x, y, z); extended kernel only.
   * `alongNormal` launches along the surface normal. Pass a `buildEmitSurface` result to skip
   * the table build; raw arrays are built (and cached by object identity) on first use.
   */
  | {
      kind: 'mesh';
      positions: ArrayLike<number>;
      normals?: ArrayLike<number>;
      indices?: ArrayLike<number>;
      alongNormal?: boolean;
    };

/**
 * How new particles are born. Colours are linear RGBA (HDR ok). Units: logical px and seconds
 * in 2D; world units and seconds in world space (defaults differ, see each field).
 *
 * The fields from `tile` on need the extended kernel (world space, or a 2D system with
 * `extended`, `texture`, `forces` or `collide`); a plain 2D system ignores them with a warning.
 */
export interface EmitParams {
  x: number;
  y: number;
  /** World space only. Default 0. */
  z?: number;
  shape?: EmitShape;
  /**
   * Launch direction in radians, in the XY plane. 2D: 0 = right, -π/2 = up (y down); default
   * -π/2. World space (y up): π/2 = up, -π/2 = down; default π/2.
   */
  angle?: number;
  /**
   * Full cone width in radians around `angle`. Default 2π: all directions (a circle in 2D, a
   * sphere in world space).
   */
  spread?: number;
  /** [min, max] speed. Default [80, 300] px/s in 2D, [0.5, 2] units/s in world space. */
  speed?: Range;
  /** World space only: added to every launch velocity's z (units/s). Default 0. */
  vz?: number;
  /** [min, max] seconds. Default [0.5, 1.2]. */
  life?: Range;
  /** Size at [birth, death]. Default [6, 1] px in 2D, [0.1, 0.02] units in world space. */
  size?: Range;
  colorStart: ArrayLike<number>;
  /** Default: `colorStart` with alpha 0. */
  colorEnd?: ArrayLike<number>;
  /**
   * Acceleration. 2D: [x, y] px/s², default [0, 400] (falls). World space: [x, y, z] units/s²
   * (a pair has z 0), default [0, -9.8, 0].
   */
  gravity?: readonly [number, number] | readonly [number, number, number];
  /**
   * World space only: the air's velocity [x, y, z] (units/s), which `drag` pulls particles
   * toward. Default [0, 0, 0] (drag slows them to rest, as in 2D).
   */
  wind?: readonly [number, number, number];
  /** Linear drag per second. Default 1. */
  drag?: number;
  /** How much the particle also feeds bloom (0..). Default 1. */
  emissive?: number;
  /**
   * Sprite-sheet tile (row-major index into the system's `atlas`): one tile, or `[from, to]`
   * played over the particle's life (or at `tileRate`). Default 0.
   */
  tile?: number | Range;
  /** Tile frames per second for a `[from, to]` range, looping. Default 0: once over life. */
  tileRate?: number;
  /** Initial rotation [min, max] radians about the view axis. Default [0, 0]. */
  rotation?: Range;
  /** Angular velocity [min, max] rad/s. Default [0, 0]. */
  spin?: Range;
  /**
   * Point the quad along the velocity (with `stretch`). Default true, the original streaks;
   * false keeps the quad upright (plus `rotation`), for sprites.
   */
  alignToVelocity?: boolean;
  /**
   * Size over life as 2..8 evenly spaced stops (replaces `size`; the per-particle size jitter
   * still applies). Cached by array identity: mutate the array, not its reference, to animate.
   */
  sizeCurve?: readonly number[];
  /** Colour over life as 2..8 evenly spaced RGBA stops (replaces `colorStart`/`colorEnd`). */
  colorCurve?: readonly ArrayLike<number>[];
  /** Emit `count` particles of `params` where this particle dies (one level deep). */
  onDeath?: { params: EmitParams; count: number };
  /** Emit `params` at `rate` per second along this particle's path (one level deep). */
  onLife?: { params: EmitParams; rate: number };
  /** Fraction of the parent's velocity its children inherit. Default 0. */
  inherit?: number;
}

/** A force applied to every particle each frame (`ParticleSystem.forces`). */
export type ParticleForce =
  /** Pull toward (x, y, z) at `strength` units/s², fading linearly to 0 at `radius` (0 = everywhere). */
  | { kind: 'attract'; x: number; y: number; z?: number; strength: number; radius?: number }
  /** Swirl about the `axis` through (x, y, z) at `strength` units/s², fading to 0 at `radius`. */
  | {
      kind: 'vortex';
      axis: readonly [number, number, number];
      x: number;
      y: number;
      z?: number;
      strength: number;
      radius?: number;
    }
  /** Curl of value noise at `frequency` (1/units) scaled by `strength` units/s²: divergence-free gusts. */
  | { kind: 'turbulence'; frequency: number; strength: number; seed?: number }
  /** Extra linear drag per second on top of each particle's own. */
  | { kind: 'drag'; amount: number };

export interface ParticleSystemOptions {
  /**
   * `'2d'` (default): logical px in the XY plane, the original behaviour, pixel for pixel.
   * `'world'`: particles in 3D world space, drawn as quads facing the camera (`size` in world
   * units), with distance and soft-depth fades and optional lighting.
   */
  space?: '2d' | 'world';
  /**
   * 2D only: use the extended kernel (sprite sheets, spin, curves, forces, sub-emission, mesh
   * emission) instead of the pixel-pinned original. Implied by `texture`, `forces` and
   * `collide`; world space always has it. Default false.
   */
  extended?: boolean;
  /** Max live particles (ring buffer). Default 65536. */
  capacity?: number;
  /** Max emit() calls between frames (also the sub-emission request budget per frame). Default 256. */
  maxSpawnsPerFrame?: number;
  /**
   * A bouncy floor. 2D: the logical y below which particles bounce (y down). World: the plane
   * y = `floorY` (y up). Default none.
   */
  floorY?: number;
  /** Floor restitution 0..1. Default 0.35. */
  bounce?: number;
  /** Seconds of velocity added to the quad length (motion streaks). Default 0.02. */
  stretch?: number;
  /**
   * `'additive'` (default): colour adds, for sparks, embers and rain. `'alpha'`: premultiplied
   * alpha over the scene, for smoke and dust that should cover what is behind.
   */
  blend?: 'additive' | 'alpha';
  /**
   * World space only: shade each particle as a small sphere through the lighting block
   * (`engine_lambert`, so `frame.lights` ambient, sun and point lights apply). Default false.
   */
  lit?: boolean;
  /**
   * World space only: fade out with distance to the camera: whole nearer than `near`, gone
   * beyond `far` (world units). Default none.
   */
  fade?: { near: number; far: number };
  /**
   * World space only: soft particles. Within this view-space distance (world units) of the
   * scene's depth a particle fades out, so quads do not cut hard lines into geometry. Needs a
   * depth camera; 0 turns it off. Default 0.25.
   */
  softness?: number;
  /** World space only: the scene target whose depth soft particles read. Default `renderer.target`. */
  depthTarget?: SceneTarget;
  /**
   * World space only: take this frame's opaque depth from the renderer's depth hook
   * (`Drawable.readsDepth`, ws/render-hooks) instead of copying the previous frame's in
   * `prepare`. Only a view with `depthTest` splits for it; elsewhere the fade is then off (no
   * copy of the system's own). Default false.
   */
  readsDepth?: boolean;
  /**
   * Count live particles on the GPU and read the count back into `alive` (a few frames late).
   * Costs one small dispatch per frame and an 8-byte readback every other frame. Default false.
   */
  countAlive?: boolean;
  /** With `countAlive`: also count live particles whose y is below this into `below`. */
  countBelowY?: number;
  /**
   * Sprite sheet (extended kernel): each particle draws a tile of this texture instead of the
   * radial falloff; its alpha and colour multiply the particle's. Both blend modes sample it.
   */
  texture?: TextureLike;
  /** The sprite sheet's grid, row-major from the top left. Default 1 × 1. */
  atlas?: { columns: number; rows: number };
  /** Initial `forces` (extended kernel; the array is live afterwards). */
  forces?: ParticleForce[];
  /**
   * World space with `readsDepth`: collide with this frame's opaque depth. Particles found
   * behind the scene (within `thickness` units along the view ray, default 1) are pushed back
   * onto the surface and bounce: `bounce` scales the normal velocity, `friction` (0..1) damps
   * the tangential.
   */
  collide?: { bounce: number; friction: number; thickness?: number };
  /** Distinct `onDeath`/`onLife` descriptors the system can hold at once. Default 16. */
  maxSubEmitters?: number;
  /** Distinct `sizeCurve` plus `colorCurve` arrays the system can hold at once. Default 32 each. */
  maxCurves?: number;
}

const POINT: EmitShape = { kind: 'point' };
/** 2D maps `box` to `rect` and `sphere` to `circle`, so the 2D shader is unchanged. */
const SHAPE_ID = { point: 0, circle: 1, rect: 2, line: 3, box: 2, sphere: 1, mesh: 6 } as const;
const WORLD_SHAPE_ID = {
  point: 0,
  circle: 1,
  rect: 2,
  line: 3,
  box: 4,
  sphere: 5,
  mesh: 6,
} as const;
const WORLD_GRAVITY = [0, -9.8, 0] as const;
const GRAVITY_2D = [0, 400] as const;
const ZERO2 = [0, 0] as const;
const ZERO3 = [0, 0, 0] as const;
const SPEED_2D = [80, 300] as const;
const WORLD_SPEED = [0.5, 2] as const;
const SIZE_2D = [6, 1] as const;
const WORLD_SIZE = [0.1, 0.02] as const;
const LIFE = [0.5, 1.2] as const;
const FORCE_ID = { attract: 0, vortex: 1, turbulence: 2, drag: 3 } as const;

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};
const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** World-space soft-particle resources, made only for `space: 'world'`. */
interface SoftDepth {
  copyLayout: GPUBindGroupLayout;
  copyPipeline: GPURenderPipeline;
  renderLayout: GPUBindGroupLayout;
  /** 1×1 stand-in bound while there is no depth to read. */
  dummy: GPUTexture;
  copy: GPUTexture | null;
  copyGroup: GPUBindGroup | null;
  /** The source depth texture `srcGroup` was made for. */
  src: Texture | null;
  srcGroup: GPUBindGroup | null;
  att: GPURenderPassDepthStencilAttachment;
  passDesc: GPURenderPassDescriptor;
}

/** Live-particle counter and its readback. */
interface AliveCounter {
  pipeline: GPUComputePipeline;
  group: GPUBindGroup;
  count: GPUBuffer;
  read: GPUBuffer;
  params: GPUBuffer;
  /** idle → copied (count recorded) → mapping (next frame) → idle. */
  state: 'idle' | 'copied' | 'mapping' | 'dead';
}

/** The extended kernel's extra resources (world space or `extended` 2D). */
interface Fx {
  computeLayout: GPUBindGroupLayout;
  computeGroup: GPUBindGroup;
  advancePipeline: GPUComputePipeline;
  subPipeline: GPUComputePipeline;
  /** Ring head, request count and the sub-emission requests. */
  state: GPUBuffer;
  /** The sub-emitter spawn records (`subData`). */
  subs: GPUBuffer;
  subData: Float32Array<ArrayBuffer>;
  subSlots: WeakMap<object, number>;
  subNext: number;
  subUsed: number;
  subDirty: boolean;
  /** The curve table (`curveData`). */
  curves: GPUBuffer;
  curveData: Float32Array<ArrayBuffer>;
  sizeSlots: WeakMap<object, number>;
  colorSlots: WeakMap<object, number>;
  sizeNext: number;
  colorNext: number;
  curveDirty: boolean;
  /** The mesh surfaces (`surfaceData`, grows; the buffer follows in `prepare`). */
  surface: GPUBuffer;
  surfaceData: Float32Array<ArrayBuffer>;
  surfaceUsed: number;
  surfaceSlots: WeakMap<object, { offset: number; count: number }>;
  surfaceDirty: boolean;
  sheet: GPUTextureView;
  sampler: GPUSampler;
  /** 1×1 white, bound when the system has no `texture`. */
  white: GPUTexture | null;
  textured: boolean;
  columns: number;
  rows: number;
  /** Particles emitted this frame (the ring head advances by it on the GPU). */
  spawnTotal: number;
  warnedSubs: boolean;
  warnedCurves: boolean;
}

/** Depth collision resources (world, `collide`). */
interface Collider {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  uniform: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  group: GPUBindGroup | null;
  view: GPUTextureView | null;
}

/**
 * GPU particles: spawn + integrate in compute, rendered as additive (or alpha) quads into both
 * scene targets (colour + emissive → bloom). Draw with `frame.drawable(system)`.
 *
 * In 2D (`space: '2d'`, the default) quads are velocity-stretched in the XY plane. In world
 * space they face the camera, stretch along the velocity's projection on the view plane,
 * test depth, fade by distance and near scene geometry, and may be lit.
 *
 * The extended kernel (world space, or 2D with `extended`) adds sprite sheets, spin, curves,
 * `forces`, depth collision, sub-emission and mesh emission; the plain 2D kernel stays what it
 * was, pixel for pixel.
 *
 * Particles live in a ring buffer: when full, the oldest are overwritten.
 */
export class ParticleSystem implements Drawable {
  readonly capacity: number;
  readonly space: '2d' | 'world';
  /** Whether this system runs the extended kernel. */
  readonly extended: boolean;
  /** Multiplier on every emit count (set < 1 for prefers-reduced-motion). */
  spawnScale = 1;
  floorY: number;
  bounce: number;
  stretch: number;
  /** World space only: see `ParticleSystemOptions.lit`. */
  lit: boolean;
  /** World space only: see `ParticleSystemOptions.fade` (null = no distance fade). */
  fade: { near: number; far: number } | null;
  /** World space only: see `ParticleSystemOptions.softness`. */
  softness: number;
  /** World space only: the target soft particles read depth from (null = `renderer.target`). */
  depthTarget: SceneTarget | null;
  /** See `ParticleSystemOptions.readsDepth`. Live. */
  readsDepth: boolean;
  /** Live particles at the last readback (`countAlive` only; -1 before the first). */
  alive = -1;
  /** Live particles below `countBelowY` at the last readback (`countAlive` only; -1 before the first). */
  below = -1;
  /** Live: the forces applied each frame (extended kernel; the first `MAX_FORCES` count). */
  readonly forces: ParticleForce[];
  /** Live: depth collision parameters (world, `readsDepth`; null = off). */
  collide: { bounce: number; friction: number; thickness?: number } | null;

  private readonly renderer: Renderer;
  private readonly device: GPUDevice;
  private readonly particleBuffer: GPUBuffer;
  private readonly spawnBuffer: GPUBuffer;
  private readonly simBuffer: GPUBuffer;
  private readonly spawnData: Float32Array<ArrayBuffer>;
  private readonly simData: Float32Array<ArrayBuffer>;
  private readonly spawnFloats: number;
  private readonly maxSpawns: number;
  private readonly spawnPipeline: GPUComputePipeline;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly renderPipeline: GPURenderPipeline;
  /** Per depth format: the same pipeline with a test-only `depthStencil` (made on first use). */
  private readonly depthPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private readonly renderDesc: GPURenderPipelineDescriptor;
  private computeGroup: GPUBindGroup;
  private readonly renderGroup: GPUBindGroup;
  private readonly soft: SoftDepth | null = null;
  private readonly counter: AliveCounter | null = null;
  private readonly fx: Fx | null = null;
  private readonly collider: Collider | null = null;
  /** Whether this frame's `prepare` copied scene depth (world space). */
  private softActive = false;
  /** The renderer's `depthCopy` view `hookGroup` was made for (`readsDepth`). */
  private hookView: GPUTextureView | null = null;
  private hookGroup: GPUBindGroup | null = null;
  /** The group `draw` binds: own copy, the renderer's copy, or the stand-in. */
  private depthGroup: GPUBindGroup | null = null;
  private spawnCount = 0;
  private maxSpawnInCmd = 0;
  private head = 0;
  private pendingDt = 0;
  private time = 0;
  private warnedOverflow = false;
  private warnedExtended = false;
  private clearPending = false;

  constructor(renderer: Renderer, opts: ParticleSystemOptions = {}) {
    const device = renderer.device;
    this.renderer = renderer;
    this.device = device;
    const world = opts.space === 'world';
    const fx =
      world ||
      !!opts.extended ||
      !!opts.texture ||
      !!opts.collide ||
      !!opts.atlas ||
      (opts.forces?.length ?? 0) > 0;
    this.space = world ? 'world' : '2d';
    this.extended = fx;
    this.capacity = Math.max(64, Math.floor(opts.capacity ?? 65536));
    this.maxSpawns = opts.maxSpawnsPerFrame ?? 256;
    this.floorY = opts.floorY ?? (world ? -1e9 : 1e9);
    this.bounce = opts.bounce ?? 0.35;
    this.stretch = opts.stretch ?? 0.02;
    this.lit = opts.lit ?? false;
    this.fade = opts.fade ? { near: opts.fade.near, far: opts.fade.far } : null;
    this.softness = opts.softness ?? 0.25;
    this.depthTarget = opts.depthTarget ?? null;
    this.readsDepth = opts.readsDepth ?? false;
    this.forces = opts.forces ?? [];
    this.collide = world && opts.collide ? opts.collide : null;
    this.spawnFloats = fx ? FX_SPAWN_FLOATS : SPAWN_FLOATS;
    this.simData = new Float32Array(fx ? FX_SIM_FLOATS : SIM_FLOATS);

    this.particleBuffer = device.createBuffer({
      label: 'particles',
      size: this.capacity * (fx ? FX_PARTICLE_BYTES : PARTICLE_BYTES),
      // COPY_DST: `clear()` zeroes it with `encoder.clearBuffer`.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.spawnData = new Float32Array(this.maxSpawns * this.spawnFloats);
    this.spawnBuffer = device.createBuffer({
      label: 'particle-spawns',
      size: this.spawnData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.simBuffer = device.createBuffer({
      label: 'particle-sim',
      size: this.simData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const computeEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: {} },
    ];
    if (fx) {
      computeEntries.push(
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      );
    }
    const computeLayout = device.createBindGroupLayout({
      label: 'particles-compute-layout',
      entries: computeEntries,
    });
    const cmod = createShaderModule(
      device,
      world ? PARTICLE_WORLD_COMPUTE_WGSL : fx ? PARTICLE_EXT_COMPUTE_WGSL : PARTICLE_COMPUTE_WGSL,
      world ? 'particles-world-compute' : fx ? 'particles-ext-compute' : 'particles-compute',
    );
    const cpl = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
    this.spawnPipeline = device.createComputePipeline({
      label: 'particles-spawn',
      layout: cpl,
      compute: { module: cmod, entryPoint: 'spawn' },
    });
    this.updatePipeline = device.createComputePipeline({
      label: 'particles-update',
      layout: cpl,
      compute: { module: cmod, entryPoint: 'update' },
    });
    if (fx) {
      this.fx = this.makeFx(computeLayout, cmod, cpl, opts);
      this.computeGroup = this.fx.computeGroup;
    } else {
      this.computeGroup = device.createBindGroup({
        label: 'particles-compute',
        layout: computeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffer } },
          { binding: 1, resource: { buffer: this.spawnBuffer } },
          { binding: 2, resource: { buffer: this.simBuffer } },
        ],
      });
    }

    const renderEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    ];
    if (world) {
      renderEntries.push({
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth' },
      });
    }
    if (fx) {
      renderEntries.push(
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      );
    }
    const renderLayout = device.createBindGroupLayout({
      label: world ? 'particles-world-render-layout' : 'particles-render-layout',
      entries: renderEntries,
    });
    const rmod = createShaderModule(
      device,
      world ? PARTICLE_WORLD_RENDER_WGSL : fx ? PARTICLE_EXT_RENDER_WGSL : PARTICLE_RENDER_WGSL,
      world ? 'particles-world-render' : fx ? 'particles-ext-render' : 'particles-render',
    );
    const blend = opts.blend === 'alpha' ? PREMULTIPLIED : ADDITIVE;
    this.renderDesc = {
      label: world ? 'particles-world' : 'particles-render',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [renderer.globalsLayout, renderLayout],
      }),
      vertex: { module: rmod, entryPoint: 'vs' },
      fragment: {
        module: rmod,
        entryPoint: 'fs',
        targets: renderer.sceneFormats.map((format) => ({ format, blend })),
      },
      primitive: { topology: 'triangle-list' },
    };
    this.renderPipeline = device.createRenderPipeline(this.renderDesc);

    if (world) this.soft = this.makeSoftDepth(renderLayout);
    this.renderGroup = this.makeRenderGroup(
      world ? 'particles-world-render' : 'particles-render',
      renderLayout,
      this.soft ? this.soft.dummy.createView() : null,
    );
    if (world && opts.collide) this.collider = this.makeCollider();
    if (opts.countAlive) this.counter = this.makeCounter(fx, opts.countBelowY ?? -Infinity);
  }

  /** A render bind group: the particles and sim, the depth view (world), the fx table/sheet. */
  private makeRenderGroup(
    label: string,
    layout: GPUBindGroupLayout,
    depth: GPUTextureView | null,
  ): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.particleBuffer } },
      { binding: 1, resource: { buffer: this.simBuffer } },
    ];
    if (depth) entries.push({ binding: 2, resource: depth });
    const fx = this.fx;
    if (fx) {
      entries.push(
        { binding: 3, resource: { buffer: fx.curves } },
        { binding: 4, resource: fx.sheet },
        { binding: 5, resource: fx.sampler },
      );
    }
    return this.device.createBindGroup({ label, layout, entries });
  }

  private makeFx(
    computeLayout: GPUBindGroupLayout,
    cmod: GPUShaderModule,
    cpl: GPUPipelineLayout,
    opts: ParticleSystemOptions,
  ): Fx {
    const device = this.device;
    const maxSubs = Math.max(1, Math.floor(opts.maxSubEmitters ?? 16));
    const maxCurves = Math.max(1, Math.floor(opts.maxCurves ?? 32));
    const state = device.createBuffer({
      label: 'particles-state',
      size: 16 + this.maxSpawns * FX_REQUEST_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const subData = new Float32Array(maxSubs * FX_SPAWN_FLOATS);
    const subs = device.createBuffer({
      label: 'particles-subs',
      size: subData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const curveData = new Float32Array(maxCurves * (SIZE_CURVE_FLOATS + COLOR_CURVE_FLOATS));
    const curves = device.createBuffer({
      label: 'particles-curves',
      size: curveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const surfaceData = new Float32Array(SURFACE_TRI_FLOATS);
    const surface = device.createBuffer({
      label: 'particles-surface',
      size: surfaceData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    let white: GPUTexture | null = null;
    let sheet: GPUTextureView;
    if (opts.texture) {
      sheet = opts.texture.view;
    } else {
      white = device.createTexture({
        label: 'particles-sheet-none',
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: white },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1],
      );
      sheet = white.createView();
    }
    const sampler = device.createSampler({
      label: 'particles-sheet',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const fx: Fx = {
      computeLayout,
      computeGroup: null as unknown as GPUBindGroup,
      advancePipeline: device.createComputePipeline({
        label: 'particles-advance',
        layout: cpl,
        compute: { module: cmod, entryPoint: 'advance' },
      }),
      subPipeline: device.createComputePipeline({
        label: 'particles-subspawn',
        layout: cpl,
        compute: { module: cmod, entryPoint: 'subspawn' },
      }),
      state,
      subs,
      subData,
      subSlots: new WeakMap(),
      subNext: 0,
      subUsed: 0,
      subDirty: false,
      curves,
      curveData,
      sizeSlots: new WeakMap(),
      colorSlots: new WeakMap(),
      sizeNext: 0,
      colorNext: 0,
      curveDirty: false,
      surface,
      surfaceData,
      surfaceUsed: 0,
      surfaceSlots: new WeakMap(),
      surfaceDirty: false,
      sheet,
      sampler,
      white,
      textured: !!opts.texture,
      columns: Math.max(1, Math.floor(opts.atlas?.columns ?? 1)),
      rows: Math.max(1, Math.floor(opts.atlas?.rows ?? 1)),
      spawnTotal: 0,
      warnedSubs: false,
      warnedCurves: false,
    };
    fx.computeGroup = this.makeComputeGroup(fx);
    const s = this.simData;
    s[17] = maxCurves * SIZE_CURVE_FLOATS;
    s[18] = this.maxSpawns;
    return fx;
  }

  private makeComputeGroup(fx: Fx): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'particles-compute',
      layout: fx.computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.spawnBuffer } },
        { binding: 2, resource: { buffer: this.simBuffer } },
        { binding: 3, resource: { buffer: fx.state } },
        { binding: 4, resource: { buffer: fx.subs } },
        { binding: 5, resource: { buffer: fx.surface } },
      ],
    });
  }

  private makeSoftDepth(renderLayout: GPUBindGroupLayout): SoftDepth {
    const device = this.device;
    const copyLayout = device.createBindGroupLayout({
      label: 'particles-depth-copy-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    const mod = createShaderModule(device, PARTICLE_DEPTH_COPY_WGSL, 'particles-depth-copy');
    const copyPipeline = device.createRenderPipeline({
      label: 'particles-depth-copy',
      layout: device.createPipelineLayout({ bindGroupLayouts: [copyLayout] }),
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: SOFT_DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'always',
      },
    });
    const dummy = device.createTexture({
      label: 'particles-depth-none',
      size: [1, 1],
      format: SOFT_DEPTH_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const att: GPURenderPassDepthStencilAttachment = {
      view: undefined as unknown as GPUTextureView,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    return {
      copyLayout,
      copyPipeline,
      renderLayout,
      dummy,
      copy: null,
      copyGroup: null,
      src: null,
      srcGroup: null,
      att,
      passDesc: {
        label: 'particles-depth-copy',
        colorAttachments: [],
        depthStencilAttachment: att,
      },
    };
  }

  private makeCollider(): Collider {
    const device = this.device;
    const layout = device.createBindGroupLayout({
      label: 'particles-collide-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
      ],
    });
    const pipeline = device.createComputePipeline({
      label: 'particles-collide',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: createShaderModule(device, PARTICLE_COLLIDE_WGSL, 'particles-collide'),
        entryPoint: 'collide',
      },
    });
    const data = new Float32Array(COLLIDE_FLOATS);
    const uniform = device.createBuffer({
      label: 'particles-collide-params',
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return { pipeline, layout, uniform, data, group: null, view: null };
  }

  private makeCounter(fx: boolean, belowY: number): AliveCounter {
    const device = this.device;
    const count = device.createBuffer({
      label: 'particles-alive',
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const read = device.createBuffer({
      label: 'particles-alive-read',
      size: 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const params = device.createBuffer({
      label: 'particles-alive-params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // capacity, vec4s per particle, index of the `life` vec4, index of the position vec4, belowY.
    const p = new ArrayBuffer(32);
    new Uint32Array(p, 0, 4).set([this.capacity, fx ? 10 : 5, fx ? 4 : 3, 0]);
    new Float32Array(p, 16, 1)[0] = belowY;
    device.queue.writeBuffer(params, 0, p);
    const layout = device.createBindGroupLayout({
      label: 'particles-alive-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      ],
    });
    const pipeline = device.createComputePipeline({
      label: 'particles-alive',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: createShaderModule(device, PARTICLE_COUNT_WGSL, 'particles-alive'),
        entryPoint: 'count',
      },
    });
    const group = device.createBindGroup({
      label: 'particles-alive',
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: count } },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    return { pipeline, group, count, read, params, state: 'idle' };
  }

  /** Queue `count` new particles. Cheap: one small record, spawned on the GPU next frame. */
  emit(p: EmitParams, count: number): void {
    const n = Math.min(Math.floor(count * this.spawnScale), this.capacity);
    if (n <= 0) return;
    if (this.spawnCount >= this.maxSpawns) {
      if (!this.warnedOverflow) {
        console.warn(`[particles] more than ${this.maxSpawns} emits in one frame; dropping`);
        this.warnedOverflow = true;
      }
      return;
    }
    const o = this.spawnCount++ * this.spawnFloats;
    const fx = this.fx;
    if (fx) {
      this.writeFxSpawn(this.spawnData, p, n, fx.spawnTotal, o, 0);
      fx.spawnTotal += n;
    } else {
      this.writeSpawn(p, n, o);
      this.head = (this.head + n) % this.capacity;
    }
    if (n > this.maxSpawnInCmd) this.maxSpawnInCmd = n;
  }

  private writeSpawn(p: EmitParams, n: number, at: number): void {
    const d = this.spawnData;
    let o = at;
    const shape = p.shape ?? POINT;
    let sa = 0;
    let sb = 0;
    if (shape.kind === 'circle' || shape.kind === 'sphere') sa = shape.radius;
    else if (shape.kind === 'rect' || shape.kind === 'box') {
      sa = shape.width;
      sb = shape.height;
    } else if (shape.kind === 'line') {
      sa = shape.dx;
      sb = shape.dy;
    }
    if (
      !this.warnedExtended &&
      (shape.kind === 'mesh' ||
        p.tile !== undefined ||
        p.rotation ||
        p.spin ||
        p.sizeCurve ||
        p.colorCurve ||
        p.onDeath ||
        p.onLife)
    ) {
      console.warn('[particles] sprite, spin, curve, mesh and sub-emission fields need `extended`');
      this.warnedExtended = true;
    }
    const speed = p.speed ?? [80, 300];
    const life = p.life ?? [0.5, 1.2];
    const size = p.size ?? [6, 1];
    const c0 = p.colorStart;
    const c1 = p.colorEnd;
    const g = p.gravity ?? [0, 400];
    // a
    d[o++] = p.x;
    d[o++] = p.y;
    d[o++] = sa;
    d[o++] = sb;
    // b
    d[o++] = p.angle ?? -Math.PI / 2;
    d[o++] = p.spread ?? Math.PI * 2;
    d[o++] = speed[0];
    d[o++] = speed[1];
    // c
    d[o++] = life[0];
    d[o++] = life[1];
    d[o++] = size[0];
    d[o++] = size[1];
    // c0, c1
    o = writeColors(d, o, c0, c1);
    // d
    d[o++] = g[0];
    d[o++] = g[1];
    d[o++] = p.drag ?? 1;
    d[o++] = shape.kind === 'mesh' ? 0 : SHAPE_ID[shape.kind];
    // e
    d[o++] = this.head;
    d[o++] = n;
    d[o++] = Math.floor(Math.random() * 16777215);
    d[o++] = p.emissive ?? 1;
  }

  /**
   * An extended spawn record at `at` of `d`: `n` particles from `start` (relative to the
   * frame's ring head). `depth` 1 writes a sub-emitter record (no sub-emitters of its own).
   */
  private writeFxSpawn(
    d: Float32Array,
    p: EmitParams,
    n: number,
    start: number,
    at: number,
    depth: number,
  ): void {
    const world = this.space === 'world';
    const fx = this.fx!;
    let o = at;
    const shape = p.shape ?? POINT;
    let sa = 0;
    let sb = 0;
    let sc = 0;
    let meshOffset = 0;
    let meshCount = 0;
    let flags = p.alignToVelocity === false ? 0 : 1;
    if (shape.kind === 'circle' || shape.kind === 'sphere') sa = shape.radius;
    else if (shape.kind === 'rect') {
      sa = shape.width;
      sb = shape.height;
    } else if (shape.kind === 'box') {
      sa = shape.width;
      sb = shape.height;
      sc = world ? shape.depth : 0;
    } else if (shape.kind === 'line') {
      sa = shape.dx;
      sb = shape.dy;
      sc = world ? (shape.dz ?? 0) : 0;
    } else if (shape.kind === 'mesh') {
      const m = this.internSurface(shape);
      meshOffset = m.offset;
      meshCount = m.count;
      if (shape.alongNormal) flags |= 2;
    }
    const speed = p.speed ?? (world ? WORLD_SPEED : SPEED_2D);
    const life = p.life ?? LIFE;
    const size = p.size ?? (world ? WORLD_SIZE : SIZE_2D);
    const g = p.gravity ?? (world ? WORLD_GRAVITY : GRAVITY_2D);
    const w = p.wind ?? ZERO3;
    const tile = p.tile ?? 0;
    const rot = p.rotation ?? ZERO2;
    const spin = p.spin ?? ZERO2;
    const sizeSlot = p.sizeCurve ? this.internCurve(fx, p.sizeCurve, false) : -1;
    const colorSlot = p.colorCurve ? this.internCurve(fx, p.colorCurve, true) : -1;
    let deathSlot = -1;
    let lifeSlot = -1;
    if (depth === 0) {
      if (p.onDeath && p.onDeath.count > 0) {
        deathSlot = this.internSub(fx, p.onDeath, p.onDeath.params, p.inherit ?? 0);
      }
      if (p.onLife && p.onLife.rate > 0) {
        lifeSlot = this.internSub(fx, p.onLife, p.onLife.params, p.inherit ?? 0);
      }
    }
    // a
    d[o++] = p.x;
    d[o++] = p.y;
    d[o++] = world ? (p.z ?? 0) : 0;
    d[o++] = world ? WORLD_SHAPE_ID[shape.kind] : SHAPE_ID[shape.kind];
    // b
    d[o++] = sa;
    d[o++] = sb;
    d[o++] = sc;
    d[o++] = p.spread ?? Math.PI * 2;
    // c
    d[o++] = p.angle ?? (world ? Math.PI / 2 : -Math.PI / 2);
    d[o++] = world ? (p.vz ?? 0) : 0;
    d[o++] = speed[0];
    d[o++] = speed[1];
    // d
    d[o++] = life[0];
    d[o++] = life[1];
    d[o++] = size[0];
    d[o++] = size[1];
    // c0, c1
    o = writeColors(d, o, p.colorStart, p.colorEnd);
    // e
    d[o++] = g[0];
    d[o++] = g[1];
    d[o++] = world ? (g[2] ?? 0) : 0;
    d[o++] = p.drag ?? 1;
    // f
    d[o++] = world ? w[0] : 0;
    d[o++] = world ? w[1] : 0;
    d[o++] = world ? w[2] : 0;
    d[o++] = p.emissive ?? 1;
    // g
    d[o++] = start;
    d[o++] = n;
    d[o++] = Math.floor(Math.random() * 16777215);
    d[o++] = p.inherit ?? 0;
    // h
    d[o++] = typeof tile === 'number' ? tile : tile[0];
    d[o++] = typeof tile === 'number' ? tile : tile[1];
    d[o++] = p.tileRate ?? 0;
    d[o++] = flags;
    // i
    d[o++] = rot[0];
    d[o++] = rot[1];
    d[o++] = spin[0];
    d[o++] = spin[1];
    // j
    d[o++] = sizeSlot;
    d[o++] = colorSlot;
    d[o++] = deathSlot;
    d[o++] = lifeSlot;
    // k
    d[o++] = p.onDeath?.count ?? 0;
    d[o++] = p.onLife?.rate ?? 0;
    d[o++] = meshOffset;
    d[o++] = meshCount;
  }

  /** The curve table slot of `stops` (by identity; rewritten on every emit, so edits are live). */
  private internCurve(
    fx: Fx,
    stops: readonly number[] | readonly ArrayLike<number>[],
    color: boolean,
  ): number {
    const n = stops.length;
    if (n < 2 || n > MAX_CURVE_STOPS) {
      throw new Error(`[particles] a curve needs 2..${MAX_CURVE_STOPS} stops, got ${n}`);
    }
    const slots = color ? fx.colorSlots : fx.sizeSlots;
    const maxCurves = this.simData[17]! / SIZE_CURVE_FLOATS;
    let slot = slots.get(stops);
    if (slot === undefined) {
      const next = color ? fx.colorNext : fx.sizeNext;
      slot = next % maxCurves;
      if (next >= maxCurves && !fx.warnedCurves) {
        console.warn(`[particles] more than ${maxCurves} distinct curves; reusing slots`);
        fx.warnedCurves = true;
      }
      if (color) fx.colorNext = next + 1;
      else fx.sizeNext = next + 1;
      slots.set(stops, slot);
    }
    const t = fx.curveData;
    if (color) {
      const base = maxCurves * SIZE_CURVE_FLOATS + slot * COLOR_CURVE_FLOATS;
      t[base] = n;
      for (let i = 0; i < n; i++) {
        const c = (stops as readonly ArrayLike<number>[])[i]!;
        t[base + 4 + i * 4] = c[0]!;
        t[base + 5 + i * 4] = c[1]!;
        t[base + 6 + i * 4] = c[2]!;
        t[base + 7 + i * 4] = c[3] ?? 1;
      }
    } else {
      const base = slot * SIZE_CURVE_FLOATS;
      t[base] = n;
      for (let i = 0; i < n; i++) t[base + 1 + i] = (stops as readonly number[])[i]!;
    }
    fx.curveDirty = true;
    return slot;
  }

  /** The sub-emitter record slot of `key` (by identity; rewritten on every parent emit). */
  private internSub(fx: Fx, key: object, params: EmitParams, inherit: number): number {
    const maxSubs = fx.subData.length / FX_SPAWN_FLOATS;
    let slot = fx.subSlots.get(key);
    if (slot === undefined) {
      slot = fx.subNext % maxSubs;
      if (fx.subNext >= maxSubs && !fx.warnedSubs) {
        console.warn(`[particles] more than ${maxSubs} distinct sub-emitters; reusing slots`);
        fx.warnedSubs = true;
      }
      fx.subNext++;
      fx.subUsed = Math.min(fx.subNext, maxSubs);
      fx.subSlots.set(key, slot);
    }
    this.writeFxSpawn(fx.subData, params, 0, 0, slot * FX_SPAWN_FLOATS, 1);
    fx.subData[slot * FX_SPAWN_FLOATS + 35] = inherit;
    fx.subDirty = true;
    return slot;
  }

  /** The surface table range of a mesh shape (built and appended on first sight). */
  private internSurface(shape: EmitShape & { kind: 'mesh' }): { offset: number; count: number } {
    const fx = this.fx!;
    let m = fx.surfaceSlots.get(shape);
    if (m) return m;
    const surface: EmitSurface =
      'table' in shape ? (shape as EmitSurface) : buildEmitSurface(shape, shape);
    const floats = surface.triangles * SURFACE_TRI_FLOATS;
    if (fx.surfaceUsed + floats > fx.surfaceData.length) {
      const grown = new Float32Array(Math.max(fx.surfaceUsed + floats, fx.surfaceData.length * 2));
      grown.set(fx.surfaceData.subarray(0, fx.surfaceUsed));
      fx.surfaceData = grown;
    }
    fx.surfaceData.set(surface.table.subarray(0, floats), fx.surfaceUsed);
    m = { offset: fx.surfaceUsed / 4, count: surface.triangles };
    fx.surfaceUsed += floats;
    fx.surfaceDirty = true;
    fx.surfaceSlots.set(shape, m);
    return m;
  }

  /** Advance simulation time. Call from fixed update; integration happens on the GPU. */
  update(dt: number): void {
    this.pendingDt += dt;
  }

  prepare(encoder: GPUCommandEncoder, frame?: Frame): void {
    const dt = Math.min(this.pendingDt, 0.1);
    this.pendingDt = 0;
    this.time += dt;
    const s = this.simData;
    const fx = this.fx;
    s[0] = dt;
    s[1] = this.floorY;
    s[2] = this.bounce;
    s[3] = this.time;
    s[4] = this.capacity;
    s[5] = this.stretch;
    s[6] = this.spawnCount;
    s[7] = fx ? fx.spawnTotal : 0;
    if (this.soft) {
      // With `readsDepth` the renderer's hook (`afterOpaque`) supplies this frame's depth.
      this.softActive = this.readsDepth ? false : this.copyDepth(encoder, frame);
      this.depthGroup = this.softActive ? this.soft.copyGroup : null;
      const f = this.fade;
      s[8] = f ? f.near : 0;
      s[9] = f ? f.far : 0;
      s[10] = this.softness;
      s[11] = this.softActive ? 1 : 0;
      s[12] = this.lit ? 1 : 0;
    }
    if (fx) {
      s[13] = fx.textured ? 1 : 0;
      s[14] = fx.columns;
      s[15] = fx.rows;
      s[16] = this.writeForces(s);
    }
    const q = this.device.queue;
    q.writeBuffer(this.simBuffer, 0, s);
    if (this.clearPending) {
      encoder.clearBuffer(this.particleBuffer);
      if (fx) encoder.clearBuffer(fx.state);
      this.clearPending = false;
    }
    if (fx) this.uploadTables(fx);
    const counter = this.counter;
    if (counter?.state === 'copied') this.readAlive(counter);
    const count = counter?.state === 'idle';
    if (count) encoder.clearBuffer(counter.count);
    const pass = encoder.beginComputePass({ label: 'particles' });
    pass.setBindGroup(0, this.computeGroup);
    if (this.spawnCount > 0) {
      q.writeBuffer(
        this.spawnBuffer,
        0,
        this.spawnData.buffer,
        0,
        this.spawnCount * this.spawnFloats * 4,
      );
      pass.setPipeline(this.spawnPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.maxSpawnInCmd / 64), this.spawnCount);
    }
    if (fx) {
      pass.setPipeline(fx.advancePipeline);
      pass.dispatchWorkgroups(1);
    }
    if (dt > 0) {
      pass.setPipeline(this.updatePipeline);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
      if (fx && fx.subUsed > 0) {
        pass.setPipeline(fx.subPipeline);
        pass.dispatchWorkgroups(Math.ceil(this.maxSpawns / 64));
      }
    }
    if (count) {
      pass.setPipeline(counter.pipeline);
      pass.setBindGroup(0, counter.group);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    }
    pass.end();
    if (count) {
      encoder.copyBufferToBuffer(counter.count, 0, counter.read, 0, 8);
      counter.state = 'copied';
    }
    this.spawnCount = 0;
    this.maxSpawnInCmd = 0;
    if (fx) fx.spawnTotal = 0;
    this.warnedOverflow = false;
  }

  /** Pack `forces` (the first `MAX_FORCES`) into the sim block; returns how many. */
  private writeForces(s: Float32Array): number {
    const forces = this.forces;
    const n = Math.min(forces.length, MAX_FORCES);
    for (let i = 0; i < n; i++) {
      const f = forces[i]!;
      const o = 20 + i * 12;
      s[o] = FORCE_ID[f.kind];
      for (let k = 1; k < 12; k++) s[o + k] = 0;
      if (f.kind === 'attract' || f.kind === 'vortex') {
        s[o + 1] = f.x;
        s[o + 2] = f.y;
        s[o + 3] = f.z ?? 0;
        s[o + 4] = f.strength;
        s[o + 5] = f.radius ?? 0;
        if (f.kind === 'vortex') {
          s[o + 8] = f.axis[0];
          s[o + 9] = f.axis[1];
          s[o + 10] = f.axis[2];
        }
      } else if (f.kind === 'turbulence') {
        s[o + 4] = f.strength;
        s[o + 6] = f.frequency;
        s[o + 7] = f.seed ?? 0;
      } else {
        s[o + 11] = f.amount;
      }
    }
    return n;
  }

  /** Upload the dirty curve, sub-emitter and surface tables (the surface buffer may grow). */
  private uploadTables(fx: Fx): void {
    const q = this.device.queue;
    if (fx.curveDirty) {
      q.writeBuffer(fx.curves, 0, fx.curveData);
      fx.curveDirty = false;
    }
    if (fx.subDirty) {
      q.writeBuffer(fx.subs, 0, fx.subData.buffer, 0, fx.subUsed * FX_SPAWN_FLOATS * 4);
      fx.subDirty = false;
    }
    if (fx.surfaceDirty) {
      const bytes = fx.surfaceUsed * 4;
      if (bytes > fx.surface.size) {
        fx.surface.destroy();
        fx.surface = this.device.createBuffer({
          label: 'particles-surface',
          size: fx.surfaceData.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        fx.computeGroup = this.makeComputeGroup(fx);
        this.computeGroup = fx.computeGroup;
      }
      q.writeBuffer(fx.surface, 0, fx.surfaceData.buffer, 0, bytes);
      fx.surfaceDirty = false;
    }
  }

  /**
   * Map last frame's count (its commands were submitted by now). This frame records nothing
   * into the readback buffer, so mapping it while this frame is encoded is valid.
   */
  private readAlive(c: AliveCounter): void {
    c.state = 'mapping';
    c.read.mapAsync(GPUMapMode.READ).then(
      () => {
        if (c.state !== 'mapping') return;
        const counts = new Uint32Array(c.read.getMappedRange(0, 8));
        this.alive = counts[0]!;
        this.below = counts[1] ?? 0;
        c.read.unmap();
        c.state = 'idle';
      },
      () => {
        c.state = 'dead';
      },
    );
  }

  /**
   * World space: copy the scene's depth into this system's own depth32float texture, which the
   * fragment shader samples for the soft fade. It runs before this frame's scene pass, so it
   * holds what the target's depth held then: the previous frame's, or that of an earlier
   * `render` call this frame (draw the particles on their own layer in a second view of the
   * same camera for a same-frame fade). Returns false (soft fade off) without depth.
   */
  private copyDepth(encoder: GPUCommandEncoder, frame: Frame | undefined): boolean {
    const sd = this.soft!;
    if (this.softness <= 0 || !frame?.depthFormat) return false;
    const src = (this.depthTarget ?? this.renderer.target).depth;
    if (!src) return false;
    const device = this.device;
    if (!sd.copy || sd.copy.width !== src.width || sd.copy.height !== src.height) {
      sd.copy?.destroy();
      sd.copy = device.createTexture({
        label: 'particles-depth',
        size: [src.width, src.height],
        format: SOFT_DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = sd.copy.createView();
      sd.att.view = view;
      sd.copyGroup = this.makeRenderGroup('particles-world-render-soft', sd.renderLayout, view);
    }
    if (sd.src !== src) {
      sd.src = src;
      sd.srcGroup = device.createBindGroup({
        label: 'particles-depth-copy',
        layout: sd.copyLayout,
        entries: [{ binding: 0, resource: src.view }],
      });
    }
    const pass = encoder.beginRenderPass(sd.passDesc);
    pass.setPipeline(sd.copyPipeline);
    pass.setBindGroup(0, sd.srcGroup!);
    pass.draw(3);
    pass.end();
    return true;
  }

  /**
   * Draw inside the scene pass. With a depth camera (`frame.depthFormat` set) the pipeline
   * tests against depth without writing it, like any blended material.
   */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    const fmt = frame?.depthFormat ?? null;
    pass.setPipeline(fmt ? this.depthPipeline(fmt) : this.renderPipeline);
    pass.setBindGroup(1, this.depthGroup ?? this.renderGroup);
    pass.draw(6, this.capacity);
  }

  /**
   * The renderer's depth hook (`readsDepth`, world space): with `softness` > 0 bind this
   * frame's opaque depth copy and flip the shader's soft flag on (a 4-byte write that lands
   * before the frame's commands run); with `collide` run the collision kernel against the same
   * depth. New bind groups only when the copy texture changed.
   */
  afterOpaque(encoder: GPUCommandEncoder, view: ViewInfo): void {
    const sd = this.soft;
    if (!sd) return;
    if (this.softness > 0) {
      if (view.depthView !== this.hookView) {
        this.hookView = view.depthView;
        this.hookGroup = this.makeRenderGroup(
          'particles-world-render-hook',
          sd.renderLayout,
          view.depthView,
        );
      }
      this.softActive = true;
      this.depthGroup = this.hookGroup;
      const s = this.simData;
      s[11] = 1;
      this.device.queue.writeBuffer(this.simBuffer, 11 * 4, s.buffer, 11 * 4, 4);
    }
    const col = this.collider;
    const params = this.collide;
    if (col && params) {
      if (view.depthView !== col.view) {
        col.view = view.depthView;
        col.group = this.device.createBindGroup({
          label: 'particles-collide',
          layout: col.layout,
          entries: [
            { binding: 0, resource: { buffer: this.particleBuffer } },
            { binding: 1, resource: { buffer: col.uniform } },
            { binding: 2, resource: view.depthView },
          ],
        });
      }
      const d = col.data;
      d.set(view.camera.viewProjection, 0);
      d.set(view.camera.invViewProj, 16);
      const vp = view.viewport;
      d[32] = vp.x;
      d[33] = vp.y;
      d[34] = vp.width;
      d[35] = vp.height;
      d[36] = params.bounce;
      d[37] = params.friction;
      d[38] = params.thickness ?? 1;
      d[39] = 0;
      this.device.queue.writeBuffer(col.uniform, 0, d);
      const pass = encoder.beginComputePass({ label: 'particles-collide' });
      pass.setPipeline(col.pipeline);
      pass.setBindGroup(0, col.group!);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
      pass.end();
    }
  }

  private depthPipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.depthPipelines.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        ...this.renderDesc,
        label: `${this.renderDesc.label}:${format}`,
        depthStencil: { format, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      this.depthPipelines.set(format, p);
    }
    return p;
  }

  /**
   * Kill every particle (e.g. on scene change), including emits queued earlier this frame.
   * The buffer is zeroed on the GPU at the start of the next `prepare` (no CPU allocation);
   * particles emitted after `clear()` survive.
   */
  clear(): void {
    this.clearPending = true;
    this.spawnCount = 0;
    this.maxSpawnInCmd = 0;
    this.head = 0;
    if (this.fx) this.fx.spawnTotal = 0;
  }

  destroy(): void {
    this.particleBuffer.destroy();
    this.spawnBuffer.destroy();
    this.simBuffer.destroy();
    if (this.soft) {
      this.soft.dummy.destroy();
      this.soft.copy?.destroy();
      this.soft.copy = null;
    }
    if (this.counter) {
      this.counter.state = 'dead';
      this.counter.count.destroy();
      this.counter.read.destroy();
      this.counter.params.destroy();
    }
    const fx = this.fx;
    if (fx) {
      fx.state.destroy();
      fx.subs.destroy();
      fx.curves.destroy();
      fx.surface.destroy();
      fx.white?.destroy();
    }
    this.collider?.uniform.destroy();
  }
}

/** Write `c0` and `c1` (default: `c0` with alpha 0) at `o`; returns the next offset. */
function writeColors(
  d: Float32Array,
  at: number,
  c0: ArrayLike<number>,
  c1: ArrayLike<number> | undefined,
): number {
  let o = at;
  d[o++] = c0[0]!;
  d[o++] = c0[1]!;
  d[o++] = c0[2]!;
  d[o++] = c0[3] ?? 1;
  d[o++] = c1 ? c1[0]! : c0[0]!;
  d[o++] = c1 ? c1[1]! : c0[1]!;
  d[o++] = c1 ? c1[2]! : c0[2]!;
  d[o++] = c1 ? (c1[3] ?? 1) : 0;
  return o;
}

/**
 * The CPU reference of the kernel's curve lookup: piecewise-linear over `stops` (2..8) spread
 * evenly on 0..1, each stop `stride` numbers (1 for a size curve, 4 for RGBA), written to `out`.
 */
export function evaluateCurve(
  stops: ArrayLike<number>,
  stride: number,
  t: number,
  out: Float32Array,
): Float32Array {
  const n = Math.floor(stops.length / stride);
  const x = Math.min(Math.max(t, 0), 1) * (n - 1);
  const i = Math.min(Math.floor(x), n - 2);
  const f = x - i;
  for (let k = 0; k < stride; k++) {
    const a = stops[i * stride + k]!;
    const b = stops[(i + 1) * stride + k]!;
    out[k] = a + (b - a) * f;
  }
  return out;
}

function pcg(v: number): number {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function lattice(x: number, y: number, z: number, seed: number): number {
  const h = pcg(
    (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ seed) >>> 0,
  );
  return h / 4294967295;
}
function vnoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const l = (dx: number, dy: number, dz: number) => lattice(ix + dx, iy + dy, iz + dz, seed);
  const x00 = l(0, 0, 0) + (l(1, 0, 0) - l(0, 0, 0)) * ux;
  const x10 = l(0, 1, 0) + (l(1, 1, 0) - l(0, 1, 0)) * ux;
  const x01 = l(0, 0, 1) + (l(1, 0, 1) - l(0, 0, 1)) * ux;
  const x11 = l(0, 1, 1) + (l(1, 1, 1) - l(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/**
 * The CPU reference of the kernel's force step: accelerate `vel` (xyz) by `forces` at `pos`
 * over `dt` and apply the extra drag (the particle's own gravity, drag and wind are not
 * included). For tests and shadow simulations; the GPU does the real work.
 */
export function applyForces(
  forces: readonly ParticleForce[],
  pos: ArrayLike<number>,
  vel: Float32Array | number[],
  dt: number,
): void {
  let ax = 0;
  let ay = 0;
  let az = 0;
  let drag = 0;
  const px = pos[0]!;
  const py = pos[1]!;
  const pz = pos[2] ?? 0;
  for (const f of forces) {
    if (f.kind === 'attract') {
      const dx = f.x - px;
      const dy = f.y - py;
      const dz = (f.z ?? 0) - pz;
      const r = Math.hypot(dx, dy, dz);
      const radius = f.radius ?? 0;
      const w = radius > 0 ? Math.max(1 - r / radius, 0) : 1;
      if (r > 1e-4) {
        ax += (dx / r) * f.strength * w;
        ay += (dy / r) * f.strength * w;
        az += (dz / r) * f.strength * w;
      }
    } else if (f.kind === 'vortex') {
      const al = Math.hypot(f.axis[0], f.axis[1], f.axis[2]) || 1;
      const nx = f.axis[0] / al;
      const ny = f.axis[1] / al;
      const nz = f.axis[2] / al;
      const rx = px - f.x;
      const ry = py - f.y;
      const rz = pz - (f.z ?? 0);
      const d = rx * nx + ry * ny + rz * nz;
      const qx = rx - nx * d;
      const qy = ry - ny * d;
      const qz = rz - nz * d;
      const r = Math.hypot(qx, qy, qz);
      const radius = f.radius ?? 0;
      const w = radius > 0 ? Math.max(1 - r / radius, 0) : 1;
      if (r > 1e-4) {
        const s = (f.strength * w) / r;
        ax += (ny * qz - nz * qy) * s;
        ay += (nz * qx - nx * qz) * s;
        az += (nx * qy - ny * qx) * s;
      }
    } else if (f.kind === 'turbulence') {
      const e = 0.05;
      const s = (f.seed ?? 0) >>> 0;
      const x = px * f.frequency;
      const y = py * f.frequency;
      const z = pz * f.frequency;
      const dzdy = vnoise(x, y + e, z, s + 2) - vnoise(x, y - e, z, s + 2);
      const dydz = vnoise(x, y, z + e, s + 1) - vnoise(x, y, z - e, s + 1);
      const dxdz = vnoise(x, y, z + e, s) - vnoise(x, y, z - e, s);
      const dzdx = vnoise(x + e, y, z, s + 2) - vnoise(x - e, y, z, s + 2);
      const dydx = vnoise(x + e, y, z, s + 1) - vnoise(x - e, y, z, s + 1);
      const dxdy = vnoise(x, y + e, z, s) - vnoise(x, y - e, z, s);
      const k = f.strength / (2 * e);
      ax += (dzdy - dydz) * k;
      ay += (dxdz - dzdx) * k;
      az += (dydx - dxdy) * k;
    } else {
      drag += f.amount;
    }
  }
  const damp = Math.exp(-drag * dt);
  vel[0] = (vel[0]! + ax * dt) * damp;
  vel[1] = (vel[1]! + ay * dt) * damp;
  if (vel.length > 2) vel[2] = (vel[2]! + az * dt) * damp;
}

/** Continuous emission at `rate` particles/second, plus bursts. Mutate `params` freely. */
export class ParticleEmitter {
  rate: number;
  active = true;
  private carry = 0;

  constructor(
    readonly system: ParticleSystem,
    public params: EmitParams,
    rate = 0,
  ) {
    this.rate = rate;
  }

  update(dt: number): void {
    if (!this.active || this.rate <= 0) return;
    this.carry += this.rate * dt;
    const n = Math.floor(this.carry);
    if (n > 0) {
      this.carry -= n;
      this.system.emit(this.params, n);
    }
  }

  burst(count: number, overrides?: Partial<EmitParams>): void {
    this.system.emit(overrides ? { ...this.params, ...overrides } : this.params, count);
  }
}
