/**
 * The render core (D1 §3, *Today (preview)*): the retained, GPU-driven, view-plural bottom layer
 * of the one renderer. A frame is
 *
 * ```
 * core.prepare(encoder, views)        once: view uniforms, dirty slot ranges, one cull dispatch per GPU set
 * core.draw(encoder, viewIndex, target)   per view: the pass list, each pass only if it has work
 * ```
 *
 * and the caller submits the encoder. Held sets that did not change cost no CPU and the same GPU
 * calls whatever their slot count: a static GPU-culled set is one `executeBundles` entry.
 */
import { Arena, type ArenaDesc } from './arena';
import { CULL_WGSL } from './cull';
import { type CoreStats, DrawSet, type DrawSetDesc, type DrawSetHost } from './draw-set';
import { type CorePass, type PassDesc, PassList } from './pass-list';
import { QuadIndex } from './quad-index';
import {
  MAX_VIEWS,
  type RenderView,
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
  /** Use `multiDrawIndexedIndirect` when the device has it (default true). */
  multiDraw?: boolean;
}

/** Where a view draws: a colour view of a texture of `format` and size, cleared or loaded. */
export interface CoreTarget {
  view: GPUTextureView;
  format: GPUTextureFormat;
  width: number;
  height: number;
  /** Clear to this colour on the first pass; without it the target is loaded. */
  clear?: GPUColor;
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
  };
}

/** The retained render core on one device. Make one with `createRenderCore`. */
export class RenderCore {
  readonly device: GPUDevice;
  readonly caps: CoreCaps;
  readonly passes: PassList;
  readonly maxViews: number;
  readonly depthFormat: GPUTextureFormat;
  readonly stats: CoreStats = newStats();
  /** Frames prepared so far. */
  frame = 0;
  /** @internal */ readonly viewLayout: GPUBindGroupLayout;
  /** @internal */ readonly cullLayout: GPUBindGroupLayout;
  /** @internal */ readonly viewBuffer: GPUBuffer;
  /** @internal */ readonly viewData: Float32Array;
  private readonly viewU32: Uint32Array;
  private readonly viewGroups: GPUBindGroup[] = [];
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

  constructor(device: GPUDevice, opts: RenderCoreOptions = {}) {
    this.device = device;
    const features = device.features as ReadonlySet<string> | undefined;
    this.caps = {
      multiDraw: (opts.multiDraw ?? true) && !!features?.has(MULTI_DRAW_FEATURE),
      firstInstance: !!features?.has('indirect-first-instance'),
    };
    this.maxViews = Math.max(1, Math.min(opts.maxViews ?? MAX_VIEWS, MAX_VIEWS));
    this.depthFormat = opts.depthFormat ?? 'depth24plus';
    this.passes = new PassList();
    this.quads = new QuadIndex(device);
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
    // The cull binds the whole buffer as `array<CoreView, MAX_VIEWS>`, so it is always full size.
    this.viewBuffer = device.createBuffer({
      label: 'core views',
      size: MAX_VIEWS * VIEW_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewData = new Float32Array(MAX_VIEWS * VIEW_SLOT_FLOATS);
    this.viewU32 = new Uint32Array(this.viewData.buffer);
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
      device,
      viewLayout: this.viewLayout,
      cullLayout: this.cullLayout,
      viewBuffer: this.viewBuffer,
      viewData: this.viewData,
      maxViews: this.maxViews,
      multiDraw: this.caps.multiDraw,
      firstInstance: this.caps.firstInstance,
      stats: this.stats,
      viewGroup: (i) => this.viewGroups[i]!,
      quadIndex: (n) => this.quads.ensure(Math.ceil(n / 6)),
      get quadVersion() {
        return core.quads.version;
      },
      pass: (id) => {
        const p = this.passes.get(id);
        if (!p) throw new Error(`no pass ${id}`);
        return p;
      },
    };
  }

  /** A new arena on the core's device (D1 §3.1 `renderer.arena(kind)`). */
  createArena(desc: ArenaDesc): Arena {
    return new Arena(this.device, desc);
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
   * every GPU-culled set for every view in one compute pass. Resets `stats`' per-frame counts.
   */
  prepare(encoder: GPUCommandEncoder, views: readonly RenderView[]): void {
    const n = views.length;
    if (n < 1 || n > this.maxViews) {
      throw new Error(`core.prepare: ${n} views (1 to ${this.maxViews})`);
    }
    const st = this.stats;
    st.calls = 0;
    st.dispatches = 0;
    st.passes = 0;
    st.bundles = 0;
    st.directDraws = 0;
    st.slotBytes = 0;
    this.frame++;
    this.viewsPrepared = n;
    for (let i = 0; i < n; i++) writeViewSlot(this.viewData, this.viewU32, i, views[i]!);
    this.device.queue.writeBuffer(this.viewBuffer, 0, this.viewData, 0, n * VIEW_SLOT_FLOATS);
    st.calls++;
    let gpu = false;
    const sets = this.sets;
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i]!;
      set.upload(n);
      if (set.cull === 'gpu' && set.highWater > 0) gpu = true;
    }
    if (!gpu) return;
    const pass = encoder.beginComputePass(this.computeDesc);
    pass.setPipeline(this.cullPipe());
    st.calls += 2;
    for (let i = 0; i < sets.length; i++) sets[i]!.dispatch(pass, n);
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
    let first = true;
    let depthCleared = false;
    const list = this.passes.passes;
    for (let p = 0; p < list.length; p++) {
      const pass = list[p]!;
      const sets = this.bySet[p]!;
      if (pass.when && !pass.when()) continue;
      let work = false;
      let wantsDepth = false;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0) continue;
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
        d.view = this.depthFor(target.width, target.height);
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
      const bundles = this.bundleList;
      // Emptied by popping: `length = 0` drops the backing store, and the next push allocates.
      while (bundles.length > 0) bundles.pop();
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i]!;
        if (s.count === 0) continue;
        if (s.encoding() === 'bundle') {
          bundles.push(s.bundle(viewIndex, target.format, depthFormat, readOnly));
          continue;
        }
        if (bundles.length > 0) this.flushBundles(enc);
        s.encodeDirect(enc, viewIndex, target.format, depthFormat);
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

  /** Destroy every set, the shared buffers and the depth attachment. */
  destroy(): void {
    for (const s of this.sets) s.destroy();
    this.sets.length = 0;
    this.setsDirty = true;
    this.viewBuffer.destroy();
    this.quads.destroy();
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
  }

  // ------------------------------------------------------------------ internals

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
