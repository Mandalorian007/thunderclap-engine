/**
 * Draw sets (D1 §3.1, §3.3): a pipeline, a vertex layout, an instance layout, a source of slots
 * and a cull mode. A slot is one draw: a range of an arena's vertices, indices (its own or the
 * shared quad index), an optional range of instances and a bounding sphere.
 *
 * - `kind: 'static'` sets encode into a render bundle per (view, target signature), rebuilt only
 *   when the slot set changes; a frame executes it with one call.
 * - `kind: 'dynamic'` sets are encoded into the pass each frame (membership that churns).
 * - `cull: 'gpu'` culls in a compute pass that writes `drawIndexedIndirect` arguments per view;
 *   `'cpu'` tests spheres on the CPU and draws the visible slots directly (small sets);
 *   `'none'` draws every live slot; `'external'` draws indirect from `DrawSetDesc.args`, a
 *   buffer the caller's own compute fills (the actors module culls and poses in one pass).
 * - With `multiDrawIndirect` and `indirect-first-instance` on the device, a GPU-culled set whose
 *   arenas are one block each draws with one `multiDrawIndexedIndirect`.
 *
 * Only the slot table's dirty range is uploaded; a held, unchanged set costs no CPU per frame.
 */
import type { Arena, ArenaAlloc } from './arena';
import {
  ARGS_BYTES,
  CULL_PARAMS_BYTES,
  CULL_WORKGROUP,
  SLOT,
  SLOT_BYTES,
  SLOT_LIVE,
  SLOT_WORDS,
} from './cull';
import type { BufferLayout } from './layout';
import type { CorePass } from './pass-list';
import { CORE_VIEW_WGSL, sphereInPlanes, VIEW_SLOT_FLOATS } from './view';

/**
 * How a set's slots are culled. `'auto'` is `'gpu'` from 256 slots of capacity, else `'cpu'`.
 * `'external'`: the caller writes the indirect arguments (`DrawSetDesc.args`).
 */
export type DrawSetCull = 'none' | 'cpu' | 'gpu' | 'auto' | 'external';
/** How a set is encoded: a cached bundle (`'static'`) or into the pass each frame (`'dynamic'`). */
export type DrawSetKind = 'static' | 'dynamic';

/** The capacity from which `cull: 'auto'` culls on the GPU. */
export const GPU_CULL_MIN_SLOTS = 256;

/** The shader of a draw set: WGSL with a vertex and a fragment entry point. */
export interface DrawSetShader {
  /**
   * WGSL. The core prepends `CORE_VIEW_WGSL`, `@group(0) @binding(0) var<uniform> view: CoreView;`,
   * the layouts' `wgslDecode` and a `struct VertexIn` holding the vertex layout's fields and then
   * the instance layout's, so the code starts at `@vertex fn vs(in: VertexIn) -> ...`.
   */
  code: string;
  /** Default `'vs'`. */
  vertexEntry?: string;
  /** Default `'fs'`. */
  fragmentEntry?: string;
  blend?: GPUBlendState;
  /** Default `'back'`. */
  cullMode?: GPUCullMode;
  /** Default `'less'`. */
  depthCompare?: GPUCompareFunction;
}

export interface DrawSetDesc {
  label?: string;
  shader: DrawSetShader;
  vertexLayout: BufferLayout;
  /** Per-instance data; without it every slot draws one instance with no instance buffer. */
  instanceLayout?: BufferLayout;
  /** The arena slots' vertices live in. */
  vertices: Arena;
  /** The arena slots' indices (`uint32`) live in; without it slots draw the shared quad index. */
  indices?: Arena;
  /** The arena slots' instances live in (required with `instanceLayout`). */
  instances?: Arena;
  /** Most slots the set holds. */
  capacity: number;
  /** Default `'static'`. */
  kind?: DrawSetKind;
  /** Default `'auto'`. */
  cull?: DrawSetCull;
  /** The pass the set joins (default `'opaque'`). */
  pass?: string;
  /** Test depth (default: when the pass has depth). */
  depth?: boolean;
  /** Order within the pass, lowest first (default 0; ties keep creation order). */
  order?: number;
  /** Extra bind groups at 1, 2, …: the set's own textures, samplers and storage. */
  bindGroups?: readonly { layout: GPUBindGroupLayout; group: GPUBindGroup }[];
  /**
   * With `cull: 'external'` (and only then): the `drawIndexedIndirect` arguments, written by
   * the caller's compute before the draw. Slot `id` of view `v` reads five `u32` (index count,
   * instance count, first index, base vertex, first instance) at byte
   * `(v * capacity + id) * 20`. Needs `INDIRECT` usage; the set never writes or destroys it.
   */
  args?: GPUBuffer;
}

/** One slot: a draw's geometry, instances and bounds. */
export interface SlotDesc {
  /** Vertices in the set's vertex arena (allocated with `align` = the layout's stride). */
  vertices: ArenaAlloc;
  /** Indices in the set's index arena; without it, the shared quad index from index 0. */
  indices?: ArenaAlloc;
  /** Indices to draw (a quad mesh: quads × 6). */
  indexCount: number;
  /** Instances in the set's instance arena (allocated with `align` = the layout's stride). */
  instances?: ArenaAlloc;
  /** Default: every instance `instances` holds, or 1 without instances. */
  instanceCount?: number;
  /** World-space bounding sphere `[x, y, z, r]` of everything the slot draws. */
  bounds: ArrayLike<number>;
}

/** What a set needs of its core (the core passes itself). */
export interface DrawSetHost {
  readonly device: GPUDevice;
  readonly viewLayout: GPUBindGroupLayout;
  readonly cullLayout: GPUBindGroupLayout;
  readonly viewBuffer: GPUBuffer;
  readonly viewData: Float32Array;
  readonly maxViews: number;
  readonly multiDraw: boolean;
  readonly firstInstance: boolean;
  readonly stats: CoreStats;
  viewGroup(index: number): GPUBindGroup;
  quadIndex(indexCount: number): GPUBuffer;
  readonly quadVersion: number;
  pass(id: string): CorePass;
}

/** Per-frame counts (reset by `prepare`) and running totals. */
export interface CoreStats {
  /** GPU API calls the core made this frame (queue writes, encoder and pass commands). */
  calls: number;
  /** Compute dispatches this frame. */
  dispatches: number;
  /** Render passes begun this frame. */
  passes: number;
  /** Bundles executed this frame. */
  bundles: number;
  /** Draw calls made directly in a pass this frame (not in a bundle). */
  directDraws: number;
  /** Slot-table bytes uploaded this frame. */
  slotBytes: number;
  /** Bundles recorded so far (each a rebuild). */
  bundleBuilds: number;
  /** Calls recorded into bundles so far. */
  bundleCalls: number;
}

/** The shape of `multiDrawIndexedIndirect` (Chromium's experimental feature). */
interface MultiDrawPass {
  multiDrawIndexedIndirect(
    buffer: GPUBuffer,
    offset: number,
    maxDrawCount: number,
    drawCountBuffer?: GPUBuffer,
    drawCountOffset?: number,
  ): void;
}

/** A cached bundle: what it was recorded against. */
interface BundleEntry {
  view: number;
  color: GPUTextureFormat;
  depth: GPUTextureFormat | undefined;
  readOnly: boolean;
  stamp: number;
  bundle: GPURenderBundle;
}

interface PipelineEntry {
  color: GPUTextureFormat;
  depth: GPUTextureFormat | undefined;
  depthWrite: boolean;
  pipeline: GPURenderPipeline;
}

/** How a frame draws a set. */
type Encoding = 'bundle' | 'direct' | 'multi';

/** A retained set of draws. Make one with `core.createDrawSet(desc)`. */
export class DrawSet {
  readonly label: string;
  readonly kind: DrawSetKind;
  readonly cull: 'none' | 'cpu' | 'gpu' | 'external';
  readonly capacity: number;
  readonly pass: CorePass;
  readonly order: number;
  /** Whether the set tests depth. */
  readonly depth: boolean;
  /** Bumped when the slot set changes (a static set's bundles are rebuilt). */
  version = 0;
  private readonly host: DrawSetHost;
  private readonly desc: DrawSetDesc;
  private readonly slotF32: Float32Array;
  private readonly slotU32: Uint32Array;
  private readonly slotI32: Int32Array;
  private readonly vertexAllocs: (ArenaAlloc | null)[];
  private readonly indexAllocs: (ArenaAlloc | null)[];
  private readonly instanceAllocs: (ArenaAlloc | null)[];
  private readonly freeIds: number[] = [];
  private live = 0;
  private high = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private readonly slotBuffer: GPUBuffer | null;
  private readonly argsBuffer: GPUBuffer | null;
  private readonly paramsBuffer: GPUBuffer | null;
  private readonly params = new Uint32Array(4);
  private readonly cullGroup: GPUBindGroup | null;
  private readonly bundles: BundleEntry[] = [];
  private readonly pipelines: PipelineEntry[] = [];
  private readonly module: GPUShaderModule;
  private readonly layout: GPUPipelineLayout;
  private paramsViews = -1;
  private paramsCount = -1;
  private paramsFirst = -1;
  private destroyed = false;

  constructor(host: DrawSetHost, desc: DrawSetDesc) {
    this.host = host;
    this.desc = desc;
    this.label = desc.label ?? 'draw set';
    if (!(desc.capacity > 0)) throw new Error(`${this.label}: capacity ${desc.capacity}`);
    if (desc.instanceLayout && !desc.instances) {
      throw new Error(`${this.label}: an instance layout needs an instance arena`);
    }
    this.kind = desc.kind ?? 'static';
    const cull = desc.cull ?? 'auto';
    this.cull = cull === 'auto' ? (desc.capacity >= GPU_CULL_MIN_SLOTS ? 'gpu' : 'cpu') : cull;
    if ((this.cull === 'external') !== !!desc.args) {
      throw new Error(`${this.label}: \`args\` goes with cull 'external' (and only with it)`);
    }
    this.capacity = desc.capacity;
    this.pass = host.pass(desc.pass ?? 'opaque');
    this.order = desc.order ?? 0;
    this.depth = desc.depth ?? this.pass.depth !== 'none';
    const words = new ArrayBuffer(desc.capacity * SLOT_BYTES);
    this.slotF32 = new Float32Array(words);
    this.slotU32 = new Uint32Array(words);
    this.slotI32 = new Int32Array(words);
    this.vertexAllocs = new Array(desc.capacity).fill(null);
    this.indexAllocs = new Array(desc.capacity).fill(null);
    this.instanceAllocs = new Array(desc.capacity).fill(null);

    const { device } = host;
    const vl = desc.vertexLayout;
    const il = desc.instanceLayout;
    const fields = [vl.wgslFields(0), il ? il.wgslFields(vl.attributes.length) : '']
      .filter(Boolean)
      .join('\n  ');
    const code = `${CORE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> view: CoreView;
struct VertexIn {
  ${fields}
};
${vl.wgslDecode}
${il?.wgslDecode ?? ''}
${desc.shader.code}`;
    this.module = device.createShaderModule({ label: this.label, code });
    const groups = [host.viewLayout];
    for (const g of desc.bindGroups ?? []) groups.push(g.layout);
    this.layout = device.createPipelineLayout({ label: this.label, bindGroupLayouts: groups });

    if (this.cull === 'gpu') {
      const u = GPUBufferUsage;
      this.slotBuffer = device.createBuffer({
        label: `${this.label} slots`,
        size: desc.capacity * SLOT_BYTES,
        usage: u.STORAGE | u.COPY_DST,
      });
      this.argsBuffer = device.createBuffer({
        label: `${this.label} args`,
        size: host.maxViews * desc.capacity * ARGS_BYTES,
        usage: u.STORAGE | u.INDIRECT | u.COPY_DST,
      });
      this.paramsBuffer = device.createBuffer({
        label: `${this.label} cull params`,
        size: CULL_PARAMS_BYTES,
        usage: u.UNIFORM | u.COPY_DST,
      });
      this.cullGroup = device.createBindGroup({
        label: `${this.label} cull`,
        layout: host.cullLayout,
        entries: [
          { binding: 0, resource: { buffer: host.viewBuffer } },
          { binding: 1, resource: { buffer: this.paramsBuffer } },
          { binding: 2, resource: { buffer: this.slotBuffer } },
          { binding: 3, resource: { buffer: this.argsBuffer } },
        ],
      });
    } else {
      this.slotBuffer = null;
      this.argsBuffer = desc.args ?? null;
      this.paramsBuffer = null;
      this.cullGroup = null;
    }
  }

  /** Live slots. */
  get count(): number {
    return this.live;
  }

  /** One past the highest slot id ever used (what a cull dispatch covers). */
  get highWater(): number {
    return this.high;
  }

  /** Add a slot; returns its id. Throws when the set is full. */
  add(slot: SlotDesc): number {
    const id = this.freeIds.length > 0 ? this.freeIds.pop()! : this.high;
    if (id >= this.capacity) throw new Error(`${this.label}: full (${this.capacity} slots)`);
    if (id >= this.high) this.high = id + 1;
    this.live++;
    this.write(id, slot);
    return id;
  }

  /** Replace slot `id`'s geometry, instances and bounds. */
  update(id: number, slot: SlotDesc): void {
    this.check(id);
    this.write(id, slot);
  }

  /** Move slot `id`'s bounding sphere (no bundle rebuild). */
  setBounds(id: number, x: number, y: number, z: number, r: number): void {
    this.check(id);
    const s = id * SLOT_WORDS;
    this.slotF32[s + SLOT.x] = x;
    this.slotF32[s + SLOT.y] = y;
    this.slotF32[s + SLOT.z] = z;
    this.slotF32[s + SLOT.r] = r;
    this.dirty(id);
  }

  /** Remove slot `id`; its id is reused by a later `add`. The allocations stay the caller's. */
  remove(id: number): void {
    this.check(id);
    const s = id * SLOT_WORDS;
    this.slotU32.fill(0, s, s + SLOT_WORDS);
    this.vertexAllocs[id] = null;
    this.indexAllocs[id] = null;
    this.instanceAllocs[id] = null;
    this.freeIds.push(id);
    this.live--;
    this.dirty(id);
    this.version++;
  }

  /** Is `id` a live slot? */
  has(id: number): boolean {
    return (
      id >= 0 && id < this.high && (this.slotU32[id * SLOT_WORDS + SLOT.flags]! & SLOT_LIVE) !== 0
    );
  }

  /** Free the set's buffers (not the arenas' allocations, which are the caller's). */
  destroy(): void {
    this.destroyed = true;
    this.slotBuffer?.destroy();
    if (this.cull !== 'external') this.argsBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.bundles.length = 0;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ------------------------------------------------------------------ core-facing

  /** @internal Upload the slot table's dirty range and the cull parameters. */
  upload(views: number): void {
    if (!this.slotBuffer || !this.paramsBuffer) {
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
      return;
    }
    const { device, stats } = this.host;
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo * SLOT_WORDS;
      const n = (this.dirtyHi + 1) * SLOT_WORDS - lo;
      device.queue.writeBuffer(this.slotBuffer, lo * 4, this.slotU32, lo, n);
      stats.calls++;
      stats.slotBytes += n * 4;
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
    }
    const first = this.useMulti() ? 1 : 0;
    if (
      views !== this.paramsViews ||
      this.high !== this.paramsCount ||
      first !== this.paramsFirst
    ) {
      this.paramsViews = views;
      this.paramsCount = this.high;
      this.paramsFirst = first;
      this.params[0] = this.high;
      this.params[1] = this.capacity;
      this.params[2] = views;
      this.params[3] = first;
      device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
      stats.calls++;
    }
  }

  /** @internal Dispatch the cull into an open compute pass (its pipeline set). */
  dispatch(pass: GPUComputePassEncoder, views: number): void {
    if (!this.cullGroup || this.high === 0) return;
    pass.setBindGroup(0, this.cullGroup);
    pass.dispatchWorkgroups(Math.ceil(this.high / CULL_WORKGROUP), views);
    this.host.stats.calls += 2;
    this.host.stats.dispatches++;
  }

  /** @internal How this frame draws the set. */
  encoding(): Encoding {
    if (this.useMulti()) return 'multi';
    if (this.kind === 'static' && this.cull !== 'cpu') return 'bundle';
    return 'direct';
  }

  /** @internal The bundle for view `view` into a target of these formats, recorded if stale. */
  bundle(
    view: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    readOnly: boolean,
  ): GPURenderBundle {
    const stamp = this.stamp();
    let entry: BundleEntry | undefined;
    for (let i = 0; i < this.bundles.length; i++) {
      const b = this.bundles[i]!;
      if (b.view === view && b.color === color && b.depth === depth && b.readOnly === readOnly) {
        entry = b;
        break;
      }
    }
    if (entry && entry.stamp === stamp) return entry.bundle;
    const { device, stats } = this.host;
    const enc = device.createRenderBundleEncoder({
      label: `${this.label} bundle`,
      colorFormats: [color],
      depthStencilFormat: depth,
      depthReadOnly: readOnly,
      stencilReadOnly: readOnly,
    });
    // Recording is not this frame's pass work: its calls count as bundle calls.
    const calls = stats.calls;
    const draws = stats.directDraws;
    this.record(enc, view, color, depth);
    stats.bundleCalls += stats.calls - calls;
    stats.calls = calls;
    stats.directDraws = draws;
    const bundle = enc.finish();
    stats.bundleBuilds++;
    if (entry) {
      entry.stamp = stamp;
      entry.bundle = bundle;
    } else {
      this.bundles.push({ view, color, depth, readOnly, stamp, bundle });
    }
    return bundle;
  }

  /** @internal Encode the set directly into an open render pass (dynamic, CPU-culled, multi). */
  encodeDirect(
    pass: GPURenderPassEncoder,
    view: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    if (this.useMulti()) {
      const { stats } = this.host;
      this.bindCommon(pass, view, color, depth);
      const v0 = this.vertexAllocs[this.firstLive()]!;
      pass.setVertexBuffer(0, this.desc.vertices.buffers[v0.block]!);
      if (this.desc.instanceLayout) pass.setVertexBuffer(1, this.desc.instances!.buffers[0]!);
      pass.setIndexBuffer(this.indexBufferOf(this.firstLive()), 'uint32');
      (pass as unknown as MultiDrawPass).multiDrawIndexedIndirect(
        this.argsBuffer!,
        view * this.capacity * ARGS_BYTES,
        this.high,
      );
      stats.calls += this.desc.instanceLayout ? 4 : 3;
      stats.directDraws++;
      return;
    }
    this.record(pass, view, color, depth);
  }

  // ------------------------------------------------------------------ internals

  private check(id: number): void {
    if (!this.has(id)) throw new Error(`${this.label}: no slot ${id}`);
  }

  private dirty(id: number): void {
    if (id < this.dirtyLo) this.dirtyLo = id;
    if (id > this.dirtyHi) this.dirtyHi = id;
  }

  private write(id: number, slot: SlotDesc): void {
    const { vertexLayout, instanceLayout } = this.desc;
    const v = slot.vertices;
    if (v.offset % vertexLayout.stride !== 0) {
      throw new Error(
        `${this.label}: vertices at ${v.offset} not aligned to stride ${vertexLayout.stride}`,
      );
    }
    if (slot.indices && slot.indices.offset % 4 !== 0) {
      throw new Error(`${this.label}: indices at ${slot.indices.offset} not 4-byte aligned`);
    }
    if (slot.indices && !this.desc.indices) {
      throw new Error(`${this.label}: slot indices given but the set has no index arena`);
    }
    let instanceCount = slot.instanceCount ?? 1;
    if (instanceLayout) {
      const inst = slot.instances;
      if (!inst) throw new Error(`${this.label}: slot needs instances`);
      if (inst.offset % instanceLayout.stride !== 0) {
        throw new Error(
          `${this.label}: instances at ${inst.offset} not aligned to stride ${instanceLayout.stride}`,
        );
      }
      instanceCount = slot.instanceCount ?? Math.floor(inst.size / instanceLayout.stride);
    }
    const s = id * SLOT_WORDS;
    const b = slot.bounds;
    this.slotF32[s + SLOT.x] = b[0]!;
    this.slotF32[s + SLOT.y] = b[1]!;
    this.slotF32[s + SLOT.z] = b[2]!;
    this.slotF32[s + SLOT.r] = b[3]!;
    this.slotU32[s + SLOT.indexCount] = slot.indexCount;
    this.slotU32[s + SLOT.firstIndex] = slot.indices ? slot.indices.offset / 4 : 0;
    this.slotI32[s + SLOT.baseVertex] = v.offset / vertexLayout.stride;
    this.slotU32[s + SLOT.instanceCount] = instanceCount;
    this.slotU32[s + SLOT.firstInstance] =
      instanceLayout && slot.instances ? slot.instances.offset / instanceLayout.stride : 0;
    this.slotU32[s + SLOT.flags] = SLOT_LIVE;
    this.vertexAllocs[id] = v;
    this.indexAllocs[id] = slot.indices ?? null;
    this.instanceAllocs[id] = slot.instances ?? null;
    if (!slot.indices) this.host.quadIndex(slot.indexCount);
    this.dirty(id);
    this.version++;
  }

  /** Everything a cached bundle depends on, as one number. */
  private stamp(): number {
    const d = this.desc;
    return (
      this.version * 31 +
      d.vertices.version * 7 +
      (d.indices?.version ?? 0) * 13 +
      (d.instances?.version ?? 0) * 17 +
      this.host.quadVersion * 19
    );
  }

  private useMulti(): boolean {
    const h = this.host;
    if (!h.multiDraw || !h.firstInstance || this.cull !== 'gpu') return false;
    const d = this.desc;
    return (
      d.vertices.buffers.length === 1 &&
      (!d.indices || d.indices.buffers.length === 1) &&
      (!d.instances || d.instances.buffers.length <= 1) &&
      this.live > 0
    );
  }

  private firstLive(): number {
    for (let i = 0; i < this.high; i++) {
      if ((this.slotU32[i * SLOT_WORDS + SLOT.flags]! & SLOT_LIVE) !== 0) return i;
    }
    return 0;
  }

  private indexBufferOf(id: number): GPUBuffer {
    const ia = this.indexAllocs[id];
    if (ia) return this.desc.indices!.buffers[ia.block]!;
    return this.host.quadIndex(0);
  }

  private pipeline(
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): GPURenderPipeline {
    const depthWrite = this.pass.depth === 'write';
    for (let i = 0; i < this.pipelines.length; i++) {
      const p = this.pipelines[i]!;
      if (p.color === color && p.depth === depth && p.depthWrite === depthWrite) return p.pipeline;
    }
    const d = this.desc;
    const buffers = [d.vertexLayout.buffer(0)];
    if (d.instanceLayout) buffers.push(d.instanceLayout.buffer(d.vertexLayout.attributes.length));
    const pipeline = this.host.device.createRenderPipeline({
      label: this.label,
      layout: this.layout,
      vertex: { module: this.module, entryPoint: d.shader.vertexEntry ?? 'vs', buffers },
      fragment: {
        module: this.module,
        entryPoint: d.shader.fragmentEntry ?? 'fs',
        targets: [d.shader.blend ? { format: color, blend: d.shader.blend } : { format: color }],
      },
      primitive: { topology: 'triangle-list', cullMode: d.shader.cullMode ?? 'back' },
      depthStencil:
        depth && this.depth
          ? {
              format: depth,
              depthWriteEnabled: depthWrite,
              depthCompare: d.shader.depthCompare ?? 'less',
            }
          : depth
            ? { format: depth, depthWriteEnabled: false, depthCompare: 'always' }
            : undefined,
    });
    this.pipelines.push({ color, depth, depthWrite, pipeline });
    return pipeline;
  }

  private bindCommon(
    enc: GPURenderPassEncoder | GPURenderBundleEncoder,
    view: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    enc.setPipeline(this.pipeline(color, depth));
    enc.setBindGroup(0, this.host.viewGroup(view));
    let calls = 2;
    const extra = this.desc.bindGroups;
    if (extra) {
      for (let i = 0; i < extra.length; i++) enc.setBindGroup(i + 1, extra[i]!.group);
      calls += extra.length;
    }
    this.host.stats.calls += calls;
  }

  /** Record the set's draws into a pass or a bundle (one slot after another, by id). */
  private record(
    enc: GPURenderPassEncoder | GPURenderBundleEncoder,
    view: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    if (this.live === 0) return;
    const { stats, viewData } = this.host;
    const d = this.desc;
    this.bindCommon(enc, view, color, depth);
    const cpu = this.cull === 'cpu';
    const gpu = this.argsBuffer !== null;
    const planesAt = view * VIEW_SLOT_FLOATS + 20;
    const instStride = d.instanceLayout?.stride ?? 0;
    let vBlock = -1;
    let iBuffer: GPUBuffer | null = null;
    let calls = 0;
    let draws = 0;
    for (let id = 0; id < this.high; id++) {
      const s = id * SLOT_WORDS;
      if ((this.slotU32[s + SLOT.flags]! & SLOT_LIVE) === 0) continue;
      if (
        cpu &&
        !sphereInPlanes(
          viewData,
          planesAt,
          this.slotF32[s + SLOT.x]!,
          this.slotF32[s + SLOT.y]!,
          this.slotF32[s + SLOT.z]!,
          this.slotF32[s + SLOT.r]!,
        )
      ) {
        continue;
      }
      const va = this.vertexAllocs[id]!;
      if (va.block !== vBlock) {
        vBlock = va.block;
        enc.setVertexBuffer(0, d.vertices.buffers[vBlock]!);
        calls++;
      }
      const ib = this.indexBufferOf(id);
      if (ib !== iBuffer) {
        iBuffer = ib;
        enc.setIndexBuffer(ib, 'uint32');
        calls++;
      }
      const inst = this.instanceAllocs[id];
      if (inst) {
        // The slot's instances bound at their offset: first instance stays 0, so no
        // `indirect-first-instance` is needed (WebKit, and Chromium without the feature).
        const n = this.slotU32[s + SLOT.instanceCount]!;
        enc.setVertexBuffer(1, d.instances!.buffers[inst.block]!, inst.offset, n * instStride);
        calls++;
      }
      if (gpu) {
        enc.drawIndexedIndirect(this.argsBuffer!, (view * this.capacity + id) * ARGS_BYTES);
      } else {
        enc.drawIndexed(
          this.slotU32[s + SLOT.indexCount]!,
          this.slotU32[s + SLOT.instanceCount]!,
          this.slotU32[s + SLOT.firstIndex]!,
          this.slotI32[s + SLOT.baseVertex]!,
          0,
        );
      }
      calls++;
      draws++;
    }
    stats.calls += calls;
    stats.directDraws += draws;
  }
}
