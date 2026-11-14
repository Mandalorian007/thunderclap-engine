/**
 * ws/core-effects (B5): a world `ParticleSystem` on the render core. The system's compute runs
 * in `core.prepare`; the draw is one instanced call over the whole ring (`draw(6, capacity)`),
 * so the call count stays flat in particle count. Each eye faces its own image plane from the
 * same bundle (`CoreViewExtras`), and a particle outside an eye's frusta collapses in the vertex
 * stage. Soft particles sample the core's depth (`readsDepth`).
 */

import type { Knob } from '../quality/governor';
import { stepKnob } from '../quality/knobs';
import type { RenderCore } from '../render/core/core';
import {
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  CoreViewExtras,
  coreDepthCompare,
  DrawablePipelines,
} from '../render/core/drawable';
import { CORE_TARGET, coreColorTargets } from '../render/core/targets';
import { FxDepthModules } from './depth';
import {
  PARTICLE_BOX_LIGHT_FLOATS,
  PARTICLE_CORE_BOX_WGSL,
  PARTICLE_CORE_RENDER_WGSL,
} from './particles-wgsl';

/** How a core particle is drawn: a camera-facing quad, or (ws/fx-fit) a small lit cube. */
export type ParticleShape = 'quad' | 'box';

/** What `ParticlesOnCore` draws from (the system's buffers). */
export interface ParticlesOnCoreSource {
  /** The system: `prepare(encoder)` runs its compute once a frame. */
  readonly system: { prepare(encoder: GPUCommandEncoder): void; readonly capacity: number };
  readonly particles: GPUBuffer;
  readonly sim: GPUBuffer;
  readonly curves: GPUBuffer;
  readonly sheet: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly blend: GPUBlendState;
  /** Sample the core's depth for the soft fade. */
  readonly readsDepth: boolean;
  /** Default `'quad'`. */
  readonly shape?: ParticleShape;
}

/** The core drawable behind a `ParticleSystem` made on a `RenderCore`. */
export class ParticlesOnCore implements CoreDrawable {
  readonly label = 'particles';
  readonly pass = 'transparent';
  readonly order = 0;
  readonly readsDepth: boolean;
  version = 0;
  active = true;
  /** Draw calls a record makes (1: the whole ring in one instanced draw). */
  static readonly CALLS = 1;
  /** `'quad'` or `'box'` (lit cubes, 36 vertices a particle). */
  readonly shape: ParticleShape;
  /**
   * Box shape: the light the cubes are shaded by (a sun's travel direction and linear colour,
   * and an ambient colour). Live; uploaded in `prepare`.
   */
  readonly boxLight = {
    sunDir: new Float32Array([-0.4, -0.8, -0.45]),
    sunColor: new Float32Array([1, 1, 1]),
    ambient: new Float32Array([0.3, 0.3, 0.35]),
  };
  private readonly lightData = new Float32Array(PARTICLE_BOX_LIGHT_FLOATS);
  private readonly lightBuffer: GPUBuffer | null;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipes: DrawablePipelines;
  private readonly extras: CoreViewExtras;
  private readonly dummyDepth: GPUTexture | null;
  private group: GPUBindGroup | null = null;
  private groupTargets = -1;
  private groupDepth: GPUTextureView | null = null;

  constructor(
    private readonly core: RenderCore,
    private readonly src: ParticlesOnCoreSource,
  ) {
    const device = core.device;
    this.readsDepth = src.readsDepth;
    this.shape = src.shape ?? 'quad';
    const box = this.shape === 'box';
    this.extras = CoreViewExtras.of(core);
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    this.lightBuffer = box
      ? device.createBuffer({
          label: 'particles-core-box-light',
          size: PARTICLE_BOX_LIGHT_FLOATS * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
      : null;
    this.layout = device.createBindGroupLayout({
      label: 'particles-core-layout',
      entries: [
        { binding: 0, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: V | F, buffer: {} },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: F, texture: {} },
        { binding: 5, visibility: F, sampler: {} },
        { binding: 6, visibility: V | F, buffer: { type: 'read-only-storage' } },
        ...(box ? [{ binding: 7, visibility: V, buffer: {} }] : []),
      ],
    });
    this.dummyDepth = src.readsDepth
      ? null
      : device.createTexture({
          label: 'particles-core-no-depth',
          size: [1, 1],
          format: 'depth32float',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        });
    const modules = new FxDepthModules(
      device,
      box ? PARTICLE_CORE_BOX_WGSL : PARTICLE_CORE_RENDER_WGSL,
      box ? 'particles-core-box' : 'particles-core',
    );
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [core.viewLayout, this.layout],
    });
    this.pipes = new DrawablePipelines((color, depth, _readOnly, aux, reversedZ) => {
      const module = modules.get(reversedZ);
      return device.createRenderPipeline({
        label: box ? 'particles-core-box' : 'particles-core',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: coreColorTargets({ format: color, blend: src.blend }, aux, CORE_TARGET.emissive),
        },
        // A cube shows its outside faces only (it writes no depth, so the back must not paint over).
        primitive: { topology: 'triangle-list', cullMode: box ? 'back' : 'none' },
        depthStencil: depth
          ? {
              format: depth,
              depthWriteEnabled: false,
              depthCompare: coreDepthCompare('less-equal', reversedZ),
            }
          : undefined,
      });
    });
  }

  prepare(encoder: GPUCommandEncoder): void {
    this.extras.update();
    if (this.lightBuffer) {
      const d = this.lightData;
      const l = this.boxLight;
      d.set(l.sunDir, 0);
      d.set(l.sunColor, 4);
      d.set(l.ambient, 8);
      this.core.device.queue.writeBuffer(this.lightBuffer, 0, d);
    }
    this.src.system.prepare(encoder);
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.draw(this.lightBuffer ? 36 : 6, this.src.system.capacity);
    return ParticlesOnCore.CALLS;
  }

  /** The bind group, re-made when the core's depth is (its `targetsVersion` moves). */
  private bindGroup(): GPUBindGroup {
    const core = this.core;
    const depth = this.readsDepth ? core.sceneDepthView : null;
    if (this.group && this.groupTargets === core.targetsVersion && this.groupDepth === depth) {
      return this.group;
    }
    const src = this.src;
    this.groupTargets = core.targetsVersion;
    this.groupDepth = depth;
    this.group = core.device.createBindGroup({
      label: 'particles-core',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: src.particles } },
        { binding: 1, resource: { buffer: src.sim } },
        { binding: 2, resource: depth ?? this.dummyDepth!.createView() },
        { binding: 3, resource: { buffer: src.curves } },
        { binding: 4, resource: src.sheet },
        { binding: 5, resource: src.sampler },
        { binding: 6, resource: { buffer: this.extras.buffer } },
        ...(this.lightBuffer ? [{ binding: 7, resource: { buffer: this.lightBuffer } }] : []),
      ],
    });
    return this.group;
  }

  destroy(): void {
    this.dummyDepth?.destroy();
    this.lightBuffer?.destroy();
    this.group = null;
  }
}

/** Options for `particleBudgetKnob`. */
export interface ParticleBudgetKnobOptions {
  /** The lowest share of spawns kept. Default 0.25. */
  min?: number;
  /** Change per step. Default 0.25. */
  step?: number;
  /** Default `'particle budget'`. */
  name?: string;
  cost?: number;
}

/**
 * The particle budget as a governor knob (C7): each step scales every system's `spawnScale`
 * (from 1 down to `min`), so fewer particles live and fill. The draw call count does not move
 * (one instanced draw a system); the fill and the simulation's live share do.
 */
export function particleBudgetKnob(
  systems: readonly { spawnScale: number }[],
  opts: ParticleBudgetKnobOptions = {},
): Knob {
  let scale = 1;
  const base = systems.map((s) => s.spawnScale);
  return stepKnob({
    name: opts.name ?? 'particle budget',
    cost: opts.cost,
    get: () => scale,
    set: (v) => {
      scale = v;
      for (let i = 0; i < systems.length; i++) systems[i]!.spawnScale = base[i]! * v;
    },
    min: opts.min ?? 0.25,
    max: 1,
    step: opts.step ?? 0.25,
  });
}
