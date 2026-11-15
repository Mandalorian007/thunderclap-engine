/**
 * ws/core-effects (B5): a `Water` on the render core. The surface draws in the core's
 * `'transparent'` pass for every view from one bundle a cull group (depth tested, not written),
 * its shoreline and depth tint from the core's depth, and its refraction and screen-space
 * reflection from the core's colour copy (`readsColor`) when either is on.
 */

import type { Knob } from '../quality/governor';
import { toggleKnob } from '../quality/knobs';
import type { RenderCore } from '../render/core/core';
import {
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  CoreViewExtras,
  DrawablePipelines,
  warmBindings,
} from '../render/core/drawable';
import { coreDepthCompare } from '../render/core/pass-list';
import { CORE_TARGET, coreColorTargets } from '../render/core/targets';
import { VERTEX_LAYOUT_3D } from '../render/mesh';
import { FxDepthModules } from './depth';
import type { Water } from './water';
import { WATER_CORE_FLOATS } from './water-shade-wgsl';
import {
  makeWaterLook,
  WATER_PREMULTIPLIED as PREMULTIPLIED,
  packWaterCore,
  type WaterLook,
} from './water-shading';
import { waterCoreWgsl } from './water-wgsl';

export type { WaterLook } from './water-shading';

/** Options for `WaterOnCore`. */
export interface WaterOnCoreOptions {
  /** Sample the core's colour copy (refraction, reflection). */
  readsColor: boolean;
  /** The game's own `water_shade` (`WaterOptions.shade`, B24). Default the engine's. */
  shade?: string;
}

/** The core drawable behind a `Water` made on a `RenderCore`. */
export class WaterOnCore implements CoreDrawable {
  readonly label = 'water';
  readonly pass = 'transparent';
  readonly order = -1;
  readonly readsDepth = true;
  readonly readsColor: boolean;
  version = 0;
  active = true;
  /** Draw calls a record makes (1: the plane). */
  static readonly CALLS = 1;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipes: DrawablePipelines;
  private readonly extras: CoreViewExtras;
  private readonly block = new Float32Array(WATER_CORE_FLOATS);
  private readonly blockBuffer: GPUBuffer;
  private readonly dummyColor: GPUTexture;
  private readonly dummyDepth: GPUTexture;
  private group: GPUBindGroup | null = null;
  private groupTargets = -1;
  private readonly looks = new Map<number, WaterLook>();
  private readonly shade: string | undefined;

  constructor(
    readonly core: RenderCore,
    private readonly water: Water,
    private readonly params: GPUBuffer,
    opts: WaterOnCoreOptions,
  ) {
    const device = core.device;
    this.readsColor = opts.readsColor;
    this.shade = opts.shade;
    this.extras = CoreViewExtras.of(core);
    this.blockBuffer = device.createBuffer({
      label: 'water-core',
      size: this.block.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dummyColor = device.createTexture({
      label: 'water-core-no-colour',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyDepth = device.createTexture({
      label: 'water-core-no-depth',
      size: [1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'water-core-layout',
      entries: [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: F, buffer: {} },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: F, buffer: { type: 'read-only-storage' } },
      ],
    });
    const modules = new FxDepthModules(device, waterCoreWgsl(opts.shade), 'water-core');
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [core.viewLayout, this.layout],
    });
    this.pipes = new DrawablePipelines((color, depth, _readOnly, aux, reversedZ) => {
      const module = modules.get(reversedZ);
      return device.createRenderPipeline({
        label: 'water-core',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT_3D.buffer] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: coreColorTargets(
            { format: color, blend: PREMULTIPLIED },
            aux,
            CORE_TARGET.roughMetal | CORE_TARGET.velocity,
          ),
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth
          ? {
              format: depth,
              depthWriteEnabled: false,
              depthCompare: coreDepthCompare(reversedZ, true),
            }
          : undefined,
      });
    });
  }

  prepare(encoder: GPUCommandEncoder): void {
    this.extras.update();
    const w = this.water;
    w.prepare(encoder);
    this.active = w.plane && w.mesh.indexCount > 0;
    packWaterCore(w, this.block, this.readsColor);
    this.core.device.queue.writeBuffer(this.blockBuffer, 0, this.block);
  }

  /**
   * Its pipeline's empty first draw (`CoreDrawable.warm`, ws/warm-voxel-fit). Nothing without
   * the plane (`Water.plane` false, ws/water-split): the plane's pipeline is neither built nor
   * warmed, so a game's `shade` that reads its looks' groups never compiles in the plane's
   * layout. A water whose plane is turned on later builds it at its first draw.
   */
  warm(enc: GPURenderPassEncoder, ctx: CoreDrawContext): number {
    if (!this.water.plane) return 0;
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    let calls = 4;
    calls += warmBindings(enc, ctx, 1);
    enc.draw(0);
    return calls;
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    const mesh = this.water.mesh;
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.setVertexBuffer(0, mesh.vertexBuffer);
    enc.setIndexBuffer(mesh.indexBuffer!, mesh.indexFormat);
    enc.drawIndexed(mesh.indexCount);
    return WaterOnCore.CALLS;
  }

  /** The water as a look whose group is `group` (`Water.look`); one per index, kept. */
  look(group: number): WaterLook {
    let look = this.looks.get(group);
    if (look) return look;
    look = makeWaterLook(
      this.core,
      group,
      this.shade,
      this.params,
      this.blockBuffer,
      this.extras.buffer,
      this.readsColor,
    );
    this.looks.set(group, look);
    return look;
  }

  /** The bind group, re-made when the core's depth or colour copy is (`targetsVersion`). */
  private bindGroup(): GPUBindGroup {
    const core = this.core;
    if (this.group && this.groupTargets === core.targetsVersion) return this.group;
    this.groupTargets = core.targetsVersion;
    const color = this.readsColor ? core.sceneColorView : null;
    this.group = core.device.createBindGroup({
      label: 'water-core',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.blockBuffer } },
        { binding: 2, resource: core.sceneDepthView ?? this.dummyDepth.createView() },
        { binding: 3, resource: color ?? this.dummyColor.createView() },
        { binding: 4, resource: { buffer: this.extras.buffer } },
      ],
    });
    return this.group;
  }

  destroy(): void {
    this.blockBuffer.destroy();
    this.dummyColor.destroy();
    this.dummyDepth.destroy();
    this.group = null;
  }
}

/**
 * Water reflection as a governor knob (C7): one step sheds the screen-space reflection march
 * (`reflectionSteps` to 0: the sky gradient only) on every surface, and brings back each one's
 * steps. Live: no pipeline or bundle is re-made.
 */
export function waterReflectionKnob(
  waters: readonly { reflectionSteps: number }[],
  name = 'water reflection',
  cost?: number,
): Knob {
  const steps = waters.map((w) => w.reflectionSteps);
  return toggleKnob(
    name,
    (shed) => {
      for (let i = 0; i < waters.length; i++) {
        const w = waters[i]!;
        if (shed) steps[i] = w.reflectionSteps;
        w.reflectionSteps = shed ? 0 : steps[i]!;
      }
    },
    cost,
  );
}
