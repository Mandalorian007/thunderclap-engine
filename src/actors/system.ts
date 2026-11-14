/**
 * The actor system: many animated characters in a fixed number of GPU calls.
 *
 * ```
 * system.prepare(encoder, views, time)   params, dirty records, args reset, one pose pass
 * core.prepare(encoder, views); core.draw(encoder, v, target)   the actors' draw set with the rest
 * ```
 *
 * - A slot table of records (`ACTOR_RECORD` header, then the game's `recordLayout` fields). Only
 *   the dirty range uploads; a held crowd uploads nothing but the clock.
 * - One compute pass, one workgroup per slot: place the actor, sample its clips, compose the
 *   hierarchy, write its skin matrices, cull it per view, pick its LOD and append it to the
 *   visible list of (view, model mesh). The pass bumps the instance counts of indirect
 *   arguments a template resets each frame.
 * - One draw set on the core (`cull: 'external'`), one slot per model mesh: a static set is one
 *   bundle of `drawIndexedIndirect`, recorded when a model is added and replayed after.
 */
import type { Arena } from '../render/core/arena';
import type { RenderCore } from '../render/core/core';
import { ARGS_BYTES } from '../render/core/cull';
import type { DrawSet } from '../render/core/draw-set';
import { type BufferLayout, createVertexLayout } from '../render/core/layout';
import { MAX_VIEWS, VIEW_SLOT_BYTES } from '../render/core/view';
import { createPoseScratch, type PoseScratch, poseRecord } from './pose-cpu';
import {
  ACTOR_NONE,
  type ActorRecordInput,
  type ActorRecordLayout,
  type ActorRecordShape,
  ACTOR_RECORD as R,
  recordShape,
} from './record';
import { ACTOR_TRS_FLOATS, ACTOR_VERTEX_BYTES, type ActorRig } from './rig';
import {
  ACTOR_DEFAULT_LIGHT_WGSL,
  ACTOR_MAX_LODS,
  ACTOR_PARAMS_BYTES,
  actorDrawWgsl,
  actorPoseWgsl,
  RIG,
  RIG_CLIP_WORDS,
  RIG_HEADER_WORDS,
} from './wgsl';

/**
 * The actor vertex (32 bytes): position, normal (`snorm8x4`), colour (`unorm8x4`; alpha set
 * means multiply by the record's tint), four joints, four weights and the draw word (the
 * system writes which model mesh the vertex belongs to).
 */
export const ACTOR_VERTEX_LAYOUT: BufferLayout = createVertexLayout({
  stride: ACTOR_VERTEX_BYTES,
  attributes: [
    { name: 'position', format: 'float32x3', offset: 0 },
    { name: 'normal', format: 'snorm8x4', offset: 12 },
    { name: 'color', format: 'unorm8x4', offset: 16 },
    { name: 'joints', format: 'uint8x4', offset: 20 },
    { name: 'weights', format: 'unorm8x4', offset: 24 },
    { name: 'draw', format: 'uint32', offset: 28 },
  ],
});

export interface ActorSystemOptions {
  /** Slots (actors at once). At most 65,535. */
  slots: number;
  /** Bones (nodes and joints) a rig may have: the pose workgroup's size, 1 to 64. Default 16. */
  bonesPerSlot?: number;
  /** The game's record fields, after the engine header. */
  recordLayout?: ActorRecordLayout;
  /**
   * LOD distances from the view, ascending (at most 4): LOD `i` draws below `lods[i]`, nothing
   * draws beyond the last. A model with fewer meshes uses its last. Default `[Infinity]`.
   */
  lods?: readonly number[];
  /** Models the system holds (default 16). */
  maxModels?: number;
  /** Meshes over every model (default `maxModels × lods.length`). */
  maxDraws?: number;
  /** Views of a frame the actors join (default 2; views beyond draw no actors). */
  maxViews?: number;
  /**
   * Light at a point, RGBA8 (`0xAABBGGRR`), sampled on the CPU when a record's position is set
   * and multiplied in by the default lighting. Default white.
   */
  sampleLight?: (x: number, y: number, z: number) => number;
  /**
   * WGSL replacing the default lighting: `fn actor_light(actor: u32, world: vec3f, normal:
   * vec3f, color: vec3f, light: u32) -> vec3f`. It may read records with `actor_word(actor,
   * ACTOR_FIELD_<NAME>)`.
   */
  lightWgsl?: string;
  /** The core pass the actors draw in (default `'opaque'`). */
  pass?: string;
  label?: string;
}

/** Per-frame counts of the last `prepare`. */
export interface ActorStats {
  /** GPU calls `prepare` made. */
  calls: number;
  /** Record bytes uploaded. */
  recordBytes: number;
  /** Slots the pose pass covered (the high-water slot + 1). */
  dispatched: number;
}

const U = () => GPUBufferUsage;

/** Many animated characters, rigid or skinned, at a fixed draw count. Make one with `createActorSystem`. */
export class ActorSystem {
  readonly label: string;
  readonly slots: number;
  readonly bonesPerSlot: number;
  readonly maxModels: number;
  readonly maxDraws: number;
  readonly maxViews: number;
  /** Record words per slot. */
  readonly stride: number;
  readonly shape: ActorRecordShape;
  readonly stats: ActorStats = { calls: 0, recordBytes: 0, dispatched: 0 };
  /** The draw set on the core (one slot per model mesh). */
  readonly drawSet: DrawSet;
  /** The skin matrices: `slots × bonesPerSlot` of three `vec4f` rows (the `SkinPalette` layout). */
  readonly bones: GPUBuffer;
  /** The records (`STORAGE | COPY_DST`). */
  readonly records: GPUBuffer;
  /** The clock of the last `prepare`. */
  time = 0;
  private readonly core: RenderCore;
  private readonly device: GPUDevice;
  private readonly sampleLight: ((x: number, y: number, z: number) => number) | null;
  private readonly recU32: Uint32Array<ArrayBuffer>;
  private readonly recF32: Float32Array<ArrayBuffer>;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private high = 0;
  private readonly rigs: ActorRig[] = [];
  private draws = 0;
  private readonly drawBases: number[] = [];
  private readonly vertexArena: Arena;
  private readonly indexArena: Arena;
  /**
   * The indirect arguments the pose pass fills: five `u32` per (view, model mesh) at
   * `(view × maxDraws + draw) × 20` bytes, the instance count second (`COPY_SRC` for readback).
   */
  readonly args: GPUBuffer;
  private readonly template: GPUBuffer;
  private readonly templateData: Uint32Array<ArrayBuffer>;
  private readonly lists: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private readonly params = new ArrayBuffer(ACTOR_PARAMS_BYTES);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly paramsU32 = new Uint32Array(this.params);
  private rigBuffer: GPUBuffer;
  private readonly poseLayout: GPUBindGroupLayout;
  private poseGroup: GPUBindGroup;
  private readonly posePipeline: GPUComputePipeline;
  private readonly computeDesc: GPUComputePassDescriptor;
  private readonly scratch: PoseScratch;
  private destroyed = false;

  constructor(core: RenderCore, opts: ActorSystemOptions) {
    this.core = core;
    this.device = core.device;
    const device = this.device;
    this.label = opts.label ?? 'actors';
    this.slots = Math.floor(opts.slots);
    if (!(this.slots >= 1 && this.slots <= 65535)) {
      throw new Error(`${this.label}: slots ${opts.slots} (1 to 65,535)`);
    }
    this.bonesPerSlot = Math.floor(opts.bonesPerSlot ?? 16);
    if (!(this.bonesPerSlot >= 1 && this.bonesPerSlot <= 64)) {
      throw new Error(`${this.label}: bonesPerSlot ${opts.bonesPerSlot} (1 to 64)`);
    }
    const lods = opts.lods ?? [Infinity];
    if (lods.length < 1 || lods.length > ACTOR_MAX_LODS) {
      throw new Error(`${this.label}: 1 to ${ACTOR_MAX_LODS} LOD distances`);
    }
    for (let i = 1; i < lods.length; i++) {
      if (!(lods[i]! > lods[i - 1]!)) throw new Error(`${this.label}: LOD distances must rise`);
    }
    this.maxModels = Math.max(1, Math.floor(opts.maxModels ?? 16));
    this.maxDraws = Math.max(1, Math.floor(opts.maxDraws ?? this.maxModels * lods.length));
    this.maxViews = Math.max(1, Math.min(Math.floor(opts.maxViews ?? 2), core.maxViews));
    this.shape = recordShape(opts.recordLayout);
    this.stride = this.shape.stride;
    this.sampleLight = opts.sampleLight ?? null;
    this.scratch = createPoseScratch(this.bonesPerSlot);

    // Records: every slot empty, unit scale, rate 1, white tint and light.
    this.recU32 = new Uint32Array(this.slots * this.stride);
    this.recF32 = new Float32Array(this.recU32.buffer);
    for (let s = 0; s < this.slots; s++) this.reset(s * this.stride);

    const u = U();
    const consts = {
      bones: this.bonesPerSlot,
      stride: this.stride,
      maxDraws: this.maxDraws,
      slots: this.slots,
      views: this.maxViews,
    };
    this.records = device.createBuffer({
      label: `${this.label} records`,
      size: this.recU32.byteLength,
      usage: u.STORAGE | u.COPY_DST,
    });
    device.queue.writeBuffer(this.records, 0, this.recU32);
    this.bones = device.createBuffer({
      label: `${this.label} bones`,
      size: this.slots * this.bonesPerSlot * 48,
      usage: u.STORAGE | u.COPY_SRC,
    });
    // Arguments for every view the core may draw, so a view past `maxViews` draws nothing.
    const argsBytes = core.maxViews * this.maxDraws * ARGS_BYTES;
    this.args = device.createBuffer({
      label: `${this.label} args`,
      size: argsBytes,
      usage: u.STORAGE | u.INDIRECT | u.COPY_DST | u.COPY_SRC,
    });
    this.template = device.createBuffer({
      label: `${this.label} args template`,
      size: argsBytes,
      usage: u.COPY_SRC | u.COPY_DST,
    });
    this.templateData = new Uint32Array(argsBytes / 4);
    this.lists = device.createBuffer({
      label: `${this.label} lists`,
      size: this.maxViews * this.maxDraws * this.slots * 4,
      usage: u.STORAGE,
    });
    this.paramsBuffer = device.createBuffer({
      label: `${this.label} params`,
      size: ACTOR_PARAMS_BYTES,
      usage: u.UNIFORM | u.COPY_DST,
    });
    // The shader compares distances; an infinite one goes up as the largest float.
    for (let i = 0; i < ACTOR_MAX_LODS; i++) this.paramsF32[4 + i] = Math.min(lods[i] ?? 0, 3.4e38);
    this.paramsU32[8] = lods.length;
    this.rigBuffer = this.makeRigBuffer();

    const S = GPUShaderStage;
    this.poseLayout = device.createBindGroupLayout({
      label: `${this.label} pose`,
      entries: [
        { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.poseGroup = this.makePoseGroup();
    const module = device.createShaderModule({
      label: `${this.label} pose`,
      code: actorPoseWgsl(consts),
    });
    this.posePipeline = device.createComputePipeline({
      label: `${this.label} pose`,
      layout: device.createPipelineLayout({
        label: `${this.label} pose`,
        bindGroupLayouts: [this.poseLayout],
      }),
      compute: { module, entryPoint: 'pose' },
    });
    this.computeDesc = { label: `${this.label} pose` };

    const drawLayout = device.createBindGroupLayout({
      label: `${this.label} draw`,
      entries: [
        { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const drawGroup = device.createBindGroup({
      label: `${this.label} draw`,
      layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bones } },
        { binding: 1, resource: { buffer: this.lists } },
        { binding: 2, resource: { buffer: this.records } },
      ],
    });
    this.vertexArena = core.createArena({
      kind: 'vertex',
      blockBytes: 16 << 20,
      label: `${this.label} vertices`,
    });
    this.indexArena = core.createArena({
      kind: 'index',
      blockBytes: 8 << 20,
      label: `${this.label} indices`,
    });
    this.drawSet = core.createDrawSet({
      label: this.label,
      shader: {
        code: actorDrawWgsl(consts, opts.lightWgsl ?? ACTOR_DEFAULT_LIGHT_WGSL, this.shape.fields),
        cullMode: 'none',
      },
      vertexLayout: ACTOR_VERTEX_LAYOUT,
      vertices: this.vertexArena,
      indices: this.indexArena,
      capacity: this.maxDraws,
      kind: 'static',
      cull: 'external',
      args: this.args,
      pass: opts.pass ?? 'opaque',
      bindGroups: [{ layout: drawLayout, group: drawGroup }],
    });
  }

  /** Models added so far. */
  get models(): number {
    return this.rigs.length;
  }

  /** The rig of model `id`. */
  rig(id: number): ActorRig {
    const r = this.rigs[id];
    if (!r) throw new Error(`${this.label}: no model ${id}`);
    return r;
  }

  /** The draw (indirect argument cell) of model `id`'s mesh for LOD `lod` (its last mesh beyond). */
  drawOf(id: number, lod = 0): number {
    const r = this.rig(id);
    return this.drawBases[id]! + Math.min(Math.max(0, lod | 0), r.meshes.length - 1);
  }

  /**
   * Add a rig as a model; returns its id for `setRecord({ model })`. Uploads its meshes and
   * clips and re-records the draw bundle once. Allocates; call at load.
   */
  addModel(rig: ActorRig): number {
    this.alive();
    if (this.rigs.length >= this.maxModels) {
      throw new Error(`${this.label}: full (${this.maxModels} models)`);
    }
    const need = Math.max(rig.nodes, rig.joints);
    if (need > this.bonesPerSlot) {
      throw new Error(`${this.label}: a rig of ${need} bones (bonesPerSlot ${this.bonesPerSlot})`);
    }
    if (this.draws + rig.meshes.length > this.maxDraws) {
      throw new Error(`${this.label}: full (${this.maxDraws} meshes)`);
    }
    const id = this.rigs.length;
    const drawBase = this.draws;
    for (let m = 0; m < rig.meshes.length; m++) {
      const mesh = rig.meshes[m]!;
      const d = drawBase + m;
      const bytes = new Uint8Array(mesh.vertices);
      const words = new Uint32Array(bytes.buffer);
      for (let i = 0; i < mesh.vertexCount; i++) words[(i * ACTOR_VERTEX_BYTES) / 4 + 7] = d;
      const v = this.vertexArena.alloc(bytes.byteLength, ACTOR_VERTEX_BYTES);
      this.vertexArena.write(v, bytes);
      const ix = this.indexArena.alloc(mesh.indices.byteLength, 4);
      this.indexArena.write(ix, mesh.indices);
      const slot = this.drawSet.add({
        vertices: v,
        indices: ix,
        indexCount: mesh.indices.length,
        instanceCount: 0,
        bounds: [0, 0, 0, Infinity],
      });
      if (slot !== d) throw new Error(`${this.label}: draw slot ${slot} is not mesh ${d}`);
      for (let view = 0; view < this.core.maxViews; view++) {
        const a = ((view * this.maxDraws + d) * ARGS_BYTES) / 4;
        this.templateData[a] = mesh.indices.length;
        this.templateData[a + 1] = 0;
        this.templateData[a + 2] = ix.offset / 4;
        this.templateData[a + 3] = v.offset / ACTOR_VERTEX_BYTES;
        this.templateData[a + 4] = 0;
      }
    }
    this.draws += rig.meshes.length;
    this.drawBases.push(drawBase);
    this.rigs.push(rig);
    this.device.queue.writeBuffer(this.template, 0, this.templateData);
    this.rigBuffer.destroy();
    this.rigBuffer = this.makeRigBuffer();
    this.poseGroup = this.makePoseGroup();
    this.paramsU32[3] = this.rigs.length;
    return id;
  }

  /**
   * Write slot `slot`'s record: the fields `rec` names, the rest kept. Positions are given at
   * `since` (default the current clock); a clip given without `clipStart` starts now. Only the
   * dirty range uploads, at the next `prepare`. Allocates nothing.
   */
  setRecord(slot: number, rec: ActorRecordInput): void {
    this.check(slot);
    const f = this.recF32;
    const u = this.recU32;
    const b = slot * this.stride;
    if (rec.model !== undefined) {
      if (rec.model >= 0 && !this.rigs[rec.model]) {
        throw new Error(`${this.label}: no model ${rec.model}`);
      }
      u[b + R.model] = rec.model < 0 ? ACTOR_NONE : rec.model;
      if (rec.model >= 0 && slot >= this.high) this.high = slot + 1;
    }
    if (rec.position) {
      f[b + R.x] = rec.position[0]!;
      f[b + R.y] = rec.position[1]!;
      f[b + R.z] = rec.position[2]!;
      f[b + R.since] = rec.since ?? this.time;
      if (this.sampleLight) {
        u[b + R.light] = this.sampleLight(rec.position[0]!, rec.position[1]!, rec.position[2]!);
      }
    } else if (rec.since !== undefined) f[b + R.since] = rec.since;
    if (rec.velocity) {
      f[b + R.vx] = rec.velocity[0]!;
      f[b + R.vy] = rec.velocity[1]!;
      f[b + R.vz] = rec.velocity[2]!;
    }
    if (rec.yaw !== undefined) f[b + R.yaw] = rec.yaw;
    if (rec.scale !== undefined) f[b + R.scale] = rec.scale;
    if (rec.clip !== undefined) {
      u[b + R.clip] = rec.clip < 0 ? ACTOR_NONE : rec.clip;
      f[b + R.clipStart] = rec.clipStart ?? this.time;
    } else if (rec.clipStart !== undefined) f[b + R.clipStart] = rec.clipStart;
    if (rec.clipRate !== undefined) f[b + R.clipRate] = rec.clipRate;
    if (rec.clip2 !== undefined) {
      u[b + R.clip2] = rec.clip2 < 0 ? ACTOR_NONE : rec.clip2;
      f[b + R.clip2Start] = rec.clip2Start ?? this.time;
    } else if (rec.clip2Start !== undefined) f[b + R.clip2Start] = rec.clip2Start;
    if (rec.clip2Rate !== undefined) f[b + R.clip2Rate] = rec.clip2Rate;
    if (rec.blend !== undefined) f[b + R.blend] = rec.blend;
    if (rec.tint !== undefined) u[b + R.tint] = rec.tint >>> 0;
    if (rec.fields) {
      for (const name in rec.fields) {
        const field = this.shape.fields.get(name);
        if (!field) throw new Error(`${this.label}: no record field '${name}'`);
        const v = rec.fields[name]!;
        if (field.type === 'f32') f[b + field.word] = v;
        else if (field.type === 'u32') u[b + field.word] = v >>> 0;
        else u[b + field.word] = v | 0;
      }
    }
    this.dirty(slot);
  }

  /** Empty slot `slot` (it draws nothing; its record resets). */
  remove(slot: number): void {
    this.check(slot);
    this.reset(slot * this.stride);
    this.dirty(slot);
  }

  /** Is slot `slot` showing a model? */
  has(slot: number): boolean {
    return (
      slot >= 0 && slot < this.slots && this.recU32[slot * this.stride + R.model] !== ACTOR_NONE
    );
  }

  /** Read word `word` of slot `slot`'s record (`ACTOR_RECORD` or a field's word) as f32. */
  readF32(slot: number, word: number): number {
    this.check(slot);
    return this.recF32[slot * this.stride + word]!;
  }

  /** Read word `word` of slot `slot`'s record as u32. */
  readU32(slot: number, word: number): number {
    this.check(slot);
    return this.recU32[slot * this.stride + word]!;
  }

  /**
   * The CPU mirror of the pose pass for slot `slot` at `time` (default the last `prepare`'s):
   * `'world'` (default) writes one world matrix per node (12 floats, 3×4 row-major, actor
   * placement included) for picking and attachments; `'skin'` writes one skin matrix per joint,
   * what the GPU wrote to `bones`. Returns false for an empty slot. Allocates nothing.
   */
  poseCpu(
    slot: number,
    out: Float32Array,
    space: 'world' | 'skin' = 'world',
    time = this.time,
  ): boolean {
    this.check(slot);
    const base = slot * this.stride;
    const model = this.recU32[base + R.model]!;
    if (model === ACTOR_NONE) return false;
    const rig = this.rigs[model]!;
    const need = (space === 'world' ? rig.nodes : rig.joints) * 12;
    if (out.length < need) throw new Error(`${this.label}: poseCpu needs ${need} floats`);
    poseRecord(rig, this.recF32, this.recU32, base, time, this.scratch, out, space);
    return true;
  }

  /**
   * Once a frame, before `core.draw` (and in the same encoder as `core.prepare`, which writes
   * the views this pass reads): upload the clock and the dirty records, reset the indirect
   * arguments, and run the pose pass over every slot up to the highest used. `views` is the
   * view count of the frame's `core.prepare`. A fixed number of GPU calls, whatever the actors.
   */
  prepare(encoder: GPUCommandEncoder, views: number | readonly unknown[], time: number): void {
    this.alive();
    const st = this.stats;
    st.calls = 0;
    st.recordBytes = 0;
    st.dispatched = 0;
    this.time = time;
    const n = typeof views === 'number' ? views : views.length;
    const q = this.device.queue;
    this.paramsF32[0] = time;
    this.paramsU32[1] = this.high;
    this.paramsU32[2] = n;
    q.writeBuffer(this.paramsBuffer, 0, this.params);
    st.calls++;
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo * this.stride;
      const words = (this.dirtyHi + 1) * this.stride - lo;
      q.writeBuffer(this.records, lo * 4, this.recU32, lo, words);
      st.calls++;
      st.recordBytes = words * 4;
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
    }
    encoder.copyBufferToBuffer(this.template, 0, this.args, 0, this.templateData.byteLength);
    st.calls++;
    if (this.high === 0 || this.rigs.length === 0) return;
    const pass = encoder.beginComputePass(this.computeDesc);
    pass.setPipeline(this.posePipeline);
    pass.setBindGroup(0, this.poseGroup);
    pass.dispatchWorkgroups(this.high);
    pass.end();
    st.calls += 5;
    st.dispatched = this.high;
  }

  /** Free the system's buffers and its draw set. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.drawSet.destroy();
    for (const b of [
      this.records,
      this.bones,
      this.args,
      this.template,
      this.lists,
      this.paramsBuffer,
      this.rigBuffer,
    ]) {
      b.destroy();
    }
  }

  // ------------------------------------------------------------------ internals

  private alive(): void {
    if (this.destroyed) throw new Error(`${this.label}: destroyed`);
  }

  private check(slot: number): void {
    if (!(slot >= 0 && slot < this.slots && Number.isInteger(slot))) {
      throw new Error(`${this.label}: no slot ${slot}`);
    }
  }

  private dirty(slot: number): void {
    if (slot < this.dirtyLo) this.dirtyLo = slot;
    if (slot > this.dirtyHi) this.dirtyHi = slot;
  }

  private reset(b: number): void {
    this.recU32.fill(0, b, b + this.stride);
    this.recU32[b + R.model] = ACTOR_NONE;
    this.recU32[b + R.clip] = ACTOR_NONE;
    this.recU32[b + R.clip2] = ACTOR_NONE;
    this.recF32[b + R.scale] = 1;
    this.recF32[b + R.clipRate] = 1;
    this.recF32[b + R.clip2Rate] = 1;
    this.recU32[b + R.tint] = 0xffffffff;
    this.recU32[b + R.light] = 0xffffffff;
  }

  /** Pack every rig's header, clips, frames, parents, joints, inverse binds and rest pose. */
  private makeRigBuffer(): GPUBuffer {
    let words = this.maxModels * RIG_HEADER_WORDS;
    for (const r of this.rigs) {
      words += r.clips.length * RIG_CLIP_WORDS + r.nodes * 2 + r.joints * 13;
      words += r.nodes * ACTOR_TRS_FLOATS;
      for (const c of r.clips) words += c.frames.length;
    }
    const u32 = new Uint32Array(Math.max(words, 4));
    const f32 = new Float32Array(u32.buffer);
    let at = this.maxModels * RIG_HEADER_WORDS;
    let draw = 0;
    this.rigs.forEach((r, m) => {
      const h = m * RIG_HEADER_WORDS;
      u32[h + RIG.nodes] = r.nodes;
      u32[h + RIG.joints] = r.joints;
      u32[h + RIG.drawBase] = draw;
      u32[h + RIG.meshes] = r.meshes.length;
      draw += r.meshes.length;
      f32[h + RIG.radius] = r.radius;
      f32[h + RIG.cx] = r.center[0];
      f32[h + RIG.cy] = r.center[1];
      f32[h + RIG.cz] = r.center[2];
      u32[h + RIG.clips] = r.clips.length;
      u32[h + RIG.clipsAt] = at;
      const clipsAt = at;
      at += r.clips.length * RIG_CLIP_WORDS;
      r.clips.forEach((c, i) => {
        const e = clipsAt + i * RIG_CLIP_WORDS;
        u32[e] = at;
        u32[e + 1] = c.frameCount;
        f32[e + 2] = c.fps;
        u32[e + 3] = c.loop ? 1 : 0;
        f32.set(c.frames, at);
        at += c.frames.length;
      });
      u32[h + RIG.parentsAt] = at;
      for (let i = 0; i < r.nodes; i++)
        u32[at + i] = r.parents[i]! < 0 ? ACTOR_NONE : r.parents[i]!;
      at += r.nodes;
      u32[h + RIG.jointNodesAt] = at;
      u32.set(r.jointNodes, at);
      at += r.joints;
      u32[h + RIG.inverseBindAt] = at;
      f32.set(r.inverseBind, at);
      at += r.joints * 12;
      u32[h + RIG.restAt] = at;
      f32.set(r.rest, at);
      at += r.nodes * ACTOR_TRS_FLOATS;
    });
    const buffer = this.device.createBuffer({
      label: `${this.label} rigs`,
      size: u32.byteLength,
      usage: U().STORAGE | U().COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, u32);
    return buffer;
  }

  private makePoseGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      label: `${this.label} pose`,
      layout: this.poseLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.core.viewBuffer, size: MAX_VIEWS * VIEW_SLOT_BYTES },
        },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.records } },
        { binding: 3, resource: { buffer: this.rigBuffer } },
        { binding: 4, resource: { buffer: this.bones } },
        { binding: 5, resource: { buffer: this.args } },
        { binding: 6, resource: { buffer: this.lists } },
      ],
    });
  }
}

/** An actor system on `core`. */
export function createActorSystem(core: RenderCore, opts: ActorSystemOptions): ActorSystem {
  return new ActorSystem(core, opts);
}
