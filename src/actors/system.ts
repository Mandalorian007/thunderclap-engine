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
import type { Arena, ArenaAlloc } from '../render/core/arena';
import type { RenderCore } from '../render/core/core';
import { ARGS_BYTES, DRAW_ARGS_BYTES } from '../render/core/cull';
import type { DrawSet, DrawSetDesc, DrawSetShader } from '../render/core/draw-set';
import { type BufferLayout, createVertexLayout } from '../render/core/layout';
import { MAX_VIEWS, VIEW_SLOT_BYTES } from '../render/core/view';
import { type ActorPoseCpu, createPoseScratch, type PoseScratch, poseRecord } from './pose-cpu';
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
  ACTOR_SHADOW_FS,
  type ActorShaderConsts,
  actorDrawWgsl,
  actorFieldConsts,
  actorPoseWgsl,
  actorSetPreludeWgsl,
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
  /**
   * The pose hook (ws/actor-fit): WGSL defining `fn actor_pose(actor: u32, model: u32, node: u32,
   * p: Trs, time: f32) -> Trs`, called in the pose pass for every node of every actor after its
   * clips are sampled and blended, on the node's local transform (`struct Trs { t: vec3f, q:
   * vec4f, s: vec3f }`: translation, rotation quaternion xyzw, scale). It may read records with
   * `actor_word(actor, ACTOR_FIELD_<NAME>)` (a game's own joint angles) and the rig table. A
   * game drives its parts' transforms with it in place of its own pose pass. Default none: the
   * pass is unchanged.
   */
  poseWgsl?: string;
  /** The CPU twin of `poseWgsl`, for `poseCpu` (picking, attachments). */
  poseCpu?: ActorPoseCpu;
  /**
   * Vertices per visible actor for draw sets added with `shape: 'actor'` (ws/actor-fit; a
   * contact shadow's quad is 6). Default 0: no such sets, and the indirect arguments keep five
   * words per (view, model mesh); with it each cell also holds a `drawIndirect` record the pose
   * pass counts actors into. A list (ws/actor-post-fit) gives each count its own record, and an
   * `'actor'` set picks one with `ActorDrawSetDesc.vertices` (a shadow's 6 beside an icon's 36).
   */
  actorVertices?: number | readonly number[];
  /**
   * Leave the body set's draws of models with no live actor out of its bundle (ws/actor-post-fit;
   * default true). False keeps every model's draws recorded from the start, so the first actor
   * of a model costs no re-record (its draws are empty indirect calls until then).
   */
  showLive?: boolean;
  /**
   * Scales every LOD distance (ws/actor-post-fit; default 1): 0.5 drops detail at half the
   * distance. Read each `prepare` from `ActorSystem.lodScale`, which a frame governor may set.
   */
  lodScale?: number;
  /**
   * Most vertices (indices drawn) of actors per view (ws/actor-post-fit; default 0, none). An
   * actor whose LOD mesh would pass it draws its model's coarsest mesh instead, in the pose
   * pass's order. Read each `prepare` from `ActorSystem.vertexCap`.
   */
  vertexCap?: number;
  /**
   * Words of a game table the pose hook reads (ws/actor-post-fit; default 0, none): bound at
   * group 0 binding 7 as `actor_table`, read with `actor_table_word(i)` / `actor_table_f32(i)`.
   * Written with `ActorSystem.writeTable`; kept on the CPU for a device restore.
   */
  tableWords?: number;
  /**
   * Make the pose pipeline with `createComputePipelineAsync` (ws/actor-post-fit; default false),
   * so building the system does not stall on the shader compile. Until `ready` settles (and
   * again after a device restore) `prepare` runs no pose pass and the actors draw nothing.
   */
  asyncPipeline?: boolean;
  label?: string;
}

/** Per-model options of `ActorSystem.addModel` (ws/actor-post-fit). */
export interface ActorModelOptions {
  /** This model's LOD distances (as `ActorSystemOptions.lods`); default the system's. */
  lods?: readonly number[];
}

/**
 * A draw set over the actor system's models (ws/actor-fit; `ActorSystem.addDrawSet`): the same
 * meshes, poses, visible lists and indirect counts as the body, drawn again with the set's own
 * shader (a shadow, a held item, an outline).
 */
export interface ActorDrawSetDesc {
  label?: string;
  /**
   * The shader. The system prepends, after the core's view and `VertexIn`, the actor buffers at
   * group 1 (`bones`, `lists`, `records`, `actor_params`) and helpers: `actor_at(draw, inst)`,
   * `actor_word`, `actor_f32`, `actor_position`, `actor_yaw`, `actor_scale`, `actor_model`,
   * `actor_bone`, `actor_skin`, `actor_point`, `actor_dir`, `actor_draw_of` and the system's
   * `actor_light`. Entry points are the set's (`vertexEntry`, default `vs`).
   */
  shader: DrawSetShader;
  /**
   * `'mesh'` (default): each model mesh's indexed vertices (`ACTOR_VERTEX_LAYOUT`, `in.draw`
   * the mesh) per visible actor, as the body. `'actor'`: `actorVertices` unindexed vertices
   * per visible actor and no vertex buffer; `actor_draw_of(in.core_vertex)` is the mesh and
   * `in.core_vertex % ACTOR_SET_VERTICES` the corner (needs `ActorSystemOptions.actorVertices`).
   * `VertexIn` holds `core_vertex`, and `core_origin` with the core's origin grid.
   */
  shape?: 'mesh' | 'actor';
  /**
   * An `'actor'` set's vertices per actor (ws/actor-post-fit): one of
   * `ActorSystemOptions.actorVertices`; default its first.
   */
  vertices?: number;
  /** As `ActorSystemOptions.showLive`, for this set (default true). */
  showLive?: boolean;
  pass?: string;
  order?: number;
  depth?: boolean;
  castShadow?: boolean;
  /** The set's own bind groups, at 2, 3, … (group 1 is the system's). */
  bindGroups?: DrawSetDesc['bindGroups'];
  variants?: DrawSetDesc['variants'];
  passes?: DrawSetDesc['passes'];
}

/** The vertex layout of an `'actor'` set: no attributes (vertices come from the vertex index). */
const NO_VERTICES: BufferLayout = createVertexLayout({ stride: 4, attributes: [] });

/** Per-frame counts of the last `prepare`. */
export interface ActorStats {
  /** GPU calls `prepare` made. */
  calls: number;
  /** Record bytes uploaded. */
  recordBytes: number;
  /**
   * Record uploads (ws/actor-post-fit): one per run of changed slots, near runs merged, so
   * slots far apart send their records and not the slots between.
   */
  recordWrites: number;
  /** Slots the pose pass covered (the high-water slot + 1). */
  dispatched: number;
}

const U = () => GPUBufferUsage;

/** A set added with `addDrawSet`: an `'actor'` set's record (-1 for a mesh set) and vertices. */
interface ExtraSet {
  set: DrawSet;
  rec: number;
  vertices: number;
  live: boolean;
  groups: DrawSetDesc['bindGroups'];
}
/** Unchanged record bytes between two changed runs worth sending to save an upload call. */
const RECORD_MERGE_BYTES = 1024;
/** Most record uploads a frame; past it, the last covers the rest of the changed range. */
const RECORD_MAX_WRITES = 16;

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
  readonly stats: ActorStats = { calls: 0, recordBytes: 0, recordWrites: 0, dispatched: 0 };
  /** `ActorSystemOptions.lodScale`, read each `prepare`. */
  lodScale: number;
  /** `ActorSystemOptions.vertexCap` (0: none), read each `prepare`. */
  vertexCap: number;
  /**
   * Settles when the pose pipeline is made (ws/actor-post-fit): at once without
   * `asyncPipeline`; replaced by a new promise when a device restore builds it again.
   */
  ready: Promise<void> = Promise.resolve();
  /** The draw set on the core (one slot per model mesh). */
  readonly drawSet: DrawSet;
  /** The skin matrices: `slots × bonesPerSlot` of three `vec4f` rows (the `SkinPalette` layout). */
  bones!: GPUBuffer;
  /** The records (`STORAGE | COPY_DST`). */
  records!: GPUBuffer;
  /** The clock of the last `prepare`. */
  time = 0;
  private readonly core: RenderCore;
  private device: GPUDevice;
  private readonly sampleLight: ((x: number, y: number, z: number) => number) | null;
  private readonly recU32: Uint32Array<ArrayBuffer>;
  private readonly recF32: Float32Array<ArrayBuffer>;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  /** Slots changed since the last upload (ws/actor-post-fit). */
  private readonly dirtyFlags: Uint8Array;
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
  args!: GPUBuffer;
  private template!: GPUBuffer;
  private readonly templateData: Uint32Array<ArrayBuffer>;
  private lists!: GPUBuffer;
  private paramsBuffer!: GPUBuffer;
  private readonly params = new ArrayBuffer(ACTOR_PARAMS_BYTES);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly paramsU32 = new Uint32Array(this.params);
  private rigBuffer!: GPUBuffer;
  private poseLayout!: GPUBindGroupLayout;
  private poseGroup!: GPUBindGroup;
  private posePipeline: GPUComputePipeline | null = null;
  /** Bumped by each build, so a slow async pipeline of an old device is dropped. */
  private buildGen = 0;
  private readonly asyncPipeline: boolean;
  private readonly bodyLive: boolean;
  private readonly tableData: Uint32Array<ArrayBuffer> | null;
  private readonly tableF32: Float32Array<ArrayBuffer> | null;
  private tableBuffer: GPUBuffer | null = null;
  /** Each model's own LOD distances (empty: the system's). */
  private readonly modelLods: (readonly number[])[] = [];
  private readonly computeDesc: GPUComputePassDescriptor;
  private readonly scratch: PoseScratch;
  private destroyed = false;
  private readonly consts: ActorShaderConsts;
  private drawLayout!: GPUBindGroupLayout;
  private drawGroup!: GPUBindGroup;
  /** Each model mesh's arena places, to write again after a device restore. */
  private readonly meshAllocs: { v: ArenaAlloc; ix: ArenaAlloc }[] = [];
  private readonly offRestored: () => void;
  /** Words per argument cell (5, and 4 per `actorVertices` count). */
  private readonly argsWords: number;
  private readonly actorVertices: readonly number[];
  private readonly poseHook: ActorPoseCpu | null;
  private readonly lightWgsl: string;
  /** Live records per model, and whether its draws are shown (ws/actor-fit). */
  private readonly live: Int32Array;
  private readonly shown: Uint8Array;
  private liveDirty = false;
  /** Sets added with `addDrawSet`: an `'actor'` set's record (-1 for a mesh set) and vertices. */
  private readonly extra: ExtraSet[] = [];
  private setLayout!: GPUBindGroupLayout;
  private setGroup!: GPUBindGroup;

  constructor(core: RenderCore, opts: ActorSystemOptions) {
    this.core = core;
    this.device = core.device;
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
    this.checkLods(lods);
    this.maxModels = Math.max(1, Math.floor(opts.maxModels ?? 16));
    this.maxDraws = Math.max(1, Math.floor(opts.maxDraws ?? this.maxModels * lods.length));
    this.maxViews = Math.max(1, Math.min(Math.floor(opts.maxViews ?? 2), core.maxViews));
    this.shape = recordShape(opts.recordLayout);
    this.stride = this.shape.stride;
    this.sampleLight = opts.sampleLight ?? null;
    this.scratch = createPoseScratch(this.bonesPerSlot);
    const av = opts.actorVertices ?? 0;
    this.actorVertices = (typeof av === 'number' ? [av] : av)
      .map((n) => Math.max(0, Math.floor(n)))
      .filter((n) => n > 0);
    this.argsWords = (ARGS_BYTES + this.actorVertices.length * DRAW_ARGS_BYTES) / 4;
    this.bodyLive = opts.showLive ?? true;
    this.lodScale = opts.lodScale ?? 1;
    this.vertexCap = Math.max(0, Math.floor(opts.vertexCap ?? 0));
    this.asyncPipeline = opts.asyncPipeline ?? false;
    const tw = Math.max(0, Math.floor(opts.tableWords ?? 0));
    this.tableData = tw > 0 ? new Uint32Array(tw) : null;
    this.tableF32 = this.tableData ? new Float32Array(this.tableData.buffer) : null;
    this.dirtyFlags = new Uint8Array(this.slots);
    this.poseHook = opts.poseCpu ?? null;
    this.lightWgsl = opts.lightWgsl ?? ACTOR_DEFAULT_LIGHT_WGSL;
    this.live = new Int32Array(this.maxModels);
    this.shown = new Uint8Array(this.maxModels).fill(1);

    // Records: every slot empty, unit scale, rate 1, white tint and light.
    this.recU32 = new Uint32Array(this.slots * this.stride);
    this.recF32 = new Float32Array(this.recU32.buffer);
    for (let s = 0; s < this.slots; s++) this.reset(s * this.stride);

    this.consts = {
      bones: this.bonesPerSlot,
      stride: this.stride,
      maxDraws: this.maxDraws,
      slots: this.slots,
      views: this.maxViews,
      argsWords: this.argsWords,
      actorVertices: this.actorVertices,
      counters: core.maxViews * this.maxDraws * this.argsWords,
      table: this.tableData !== null,
      pose: opts.poseWgsl ?? '',
      fieldConsts: actorFieldConsts(this.shape.fields),
    };
    const consts = this.consts;
    // The shader compares distances; an infinite one goes up as the largest float.
    for (let i = 0; i < ACTOR_MAX_LODS; i++) this.paramsF32[4 + i] = Math.min(lods[i] ?? 0, 3.4e38);
    this.paramsU32[8] = lods.length;
    // The argument cells, then one vertex counter per view (the vertex cap's), all reset each frame.
    this.templateData = new Uint32Array(consts.counters + this.maxViews);
    this.computeDesc = { label: `${this.label} pose` };
    this.build();
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
        code: actorDrawWgsl(consts, this.lightWgsl, this.shape.fields),
        cullMode: 'none',
        shadowFragmentEntry: ACTOR_SHADOW_FS,
      },
      vertexLayout: ACTOR_VERTEX_LAYOUT,
      vertices: this.vertexArena,
      indices: this.indexArena,
      capacity: this.maxDraws,
      kind: 'static',
      cull: 'external',
      args: this.args,
      ...(this.argsWords !== ARGS_BYTES / 4
        ? { argsStride: this.argsWords * 4 * this.maxDraws }
        : {}),
      pass: opts.pass ?? 'opaque',
      bindGroups: [{ layout: this.drawLayout, group: this.drawGroup }],
    });
    this.offRestored = core.onDeviceRestored((device) => this.restore(device));
  }

  /** The system's buffers, layouts and pose pipeline on `this.device`. */
  private build(): void {
    const device = this.device;
    const consts = this.consts;
    const u = U();
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
    const argsBytes = this.templateData.byteLength;
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
    this.rigBuffer = this.makeRigBuffer();
    if (this.tableData) {
      this.tableBuffer = device.createBuffer({
        label: `${this.label} table`,
        size: this.tableData.byteLength,
        usage: u.STORAGE | u.COPY_DST,
      });
      device.queue.writeBuffer(this.tableBuffer, 0, this.tableData);
    }

    const S = GPUShaderStage;
    const poseEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: S.COMPUTE, buffer: { type: 'storage' } },
    ];
    if (this.tableBuffer) {
      poseEntries.push({
        binding: 7,
        visibility: S.COMPUTE,
        buffer: { type: 'read-only-storage' },
      });
    }
    this.poseLayout = device.createBindGroupLayout({
      label: `${this.label} pose`,
      entries: poseEntries,
    });
    this.poseGroup = this.makePoseGroup();
    const module = device.createShaderModule({
      label: `${this.label} pose`,
      code: actorPoseWgsl(consts),
    });
    const pipeDesc: GPUComputePipelineDescriptor = {
      label: `${this.label} pose`,
      layout: device.createPipelineLayout({
        label: `${this.label} pose`,
        bindGroupLayouts: [this.poseLayout],
      }),
      compute: { module, entryPoint: 'pose' },
    };
    const gen = ++this.buildGen;
    this.posePipeline = null;
    if (this.asyncPipeline && typeof device.createComputePipelineAsync === 'function') {
      this.ready = device.createComputePipelineAsync(pipeDesc).then((p) => {
        if (gen === this.buildGen && !this.destroyed) {
          this.posePipeline = p;
          this.warmPose(p);
        }
      });
    } else {
      this.posePipeline = device.createComputePipeline(pipeDesc);
      this.warmPose(this.posePipeline);
      this.ready = Promise.resolve();
    }

    this.drawLayout = device.createBindGroupLayout({
      label: `${this.label} draw`,
      entries: [
        { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.drawGroup = device.createBindGroup({
      label: `${this.label} draw`,
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bones } },
        { binding: 1, resource: { buffer: this.lists } },
        { binding: 2, resource: { buffer: this.records } },
      ],
    });
    this.setLayout = device.createBindGroupLayout({
      label: `${this.label} sets`,
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.setGroup = device.createBindGroup({
      label: `${this.label} sets`,
      layout: this.setLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bones } },
        { binding: 1, resource: { buffer: this.lists } },
        { binding: 2, resource: { buffer: this.records } },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
      ],
    });
  }

  /**
   * After a device loss (`RenderCore.onDeviceRestored`): every buffer, the pipeline and the bind
   * groups again on the new device, the records, rigs and argument template uploaded again and
   * each model mesh written back into the core's restored arenas.
   */
  private restore(device: GPUDevice): void {
    if (this.destroyed) return;
    this.device = device;
    this.build();
    this.device.queue.writeBuffer(this.template, 0, this.templateData);
    let d = 0;
    for (const rig of this.rigs) {
      for (const mesh of rig.meshes) {
        const a = this.meshAllocs[d]!;
        this.vertexArena.write(a.v, this.stampedVertices(mesh, d));
        this.indexArena.write(a.ix, mesh.indices);
        d++;
      }
    }
    this.drawSet.setBindGroups([{ layout: this.drawLayout, group: this.drawGroup }], this.args);
    for (const e of this.extra) e.set.setBindGroups(this.setGroups(e.groups), this.args);
  }

  private setGroups(
    own: DrawSetDesc['bindGroups'],
  ): { layout: GPUBindGroupLayout; group: GPUBindGroup }[] {
    return [{ layout: this.setLayout, group: this.setGroup }, ...(own ?? [])];
  }

  /** Add model mesh `d`'s slot to an added set (slot `d`, its own argument record). */
  private addExtraSlot(e: ExtraSet, d: number): void {
    const w = this.argsWords * 4;
    if (e.rec >= 0) {
      e.set.addAt(d, {
        indexCount: e.vertices,
        instanceCount: 0,
        bounds: [0, 0, 0, Infinity],
        argsOffset: d * w + ARGS_BYTES + e.rec * DRAW_ARGS_BYTES,
      });
    } else {
      const a = this.meshAllocs[d]!;
      e.set.addAt(d, {
        vertices: a.v,
        indices: a.ix,
        indexCount: a.ix.size / 4,
        instanceCount: 0,
        bounds: [0, 0, 0, Infinity],
        ...(w !== ARGS_BYTES ? { argsOffset: d * w } : {}),
      });
    }
    if (e.live && !this.shown[this.modelOfDraw(d)]) e.set.setHidden(d, true);
  }

  private modelOfDraw(d: number): number {
    let m = 0;
    while (m + 1 < this.drawBases.length && this.drawBases[m + 1]! <= d) m++;
    return m;
  }

  /**
   * Another draw set over the system's models (ws/actor-fit): the bodies' meshes (or, with
   * `shape: 'actor'`, a few vertices per actor), poses and per-view visible lists, drawn with
   * `desc.shader` — a contact shadow, a held item's icon, an outline. One slot per model mesh
   * (slot = draw), indirect from the system's arguments, so it costs one bundle more and no
   * extra pass. Models with no live actor are left out, as in the body's set. Allocates; call
   * at load.
   */
  addDrawSet(desc: ActorDrawSetDesc): DrawSet {
    this.alive();
    const actor = desc.shape === 'actor';
    if (actor && this.actorVertices.length === 0) {
      throw new Error(`${this.label}: an 'actor' set needs ActorSystemOptions.actorVertices`);
    }
    const vertices = actor ? (desc.vertices ?? this.actorVertices[0]!) : 0;
    const rec = actor ? this.actorVertices.indexOf(vertices) : -1;
    if (actor && rec < 0) {
      throw new Error(`${this.label}: ${vertices} vertices is not in actorVertices`);
    }
    const label = desc.label ?? `${this.label} set ${this.extra.length + 1}`;
    const set = this.core.createDrawSet({
      label,
      shader: {
        // Its groups stay bound in the shadow pass (an actor's vertices read group 1).
        shadowFragmentEntry: ACTOR_SHADOW_FS,
        ...desc.shader,
        code:
          actorSetPreludeWgsl(this.consts, this.lightWgsl, this.shape.fields, vertices) +
          desc.shader.code,
      },
      vertexLayout: actor ? NO_VERTICES : ACTOR_VERTEX_LAYOUT,
      vertices: this.vertexArena,
      ...(actor ? { indexed: false } : { indices: this.indexArena }),
      capacity: this.maxDraws,
      kind: 'static',
      cull: 'external',
      args: this.args,
      argsStride: this.argsWords * 4 * this.maxDraws,
      pass: desc.pass ?? 'opaque',
      ...(desc.order !== undefined ? { order: desc.order } : {}),
      ...(desc.depth !== undefined ? { depth: desc.depth } : {}),
      ...(desc.castShadow !== undefined ? { castShadow: desc.castShadow } : {}),
      ...(desc.variants ? { variants: desc.variants } : {}),
      ...(desc.passes ? { passes: desc.passes } : {}),
      bindGroups: this.setGroups(desc.bindGroups),
    });
    const e = { set, rec, vertices, live: desc.showLive ?? true, groups: desc.bindGroups };
    this.extra.push(e);
    for (let d = 0; d < this.draws; d++) this.addExtraSlot(e, d);
    return set;
  }

  /** A mesh's vertices with the draw index `d` in each vertex's last word. */
  private stampedVertices(mesh: ActorRig['meshes'][number], d: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(mesh.vertices);
    const words = new Uint32Array(bytes.buffer);
    for (let i = 0; i < mesh.vertexCount; i++) words[(i * ACTOR_VERTEX_BYTES) / 4 + 7] = d;
    return bytes;
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
  addModel(rig: ActorRig, opts: ActorModelOptions = {}): number {
    this.alive();
    if (opts.lods) this.checkLods(opts.lods);
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
      const bytes = this.stampedVertices(mesh, d);
      const v = this.vertexArena.alloc(bytes.byteLength, ACTOR_VERTEX_BYTES);
      this.vertexArena.write(v, bytes);
      const ix = this.indexArena.alloc(mesh.indices.byteLength, 4);
      this.indexArena.write(ix, mesh.indices);
      this.meshAllocs[d] = { v, ix };
      const W = this.argsWords;
      const slot = this.drawSet.add({
        vertices: v,
        indices: ix,
        indexCount: mesh.indices.length,
        instanceCount: 0,
        bounds: [0, 0, 0, Infinity],
        ...(W !== ARGS_BYTES / 4 ? { argsOffset: d * W * 4 } : {}),
      });
      if (slot !== d) throw new Error(`${this.label}: draw slot ${slot} is not mesh ${d}`);
      for (let view = 0; view < this.core.maxViews; view++) {
        const a = (view * this.maxDraws + d) * W;
        this.templateData[a] = mesh.indices.length;
        this.templateData[a + 1] = 0;
        this.templateData[a + 2] = ix.offset / 4;
        this.templateData[a + 3] = v.offset / ACTOR_VERTEX_BYTES;
        this.templateData[a + 4] = 0;
        // The 'actor' sets' drawIndirects: the corners of each actor, the mesh in firstVertex.
        for (let i = 0; i < this.actorVertices.length; i++) {
          const n = this.actorVertices[i]!;
          const at = a + 5 + i * 4;
          this.templateData[at] = n;
          this.templateData[at + 1] = 0;
          this.templateData[at + 2] = d * n;
          this.templateData[at + 3] = 0;
        }
      }
    }
    this.draws += rig.meshes.length;
    this.drawBases.push(drawBase);
    // No live actor yet: its draws stay out of the bundles until one shows it.
    this.liveDirty = true;
    for (const e of this.extra) {
      for (let m = 0; m < rig.meshes.length; m++) this.addExtraSlot(e, drawBase + m);
    }
    this.rigs.push(rig);
    this.modelLods.push(opts.lods ?? []);
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
      const was = u[b + R.model]!;
      const now = rec.model < 0 ? ACTOR_NONE : rec.model;
      if (was !== now) this.count(was, now);
      u[b + R.model] = now;
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
    if (rec.cullRadius !== undefined) f[b + R.cullRadius] = rec.cullRadius;
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
    this.count(this.recU32[slot * this.stride + R.model]!, ACTOR_NONE);
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
    poseRecord(
      rig,
      this.recF32,
      this.recU32,
      base,
      time,
      this.scratch,
      out,
      space,
      this.poseHook,
      slot,
    );
    return true;
  }

  /**
   * Once a frame, before `core.draw` (and in the same encoder as `core.prepare`, which writes
   * the views this pass reads): upload the clock and the dirty records, reset the indirect
   * arguments, and run the pose pass over every slot up to the highest used. `views` is the
   * view count of the frame's `core.prepare`. A fixed number of GPU calls, whatever the actors.
   */
  prepare(
    encoder: GPUCommandEncoder,
    views: number | readonly unknown[],
    time: number,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    this.alive();
    const st = this.stats;
    st.calls = 0;
    st.recordBytes = 0;
    st.recordWrites = 0;
    st.dispatched = 0;
    this.time = time;
    const n = typeof views === 'number' ? views : views.length;
    const q = this.device.queue;
    this.paramsF32[0] = time;
    this.paramsU32[1] = this.high;
    this.paramsU32[2] = n;
    this.paramsF32[9] = this.lodScale;
    this.paramsU32[10] = this.vertexCap;
    q.writeBuffer(this.paramsBuffer, 0, this.params);
    st.calls++;
    if (this.dirtyHi >= this.dirtyLo) this.uploadRecords();
    encoder.copyBufferToBuffer(this.template, 0, this.args, 0, this.templateData.byteLength);
    st.calls++;
    if (this.liveDirty) this.showLive();
    if (this.high === 0 || this.rigs.length === 0 || !this.posePipeline) return;
    this.computeDesc.timestampWrites = timestampWrites;
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
    this.offRestored();
    this.drawSet.destroy();
    for (const e of this.extra) e.set.destroy();
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
    this.tableBuffer?.destroy();
  }

  /**
   * Write `data` into the game table at word `at` (ws/actor-post-fit; `tableWords`): uploaded
   * now and kept for a device restore. Allocates nothing.
   */
  writeTable(data: Uint32Array | Float32Array, at = 0): void {
    this.alive();
    const t = this.tableData;
    if (!t || !this.tableBuffer) throw new Error(`${this.label}: no table (tableWords)`);
    if (!(at >= 0 && Number.isInteger(at) && at + data.length <= t.length)) {
      throw new Error(`${this.label}: table words ${at}+${data.length} > ${t.length}`);
    }
    if (data instanceof Float32Array) this.tableF32!.set(data, at);
    else t.set(data, at);
    this.device.queue.writeBuffer(this.tableBuffer, at * 4, t, at, data.length);
  }

  // ------------------------------------------------------------------ internals

  private checkLods(lods: readonly number[]): void {
    if (lods.length < 1 || lods.length > ACTOR_MAX_LODS) {
      throw new Error(`${this.label}: 1 to ${ACTOR_MAX_LODS} LOD distances`);
    }
    for (let i = 1; i < lods.length; i++) {
      if (!(lods[i]! > lods[i - 1]!)) throw new Error(`${this.label}: LOD distances must rise`);
    }
  }

  /**
   * Upload the changed records (ws/actor-post-fit): one write per run of changed slots, runs
   * closer than `RECORD_MERGE_BYTES` joined, at most `RECORD_MAX_WRITES` writes.
   */
  private uploadRecords(): void {
    const st = this.stats;
    const q = this.device.queue;
    const flags = this.dirtyFlags;
    const stride = this.stride;
    const gap = Math.max(1, Math.floor(RECORD_MERGE_BYTES / (stride * 4)));
    const hi = this.dirtyHi;
    let s = this.dirtyLo;
    while (s <= hi) {
      // A run from s: extend while the next changed slot is within the gap.
      let last = s;
      const lastWrite = st.recordWrites === RECORD_MAX_WRITES - 1;
      for (let t = s + 1; t <= hi; t++) {
        if (flags[t]) {
          if (!lastWrite && t - last > gap) break;
          last = t;
        }
      }
      const end = last;
      const lo = s * stride;
      const words = (end + 1) * stride - lo;
      q.writeBuffer(this.records, lo * 4, this.recU32, lo, words);
      st.calls++;
      st.recordWrites++;
      st.recordBytes += words * 4;
      flags.fill(0, s, end + 1);
      s = end + 1;
      while (s <= hi && !flags[s]) s++;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  private alive(): void {
    if (this.destroyed) throw new Error(`${this.label}: destroyed`);
  }

  private check(slot: number): void {
    if (!(slot >= 0 && slot < this.slots && Number.isInteger(slot))) {
      throw new Error(`${this.label}: no slot ${slot}`);
    }
  }

  /** A record went from model `was` to `now` (either may be `ACTOR_NONE`). */
  private count(was: number, now: number): void {
    if (was !== ACTOR_NONE) this.live[was]!--;
    if (now !== ACTOR_NONE) this.live[now]!++;
    this.liveDirty = true;
  }

  /**
   * Leave out the draws of models no record shows (ws/actor-fit), so the bundles hold no empty
   * indirect draws; a set re-records only when a model gains its first actor or loses its last.
   */
  private showLive(): void {
    this.liveDirty = false;
    for (let m = 0; m < this.rigs.length; m++) {
      const show = this.live[m]! > 0 ? 1 : 0;
      if (show === this.shown[m]) continue;
      this.shown[m] = show;
      const base = this.drawBases[m]!;
      const end = base + this.rigs[m]!.meshes.length;
      for (let d = base; d < end; d++) {
        if (this.bodyLive) this.drawSet.setHidden(d, !show);
        for (const e of this.extra) if (e.live) e.set.setHidden(d, !show);
      }
    }
  }

  private dirty(slot: number): void {
    this.dirtyFlags[slot] = 1;
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
      const lods = this.modelLods[m]!;
      u32[h + RIG.lodCount] = lods.length;
      for (let i = 0; i < lods.length; i++) f32[h + RIG.lods + i] = Math.min(lods[i]!, 3.4e38);
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

  /**
   * The pose pass's empty first dispatch at load (ws/forge-asks-fit): WebKit compiles a compute
   * pipeline at its first dispatch, which is otherwise the first frame an actor moves.
   */
  private warmPose(pipeline: GPUComputePipeline): void {
    if (!this.core.warming) return;
    this.core.warmCompute(pipeline, {
      live: () => !this.destroyed,
      bind: (pass) => {
        pass.setBindGroup(0, this.poseGroup);
        return 1;
      },
    });
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
        ...(this.tableBuffer ? [{ binding: 7, resource: { buffer: this.tableBuffer } }] : []),
      ],
    });
  }
}

/** An actor system on `core`. */
export function createActorSystem(core: RenderCore, opts: ActorSystemOptions): ActorSystem {
  return new ActorSystem(core, opts);
}
