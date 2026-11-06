import type { Drawable, Frame, ViewInfo } from '../render/frame';
import type { Renderer } from '../render/renderer';
import type { SceneTarget } from '../render/scene-target';
import type { Texture } from '../render/texture';
import { createShaderModule } from '../render/wgsl';
import {
  PARTICLE_COMPUTE_WGSL,
  PARTICLE_COUNT_WGSL,
  PARTICLE_DEPTH_COPY_WGSL,
  PARTICLE_RENDER_WGSL,
  PARTICLE_WORLD_COMPUTE_WGSL,
  PARTICLE_WORLD_RENDER_WGSL,
} from './particles-wgsl';

const PARTICLE_BYTES = 80;
const SPAWN_FLOATS = 28;
const SIM_FLOATS = 8;
const WORLD_PARTICLE_BYTES = 112;
const WORLD_SPAWN_FLOATS = 36;
const WORLD_SIM_FLOATS = 16;
/** The soft-particle depth copy's format (sampleable as `texture_depth_2d`). */
const SOFT_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

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
  | { kind: 'sphere'; radius: number };

/**
 * How new particles are born. Colours are linear RGBA (HDR ok). Units: logical px and seconds
 * in 2D; world units and seconds in world space (defaults differ, see each field).
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
  speed?: readonly [number, number];
  /** World space only: added to every launch velocity's z (units/s). Default 0. */
  vz?: number;
  /** [min, max] seconds. Default [0.5, 1.2]. */
  life?: readonly [number, number];
  /** Size at [birth, death]. Default [6, 1] px in 2D, [0.1, 0.02] units in world space. */
  size?: readonly [number, number];
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
}

export interface ParticleSystemOptions {
  /**
   * `'2d'` (default): logical px in the XY plane, the original behaviour, pixel for pixel.
   * `'world'`: particles in 3D world space, drawn as quads facing the camera (`size` in world
   * units), with distance and soft-depth fades and optional lighting.
   */
  space?: '2d' | 'world';
  /** Max live particles (ring buffer). Default 65536. */
  capacity?: number;
  /** Max emit() calls between frames. Default 256. */
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
   * Costs one small dispatch per frame and a 4-byte readback every other frame. Default false.
   */
  countAlive?: boolean;
}

const POINT: EmitShape = { kind: 'point' };
/** 2D maps `box` to `rect` and `sphere` to `circle`, so the 2D shader is unchanged. */
const SHAPE_ID = { point: 0, circle: 1, rect: 2, line: 3, box: 2, sphere: 1 } as const;
const WORLD_SHAPE_ID = { point: 0, circle: 1, rect: 2, line: 3, box: 4, sphere: 5 } as const;
const WORLD_GRAVITY = [0, -9.8, 0] as const;
const ZERO3 = [0, 0, 0] as const;
const WORLD_SPEED = [0.5, 2] as const;
const WORLD_SIZE = [0.1, 0.02] as const;

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

/**
 * GPU particles: spawn + integrate in compute, rendered as additive (or alpha) quads into both
 * scene targets (colour + emissive → bloom). Draw with `frame.drawable(system)`.
 *
 * In 2D (`space: '2d'`, the default) quads are velocity-stretched in the XY plane. In world
 * space they face the camera, stretch along the velocity's projection on the view plane,
 * test depth, fade by distance and near scene geometry, and may be lit.
 *
 * Particles live in a ring buffer: when full, the oldest are overwritten.
 */
export class ParticleSystem implements Drawable {
  readonly capacity: number;
  readonly space: '2d' | 'world';
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
  private readonly computeGroup: GPUBindGroup;
  private readonly renderGroup: GPUBindGroup;
  private readonly soft: SoftDepth | null = null;
  private readonly counter: AliveCounter | null = null;
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
  private clearPending = false;

  constructor(renderer: Renderer, opts: ParticleSystemOptions = {}) {
    const device = renderer.device;
    this.renderer = renderer;
    this.device = device;
    const world = opts.space === 'world';
    this.space = world ? 'world' : '2d';
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
    this.spawnFloats = world ? WORLD_SPAWN_FLOATS : SPAWN_FLOATS;
    this.simData = new Float32Array(world ? WORLD_SIM_FLOATS : SIM_FLOATS);

    this.particleBuffer = device.createBuffer({
      label: 'particles',
      size: this.capacity * (world ? WORLD_PARTICLE_BYTES : PARTICLE_BYTES),
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

    const computeLayout = device.createBindGroupLayout({
      label: 'particles-compute-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      ],
    });
    const cmod = createShaderModule(
      device,
      world ? PARTICLE_WORLD_COMPUTE_WGSL : PARTICLE_COMPUTE_WGSL,
      world ? 'particles-world-compute' : 'particles-compute',
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
    this.computeGroup = device.createBindGroup({
      label: 'particles-compute',
      layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.spawnBuffer } },
        { binding: 2, resource: { buffer: this.simBuffer } },
      ],
    });

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
    const renderLayout = device.createBindGroupLayout({
      label: world ? 'particles-world-render-layout' : 'particles-render-layout',
      entries: renderEntries,
    });
    const rmod = createShaderModule(
      device,
      world ? PARTICLE_WORLD_RENDER_WGSL : PARTICLE_RENDER_WGSL,
      world ? 'particles-world-render' : 'particles-render',
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

    const renderBindings: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.particleBuffer } },
      { binding: 1, resource: { buffer: this.simBuffer } },
    ];
    if (world) {
      this.soft = this.makeSoftDepth(renderLayout);
      renderBindings.push({ binding: 2, resource: this.soft.dummy.createView() });
    }
    this.renderGroup = device.createBindGroup({
      label: world ? 'particles-world-render' : 'particles-render',
      layout: renderLayout,
      entries: renderBindings,
    });
    if (opts.countAlive) this.counter = this.makeCounter(world);
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

  private makeCounter(world: boolean): AliveCounter {
    const device = this.device;
    const count = device.createBuffer({
      label: 'particles-alive',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const read = device.createBuffer({
      label: 'particles-alive-read',
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const params = device.createBuffer({
      label: 'particles-alive-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // capacity, vec4s per particle, index of the `life` vec4.
    device.queue.writeBuffer(
      params,
      0,
      new Uint32Array([this.capacity, world ? 7 : 5, world ? 4 : 3, 0]),
    );
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
    if (this.space === 'world') this.writeWorldSpawn(p, n, o);
    else this.writeSpawn(p, n, o);
    this.head = (this.head + n) % this.capacity;
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
    d[o++] = SHAPE_ID[shape.kind];
    // e
    d[o++] = this.head;
    d[o++] = n;
    d[o++] = Math.floor(Math.random() * 16777215);
    d[o++] = p.emissive ?? 1;
  }

  private writeWorldSpawn(p: EmitParams, n: number, at: number): void {
    const d = this.spawnData;
    let o = at;
    const shape = p.shape ?? POINT;
    let sa = 0;
    let sb = 0;
    let sc = 0;
    if (shape.kind === 'circle' || shape.kind === 'sphere') sa = shape.radius;
    else if (shape.kind === 'rect') {
      sa = shape.width;
      sb = shape.height;
    } else if (shape.kind === 'box') {
      sa = shape.width;
      sb = shape.height;
      sc = shape.depth;
    } else if (shape.kind === 'line') {
      sa = shape.dx;
      sb = shape.dy;
      sc = shape.dz ?? 0;
    }
    const speed = p.speed ?? WORLD_SPEED;
    const life = p.life ?? [0.5, 1.2];
    const size = p.size ?? WORLD_SIZE;
    const g = p.gravity ?? WORLD_GRAVITY;
    const w = p.wind ?? ZERO3;
    // a
    d[o++] = p.x;
    d[o++] = p.y;
    d[o++] = p.z ?? 0;
    d[o++] = WORLD_SHAPE_ID[shape.kind];
    // b
    d[o++] = sa;
    d[o++] = sb;
    d[o++] = sc;
    d[o++] = p.spread ?? Math.PI * 2;
    // c
    d[o++] = p.angle ?? Math.PI / 2;
    d[o++] = p.vz ?? 0;
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
    d[o++] = g[2] ?? 0;
    d[o++] = p.drag ?? 1;
    // f
    d[o++] = w[0];
    d[o++] = w[1];
    d[o++] = w[2];
    d[o++] = p.emissive ?? 1;
    // g
    d[o++] = this.head;
    d[o++] = n;
    d[o++] = Math.floor(Math.random() * 16777215);
    d[o++] = 0;
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
    s[0] = dt;
    s[1] = this.floorY;
    s[2] = this.bounce;
    s[3] = this.time;
    s[4] = this.capacity;
    s[5] = this.stretch;
    s[6] = this.spawnCount;
    s[7] = 0;
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
    const q = this.device.queue;
    q.writeBuffer(this.simBuffer, 0, s);
    if (this.clearPending) {
      encoder.clearBuffer(this.particleBuffer);
      this.clearPending = false;
    }
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
    if (dt > 0) {
      pass.setPipeline(this.updatePipeline);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    }
    if (count) {
      pass.setPipeline(counter.pipeline);
      pass.setBindGroup(0, counter.group);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    }
    pass.end();
    if (count) {
      encoder.copyBufferToBuffer(counter.count, 0, counter.read, 0, 4);
      counter.state = 'copied';
    }
    this.spawnCount = 0;
    this.maxSpawnInCmd = 0;
    this.warnedOverflow = false;
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
        this.alive = new Uint32Array(c.read.getMappedRange(0, 4))[0]!;
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
      sd.copyGroup = device.createBindGroup({
        label: 'particles-world-render-soft',
        layout: sd.renderLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffer } },
          { binding: 1, resource: { buffer: this.simBuffer } },
          { binding: 2, resource: view },
        ],
      });
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
   * The renderer's depth hook (`readsDepth`, world space with `softness` > 0): bind this
   * frame's opaque depth copy and flip the shader's soft flag on (a 4-byte write that lands
   * before the frame's commands run). A new bind group only when the copy texture changed.
   */
  afterOpaque(_encoder: GPUCommandEncoder, view: ViewInfo): void {
    const sd = this.soft;
    if (!sd || this.softness <= 0) return;
    if (view.depthView !== this.hookView) {
      this.hookView = view.depthView;
      this.hookGroup = this.device.createBindGroup({
        label: 'particles-world-render-hook',
        layout: sd.renderLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffer } },
          { binding: 1, resource: { buffer: this.simBuffer } },
          { binding: 2, resource: view.depthView },
        ],
      });
    }
    this.softActive = true;
    this.depthGroup = this.hookGroup;
    const s = this.simData;
    s[11] = 1;
    this.device.queue.writeBuffer(this.simBuffer, 11 * 4, s.buffer, 11 * 4, 4);
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
