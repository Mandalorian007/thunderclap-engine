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
import { CORE_TARGET, type CoreTargetName, coreColorTargets } from '../render/core/targets';
import { VERTEX_LAYOUT_3D } from '../render/mesh';
import { FxDepthModules, fxDepthCode } from './depth';
import type { Water } from './water';
import { WATER_CORE_FLOATS, WATER_CORE_WGSL, waterLookWgsl } from './water-wgsl';

const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * The water as a look over a game's own geometry (`Water.look`, ws/scene-read-fit): what a
 * draw set (or a `VoxelMaterial`) that shades its surfaces as this water takes. The set reads
 * the core's scene depth (and colour, with `readsColor`) through the core's scene-read group,
 * in a pass that does not write depth (`'transparent'`).
 */
export interface WaterLook {
  /**
   * WGSL to put after the set's prelude, before its fragment: the water's group at the look's
   * index, `water_look(frag, rel, up) -> WaterShade` (`frag` the fragment's builtin
   * position, `rel` its core-frame position, `up` its normal; the waves bend what faces up)
   * and `water_look_out(s) -> WaterLookOut` (colour, rough-metal, velocity at the core's
   * locations). Call `water_look` in uniform control flow (it takes screen derivatives). It
   * declares `water`, `wc`, `extras` and the engine's noise helpers.
   */
  readonly wgsl: string;
  /** The water's bind group, for the set's `bindGroups` at the look's index. */
  readonly bindGroup: { readonly layout: GPUBindGroupLayout; readonly group: GPUBindGroup };
  /** Premultiplied alpha (the shading's colour is premultiplied). */
  readonly blend: GPUBlendState;
  /** The core targets `water_look_out` writes. */
  readonly writes: readonly CoreTargetName[];
  /** Always true: the shoreline, depth tint and foam read the scene depth. */
  readonly readsDepth: true;
  /** True when the water refracts or reflects the scene (`WaterOptions.refraction` > 0 or reflection steps). */
  readonly readsColor: boolean;
}

const LOOK_WRITES: readonly CoreTargetName[] = ['roughMetal', 'velocity'];

/** Options for `WaterOnCore`. */
export interface WaterOnCoreOptions {
  /** Sample the core's colour copy (refraction, reflection). */
  readsColor: boolean;
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

  constructor(
    readonly core: RenderCore,
    private readonly water: Water,
    private readonly params: GPUBuffer,
    opts: WaterOnCoreOptions,
  ) {
    const device = core.device;
    this.readsColor = opts.readsColor;
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
    const modules = new FxDepthModules(device, WATER_CORE_WGSL, 'water-core');
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
    const b = this.block;
    const s = w.sunDirection;
    const len = Math.hypot(s[0]!, s[1]!, s[2]!) || 1;
    b[0] = s[0]! / len;
    b[1] = s[1]! / len;
    b[2] = s[2]! / len;
    b[3] = w.sunColor[0]! + w.sunColor[1]! + w.sunColor[2]! > 0 ? 1 : 0;
    b[4] = w.sunColor[0]!;
    b[5] = w.sunColor[1]!;
    b[6] = w.sunColor[2]!;
    b[8] = w.skyColor[0]!;
    b[9] = w.skyColor[1]!;
    b[10] = w.skyColor[2]!;
    // Without the colour copy, refraction and reflection fall back in the shader (1×1 input).
    b[12] = this.readsColor ? Math.max(0, w.refraction) : 0;
    b[13] = Math.max(0, Math.floor(w.reflectionSteps));
    b[14] = w.reflectionReach;
    this.core.device.queue.writeBuffer(this.blockBuffer, 0, b);
  }

  /** Its pipeline's empty first draw (`CoreDrawable.warm`, ws/warm-voxel-fit). */
  warm(enc: GPURenderPassEncoder, ctx: CoreDrawContext): number {
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
    const device = this.core.device;
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'water-look-layout',
      entries: [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: F, buffer: {} },
        { binding: 2, visibility: F, buffer: { type: 'read-only-storage' } },
      ],
    });
    look = {
      wgsl: fxDepthCode(waterLookWgsl(group), this.core.passes.reversedZ),
      bindGroup: {
        layout,
        group: device.createBindGroup({
          label: 'water-look',
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.params } },
            { binding: 1, resource: { buffer: this.blockBuffer } },
            { binding: 2, resource: { buffer: this.extras.buffer } },
          ],
        }),
      },
      blend: PREMULTIPLIED,
      writes: LOOK_WRITES,
      readsDepth: true,
      readsColor: this.readsColor,
    };
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
