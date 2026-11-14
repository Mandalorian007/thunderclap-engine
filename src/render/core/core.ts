/**
 * The render core (D1 §3, *Today (preview)*): the retained, GPU-driven, view-plural bottom layer
 * of the one renderer. A frame is
 *
 * ```
 * core.prepare(encoder, views | groups)   once: view uniforms, dirty slot ranges, one cull dispatch per GPU set
 * core.draw(encoder, viewIndex, target)   per view: the pass list, each pass only if it has work
 * ```
 *
 * and the caller submits the encoder. Held sets that did not change cost no CPU and the same GPU
 * calls whatever their slot count: a static GPU-culled set is one `executeBundles` entry.
 *
 * Views come in cull groups (D1 §3.5). A plain view list makes each view its own group. A group
 * of several views (a stereo pair) is culled once by the union of its frusta: one dispatch row,
 * one argument set and one bundle per set serve all its views; `draw` copies the view's uniforms
 * into the group's binding first (one `copyBufferToBuffer`).
 */
import { Arena, type ArenaDesc } from './arena';
import { CULL_WGSL } from './cull';
import { type CoreStats, DrawSet, type DrawSetDesc, type DrawSetHost } from './draw-set';
import { type CorePass, type PassDesc, PassList } from './pass-list';
import { QuadIndex } from './quad-index';
import {
  type CullGroup,
  MAX_VIEWS,
  openPlanesInto,
  type RenderView,
  unionPlanesInto,
  VIEW_SLOT,
  VIEW_SLOT_BYTES,
  VIEW_SLOT_FLOATS,
  writeViewSlot,
} from './view';

/** Chromium's multi-draw feature name. */
export const MULTI_DRAW_FEATURE = 'chromium-experimental-multi-draw-indirect';

export interface RenderCoreOptions {
  /** Views a frame may prepare (default and most `MAX_VIEWS`). */
  maxViews?: number;
  /** The depth format of attachments made from use (default `'depth24plus'`). */
  depthFormat?: GPUTextureFormat;
  /** Use `multiDrawIndexedIndirect` when the device has it (default true; off with an origin). */
  multiDraw?: boolean;
  /**
   * Camera-relative rendering (D1 §3.8): snap the frame origin to this grid (metres, e.g. 1024)
   * around the first view's eye and hand the GPU everything relative to it. Slots then take a
   * float64 `origin` and shaders read `in.core_origin`. Default 0: off, world space as given.
   */
  originGrid?: number;
  /**
   * Called as `draw` starts each view, with its index (a test's `meter.view` or
   * `FakeDevice.markView`, to split counts by view).
   */
  onView?: ((viewIndex: number) => void) | null;
  /**
   * Re-record at most one set's stale bundles a frame (default true; D1 §3.3). While sections
   * stream in, every upload frame changes a set; rebuilding each set's bundle each frame is the
   * hitch. A GPU-culled static set whose slots only came, went or were hidden keeps drawing its
   * last bundle (the cull still writes every recorded slot's arguments, so nothing wrong draws;
   * new slots wait) until its turn: the set stale the longest goes first. A change that moved a
   * recorded slot to another buffer, a set with per-slot instances and a first bundle never wait.
   */
  coalesceRebuilds?: boolean;
}

/** Where a view draws: a colour view of a texture of `format` and size, cleared or loaded. */
export interface CoreTarget {
  view: GPUTextureView;
  format: GPUTextureFormat;
  width: number;
  height: number;
  /** Clear to this colour on the first pass; without it the target is loaded. */
  clear?: GPUColor;
  /**
   * Draw into this rectangle of the target only (pixels; viewport and scissor). Depth is still
   * the target's size and is cleared whole by the view's first depth pass.
   */
  viewport?: { x: number; y: number; width: number; height: number };
  /**
   * A depth attachment the caller owns, in the core's `depthFormat` and the target's size, that
   * already holds the scene's depth (ws/core-passes): the core loads it and never clears it,
   * and makes no depth of its own. The `Renderer` hands its scene target's depth here.
   */
  depth?: GPUTextureView;
  /**
   * Which of the pass list's passes to draw (ws/core-passes): `'opaque'`, those before
   * `transparent`; `'blend'`, `transparent` and every pass after it; `'all'` (default) every
   * pass. A caller that draws blended work of its own between the two calls `draw` twice.
   */
  phase?: 'all' | 'opaque' | 'blend';
}

/** What the core's device offers it. */
export interface CoreCaps {
  /** `multiDrawIndexedIndirect` (Chromium's experimental feature, and enabled in options). */
  readonly multiDraw: boolean;
  /** `indirect-first-instance`. */
  readonly firstInstance: boolean;
}

function newStats(): CoreStats {
  return {
    calls: 0,
    dispatches: 0,
    passes: 0,
    bundles: 0,
    directDraws: 0,
    slotBytes: 0,
    bundleBuilds: 0,
    bundleCalls: 0,
    deferredBuilds: 0,
  };
}

/** The retained render core on one device. Make one with `createRenderCore`. */
export class RenderCore {
  private dev: GPUDevice;
  private capsNow: CoreCaps;
  /** The device; a new one after `restore`. */
  get device(): GPUDevice {
    return this.dev;
  }
  /** What the device offers (re-read by `restore`). */
  get caps(): CoreCaps {
    return this.capsNow;
  }
  readonly passes: PassList;
  readonly maxViews: number;
  readonly depthFormat: GPUTextureFormat;
  readonly stats: CoreStats = newStats();
  /** Frames prepared so far. */
  frame = 0;
  /** The frame origin (float64; zero unless `originGrid`), set by `prepare`. */
  readonly origin = new Float64Array(3);
  /** The origin grid (0: off). */
  readonly originGrid: number;
  /** Cull groups of the last `prepare`. */
  groups = 0;
  /** Called as `draw` starts each view (see `RenderCoreOptions.onView`). */
  onView: ((viewIndex: number) => void) | null;
  /** @internal */ viewLayout!: GPUBindGroupLayout;
  /** @internal */ cullLayout!: GPUBindGroupLayout;
  /** @internal */ viewBuffer!: GPUBuffer;
  /** @internal */ readonly viewData: Float32Array;
  /** Device restores so far (`restore`). */
  restores = 0;
  private readonly viewU32: Uint32Array;
  private readonly viewGroups: GPUBindGroup[] = [];
  /** The view a multi-view group's draw reads: `draw` copies its view's slot here. */
  private currentBuffer!: GPUBuffer;
  private currentGroup!: GPUBindGroup;
  /** Arenas made through `createArena`: rebuilt by `restore`. */
  private readonly arenas: Arena[] = [];
  private readonly restoredFns: ((device: GPUDevice) => void)[] = [];
  private readonly multiDrawOpt: boolean;
  /** Per prepared view: its cull group; per group: its first view and count. */
  private readonly groupOf = new Int32Array(MAX_VIEWS);
  private readonly groupFirst = new Int32Array(MAX_VIEWS);
  private readonly groupSize = new Int32Array(MAX_VIEWS);
  private readonly flat: RenderView[] = [];
  private readonly quads: QuadIndex;
  private cullPipeline: GPUComputePipeline | null = null;
  private readonly sets: DrawSet[] = [];
  /** Sets per pass, in pass order then set order (rebuilt when sets come or go). */
  private readonly bySet: DrawSet[][] = [];
  private setsDirty = true;
  private viewsPrepared = 0;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private readonly bundleList: GPURenderBundle[] = [];
  private readonly host: DrawSetHost;
  private readonly colorAttachment: GPURenderPassColorAttachment;
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment;
  private readonly passDesc: GPURenderPassDescriptor;
  private readonly passDescDepth: GPURenderPassDescriptor;
  private readonly computeDesc: GPUComputePassDescriptor = { label: 'core cull' };
  /** Whose stale bundles may be re-recorded this frame (see `coalesceRebuilds`). */
  private rebuildTurn: DrawSet | null = null;
  private readonly coalesce: boolean;

  constructor(device: GPUDevice, opts: RenderCoreOptions = {}) {
    this.dev = device;
    this.multiDrawOpt = opts.multiDraw ?? true;
    this.capsNow = this.capsOf(device);
    this.maxViews = Math.max(1, Math.min(opts.maxViews ?? MAX_VIEWS, MAX_VIEWS));
    this.depthFormat = opts.depthFormat ?? 'depth24plus';
    this.originGrid = Math.max(0, opts.originGrid ?? 0);
    this.onView = opts.onView ?? null;
    this.coalesce = opts.coalesceRebuilds ?? true;
    this.passes = new PassList();
    this.quads = new QuadIndex(device);
    this.viewData = new Float32Array(2 * MAX_VIEWS * VIEW_SLOT_FLOATS);
    this.viewU32 = new Uint32Array(this.viewData.buffer);
    this.build();
    this.colorAttachment = {
      view: undefined as unknown as GPUTextureView,
      loadOp: 'load',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.depthAttachment = {
      view: undefined as unknown as GPUTextureView,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 1,
    };
    this.passDesc = { label: 'core pass', colorAttachments: [this.colorAttachment] };
    this.passDescDepth = {
      label: 'core pass',
      colorAttachments: [this.colorAttachment],
      depthStencilAttachment: this.depthAttachment,
    };
    const core = this;
    this.host = {
      get device() {
        return core.device;
      },
      get viewLayout() {
        return core.viewLayout;
      },
      get cullLayout() {
        return core.cullLayout;
      },
      get viewBuffer() {
        return core.viewBuffer;
      },
      viewData: this.viewData,
      groupOffset: MAX_VIEWS * VIEW_SLOT_BYTES,
      maxViews: this.maxViews,
      get multiDraw() {
        return core.caps.multiDraw;
      },
      get firstInstance() {
        return core.caps.firstInstance;
      },
      stats: this.stats,
      drawGroup: (g) =>
        this.groupSize[g]! > 1 ? this.currentGroup : this.viewGroups[this.groupFirst[g]!]!,
      groupPlanes: (g) => (MAX_VIEWS + g) * VIEW_SLOT_FLOATS + VIEW_SLOT.planes,
      get frame() {
        return core.frame;
      },
      origin: this.origin,
      originOn: this.originGrid > 0,
      quadIndex: (n) => this.quads.ensure(Math.ceil(n / 6)),
      get quadVersion() {
        return core.quads.version;
      },
      pass: (id) => {
        const p = this.passes.get(id);
        if (!p) throw new Error(`no pass ${id}`);
        return p;
      },
      get rebuildTurn() {
        return core.rebuildTurn;
      },
    };
  }

  /**
   * A new arena on the core's device (D1 §3.1 `renderer.arena(kind)`); `restore` rebuilds it.
   */
  createArena(desc: ArenaDesc): Arena {
    const arena = new Arena(this.device, desc);
    this.arenas.push(arena);
    return arena;
  }

  /**
   * Rebuild everything the core owns on `device`, after the old one was lost (D1 §3, device
   * loss). The rebuild list: the core's view buffers, layouts and cull pipeline; every arena made
   * through `createArena` (each block again, the same size, every allocation still valid, the
   * bytes gone); every draw set (its slots, bounds and hidden bits kept and re-uploaded; its
   * pipelines and bundles recorded again on first use); the shared quad index; the depth
   * attachment (on next use). Passes are data and stay. Then each `onDeviceRestored` listener
   * runs once, with the device: that is where the game writes its arenas' bytes again and hands
   * sets made with `bindGroups` new ones (`DrawSet.setBindGroups`). Nothing is drawn until the
   * next `prepare`.
   */
  restore(device: GPUDevice): void {
    this.dev = device;
    this.capsNow = this.capsOf(device);
    this.cullPipeline = null;
    this.depthTexture = null;
    this.depthView = null;
    this.viewsPrepared = 0;
    this.build();
    this.quads.restore(device);
    for (const a of this.arenas) a.restore(device);
    for (const s of this.sets) s.restore();
    this.restores++;
    for (const fn of this.restoredFns.slice()) fn(device);
  }

  /** True when some set has live slots to draw (ws/core-passes; the `Renderer` skips the core otherwise). */
  get hasWork(): boolean {
    const sets = this.sets;
    for (let i = 0; i < sets.length; i++) if (sets[i]!.count > 0) return true;
    return false;
  }

  /**
   * Call `fn(device)` after each `restore`: the one "device restored" event a game sees for the
   * core. Returns the unsubscribe.
   */
  onDeviceRestored(fn: (device: GPUDevice) => void): () => void {
    this.restoredFns.push(fn);
    return () => {
      const i = this.restoredFns.indexOf(fn);
      if (i >= 0) this.restoredFns.splice(i, 1);
    };
  }

  /** A new draw set; it joins `desc.pass` (default `'opaque'`). */
  createDrawSet(desc: DrawSetDesc): DrawSet {
    const set = new DrawSet(this.host, desc);
    this.sets.push(set);
    this.setsDirty = true;
    return set;
  }

  /** Destroy `set` and take it out of its pass. */
  removeDrawSet(set: DrawSet): void {
    const i = this.sets.indexOf(set);
    if (i >= 0) this.sets.splice(i, 1);
    set.destroy();
    this.setsDirty = true;
  }

  /** Declare a pass (D1 §3.4 `definePass`); sets join it by id. */
  definePass(desc: PassDesc): CorePass {
    const p = this.passes.define(desc);
    this.setsDirty = true;
    return p;
  }

  /** Draw sets, in creation order. */
  get drawSets(): readonly DrawSet[] {
    return this.sets;
  }

  /** The depth attachment, once a pass has needed one (null until then). */
  get depth(): GPUTexture | null {
    return this.depthTexture;
  }

  /**
   * Once a frame, before any `draw`: write the views' uniforms, upload what changed and cull
   * every GPU-culled set for every cull group in one compute pass. Resets `stats`' per-frame
   * counts. `views` is a view list (each view its own cull group) or a list of cull groups;
   * either way views are numbered in order for `draw`.
   */
  prepare(encoder: GPUCommandEncoder, views: readonly RenderView[] | readonly CullGroup[]): void {
    const n = this.flatten(views);
    if (n < 1 || n > this.maxViews) {
      throw new Error(`core.prepare: ${n} views (1 to ${this.maxViews})`);
    }
    const flat = this.flat;
    const relative = this.originGrid > 0;
    if (relative) {
      const v0 = flat[0]!;
      const g = this.originGrid;
      for (let k = 0; k < 3; k++) {
        this.origin[k] = Math.round((v0.eye ? v0.eye[k]! : v0.position[k]!) / g) * g;
      }
    }
    const st = this.stats;
    st.calls = 0;
    st.dispatches = 0;
    st.passes = 0;
    st.bundles = 0;
    st.directDraws = 0;
    st.slotBytes = 0;
    st.deferredBuilds = 0;
    this.frame++;
    this.viewsPrepared = n;
    const data = this.viewData;
    for (let i = 0; i < n; i++) {
      writeViewSlot(data, this.viewU32, i, flat[i]!, this.origin, relative);
    }
    const groups = this.groups;
    for (let g = 0; g < groups; g++) {
      const first = this.groupFirst[g]!;
      const size = this.groupSize[g]!;
      const at = (MAX_VIEWS + g) * VIEW_SLOT_FLOATS + VIEW_SLOT.planes;
      if (size === 1) {
        const from = first * VIEW_SLOT_FLOATS + VIEW_SLOT.planes;
        data.copyWithin(at, from, from + 24);
      } else if (!unionPlanesInto(data, at, flat, first, size, this.origin, relative)) {
        openPlanesInto(data, at);
      }
    }
    // One write: the views, the padding up to the groups, the groups.
    this.device.queue.writeBuffer(
      this.viewBuffer,
      0,
      data,
      0,
      (MAX_VIEWS + groups) * VIEW_SLOT_FLOATS,
    );
    st.calls++;
    let gpu = false;
    const sets = this.sets;
    let turn: DrawSet | null = null;
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i]!;
      set.upload(groups);
      if (set.cull === 'gpu' && set.highWater > 0) gpu = true;
      if (this.coalesce && set.waitsForTurn() && (!turn || set.staleFrame < turn.staleFrame)) {
        turn = set;
      }
    }
    this.rebuildTurn = turn;
    if (!gpu) return;
    const pass = encoder.beginComputePass(this.computeDesc);
    pass.setPipeline(this.cullPipe());
    st.calls += 2;
    for (let i = 0; i < sets.length; i++) sets[i]!.dispatch(pass, groups);
    pass.end();
    st.calls++;
  }

  /**
   * Encode view `viewIndex` (of the last `prepare`) into `target`: each pass of the list that has
   * work, in order. The first pass clears `target` when `target.clear` is given; depth exists
   * only when a pass that runs has a set testing it, and is cleared by the first such pass.
   */
  draw(encoder: GPUCommandEncoder, viewIndex: number, target: CoreTarget): void {
    if (viewIndex < 0 || viewIndex >= this.viewsPrepared) {
      throw new Error(`core.draw: view ${viewIndex} was not prepared`);
    }
    if (this.setsDirty) this.sortSets();
    const st = this.stats;
    this.onView?.(viewIndex);
    const group = this.groupOf[viewIndex]!;
    if (this.groupSize[group]! > 1) {
      encoder.copyBufferToBuffer(
        this.viewBuffer,
        viewIndex * VIEW_SLOT_BYTES,
        this.currentBuffer,
        0,
        VIEW_SLOT_BYTES,
      );
      st.calls++;
    }
    const vp = target.viewport;
    let first = true;
    let depthCleared = target.depth !== undefined;
    const list = this.passes.passes;
    const phase = target.phase ?? 'all';
    let from = 0;
    let to = list.length;
    if (phase !== 'all') {
      let at = list.length;
      for (let p = 0; p < list.length; p++) {
        if (list[p]!.id === 'transparent') {
          at = p;
          break;
        }
      }
      if (phase === 'opaque') to = at;
      else from = at;
    }
    for (let p = from; p < to; p++) {
      const pass = list[p]!;
      const sets = this.bySet[p]!;
      if (pass.when && !pass.when()) continue;
      let work = false;
      let wantsDepth = false;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0 || !s.ready) continue;
        work = true;
        if (s.depth && pass.depth !== 'none') wantsDepth = true;
      }
      if (!work) continue;
      const depthFormat = wantsDepth ? this.depthFormat : undefined;
      const readOnly = wantsDepth && pass.depth === 'read';
      const color = this.colorAttachment;
      color.view = target.view;
      if (first && target.clear) {
        color.loadOp = 'clear';
        color.clearValue = target.clear;
      } else {
        color.loadOp = 'load';
      }
      first = false;
      let desc = this.passDesc;
      if (wantsDepth) {
        const d = this.depthAttachment;
        d.view = target.depth ?? this.depthFor(target.width, target.height);
        if (readOnly) {
          // A read-only pass may not load or store depth; it must follow a writing pass.
          d.depthReadOnly = true;
          d.depthLoadOp = undefined;
          d.depthStoreOp = undefined;
        } else {
          d.depthReadOnly = false;
          d.depthLoadOp = depthCleared ? 'load' : 'clear';
          d.depthStoreOp = 'store';
          depthCleared = true;
        }
        desc = this.passDescDepth;
      }
      const enc = encoder.beginRenderPass(desc);
      st.calls++;
      st.passes++;
      if (vp) {
        enc.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
        enc.setScissorRect(vp.x, vp.y, vp.width, vp.height);
        st.calls += 2;
      }
      const bundles = this.bundleList;
      // Emptied by popping: `length = 0` drops the backing store, and the next push allocates.
      while (bundles.length > 0) bundles.pop();
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0 || !s.ready) continue;
        if (s.encoding() === 'bundle') {
          bundles.push(s.bundle(group, target.format, depthFormat, readOnly));
          continue;
        }
        if (bundles.length > 0) this.flushBundles(enc);
        s.encodeDirect(enc, group, target.format, depthFormat);
      }
      if (bundles.length > 0) this.flushBundles(enc);
      enc.end();
      st.calls++;
    }
    if (first && target.clear) {
      // Nothing drew: still clear, as a target given a clear colour expects.
      const color = this.colorAttachment;
      color.view = target.view;
      color.loadOp = 'clear';
      color.clearValue = target.clear;
      encoder.beginRenderPass(this.passDesc).end();
      st.calls += 2;
      st.passes++;
    }
  }

  private capsOf(device: GPUDevice): CoreCaps {
    const features = device.features as ReadonlySet<string> | undefined;
    return {
      multiDraw: this.multiDrawOpt && !!features?.has(MULTI_DRAW_FEATURE),
      firstInstance: !!features?.has('indirect-first-instance'),
    };
  }

  /** The core's own GPU objects: layouts, the view buffers and their bind groups. */
  private build(): void {
    const device = this.device;
    const S = GPUShaderStage;
    this.viewLayout = device.createBindGroupLayout({
      label: 'core view',
      entries: [
        {
          binding: 0,
          visibility: S.VERTEX | S.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: VIEW_SLOT_BYTES },
        },
      ],
    });
    this.cullLayout = device.createBindGroupLayout({
      label: 'core cull',
      entries: [
        { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    // Views in slots [0, MAX_VIEWS), the cull groups' planes in [MAX_VIEWS, 2 · MAX_VIEWS): the
    // cull binds the second half as `array<CoreView, MAX_VIEWS>`, so the buffer is always full size.
    this.viewBuffer = device.createBuffer({
      label: 'core views',
      size: 2 * MAX_VIEWS * VIEW_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.viewGroups.length = 0;
    for (let i = 0; i < this.maxViews; i++) {
      this.viewGroups.push(
        device.createBindGroup({
          label: `core view ${i}`,
          layout: this.viewLayout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.viewBuffer,
                offset: i * VIEW_SLOT_BYTES,
                size: VIEW_SLOT_BYTES,
              },
            },
          ],
        }),
      );
    }
    this.currentBuffer = device.createBuffer({
      label: 'core current view',
      size: VIEW_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.currentGroup = device.createBindGroup({
      label: 'core current view',
      layout: this.viewLayout,
      entries: [{ binding: 0, resource: { buffer: this.currentBuffer } }],
    });
  }

  /** Destroy every set, the shared buffers and the depth attachment. */
  destroy(): void {
    for (const s of this.sets) s.destroy();
    this.sets.length = 0;
    this.setsDirty = true;
    this.viewBuffer.destroy();
    this.currentBuffer.destroy();
    this.quads.destroy();
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Flatten views or groups into `flat` and the group tables (nothing allocates); returns the
   * view count, or `MAX_VIEWS + 1` when there are too many.
   */
  private flatten(list: readonly RenderView[] | readonly CullGroup[]): number {
    const flat = this.flat;
    while (flat.length > 0) flat.pop();
    this.groups = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if (!('views' in item)) {
        if (!this.addGroup(item, 0, 1, true)) return MAX_VIEWS + 1;
        continue;
      }
      const vs = item.views;
      if (item.planes === 'each') {
        for (let k = 0; k < vs.length; k++) {
          if (!this.addGroup(vs, k, 1, false)) return MAX_VIEWS + 1;
        }
      } else if (vs.length > 0 && !this.addGroup(vs, 0, vs.length, false)) {
        return MAX_VIEWS + 1;
      }
    }
    return flat.length;
  }

  /** Append a group of `count` views: `src` itself (`single`) or `src[first..]`. */
  private addGroup(
    src: RenderView | readonly RenderView[],
    first: number,
    count: number,
    single: boolean,
  ): boolean {
    const flat = this.flat;
    if (flat.length + count > MAX_VIEWS) return false;
    const g = this.groups++;
    this.groupFirst[g] = flat.length;
    this.groupSize[g] = count;
    for (let k = 0; k < count; k++) {
      this.groupOf[flat.length] = g;
      flat.push(single ? (src as RenderView) : (src as readonly RenderView[])[first + k]!);
    }
    return true;
  }

  private flushBundles(enc: GPURenderPassEncoder): void {
    enc.executeBundles(this.bundleList);
    this.stats.calls++;
    this.stats.bundles += this.bundleList.length;
    while (this.bundleList.length > 0) this.bundleList.pop();
  }

  private cullPipe(): GPUComputePipeline {
    if (this.cullPipeline) return this.cullPipeline;
    const module = this.device.createShaderModule({ label: 'core cull', code: CULL_WGSL });
    this.cullPipeline = this.device.createComputePipeline({
      label: 'core cull',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.cullLayout] }),
      compute: { module, entryPoint: 'cs_cull' },
    });
    return this.cullPipeline;
  }

  private sortSets(): void {
    const list = this.passes.passes;
    this.bySet.length = 0;
    for (let p = 0; p < list.length; p++) {
      const id = list[p]!.id;
      const sets = this.sets.filter((s) => s.pass.id === id);
      // Stable: equal orders keep creation order.
      sets.sort((a, b) => a.order - b.order);
      this.bySet.push(sets);
    }
    this.setsDirty = false;
  }

  private depthFor(width: number, height: number): GPUTextureView {
    const t = this.depthTexture;
    if (t && t.width === width && t.height === height && this.depthView) return this.depthView;
    t?.destroy();
    this.depthTexture = this.device.createTexture({
      label: 'core depth',
      size: [width, height],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
    return this.depthView;
  }
}

/** A render core on `device` (or a `{ device }` such as `Renderer` or `boot`'s `gpu`). */
export function createRenderCore(
  gpu: GPUDevice | { readonly device: GPUDevice },
  opts?: RenderCoreOptions,
): RenderCore {
  const device = 'device' in gpu ? gpu.device : gpu;
  return new RenderCore(device, opts);
}
