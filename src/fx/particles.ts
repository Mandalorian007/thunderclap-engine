import type { Drawable } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { createShaderModule } from '../render/wgsl';
import { PARTICLE_COMPUTE_WGSL, PARTICLE_RENDER_WGSL } from './particles-wgsl';

const PARTICLE_BYTES = 80;
const SPAWN_FLOATS = 28;
const SIM_FLOATS = 8;

export type EmitShape =
  | { kind: 'point' }
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  /** Segment from (x, y) to (x + dx, y + dy). */
  | { kind: 'line'; dx: number; dy: number };

/** How new particles are born. Colours are linear RGBA (HDR ok). Units: logical px, seconds. */
export interface EmitParams {
  x: number;
  y: number;
  shape?: EmitShape;
  /** Launch direction in radians (0 = right, -π/2 = up). Default -π/2. */
  angle?: number;
  /** Full cone width in radians. Default 2π (all directions). */
  spread?: number;
  /** [min, max] px/s. Default [80, 300]. */
  speed?: readonly [number, number];
  /** [min, max] seconds. Default [0.5, 1.2]. */
  life?: readonly [number, number];
  /** Size in px at [birth, death]. Default [6, 1]. */
  size?: readonly [number, number];
  colorStart: ArrayLike<number>;
  /** Default: `colorStart` with alpha 0. */
  colorEnd?: ArrayLike<number>;
  /** px/s². Default [0, 400] (falls). */
  gravity?: readonly [number, number];
  /** Linear drag per second. Default 1. */
  drag?: number;
  /** How much the particle also feeds bloom (0..). Default 1. */
  emissive?: number;
}

export interface ParticleSystemOptions {
  /** Max live particles (ring buffer). Default 65536. */
  capacity?: number;
  /** Max emit() calls between frames. Default 256. */
  maxSpawnsPerFrame?: number;
  /** Logical y of a bouncy floor. Default: none. */
  floorY?: number;
  /** Floor restitution 0..1. Default 0.35. */
  bounce?: number;
  /** Seconds of velocity added to the quad length (motion streaks). Default 0.02. */
  stretch?: number;
}

const POINT: EmitShape = { kind: 'point' };
const SHAPE_ID = { point: 0, circle: 1, rect: 2, line: 3 } as const;

/**
 * GPU particles: spawn + integrate in compute, rendered as additive velocity-stretched quads
 * into both scene targets (colour + emissive → bloom). Draw with `frame.drawable(system)`.
 *
 * Particles live in a ring buffer: when full, the oldest are overwritten.
 */
export class ParticleSystem implements Drawable {
  readonly capacity: number;
  /** Multiplier on every emit count (set < 1 for prefers-reduced-motion). */
  spawnScale = 1;
  floorY: number;
  bounce: number;
  stretch: number;

  private readonly device: GPUDevice;
  private readonly particleBuffer: GPUBuffer;
  private readonly spawnBuffer: GPUBuffer;
  private readonly simBuffer: GPUBuffer;
  private readonly spawnData: Float32Array<ArrayBuffer>;
  private readonly simData = new Float32Array(SIM_FLOATS);
  private readonly maxSpawns: number;
  private readonly spawnPipeline: GPUComputePipeline;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly renderPipeline: GPURenderPipeline;
  private readonly computeGroup: GPUBindGroup;
  private readonly renderGroup: GPUBindGroup;
  private spawnCount = 0;
  private maxSpawnInCmd = 0;
  private head = 0;
  private pendingDt = 0;
  private time = 0;
  private warnedOverflow = false;
  private clearPending = false;

  constructor(renderer: Renderer, opts: ParticleSystemOptions = {}) {
    const device = renderer.device;
    this.device = device;
    this.capacity = Math.max(64, Math.floor(opts.capacity ?? 65536));
    this.maxSpawns = opts.maxSpawnsPerFrame ?? 256;
    this.floorY = opts.floorY ?? 1e9;
    this.bounce = opts.bounce ?? 0.35;
    this.stretch = opts.stretch ?? 0.02;

    this.particleBuffer = device.createBuffer({
      label: 'particles',
      size: this.capacity * PARTICLE_BYTES,
      // COPY_DST: `clear()` zeroes it with `encoder.clearBuffer`.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.spawnData = new Float32Array(this.maxSpawns * SPAWN_FLOATS);
    this.spawnBuffer = device.createBuffer({
      label: 'particle-spawns',
      size: this.spawnData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.simBuffer = device.createBuffer({
      label: 'particle-sim',
      size: SIM_FLOATS * 4,
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
    const cmod = createShaderModule(device, PARTICLE_COMPUTE_WGSL, 'particles-compute');
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

    const renderLayout = device.createBindGroupLayout({
      label: 'particles-render-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
    const rmod = createShaderModule(device, PARTICLE_RENDER_WGSL, 'particles-render');
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    this.renderPipeline = device.createRenderPipeline({
      label: 'particles-render',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [renderer.globalsLayout, renderLayout],
      }),
      vertex: { module: rmod, entryPoint: 'vs' },
      fragment: {
        module: rmod,
        entryPoint: 'fs',
        targets: renderer.sceneFormats.map((format) => ({ format, blend: additive })),
      },
      primitive: { topology: 'triangle-list' },
    });
    this.renderGroup = device.createBindGroup({
      label: 'particles-render',
      layout: renderLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.simBuffer } },
      ],
    });
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
    const d = this.spawnData;
    let o = this.spawnCount++ * SPAWN_FLOATS;
    const shape = p.shape ?? POINT;
    let sa = 0;
    let sb = 0;
    if (shape.kind === 'circle') sa = shape.radius;
    else if (shape.kind === 'rect') {
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
    d[o++] = c0[0]!;
    d[o++] = c0[1]!;
    d[o++] = c0[2]!;
    d[o++] = c0[3] ?? 1;
    d[o++] = c1 ? c1[0]! : c0[0]!;
    d[o++] = c1 ? c1[1]! : c0[1]!;
    d[o++] = c1 ? c1[2]! : c0[2]!;
    d[o++] = c1 ? (c1[3] ?? 1) : 0;
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
    this.head = (this.head + n) % this.capacity;
    if (n > this.maxSpawnInCmd) this.maxSpawnInCmd = n;
  }

  /** Advance simulation time. Call from fixed update; integration happens on the GPU. */
  update(dt: number): void {
    this.pendingDt += dt;
  }

  prepare(encoder: GPUCommandEncoder): void {
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
    const q = this.device.queue;
    q.writeBuffer(this.simBuffer, 0, s);
    if (this.clearPending) {
      encoder.clearBuffer(this.particleBuffer);
      this.clearPending = false;
    }
    const pass = encoder.beginComputePass({ label: 'particles' });
    pass.setBindGroup(0, this.computeGroup);
    if (this.spawnCount > 0) {
      q.writeBuffer(
        this.spawnBuffer,
        0,
        this.spawnData.buffer,
        0,
        this.spawnCount * SPAWN_FLOATS * 4,
      );
      pass.setPipeline(this.spawnPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.maxSpawnInCmd / 64), this.spawnCount);
    }
    if (dt > 0) {
      pass.setPipeline(this.updatePipeline);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    }
    pass.end();
    this.spawnCount = 0;
    this.maxSpawnInCmd = 0;
    this.warnedOverflow = false;
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(1, this.renderGroup);
    pass.draw(6, this.capacity);
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
  }
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
