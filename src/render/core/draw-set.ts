/**
 * Draw sets (D1 §3.1, §3.3): a pipeline, a vertex layout, an instance layout, a source of slots
 * and a cull mode. A slot is one draw: a range of an arena's vertices, indices (its own or the
 * shared quad index), an optional range of instances and a bounding sphere.
 *
 * - `kind: 'static'` sets encode into a render bundle per (cull group, target signature), rebuilt
 *   only when the slot set changes; a frame executes it with one call, and both eyes of a stereo
 *   pair execute the same bundle.
 * - `kind: 'dynamic'` sets are encoded into the pass each frame (membership that churns).
 * - `cull: 'gpu'` culls in a compute pass that writes `drawIndexedIndirect` arguments per cull
 *   group; `'cpu'` tests spheres on the CPU once per group and draws the visible slots directly;
 *   `'none'` draws every live slot; `'external'` draws indirect from `DrawSetDesc.args`, a
 *   buffer the caller's own compute fills (the actors module culls and poses in one pass).
 * - With `multiDrawIndirect` and `indirect-first-instance` on the device, a GPU-culled set whose
 *   arenas are one block each draws with one `multiDrawIndexedIndirect`.
 *
 * Only the slot table's dirty range is uploaded; a held, unchanged set costs no CPU per frame.
 * With the core's `originGrid`, each slot has a float64 origin; the shader sees it relative to the
 * frame origin as `in.core_origin` (bound per slot, so a far world keeps float32 precision).
 */
import type { Arena, ArenaAlloc } from './arena';
import {
  ARGS_BYTES,
  CULL_PARAMS_BYTES,
  CULL_WORKGROUP,
  SLOT,
  SLOT_BYTES,
  SLOT_HIDDEN,
  SLOT_LIVE,
  SLOT_WORDS,
} from './cull';
import type { BufferLayout } from './layout';
import type { CorePass } from './pass-list';
import { CORE_VIEW_WGSL, sphereInPlanes } from './view';

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
   * the instance layout's, so the code starts at `@vertex fn vs(in: VertexIn) -> ...`. With the
   * core's `originGrid`, `VertexIn` ends with `core_origin: vec3f`: the slot's origin relative to
   * the frame origin, which the shader adds to its slot-local positions.
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
   * the caller's compute before the draw. Slot `id` of cull group `g` reads five `u32` (index
   * count, instance count, first index, base vertex, first instance) at byte
   * `(g * capacity + id) * 20`. Needs `INDIRECT` usage; the set never writes or destroys it.
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
  /** Bounding sphere `[x, y, z, r]` of everything the slot draws, relative to `origin`. */
  bounds: ArrayLike<number>;
  /**
   * The slot's origin in world space at float64 (default 0): its geometry and bounds are relative
   * to it. Needs the core's `originGrid`; the shader reads it, frame-relative, as `core_origin`.
   */
  origin?: ArrayLike<number>;
}

/** What a set needs of its core (the core passes itself). */
export interface DrawSetHost {
  readonly device: GPUDevice;
  readonly viewLayout: GPUBindGroupLayout;
  readonly cullLayout: GPUBindGroupLayout;
  readonly viewBuffer: GPUBuffer;
  readonly viewData: Float32Array;
  /** Byte offset of the cull groups' slots in `viewBuffer`. */
  readonly groupOffset: number;
  readonly maxViews: number;
  readonly multiDraw: boolean;
  readonly firstInstance: boolean;
  readonly stats: CoreStats;
  /** The bind group a draw of cull group `group` binds at 0. */
  drawGroup(group: number): GPUBindGroup;
  /** Float offset in `viewData` of cull group `group`'s planes. */
  groupPlanes(group: number): number;
  /** Frames prepared so far. */
  readonly frame: number;
  /** The frame origin (float64), when `originOn`. */
  readonly origin: Float64Array;
  readonly originOn: boolean;
  quadIndex(indexCount: number): GPUBuffer;
  readonly quadVersion: number;
  pass(id: string): CorePass;
  /**
   * The set whose stale bundles may be re-recorded this frame (D1 §3.3, streaming: one rebuild
   * a frame, coalesced), or null when every set may rebuild.
   */
  readonly rebuildTurn: DrawSet | null;
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
  /**
   * Stale bundles drawn as they were this frame because another set had the frame's rebuild
   * (`RenderCoreOptions.rebuildsPerFrame`); each is re-recorded on a later frame.
   */
  deferredBuilds: number;
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
  group: number;
  bind: GPUBindGroup;
  color: GPUTextureFormat;
  depth: GPUTextureFormat | undefined;
  readOnly: boolean;
  stamp: number;
  /** The part of `stamp` a stale bundle cannot be drawn without: buffers and bindings. */
  hard: number;
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
  /**
   * Bumped when a change moves a slot already recorded into a bundle to another buffer: such a
   * bundle must be re-recorded before it draws again (other changes may wait a frame).
   */
  private hardVersion = 0;
  /** Per slot: the vertex block and index buffer it was last recorded with (-1: never). */
  private readonly recorded: Int32Array;
  /** @internal The frame the set went stale (a change its bundles have not seen), or -1. */
  staleFrame = -1;
  private readonly host: DrawSetHost;
  private readonly desc: DrawSetDesc;
  private readonly slotF32: Float32Array;
  private readonly slotU32: Uint32Array;
  private readonly slotI32: Int32Array;
  private readonly vertexAllocs: (ArenaAlloc | null)[];
  private readonly indexAllocs: (ArenaAlloc | null)[];
  private readonly instanceAllocs: (ArenaAlloc | null)[];
  /** With an origin: each slot's origin + bounds centre, float64 (x, y, z per slot). */
  private readonly centres: Float64Array | null;
  private readonly origins: Float64Array | null;
  /** With an origin: each slot's origin relative to the frame origin, `vec4f` per slot. */
  private readonly originRel: Float32Array | null;
  private originBuffer: GPUBuffer | null = null;
  private readonly originSlot: number;
  private readonly frameOrigin = new Float64Array(3);
  /** CPU cull: the visible slots of the group last culled, and which (frame, group) that was. */
  private readonly visible: Uint8Array | null;
  private visibleFrame = -1;
  private visibleGroup = -1;
  private readonly freeIds: number[] = [];
  private live = 0;
  private high = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private slotBuffer: GPUBuffer | null = null;
  private argsBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private readonly params = new Uint32Array(4);
  private cullGroup: GPUBindGroup | null = null;
  private readonly bundles: BundleEntry[] = [];
  private readonly pipelines: PipelineEntry[] = [];
  private module!: GPUShaderModule;
  private layout!: GPUPipelineLayout;
  private bindGroups: readonly { layout: GPUBindGroupLayout; group: GPUBindGroup }[] | null;
  /** Restored with `bindGroups`: waits for `setBindGroups`. */
  private waiting = false;
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
    this.visible = this.cull === 'cpu' ? new Uint8Array(desc.capacity) : null;
    this.recorded = new Int32Array(desc.capacity).fill(-1);

    if (host.originOn) {
      this.centres = new Float64Array(desc.capacity * 3);
      this.origins = new Float64Array(desc.capacity * 3);
      this.originRel = new Float32Array(desc.capacity * 4);
      this.frameOrigin.set(host.origin);
    } else {
      this.centres = null;
      this.origins = null;
      this.originRel = null;
    }
    this.originSlot = desc.instanceLayout ? 2 : 1;
    this.bindGroups = desc.bindGroups ?? null;
    this.build();
  }

  /**
   * Make the set's GPU objects on the host's device: the shader, the pipeline layout and, by
   * cull mode, the slot table, argument and parameter buffers. The constructor's and
   * `restore`'s work; the CPU slot table is kept, so it is all re-uploaded on the next frame.
   */
  private build(): void {
    const host = this.host;
    const desc = this.desc;
    const { device } = host;
    this.originBuffer = host.originOn
      ? device.createBuffer({
          label: `${this.label} origins`,
          size: desc.capacity * 16,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
      : null;
    const vl = desc.vertexLayout;
    const il = desc.instanceLayout;
    const originLoc = vl.attributes.length + (il?.attributes.length ?? 0);
    const fields = [
      vl.wgslFields(0),
      il ? il.wgslFields(vl.attributes.length) : '',
      host.originOn ? `@location(${originLoc}) core_origin: vec3f,` : '',
    ]
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
    for (const g of this.bindGroups ?? []) groups.push(g.layout);
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
          {
            binding: 0,
            resource: {
              buffer: host.viewBuffer,
              offset: host.groupOffset,
              size: host.groupOffset,
            },
          },
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

  /**
   * @internal Rebuild on the host's new device after a device loss (`RenderCore.restore`). The
   * slots, their bounds and the hidden bits are kept and re-uploaded; the arenas' contents are
   * the game's to write again. A set made with `bindGroups` draws nothing until `setBindGroups`
   * hands it groups made on the new device.
   */
  restore(): void {
    if (this.destroyed) return;
    this.bundles.length = 0;
    this.pipelines.length = 0;
    this.recorded.fill(-1);
    this.paramsViews = -1;
    this.paramsCount = -1;
    this.paramsFirst = -1;
    this.visibleFrame = -1;
    this.waiting = this.bindGroups !== null && this.bindGroups.length > 0;
    this.build();
    if (this.high > 0) {
      this.dirty(0);
      this.dirty(this.high - 1);
    }
    if (this.originRel) {
      // Re-derive every slot's frame-relative origin on the next upload.
      this.frameOrigin[0] = Number.NaN;
    }
    this.bump();
  }

  /**
   * Replace the set's extra bind groups (at 1, 2, …) with groups of the same layouts' shape:
   * after a device loss, the ones made on the new device (`RenderCore.onDeviceRestored`).
   * Re-records the set's bundles.
   */
  setBindGroups(groups: readonly { layout: GPUBindGroupLayout; group: GPUBindGroup }[]): void {
    this.bindGroups = groups;
    this.waiting = false;
    this.layout = this.host.device.createPipelineLayout({
      label: this.label,
      bindGroupLayouts: [this.host.viewLayout, ...groups.map((g) => g.layout)],
    });
    this.pipelines.length = 0;
    this.bundles.length = 0;
    this.bump();
  }

  /** @internal False while a restored set waits for `setBindGroups`. */
  get ready(): boolean {
    return !this.waiting && !this.destroyed;
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
    this.writeCentre(id, x, y, z);
    this.slotF32[s + SLOT.r] = r;
    this.dirty(id);
  }

  /**
   * Hide or show slot `id` (D1 §3.3 `hiddenMask`): a hidden slot stays in the set, keeps its
   * geometry and draws nothing, as if culled. A GPU- or CPU-culled set takes it with no bundle
   * rebuild (the slot table's word changes); a `cull: 'none'` static set re-records its bundle.
   */
  setHidden(id: number, hidden: boolean): void {
    this.check(id);
    const at = id * SLOT_WORDS + SLOT.flags;
    const was = this.slotU32[at]!;
    const now = hidden ? was | SLOT_HIDDEN : was & ~SLOT_HIDDEN;
    if (now === was) return;
    this.slotU32[at] = now;
    this.dirty(id);
    if (this.cull === 'none') this.bump();
  }

  /** Is slot `id` hidden (`setHidden`)? */
  isHidden(id: number): boolean {
    return this.has(id) && (this.slotU32[id * SLOT_WORDS + SLOT.flags]! & SLOT_HIDDEN) !== 0;
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
    this.bump();
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
    this.originBuffer?.destroy();
    this.bundles.length = 0;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ------------------------------------------------------------------ core-facing

  /**
   * @internal Upload the slot table's dirty range and the cull parameters for `groups` cull
   * groups; first move to the host's frame origin when it changed.
   */
  upload(groups: number): void {
    const { device, stats } = this.host;
    if (this.originBuffer) this.rebase();
    if (this.originBuffer && this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo * 4;
      const n = (this.dirtyHi + 1) * 4 - lo;
      device.queue.writeBuffer(this.originBuffer, lo * 4, this.originRel!, lo, n);
      stats.calls++;
    }
    if (!this.slotBuffer || !this.paramsBuffer) {
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
      return;
    }
    const views = groups;
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

  /** @internal Dispatch the cull for `groups` cull groups into an open compute pass. */
  dispatch(pass: GPUComputePassEncoder, groups: number): void {
    if (!this.cullGroup || this.high === 0) return;
    pass.setBindGroup(0, this.cullGroup);
    pass.dispatchWorkgroups(Math.ceil(this.high / CULL_WORKGROUP), groups);
    this.host.stats.calls += 2;
    this.host.stats.dispatches++;
  }

  /** @internal How this frame draws the set. */
  encoding(): Encoding {
    if (this.useMulti()) return 'multi';
    if (this.kind === 'static' && this.cull !== 'cpu') return 'bundle';
    return 'direct';
  }

  /**
   * @internal The bundle for cull group `group` into a target of these formats, recorded if
   * stale. Every view of the group executes it.
   */
  bundle(
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    readOnly: boolean,
  ): GPURenderBundle {
    const stamp = this.stamp();
    const bind = this.host.drawGroup(group);
    let entry: BundleEntry | undefined;
    for (let i = 0; i < this.bundles.length; i++) {
      const b = this.bundles[i]!;
      if (b.group === group && b.color === color && b.depth === depth && b.readOnly === readOnly) {
        entry = b;
        break;
      }
    }
    if (entry && entry.stamp === stamp && entry.bind === bind) return entry.bundle;
    const hard = this.hardStamp();
    const { device, stats } = this.host;
    if (entry && entry.bind === bind && entry.hard === hard && this.deferrable()) {
      const turn = this.host.rebuildTurn;
      if (turn !== null && turn !== this) {
        // Slots only came, went or were hidden: the GPU cull still writes every recorded slot's
        // arguments (a removed one's are zero), so the old bundle draws correctly minus the new
        // slots, until this set's turn.
        stats.deferredBuilds++;
        return entry.bundle;
      }
    }
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
    this.record(enc, group, color, depth);
    stats.bundleCalls += stats.calls - calls;
    stats.calls = calls;
    stats.directDraws = draws;
    const bundle = enc.finish();
    stats.bundleBuilds++;
    if (entry) {
      entry.stamp = stamp;
      entry.hard = hard;
      entry.bind = bind;
      entry.bundle = bundle;
    } else {
      this.bundles.push({ group, bind, color, depth, readOnly, stamp, hard, bundle });
    }
    this.staleFrame = -1;
    return bundle;
  }

  /** @internal Encode cull group `group`'s draws into an open render pass (dynamic, CPU, multi). */
  encodeDirect(
    pass: GPURenderPassEncoder,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    if (this.useMulti()) {
      const { stats } = this.host;
      this.bindCommon(pass, group, color, depth);
      const v0 = this.vertexAllocs[this.firstLive()]!;
      pass.setVertexBuffer(0, this.desc.vertices.buffers[v0.block]!);
      if (this.desc.instanceLayout) pass.setVertexBuffer(1, this.desc.instances!.buffers[0]!);
      pass.setIndexBuffer(this.indexBufferOf(this.firstLive()), 'uint32');
      (pass as unknown as MultiDrawPass).multiDrawIndexedIndirect(
        this.argsBuffer!,
        group * this.capacity * ARGS_BYTES,
        this.high,
      );
      stats.calls += this.desc.instanceLayout ? 4 : 3;
      stats.directDraws++;
      return;
    }
    this.record(pass, group, color, depth);
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
    const so = slot.origin;
    if (!this.origins && so && (so[0] !== 0 || so[1] !== 0 || so[2] !== 0)) {
      throw new Error(`${this.label}: a slot origin needs the core's originGrid`);
    }
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
    const o = slot.origin;
    if (this.origins) {
      const k = id * 3;
      this.origins[k] = o ? o[0]! : 0;
      this.origins[k + 1] = o ? o[1]! : 0;
      this.origins[k + 2] = o ? o[2]! : 0;
      this.writeOrigin(id);
    }
    this.writeCentre(id, b[0]!, b[1]!, b[2]!);
    this.slotF32[s + SLOT.r] = b[3]!;
    this.slotU32[s + SLOT.indexCount] = slot.indexCount;
    this.slotU32[s + SLOT.firstIndex] = slot.indices ? slot.indices.offset / 4 : 0;
    this.slotI32[s + SLOT.baseVertex] = v.offset / vertexLayout.stride;
    this.slotU32[s + SLOT.instanceCount] = instanceCount;
    this.slotU32[s + SLOT.firstInstance] =
      instanceLayout && slot.instances ? slot.instances.offset / instanceLayout.stride : 0;
    const hidden = this.slotU32[s + SLOT.flags]! & SLOT_HIDDEN;
    this.slotU32[s + SLOT.flags] = SLOT_LIVE | hidden;
    const rec = this.recorded[id]!;
    if (rec >= 0 && rec !== this.bindingKey(v, slot.indices ?? null)) this.hardVersion++;
    if (slot.instances && this.instanceAllocs[id] !== slot.instances) this.hardVersion++;
    this.vertexAllocs[id] = v;
    this.indexAllocs[id] = slot.indices ?? null;
    this.instanceAllocs[id] = slot.instances ?? null;
    if (!slot.indices) this.host.quadIndex(slot.indexCount);
    this.dirty(id);
    this.bump();
  }

  /** The slot set changed: bundles are stale from this frame. */
  private bump(): void {
    this.version++;
    if (this.staleFrame < 0) this.staleFrame = this.host.frame;
  }

  /** What a recorded draw of a slot binds: its vertex block and its index buffer. */
  private bindingKey(v: ArenaAlloc, indices: ArenaAlloc | null): number {
    return v.block * 65536 + (indices ? indices.block + 1 : 0);
  }

  /**
   * @internal Stale, and its bundles may wait for its turn (`RenderCore`'s one rebuild a frame).
   */
  waitsForTurn(): boolean {
    return (
      this.staleFrame >= 0 && this.live > 0 && this.encoding() === 'bundle' && this.deferrable()
    );
  }

  /** A stale bundle of this set may be drawn a frame longer (GPU cull, no per-slot instances). */
  private deferrable(): boolean {
    return this.cull === 'gpu' && !this.desc.instanceLayout;
  }

  /** The stamp of the buffers a bundle binds (a change here forbids drawing a stale one). */
  private hardStamp(): number {
    const d = this.desc;
    return (
      this.hardVersion * 31 +
      d.vertices.version * 7 +
      (d.indices?.version ?? 0) * 13 +
      (d.instances?.version ?? 0) * 17 +
      this.host.quadVersion * 19
    );
  }

  /** Slot `id`'s bounds centre (relative to its origin) into the slot table, frame-relative. */
  private writeCentre(id: number, x: number, y: number, z: number): void {
    const s = id * SLOT_WORDS;
    const c = this.centres;
    if (!c) {
      this.slotF32[s + SLOT.x] = x;
      this.slotF32[s + SLOT.y] = y;
      this.slotF32[s + SLOT.z] = z;
      return;
    }
    const k = id * 3;
    const o = this.origins!;
    const f = this.frameOrigin;
    c[k] = o[k]! + x;
    c[k + 1] = o[k + 1]! + y;
    c[k + 2] = o[k + 2]! + z;
    this.slotF32[s + SLOT.x] = c[k]! - f[0]!;
    this.slotF32[s + SLOT.y] = c[k + 1]! - f[1]!;
    this.slotF32[s + SLOT.z] = c[k + 2]! - f[2]!;
  }

  /** Slot `id`'s origin relative to the frame origin, for the shader. */
  private writeOrigin(id: number): void {
    const o = this.origins!;
    const f = this.frameOrigin;
    const k = id * 3;
    const r = this.originRel!;
    r[id * 4] = o[k]! - f[0]!;
    r[id * 4 + 1] = o[k + 1]! - f[1]!;
    r[id * 4 + 2] = o[k + 2]! - f[2]!;
  }

  /** Move every live slot to the host's frame origin, when it changed. */
  private rebase(): void {
    const h = this.host.origin;
    const f = this.frameOrigin;
    if (h[0] === f[0] && h[1] === f[1] && h[2] === f[2]) return;
    f.set(h);
    const c = this.centres!;
    let any = false;
    for (let id = 0; id < this.high; id++) {
      const s = id * SLOT_WORDS;
      if ((this.slotU32[s + SLOT.flags]! & SLOT_LIVE) === 0) continue;
      const k = id * 3;
      this.slotF32[s + SLOT.x] = c[k]! - f[0]!;
      this.slotF32[s + SLOT.y] = c[k + 1]! - f[1]!;
      this.slotF32[s + SLOT.z] = c[k + 2]! - f[2]!;
      this.writeOrigin(id);
      any = true;
    }
    if (any) {
      this.dirty(0);
      this.dirty(this.high - 1);
    }
  }

  /** CPU cull: which live slots cull group `group` sees, once per (frame, group). */
  private cullCpu(group: number): void {
    const h = this.host;
    if (this.visibleFrame === h.frame && this.visibleGroup === group) return;
    this.visibleFrame = h.frame;
    this.visibleGroup = group;
    const vis = this.visible!;
    const at = h.groupPlanes(group);
    for (let id = 0; id < this.high; id++) {
      const s = id * SLOT_WORDS;
      vis[id] =
        (this.slotU32[s + SLOT.flags]! & (SLOT_LIVE | SLOT_HIDDEN)) === SLOT_LIVE &&
        sphereInPlanes(
          h.viewData,
          at,
          this.slotF32[s + SLOT.x]!,
          this.slotF32[s + SLOT.y]!,
          this.slotF32[s + SLOT.z]!,
          this.slotF32[s + SLOT.r]!,
        )
          ? 1
          : 0;
    }
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
    if (!h.multiDraw || !h.firstInstance || this.cull !== 'gpu' || h.originOn) return false;
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
    const buffers: GPUVertexBufferLayout[] = [d.vertexLayout.buffer(0)];
    if (d.instanceLayout) buffers.push(d.instanceLayout.buffer(d.vertexLayout.attributes.length));
    if (this.originBuffer) {
      // One vec3f per slot, bound at the slot's offset: stride 0 repeats it for every instance.
      buffers.push({
        arrayStride: 0,
        stepMode: 'instance',
        attributes: [
          {
            shaderLocation:
              d.vertexLayout.attributes.length + (d.instanceLayout?.attributes.length ?? 0),
            offset: 0,
            format: 'float32x3',
          },
        ],
      });
    }
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
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    enc.setPipeline(this.pipeline(color, depth));
    enc.setBindGroup(0, this.host.drawGroup(group));
    let calls = 2;
    const extra = this.bindGroups;
    if (extra) {
      for (let i = 0; i < extra.length; i++) enc.setBindGroup(i + 1, extra[i]!.group);
      calls += extra.length;
    }
    this.host.stats.calls += calls;
  }

  /** Record cull group `group`'s draws into a pass or a bundle (slot after slot, by id). */
  private record(
    enc: GPURenderPassEncoder | GPURenderBundleEncoder,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
  ): void {
    if (this.live === 0) return;
    const { stats } = this.host;
    const d = this.desc;
    this.bindCommon(enc, group, color, depth);
    const cpu = this.cull === 'cpu';
    const gpu = this.argsBuffer !== null;
    if (cpu) this.cullCpu(group);
    const vis = this.visible;
    const origins = this.originBuffer;
    const originSlot = this.originSlot;
    const instStride = d.instanceLayout?.stride ?? 0;
    let vBlock = -1;
    let iBuffer: GPUBuffer | null = null;
    let calls = 0;
    let draws = 0;
    for (let id = 0; id < this.high; id++) {
      const s = id * SLOT_WORDS;
      const flags = this.slotU32[s + SLOT.flags]!;
      if ((flags & SLOT_LIVE) === 0) continue;
      if (cpu && vis![id] === 0) continue;
      // A GPU-culled slot is recorded hidden or not (the cull zeroes its instances); others skip.
      if (!gpu && (flags & SLOT_HIDDEN) !== 0) continue;
      const va = this.vertexAllocs[id]!;
      this.recorded[id] = this.bindingKey(va, this.indexAllocs[id] ?? null);
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
      if (origins) {
        enc.setVertexBuffer(originSlot, origins, id * 16, 12);
        calls++;
      }
      if (gpu) {
        enc.drawIndexedIndirect(this.argsBuffer!, (group * this.capacity + id) * ARGS_BYTES);
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
