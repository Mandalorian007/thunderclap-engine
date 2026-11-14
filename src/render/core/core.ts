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
import {
  type CoreDrawable,
  type CoreDrawContext,
  DrawableEntry,
  type DrawableHost,
  type PassMember,
} from './drawable';
import {
  type CorePass,
  type CorePassContext,
  type CoreResolveContext,
  type PassDesc,
  PassList,
} from './pass-list';
import { QuadIndex } from './quad-index';
import {
  CORE_TARGET,
  CORE_TARGET_FORMATS,
  CORE_TARGET_NAMES,
  type CoreTargetName,
  coreTargetMask,
} from './targets';
import {
  type CullGroup,
  MAX_VIEWS,
  openPlanesInto,
  type RenderView,
  unionPlanesInto,
  VIEW_SLOT,
  VIEW_SLOT_BYTES,
  VIEW_SLOT_FLOATS,
  writePrevRows,
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
  /**
   * Extra colour targets the core's passes draw (ws/core-targets; `./targets`): `'emissive'`,
   * `'roughMetal'`, `'velocity'`, for post (bloom, SSR, TAA and motion blur). Default none: one
   * colour attachment, nothing more. `setTargets` changes them later.
   */
  targets?: readonly CoreTargetName[];
  /**
   * Reversed-Z for every pass (ws/render-fit; `PassDesc.reversedZ`): depth clears to 0 and sets
   * test `'greater'` unless they say otherwise. A pass's own `reversedZ` wins. Default false.
   * The shadow pass is unaffected (it clears to 1 and tests `'less'`).
   */
  reversedZ?: boolean;
  /**
   * Label each render pass after its pass (`CorePass.label`, `'core opaque'`; a clear-only pass
   * `'core clear'`) for GPU captures and timings (ws/render-fit). Default false: every one is
   * `'core pass'`.
   */
  passLabels?: boolean;
}

/**
 * GPU timing for a pass (`CoreTarget.timestamps`): `label` is `'core'` for the view's render
 * passes, `'shadow'` for `drawShadow` and `'prepare'` for the cull's compute pass; `pass` is
 * the pass list's id (`'opaque'`, a pass of the game's), or `'clear'` for a clear-only pass.
 */
export type CoreTimestamps = (
  label: string,
  pass?: string,
) => GPURenderPassTimestampWrites | undefined;

/**
 * A depth-only target for `RenderCore.drawShadow` (ws/core-passes): a sun shadow map, or one
 * cascade of one.
 */
export interface CoreShadowTarget {
  view: GPUTextureView;
  /** The map's depth format. */
  format: GPUTextureFormat;
  /** Clear depth to 1 first; without it the map is loaded (drawn over earlier casters). */
  clear?: boolean;
  /** GPU timing for the pass (see `CoreTarget.timestamps`), labelled `'shadow'`. */
  timestamps?: (label: string) => GPURenderPassTimestampWrites | undefined;
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
  /**
   * The texture `view` is of, for drawables that read colour (`CoreDrawable.readsColor`): before
   * the first pass with one, the target (its viewport) is copied into `core.sceneColorView`.
   * Needs `COPY_SRC` (a canvas configured with `usage: RENDER_ATTACHMENT | COPY_SRC`).
   */
  texture?: GPUTexture;
  /**
   * GPU timing for the core's render passes (ws/core-passes): called once per pass with the
   * label `'core'` and the pass's id (ws/render-fit: `CoreTimestamps`), its result set as the
   * pass's `timestampWrites`. The `Renderer` hands its `GpuTimer` here, so a sampled frame's
   * GPU time counts the core's work.
   */
  timestamps?: CoreTimestamps;
  /**
   * Clear `depth` (the caller's) on the view's first depth pass, to that pass's `depthClear`
   * (ws/render-fit), instead of loading it: the caller needs no clear pass of its own. Default
   * false. Ignored without `depth` (the core's own depth is always cleared).
   */
  clearDepth?: boolean;
  /**
   * Draw the view with this pipeline variant (ws/render-fit; `DrawSetDesc.variants`): each set
   * that has a variant of this name draws with it in its own pass; the others draw as usual
   * (a forward eye, a debug view).
   */
  variant?: string;
  /**
   * Where a resolve pass (`PassDesc.resolve`: post) writes (ws/core-passes), in `outputFormat`;
   * passes after it draw here, without depth. Without it resolve passes are skipped.
   */
  output?: GPUTextureView;
  outputFormat?: GPUTextureFormat;
  /** The view's rectangle of `output` (an eye of a shared layer), else the whole output. */
  outputViewport?: { x: number; y: number; width: number; height: number };
  /**
   * The extra targets' attachments when the caller owns them (ws/core-targets): the target's
   * size, in `CORE_TARGET_FORMATS`; cleared with `clear`, loaded otherwise. A target the core has
   * (`targetMask`) and the caller does not give is the core's own, cleared each view (except in
   * `phase: 'blend'`, which continues the `'opaque'` draw). Ignored for targets the core lacks.
   */
  emissive?: GPUTextureView;
  roughMetal?: GPUTextureView;
  velocity?: GPUTextureView;
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
  private readonly drawables: DrawableEntry[] = [];
  /** Sets and drawables per pass, in pass order then order (rebuilt when members come or go). */
  private readonly bySet: PassMember[][] = [];
  private readonly drawCtx: CoreDrawContext;
  private readonly drawableHost: DrawableHost;
  /** Some drawable samples depth / colour (rebuilt with `bySet`). */
  private wantsDepthBinding = false;
  private wantsColor = false;
  /** The current target can be copied (`CoreTarget.texture`): `sceneColorView` is live. */
  private colorLive = false;
  private depthUsage = 0;
  private colorTexture: GPUTexture | null = null;
  private colorView: GPUTextureView | null = null;
  private targets = 0;
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
  /** The last target's own depth (`CoreTarget.depth`), which `sceneDepthView` then is. */
  private extDepth: GPUTextureView | null = null;
  /** Depth alone, cleared: before a read pass whose drawable samples depth nothing wrote yet. */
  private readonly passDescDepthClear: GPURenderPassDescriptor;
  private readonly shadowAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    depthClearValue: 1,
  };
  private readonly passDescShadow: GPURenderPassDescriptor = {
    label: 'core shadow',
    colorAttachments: [],
    depthStencilAttachment: this.shadowAttachment,
  };
  /** The extra targets (`CORE_TARGET` mask, ws/core-targets). */
  private auxMask = 0;
  /** The view being drawn's `CoreTarget.variant` (ws/render-fit), else null. */
  private viewVariant: string | null = null;
  /** Shader modules by code (ws/render-fit): sets with the same code share one. */
  private readonly modules = new Map<string, GPUShaderModule>();
  /** One attachment per extra target, in location order; set per view. */
  private readonly auxAtt: GPURenderPassColorAttachment[] = [];
  /** Per extra target: clear it on the view's first pass. */
  private readonly auxClear: boolean[] = [false, false, false];
  /** The core's own extra targets (when the caller gives none). */
  private readonly ownAux: (GPUTexture | null)[] = [null, null, null];
  private readonly ownAuxView: (GPUTextureView | null)[] = [null, null, null];
  private passDescAux: GPURenderPassDescriptor;
  private passDescAuxDepth: GPURenderPassDescriptor;
  /** Per view index: last frame's view-projection (relative to `prevAt`), and when it was. */
  private readonly prevVP = new Float32Array(MAX_VIEWS * 16);
  private readonly prevAt = new Float64Array(MAX_VIEWS * 3);
  private readonly prevFrame = new Int32Array(MAX_VIEWS).fill(-2);
  /** The context handed to a resolve pass, rewritten per call. */
  private readonly resolveCtx = {} as CoreResolveContext;
  /** The context handed to a pass's `encode`, rewritten per call. */
  private readonly passCtx = {} as CorePassContext;
  private readonly coalesce: boolean;
  private readonly passLabels: boolean;
  private readonly copyOrigin = { x: 0, y: 0, z: 0 };
  private readonly copySrc: GPUTexelCopyTextureInfo = {
    texture: undefined as unknown as GPUTexture,
    origin: this.copyOrigin,
  };
  private readonly copyDst: GPUTexelCopyTextureInfo = {
    texture: undefined as unknown as GPUTexture,
    origin: this.copyOrigin,
  };
  private readonly copySize = { width: 1, height: 1, depthOrArrayLayers: 1 };

  constructor(device: GPUDevice, opts: RenderCoreOptions = {}) {
    this.dev = device;
    this.multiDrawOpt = opts.multiDraw ?? true;
    this.capsNow = this.capsOf(device);
    this.maxViews = Math.max(1, Math.min(opts.maxViews ?? MAX_VIEWS, MAX_VIEWS));
    this.depthFormat = opts.depthFormat ?? 'depth24plus';
    this.originGrid = Math.max(0, opts.originGrid ?? 0);
    this.onView = opts.onView ?? null;
    this.coalesce = opts.coalesceRebuilds ?? true;
    this.passLabels = opts.passLabels ?? false;
    this.passes = new PassList(undefined, opts.reversedZ ?? false);
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
    for (let k = 0; k < 3; k++) {
      this.auxAtt.push({
        view: undefined as unknown as GPUTextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      });
    }
    this.passDescAux = this.passDesc;
    this.passDescAuxDepth = this.passDescDepth;
    this.setTargets(opts.targets ?? []);
    this.passDescDepthClear = {
      label: 'core depth clear',
      colorAttachments: [],
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
      get viewVariant() {
        return core.viewVariant;
      },
      module: (label, code) => {
        let m = this.modules.get(code);
        if (!m) {
          m = this.device.createShaderModule({ label, code });
          this.modules.set(code, m);
        }
        return m;
      },
    };
    this.drawCtx = {
      core: this,
      group: 0,
      viewGroup: this.viewGroups[0]!,
      viewLayout: this.viewLayout,
      color: 'rgba8unorm',
      depth: undefined,
      depthReadOnly: false,
      aux: 0,
    };
    this.drawableHost = {
      // Live: after `restore` drawables record on the new device (ws/core-decals).
      get device() {
        return core.device;
      },
      ctx: this.drawCtx,
      stats: this.stats,
      viewData: this.viewData,
      drawGroup: this.host.drawGroup,
      groupPlanes: (g) => (MAX_VIEWS + g) * VIEW_SLOT_FLOATS + VIEW_SLOT.planes,
      get targetsVersion() {
        return core.targets;
      },
    };
  }

  /** The extra targets the core's passes draw (`CORE_TARGET` bits; ws/core-targets). */
  get targetMask(): number {
    return this.auxMask;
  }

  /**
   * Draw these extra targets from now on (ws/core-targets; `RenderCoreOptions.targets`). Sets
   * and drawables record new pipelines and bundles for them on next use.
   */
  setTargets(names: readonly CoreTargetName[]): void {
    const mask = coreTargetMask(names);
    if (mask === this.auxMask) return;
    this.auxMask = mask;
    if (mask === 0) {
      this.passDescAux = this.passDesc;
      this.passDescAuxDepth = this.passDescDepth;
    } else {
      const list: (GPURenderPassColorAttachment | null)[] = [this.colorAttachment];
      const last = mask & 4 ? 3 : mask & 2 ? 2 : 1;
      for (let k = 0; k < last; k++) list.push(mask & (1 << k) ? this.auxAtt[k]! : null);
      this.passDescAux = { label: 'core pass', colorAttachments: list };
      this.passDescAuxDepth = {
        label: 'core pass',
        colorAttachments: list,
        depthStencilAttachment: this.depthAttachment,
      };
    }
    for (let k = 0; k < 3; k++) {
      if (mask & (1 << k)) continue;
      this.ownAux[k]?.destroy();
      this.ownAux[k] = null;
      this.ownAuxView[k] = null;
    }
    this.prevFrame.fill(-2);
    this.targets++;
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
    this.depthUsage = 0;
    this.colorTexture = null;
    this.colorView = null;
    for (let k = 0; k < 3; k++) {
      this.ownAux[k] = null;
      this.ownAuxView[k] = null;
    }
    // Drawables re-record their bundles and re-bind the core's depth and colour copy.
    this.targets++;
    this.viewsPrepared = 0;
    this.modules.clear();
    this.build();
    this.quads.restore(device);
    for (const a of this.arenas) a.restore(device);
    for (const s of this.sets) s.restore();
    this.restores++;
    for (const fn of this.restoredFns.slice()) fn(device);
  }

  /** True when some set has live slots, or some drawable is active (ws/core-passes; the `Renderer` skips the core otherwise). */
  /** Some draw set casts the sun's shadow and has slots (`DrawSetDesc.castShadow`). */
  /**
   * Some pass resolves (`PassDesc.resolve`: post, ws/core-passes): draw with `CoreTarget.output`
   * and an HDR `view` for it to run.
   */
  get hasResolve(): boolean {
    const list = this.passes.passes;
    for (let i = 0; i < list.length; i++) if (list[i]!.resolve) return true;
    return false;
  }

  get castsShadow(): boolean {
    const sets = this.sets;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i]!;
      if (s.castShadow && s.enabled && s.count > 0) return true;
    }
    return false;
  }

  get hasWork(): boolean {
    const sets = this.sets;
    for (let i = 0; i < sets.length; i++) if (sets[i]!.enabled && sets[i]!.count > 0) return true;
    const drawables = this.drawables;
    for (let i = 0; i < drawables.length; i++) if (drawables[i]!.count > 0) return true;
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

  /**
   * Add a drawable (B5): it joins `d.pass` (default `'transparent'`) with the draw sets, its
   * `prepare` runs in every `prepare`, and it records into one bundle per cull group (or
   * directly). Throws if the pass is unknown, or if it `readsDepth` in a depth-writing pass.
   */
  addDrawable(d: CoreDrawable): void {
    for (let i = 0; i < this.drawables.length; i++) {
      if (this.drawables[i]!.drawable === d) return;
    }
    this.drawables.push(
      new DrawableEntry(d, this.drawableHost, this.host.pass(d.pass ?? 'transparent')),
    );
    this.setsDirty = true;
  }

  /** Take `d` out of its pass (its bundles are dropped; nothing of it is destroyed). */
  removeDrawable(d: CoreDrawable): void {
    for (let i = 0; i < this.drawables.length; i++) {
      if (this.drawables[i]!.drawable !== d) continue;
      this.drawables.splice(i, 1);
      this.setsDirty = true;
      return;
    }
  }

  /** Drawables, in the order added. */
  get coreDrawables(): readonly CoreDrawable[] {
    return this.drawables.map((e) => e.drawable);
  }

  /** Views of the last `prepare` (their slots are `viewData`'s first `viewCount`). */
  get viewCount(): number {
    return this.viewsPrepared;
  }

  /**
   * The depth attachment as a texture view, for drawables that `readsDepth` (null until a
   * `draw` made it). Re-made when the target's size changes (`targetsVersion` bumps).
   */
  get sceneDepthView(): GPUTextureView | null {
    return this.extDepth ?? this.depthView;
  }

  /**
   * The copy of the target's colour drawables that `readsColor` sample: null until made, and
   * null while the target has no `texture` to copy from.
   */
  get sceneColorView(): GPUTextureView | null {
    return this.colorLive ? this.colorView : null;
  }

  /** Bumped when `sceneDepthView` or `sceneColorView` is re-made (bind groups go stale). */
  get targetsVersion(): number {
    return this.targets;
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
   * either way views are numbered in order for `draw`. `timestamps` times the cull's compute
   * pass, called with `'prepare'` (ws/render-fit).
   */
  prepare(
    encoder: GPUCommandEncoder,
    views: readonly RenderView[] | readonly CullGroup[],
    timestamps?: CoreTimestamps,
  ): void {
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
    if (this.auxMask & CORE_TARGET.velocity) this.writeHistory(n);
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
      // The group's eye, for `DrawSet.maxDistance`: its views' positions averaged.
      const pos = (MAX_VIEWS + g) * VIEW_SLOT_FLOATS + VIEW_SLOT.position;
      let x = 0;
      let y = 0;
      let z = 0;
      for (let k = 0; k < size; k++) {
        const o = (first + k) * VIEW_SLOT_FLOATS + VIEW_SLOT.position;
        x += data[o]!;
        y += data[o + 1]!;
        z += data[o + 2]!;
      }
      data[pos] = x / size;
      data[pos + 1] = y / size;
      data[pos + 2] = z / size;
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
    const drawables = this.drawables;
    for (let i = 0; i < drawables.length; i++) drawables[i]!.drawable.prepare?.(encoder, this);
    let gpu = false;
    const sets = this.sets;
    let turn: DrawSet | null = null;
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i]!;
      set.upload(groups);
      if (set.cull === 'gpu' && set.highWater > 0 && set.enabled) gpu = true;
      if (this.coalesce && set.waitsForTurn() && (!turn || set.staleFrame < turn.staleFrame)) {
        turn = set;
      }
    }
    this.rebuildTurn = turn;
    if (!gpu) return;
    this.computeDesc.timestampWrites = timestamps?.('prepare', 'prepare');
    const pass = encoder.beginComputePass(this.computeDesc);
    pass.setPipeline(this.cullPipe());
    st.calls += 2;
    for (let i = 0; i < sets.length; i++) if (sets[i]!.enabled) sets[i]!.dispatch(pass, groups);
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
    // Effects bind depth and colour by view: make them before any bundle is recorded.
    const ext = target.depth ?? null;
    if (ext !== this.extDepth) {
      this.extDepth = ext;
      this.targets++;
    }
    if (this.wantsDepthBinding && !ext) this.depthFor(target.width, target.height);
    if (this.wantsColor) {
      const live = target.texture !== undefined;
      if (live !== this.colorLive) {
        this.colorLive = live;
        this.targets++;
      }
      if (live) this.colorFor(target);
    }
    const auxMask = this.auxMask;
    // A 'blend' draw continues an 'opaque' one: the core's own extra targets are loaded.
    if (auxMask !== 0) this.auxFor(target, target.phase === 'blend');
    let first = true;
    let depthCleared = target.depth !== undefined && target.clearDepth !== true;
    this.viewVariant = target.variant ?? null;
    let colorCopied = false;
    /** A resolve pass ran: later passes draw into `target.output`, without depth. */
    let resolved = false;
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
      if (pass.resolve) {
        if (!target.output || resolved) continue;
        if (first && target.clear) {
          // Nothing drew before post: it still reads a cleared scene.
          this.clearOnly(encoder, target);
          first = false;
        }
        const r = this.resolveCtx;
        r.viewIndex = viewIndex;
        r.view = this.flat[viewIndex]!;
        r.color = target.view;
        r.colorTexture = target.texture;
        r.format = target.format;
        r.width = target.width;
        r.height = target.height;
        r.viewport = vp;
        r.depth = depthCleared ? (target.depth ?? this.depthView) : null;
        r.output = target.output;
        r.outputFormat = target.outputFormat ?? target.format;
        r.outputViewport = target.outputViewport;
        r.emissive =
          auxMask & CORE_TARGET.emissive ? (this.auxAtt[0]!.view as GPUTextureView) : null;
        r.roughMetal =
          auxMask & CORE_TARGET.roughMetal ? (this.auxAtt[1]!.view as GPUTextureView) : null;
        r.velocity =
          auxMask & CORE_TARGET.velocity ? (this.auxAtt[2]!.view as GPUTextureView) : null;
        pass.resolve(encoder, r);
        resolved = true;
        first = false;
        continue;
      }
      let work = pass.encode !== null;
      let wantsDepth = work && pass.depth !== 'none';
      let readsColor = false;
      let samplesDepth = false;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0 || s.ready === false || (s.inView && !s.inView(group))) continue;
        work = true;
        if (s.depth && pass.depth !== 'none') wantsDepth = true;
        if (s.readsColor) readsColor = true;
        if (s.readsDepth) samplesDepth = true;
      }
      if (!work) continue;
      if (readsColor && !colorCopied && target.texture && this.colorTexture) {
        this.copyColor(encoder, target);
        colorCopied = true;
      }
      if (resolved) wantsDepth = false;
      const depthFormat = wantsDepth ? this.depthFormat : undefined;
      const colorFormat = resolved ? (target.outputFormat ?? target.format) : target.format;
      const colorRect = resolved ? target.outputViewport : vp;
      const aux = resolved ? 0 : auxMask;
      if (wantsDepth && samplesDepth && pass.depth === 'read' && !depthCleared) {
        // A drawable samples depth here, so the pass must be read-only: clear depth first.
        const d = this.depthAttachment;
        d.view = target.depth ?? this.depthFor(target.width, target.height);
        d.depthReadOnly = false;
        d.depthLoadOp = 'clear';
        d.depthStoreOp = 'store';
        d.depthClearValue = pass.depthClear;
        this.passDescDepthClear.timestampWrites = target.timestamps?.('core', pass.id);
        encoder.beginRenderPass(this.passDescDepthClear).end();
        st.calls += 2;
        st.passes++;
        depthCleared = true;
      }
      // A read pass with nothing written before it clears depth instead (nothing to read).
      const readOnly = wantsDepth && pass.depth === 'read' && depthCleared;
      const color = this.colorAttachment;
      color.view = resolved ? target.output! : target.view;
      if (first && target.clear) {
        color.loadOp = 'clear';
        color.clearValue = target.clear;
      } else {
        color.loadOp = 'load';
      }
      if (aux !== 0) {
        for (let k = 0; k < 3; k++) {
          if (aux & (1 << k)) this.auxAtt[k]!.loadOp = first && this.auxClear[k] ? 'clear' : 'load';
        }
      }
      first = false;
      let desc = aux !== 0 ? this.passDescAux : this.passDesc;
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
          d.depthClearValue = pass.depthClear;
          depthCleared = true;
        }
        desc = aux !== 0 ? this.passDescAuxDepth : this.passDescDepth;
      }
      if (this.passLabels) desc.label = pass.label;
      desc.timestampWrites = target.timestamps?.('core', pass.id);
      const enc = encoder.beginRenderPass(desc);
      st.calls++;
      st.passes++;
      if (colorRect) {
        enc.setViewport(colorRect.x, colorRect.y, colorRect.width, colorRect.height, 0, 1);
        enc.setScissorRect(colorRect.x, colorRect.y, colorRect.width, colorRect.height);
        st.calls += 2;
      }
      const bundles = this.bundleList;
      // Emptied by popping: `length = 0` drops the backing store, and the next push allocates.
      while (bundles.length > 0) bundles.pop();
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0 || s.ready === false || (s.inView && !s.inView(group))) continue;
        if (s.encoding() === 'bundle') {
          bundles.push(s.bundle(group, colorFormat, depthFormat, readOnly, aux));
          continue;
        }
        if (bundles.length > 0) this.flushBundles(enc);
        s.encodeDirect(enc, group, colorFormat, depthFormat, aux);
      }
      if (bundles.length > 0) this.flushBundles(enc);
      if (pass.encode) {
        const ctx = this.passCtx;
        ctx.viewIndex = viewIndex;
        ctx.view = this.groupSize[group]! > 1 ? this.currentGroup : this.viewGroups[viewIndex]!;
        ctx.viewLayout = this.viewLayout;
        ctx.format = colorFormat;
        ctx.depthFormat = depthFormat;
        ctx.depthReadOnly = readOnly;
        ctx.aux = aux;
        pass.encode(enc, ctx);
      }
      enc.end();
      st.calls++;
    }
    // Nothing drew: still clear, as a target given a clear colour expects.
    if (first && target.clear) this.clearOnly(encoder, target);
  }

  /** One pass that only clears the target's colour and the view's extra targets. */
  private clearOnly(encoder: GPUCommandEncoder, target: CoreTarget): void {
    const color = this.colorAttachment;
    color.view = target.view;
    color.loadOp = 'clear';
    color.clearValue = target.clear!;
    const aux = this.auxMask;
    for (let k = 0; k < 3; k++) if (aux & (1 << k)) this.auxAtt[k]!.loadOp = 'clear';
    const desc = aux !== 0 ? this.passDescAux : this.passDesc;
    if (this.passLabels) desc.label = 'core clear';
    desc.timestampWrites = target.timestamps?.('core', 'clear');
    encoder.beginRenderPass(desc).end();
    this.stats.calls += 2;
    this.stats.passes++;
  }

  /**
   * Point the extra targets' attachments at the caller's views or the core's own (made at the
   * target's size), and decide which are cleared on the view's first pass.
   */
  private auxFor(target: CoreTarget, blend: boolean): void {
    const aux = this.auxMask;
    for (let k = 0; k < 3; k++) {
      if (!(aux & (1 << k))) continue;
      const given = target[CORE_TARGET_NAMES[k]!];
      const att = this.auxAtt[k]!;
      if (given) {
        att.view = given;
        this.auxClear[k] = target.clear !== undefined;
        continue;
      }
      let t = this.ownAux[k];
      if (!t || t.width !== target.width || t.height !== target.height) {
        t?.destroy();
        t = this.device.createTexture({
          label: `core ${CORE_TARGET_NAMES[k]}`,
          size: [target.width, target.height],
          format: CORE_TARGET_FORMATS[k]!,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.ownAux[k] = t;
        this.ownAuxView[k] = t.createView();
        this.targets++;
      }
      att.view = this.ownAuxView[k]!;
      this.auxClear[k] = !blend;
    }
  }

  /** Each prepared view's last-frame rows (`CoreView.prevRows`), then this frame's kept. */
  private writeHistory(n: number): void {
    const data = this.viewData;
    const prev = this.prevVP;
    const at = this.prevAt;
    const origin = this.origin;
    for (let i = 0; i < n; i++) {
      const o = i * VIEW_SLOT_FLOATS;
      if (this.prevFrame[i] === this.frame - 1) {
        writePrevRows(data, i, prev, i * 16, at, i * 3, origin);
      } else {
        // No last frame at this index: no motion.
        writePrevRows(data, i, data, o, origin, 0, origin);
      }
      for (let k = 0; k < 16; k++) prev[i * 16 + k] = data[o + k]!;
      at[i * 3] = origin[0]!;
      at[i * 3 + 1] = origin[1]!;
      at[i * 3 + 2] = origin[2]!;
      this.prevFrame[i] = this.frame;
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
    this.colorTexture?.destroy();
    this.colorTexture = null;
    this.colorView = null;
    for (let k = 0; k < 3; k++) {
      this.ownAux[k]?.destroy();
      this.ownAux[k] = null;
      this.ownAuxView[k] = null;
    }
    this.drawables.length = 0;
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

  /**
   * Encode the shadow casters (`DrawSetDesc.castShadow`) of view `viewIndex` (of the last
   * `prepare`) into the depth-only `target`, through the same cull and the same kind of bundles
   * as the colour passes (ws/core-passes). The view is the light's: a sun camera set with
   * `setViewFromCamera`, prepared with the frame's views as a cull group of its own. Cascades
   * are one `CullGroup` with `planes: 'each'`, a view and a target per cascade. One render pass
   * when a caster has slots or `target.clear` is set; none otherwise.
   */
  drawShadow(encoder: GPUCommandEncoder, viewIndex: number, target: CoreShadowTarget): void {
    if (viewIndex < 0 || viewIndex >= this.viewsPrepared) {
      throw new Error(`core.drawShadow: view ${viewIndex} was not prepared`);
    }
    const group = this.groupOf[viewIndex]!;
    const sets = this.sets;
    let any = false;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i]!;
      if (s.castShadow && s.count > 0 && s.ready) {
        any = true;
        break;
      }
    }
    if (!any && !target.clear) return;
    const st = this.stats;
    if (any && this.groupSize[group]! > 1) {
      encoder.copyBufferToBuffer(
        this.viewBuffer,
        viewIndex * VIEW_SLOT_BYTES,
        this.currentBuffer,
        0,
        VIEW_SLOT_BYTES,
      );
      st.calls++;
    }
    const att = this.shadowAttachment;
    att.view = target.view;
    att.depthLoadOp = target.clear ? 'clear' : 'load';
    const desc = this.passDescShadow;
    desc.timestampWrites = target.timestamps?.('shadow');
    const enc = encoder.beginRenderPass(desc);
    st.calls++;
    st.passes++;
    const bundles = this.bundleList;
    while (bundles.length > 0) bundles.pop();
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i]!;
      if (!s.castShadow || s.count === 0 || !s.ready) continue;
      if (s.encoding() === 'bundle') {
        bundles.push(s.bundle(group, null, target.format, false, 0));
        continue;
      }
      if (bundles.length > 0) this.flushBundles(enc);
      s.encodeDirect(enc, group, null, target.format, 0);
    }
    if (bundles.length > 0) this.flushBundles(enc);
    enc.end();
    st.calls++;
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
      const members: PassMember[] = [];
      for (const s of this.sets) {
        if (s.pass.id === id) members.push(s);
        // A set's extra joins (`DrawSetDesc.passes`, ws/render-fit).
        for (const j of s.joins) if (j.pass.id === id) members.push(j);
      }
      for (const d of this.drawables) if (d.pass.id === id) members.push(d);
      // Stable: equal orders keep creation order, sets before drawables.
      members.sort((a, b) => a.order - b.order);
      this.bySet.push(members);
    }
    this.wantsDepthBinding =
      list.some((p) => p.resolve !== null) || this.drawables.some((d) => d.readsDepth);
    this.wantsColor = this.drawables.some((d) => d.readsColor);
    this.setsDirty = false;
  }

  /** The colour copy `readsColor` drawables sample: the target's size and format. */
  private colorFor(target: CoreTarget): void {
    const t = this.colorTexture;
    if (t && t.width === target.width && t.height === target.height && t.format === target.format) {
      return;
    }
    t?.destroy();
    this.colorTexture = this.device.createTexture({
      label: 'core scene colour',
      size: [target.width, target.height],
      format: target.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.colorView = this.colorTexture.createView();
    this.targets++;
  }

  private copyColor(encoder: GPUCommandEncoder, target: CoreTarget): void {
    const vp = target.viewport;
    const x = vp ? vp.x : 0;
    const y = vp ? vp.y : 0;
    const origin = this.copyOrigin;
    origin.x = x;
    origin.y = y;
    this.copySrc.texture = target.texture!;
    this.copyDst.texture = this.colorTexture!;
    const size = this.copySize;
    size.width = vp ? vp.width : target.width;
    size.height = vp ? vp.height : target.height;
    encoder.copyTextureToTexture(this.copySrc, this.copyDst, size);
    this.stats.calls++;
  }

  private depthFor(width: number, height: number): GPUTextureView {
    const t = this.depthTexture;
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      (this.wantsDepthBinding ? GPUTextureUsage.TEXTURE_BINDING : 0);
    if (
      t &&
      t.width === width &&
      t.height === height &&
      this.depthView &&
      (this.depthUsage & usage) === usage
    ) {
      return this.depthView;
    }
    t?.destroy();
    this.depthUsage = usage;
    this.depthTexture = this.device.createTexture({
      label: 'core depth',
      size: [width, height],
      format: this.depthFormat,
      usage,
    });
    this.depthView = this.depthTexture.createView();
    this.targets++;
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
