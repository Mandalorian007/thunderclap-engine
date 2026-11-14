import type { Drawable, Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { auxSuffix, ScenePipelineCache, sceneVariant } from '../render/scene-pipelines';
import { createShaderModule } from '../render/wgsl';
import { MODEL_VERTEX_FLOATS } from './builder';
import { MODEL_UNIT_FLOATS, type ModelUnit, type ModelUnits } from './compile';
import {
  MODEL_INSTANCE_FLOATS,
  type ModelInstanceState,
  ModelInstances,
  type ModelXform,
} from './instances';
import type { MaterialCodeTable } from './spec';
import { modelShaderWgsl } from './wgsl';

export interface ModelSceneOptions {
  /** The game's material table: every model placed must be compiled against these names, in this order. */
  materials: MaterialCodeTable;
  /** Instance slots. Default 4096. */
  maxInstances?: number;
  /** A WGSL `fn model_shade(s: ModelSurface) -> ModelShaded` (see `MODEL_SURFACE_WGSL`); default lit + fogged. */
  shade?: string;
  /** Back-face culling (default `'back'`: the shapes face outward, counter-clockwise). */
  cull?: 'back' | 'none';
  label?: string;
}

/** Counters a budget test holds a scene to. */
export interface ModelSceneStats {
  /** `writeBuffer` calls and bytes, all buffers. */
  writes: number;
  bytes: number;
  /** Bytes of instance data written. */
  instanceBytes: number;
  /** Draw calls recorded by the last `draw`. */
  drawCalls: number;
  /** Bind groups built (one per growth of the vertex or unit buffer). */
  bindGroups: number;
}

const VERT_BYTES = MODEL_VERTEX_FLOATS * 4;
const UNIT_BYTES = MODEL_UNIT_FLOATS * 4;
const INST_BYTES = MODEL_INSTANCE_FLOATS * 4;

/**
 * Procedural part models drawn through the renderer: a `Drawable` over a `ModelInstances`.
 * `place` puts a compiled unit in a slot; `prepare` uploads only what changed (the slots
 * placed since the last frame, models added, and 16 bytes of frame time), and `draw` issues
 * one instanced draw per unit in use, pulling vertices and instances from storage buffers.
 * Moving parts turn and slide in the vertex shader from their instance's channel values and
 * rates, so a scene of spinning windmills writes nothing per frame but its clock.
 *
 * ```ts
 * const scene = createModelScene(renderer, { materials });
 * const mill = compileModel(windmillSpec, materials);
 * scene.placeModel(mill, 0, transform, { channels: { spin: [0, 1.5] } });
 * frame.drawable(scene); // every frame
 * ```
 */
export class ModelScene implements Drawable {
  readonly instances: ModelInstances;
  readonly materials: MaterialCodeTable;
  readonly stats: ModelSceneStats = {
    writes: 0,
    bytes: 0,
    instanceBytes: 0,
    drawCalls: 0,
    bindGroups: 0,
  };
  private readonly device: GPUDevice;
  private readonly renderer: Renderer;
  private readonly label: string;
  private readonly layout: GPUBindGroupLayout;
  private readonly desc: GPURenderPipelineDescriptor;
  private readonly pipelines = new ScenePipelineCache();
  private readonly checked = new WeakSet<ModelUnits>();
  private readonly matNames: string;
  private vertBuf: GPUBuffer | null = null;
  private unitBuf: GPUBuffer | null = null;
  private readonly instBuf: GPUBuffer;
  private readonly orderBuf: GPUBuffer;
  private readonly matBuf: GPUBuffer;
  private readonly frameBuf: GPUBuffer;
  private group: GPUBindGroup | null = null;
  private readonly frameData = new Float32Array(4);
  private readonly writes: number[] = [];
  private readonly added: [number, number] = [0, 0];
  private lastDt = Number.NaN;
  private orderStale = true;

  constructor(renderer: Renderer, opts: ModelSceneOptions) {
    const device = renderer.device;
    this.device = device;
    this.renderer = renderer;
    this.label = opts.label ?? 'models';
    this.materials = opts.materials;
    this.matNames = Object.keys(opts.materials).join('\n');
    if (this.matNames.length === 0) throw new Error('models: the material table is empty');
    this.instances = new ModelInstances(
      opts.maxInstances !== undefined ? { maxInstances: opts.maxInstances } : {},
    );
    const n = this.instances.maxInstances;
    this.instBuf = this.buffer(`${this.label}-instances`, n * INST_BYTES, GPUBufferUsage.STORAGE);
    this.orderBuf = this.buffer(`${this.label}-order`, n * 4, GPUBufferUsage.STORAGE);
    const mats = materialRows(opts.materials);
    this.matBuf = this.buffer(`${this.label}-materials`, mats.byteLength, GPUBufferUsage.STORAGE);
    this.write(this.matBuf, 0, mats, 0, mats.length);
    this.frameBuf = this.buffer(`${this.label}-frame`, 16, GPUBufferUsage.UNIFORM);
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: 'read-only-storage' },
    });
    this.layout = device.createBindGroupLayout({
      label: `${this.label}-layout`,
      entries: [
        storage(0),
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    const module = createShaderModule(
      device,
      modelShaderWgsl(opts.materials, opts.shade),
      this.label,
    );
    this.desc = {
      label: this.label,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [renderer.globalsLayout, this.layout],
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: renderer.sceneTargets() },
      primitive: { topology: 'triangle-list', cullMode: opts.cull ?? 'back', frontFace: 'ccw' },
    };
  }

  /** Slots holding an instance. */
  get count(): number {
    return this.instances.count;
  }

  /**
   * Place `unit` in `slot` by `xform` (a `Transform` or a 3×4 row-major matrix) with `state`
   * (channel values as of the last frame's time, colours, user vec4). Writes that slot only.
   */
  place(unit: ModelUnit, slot: number, xform: ModelXform, state?: ModelInstanceState): void {
    this.check(unit.owner);
    this.instances.place(unit, slot, xform, state);
  }

  /** Place every unit of `model` from `slot` on; returns the slots used (`model.units.length`). */
  placeModel(
    model: ModelUnits,
    slot: number,
    xform: ModelXform,
    state?: ModelInstanceState,
  ): number {
    this.check(model);
    return this.instances.placeModel(model, slot, xform, state);
  }

  remove(slot: number): void {
    this.instances.remove(slot);
  }

  removeRange(slot: number, count: number): void {
    this.instances.removeRange(slot, count);
  }

  clear(): void {
    this.instances.clear();
  }

  /**
   * Set the scene's clock (seconds) before placing with channel rates outside a frame; `prepare`
   * sets it to `frame.time` on its own.
   */
  setTime(time: number): void {
    this.instances.advance(time);
  }

  prepare(_encoder: GPUCommandEncoder, frame: Frame): void {
    // Every view of a frame prepares; after the first, nothing is left to write.
    const inst = this.instances;
    inst.advance(frame.time);
    this.uploadAdded();
    const orderChanged = inst.flush(this.writes);
    const w = this.writes;
    for (let i = 0; i < w.length; i += 2) {
      const from = w[i]!;
      const to = w[i + 1]!;
      this.write(this.instBuf, from * 4, inst.data, from, to - from);
      this.stats.instanceBytes += (to - from) * 4;
    }
    if (orderChanged || this.orderStale) {
      this.orderStale = false;
      if (inst.instances > 0) this.write(this.orderBuf, 0, inst.order, 0, inst.instances);
    }
    const dt = inst.dt;
    if (dt !== this.lastDt) {
      this.lastDt = dt;
      this.frameData[0] = dt;
      this.write(this.frameBuf, 0, this.frameData, 0, 4);
    }
  }

  draw(pass: GPURenderPassEncoder, frame: Frame): void {
    const inst = this.instances;
    const n = inst.drawCalls;
    this.stats.drawCalls = 0;
    if (n === 0 || !this.group) return;
    pass.setPipeline(this.pipeline(frame.depthFormat, frame.auxKey));
    pass.setBindGroup(1, this.group);
    const draws = inst.draws;
    for (let i = 0; i < n; i++) {
      const d = draws[i]!;
      pass.draw(d.count, d.instances, d.first, d.firstInstance);
    }
    this.stats.drawCalls = n;
  }

  /** Free the GPU buffers; the scene draws nothing afterwards. */
  destroy(): void {
    this.vertBuf?.destroy();
    this.unitBuf?.destroy();
    this.instBuf.destroy();
    this.orderBuf.destroy();
    this.matBuf.destroy();
    this.frameBuf.destroy();
    this.vertBuf = null;
    this.unitBuf = null;
    this.group = null;
  }

  private check(model: ModelUnits): void {
    if (this.checked.has(model)) return;
    if (
      model.materials !== this.materials &&
      Object.keys(model.materials).join('\n') !== this.matNames
    ) {
      throw new Error(
        `models: ${model.name} was compiled against another material table than the scene's`,
      );
    }
    this.checked.add(model);
  }

  /** Upload added vertices and unit rows, growing their buffers (and the bind group) as needed. */
  private uploadAdded(): void {
    const inst = this.instances;
    const [vFrom, uFrom] = inst.takeAdded(this.added);
    let rebind = !this.group;
    if (inst.vertexCount > vFrom || !this.vertBuf) {
      const need = Math.max(1, inst.vertexCount) * VERT_BYTES;
      if (!this.vertBuf || this.vertBuf.size < need) {
        this.vertBuf?.destroy();
        this.vertBuf = this.buffer(
          `${this.label}-verts`,
          inst.verts.byteLength,
          GPUBufferUsage.STORAGE,
        );
        if (inst.vertexCount > 0)
          this.write(this.vertBuf, 0, inst.verts, 0, inst.vertexCount * MODEL_VERTEX_FLOATS);
        rebind = true;
      } else {
        const f = vFrom * MODEL_VERTEX_FLOATS;
        this.write(
          this.vertBuf,
          f * 4,
          inst.verts,
          f,
          (inst.vertexCount - vFrom) * MODEL_VERTEX_FLOATS,
        );
      }
    }
    if (inst.unitCount > uFrom || !this.unitBuf) {
      const need = Math.max(1, inst.unitCount) * UNIT_BYTES;
      if (!this.unitBuf || this.unitBuf.size < need) {
        this.unitBuf?.destroy();
        this.unitBuf = this.buffer(
          `${this.label}-units`,
          inst.unitRows.byteLength,
          GPUBufferUsage.STORAGE,
        );
        if (inst.unitCount > 0)
          this.write(this.unitBuf, 0, inst.unitRows, 0, inst.unitCount * MODEL_UNIT_FLOATS);
        rebind = true;
      } else {
        const f = uFrom * MODEL_UNIT_FLOATS;
        this.write(
          this.unitBuf,
          f * 4,
          inst.unitRows,
          f,
          (inst.unitCount - uFrom) * MODEL_UNIT_FLOATS,
        );
      }
    }
    if (rebind) this.bind();
  }

  private bind(): void {
    const entry = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({
      binding,
      resource: { buffer },
    });
    this.group = this.device.createBindGroup({
      label: `${this.label}-group`,
      layout: this.layout,
      entries: [
        entry(0, this.vertBuf!),
        entry(1, this.instBuf),
        entry(2, this.orderBuf),
        entry(3, this.unitBuf!),
        entry(4, this.matBuf),
        entry(5, this.frameBuf),
      ],
    });
    this.stats.bindGroups++;
  }

  private buffer(label: string, size: number, usage: number): GPUBuffer {
    return this.device.createBuffer({
      label,
      size: Math.max(16, size),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
  }

  private write(
    buffer: GPUBuffer,
    offset: number,
    data: Float32Array | Uint32Array,
    from: number,
    count: number,
  ): void {
    if (count <= 0) return;
    this.device.queue.writeBuffer(buffer, offset, data, from, count);
    this.stats.writes++;
    this.stats.bytes += count * 4;
  }

  private pipeline(format: GPUTextureFormat | null, aux: number): GPURenderPipeline {
    const p = this.pipelines.get(format, aux);
    if (p) return p;
    return this.pipelines.set(
      format,
      aux,
      this.device.createRenderPipeline(
        sceneVariant(
          this.desc,
          this.renderer.sceneTargets(undefined, aux),
          `${this.label}${format ? `:${format}` : ''}${auxSuffix(aux)}`,
          format ? { format, depthWriteEnabled: true, depthCompare: 'less-equal' } : undefined,
        ),
      ),
    );
  }
}

/** Two vec4 per material: colour (w 1), emissive (w 1 when declared, else 0: the shader uses the colour). */
function materialRows(table: MaterialCodeTable): Float32Array<ArrayBuffer> {
  const names = Object.keys(table);
  const out = new Float32Array(names.length * 8);
  names.forEach((name, i) => {
    const m = table[name]!;
    out.set([m.color[0], m.color[1], m.color[2], 1], i * 8);
    if (m.emissive) out.set([m.emissive[0], m.emissive[1], m.emissive[2], 1], i * 8 + 4);
  });
  return out;
}

/** Make a `ModelScene` for `renderer`; see the class. */
export function createModelScene(renderer: Renderer, opts: ModelSceneOptions): ModelScene {
  return new ModelScene(renderer, opts);
}
