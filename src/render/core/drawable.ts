/**
 * Core drawables (D1 §3.6, B5): a pass member any module registers that records its own draws,
 * next to the core's draw sets. World effects (particles, weather, water, decals) are core
 * drawables: the core runs their `prepare` once a frame (after the views are written), walks
 * them in their pass with the sets, and records them into one bundle per cull group (or encodes
 * them directly), so a stereo pair draws them in both eyes from one bundle.
 *
 * Effects that read the scene take it from the core: `readsDepth` binds the core's depth
 * attachment (sampled while the pass holds it read-only), `readsColor` a copy of the target's
 * colour taken before the pass (`CoreTarget.texture`). `CoreViewExtras` adds what `CoreView`
 * leaves out (inverse view-projection, the eye's right, up and forward), indexed by
 * `view.index`.
 */
import { mat4 } from '../../core/math';
import type { RenderCore } from './core';
import type { CorePass } from './pass-list';
import { type CoreTargetName, coreColorFormats, coreTargetMask } from './targets';
import { CORE_VIEW_WGSL, MAX_VIEWS, sphereInPlanes, VIEW_SLOT, VIEW_SLOT_FLOATS } from './view';
import { type PipelineWarmer, pipelineWarmer } from './warm';

/** What a drawable records into: an open pass (direct) or a bundle. */
export type CoreDrawableEncoder = GPURenderPassEncoder | GPURenderBundleEncoder;

/** Where a drawable records (one object, reused: read it during `record`, do not keep it). */
export interface CoreDrawContext {
  readonly core: RenderCore;
  /** The cull group being recorded (a bundle serves every view of it). */
  group: number;
  /** Bind this at group 0: the `CoreView` the shader reads (`CORE_DRAWABLE_WGSL`). */
  viewGroup: GPUBindGroup;
  /** The layout of `viewGroup`, for the drawable's pipeline layout. */
  readonly viewLayout: GPUBindGroupLayout;
  /** The colour target's format (at location 0). */
  color: GPUTextureFormat;
  /**
   * The pass's extra targets (ws/core-targets), a `CORE_TARGET` mask: a drawable's pipeline
   * lists them with `coreColorTargets(color, aux, writes)` (`DrawablePipelines` keys by it).
   */
  aux: number;
  /** The depth attachment's format, undefined when the pass has none. */
  depth: GPUTextureFormat | undefined;
  /** The pass holds depth read-only (a pipeline must not write it). */
  depthReadOnly: boolean;
  /**
   * The pass's depth convention (ws/render-fit, `PassDesc.reversedZ`): reversed-Z (depth
   * clears to 0, nearer is greater) or not. Build depth tests from it with `coreDepthCompare`.
   */
  reversedZ: boolean;
}

/**
 * A pass member that records its own draws. `active` false (or `bounds` outside a group's
 * frusta) leaves it out of that frame or group; a pass with no member at work is skipped.
 */
export interface CoreDrawable {
  readonly label?: string;
  /** The pass id it joins (default `'transparent'`). Fixed once added. */
  readonly pass?: string;
  /** Order within the pass, after sets of the same order (default 0). Fixed once added. */
  readonly order?: number;
  /** Tests depth (default true): the pass then has a depth attachment. */
  readonly depth?: boolean;
  /**
   * Samples the core's depth (`core.sceneDepthView`): the attachment gets `TEXTURE_BINDING`.
   * Only in a pass whose depth is `'read'` or `'none'` (a writing pass may not sample it).
   */
  readonly readsDepth?: boolean;
  /**
   * Samples the target's colour as it was before this pass (`core.sceneColorView`), copied
   * from `CoreTarget.texture` (which needs `COPY_SRC`). Without a texture the copy is not made.
   */
  readonly readsColor?: boolean;
  /**
   * The core's extra targets it writes (ws/pass-actor-fit): its pass attaches them even when
   * the pass's `PassDesc.writes` leaves them out (a sky that writes velocity in a pass that
   * writes none), so the pass's `aux` and every pipeline drawn there list them. Fixed once
   * added. Default none: the pass attaches what it declares.
   */
  readonly writes?: readonly CoreTargetName[];
  /** `'bundle'` (default): recorded once per group and format until `version` changes. */
  readonly encoding?: 'bundle' | 'direct';
  /** Bump to re-record its bundles (a new pipeline, bind group or draw count). */
  readonly version: number;
  /** Draws anything this frame. */
  readonly active: boolean;
  /** World sphere `[x, y, z, r]` it lies in (null or absent: never culled). Live. */
  readonly bounds?: ArrayLike<number> | null;
  /** Once a frame, in `core.prepare` after the views are written: uploads, compute. */
  prepare?(encoder: GPUCommandEncoder, core: RenderCore): void;
  /** Record its draws (pipeline, bind groups, draws); returns the GPU calls it made. */
  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number;
  /**
   * Record an empty draw (`draw(0)`) of each pipeline `record` would use for `ctx`'s target
   * (ws/warm-voxel-fit): set the pipeline and what it binds (`warmBindings` binds scratch
   * vertex buffers), draw nothing; returns the GPU calls made. The core calls it once per
   * target while the drawable is inactive, into a scratch pass of the target's formats, so the
   * pipeline compiles at load (WebKit compiles at the first draw) and not when it first draws.
   * Absent: not warmed.
   */
  warm?(enc: GPURenderPassEncoder, ctx: CoreDrawContext): number;
}

/**
 * The WGSL prelude a drawable's shader starts with: `CoreView` bound at group 0 as `view`. With
 * an origin grid, positions are relative to `view.origin.xyz`.
 */
export const CORE_DRAWABLE_WGSL = `${CORE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> view: CoreView;
`;

/** @internal What the core needs from a pass member (a draw set or a drawable). */
export interface PassMember {
  readonly count: number;
  readonly depth: boolean;
  readonly order: number;
  readonly pass: CorePass;
  readonly readsDepth?: boolean;
  readonly readsColor?: boolean;
  /** False while a restored draw set waits for its bind groups (ws/core-passes). */
  readonly ready?: boolean;
  encoding(): string;
  inView?(group: number): boolean;
  /** A GPU-culled set `encodeCulled` may draw from a CPU cull (E28; `RenderCoreOptions.drawCull`). */
  cpuCullable?(): boolean;
  encodeCulled?(
    pass: GPURenderPassEncoder,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    aux: number,
  ): void;
  bundle(
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    readOnly: boolean,
    aux: number,
  ): GPURenderBundle;
  encodeDirect(
    pass: GPURenderPassEncoder,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    aux: number,
  ): void;
  /**
   * Queue the empty first draw of what it would draw into a target of these formats unless
   * done (ws/warm-voxel-fit); returns the warms queued.
   */
  warm?(
    warmer: PipelineWarmer,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    aux: number,
  ): number;
}

/** @internal The core side the entry reads. */
export interface DrawableHost {
  readonly device: GPUDevice;
  readonly ctx: CoreDrawContext;
  readonly stats: {
    calls: number;
    directDraws: number;
    bundleBuilds: number;
    bundleCalls: number;
  };
  readonly viewData: Float32Array;
  drawGroup(group: number): GPUBindGroup;
  groupPlanes(group: number): number;
  /** Bumped when the core's depth or colour copy is re-created. */
  readonly targetsVersion: number;
}

interface Recorded {
  group: number;
  bind: GPUBindGroup;
  color: GPUTextureFormat;
  depth: GPUTextureFormat | undefined;
  readOnly: boolean;
  aux: number;
  version: number;
  targets: number;
  bundle: GPURenderBundle;
}

/** @internal A drawable as a pass member. */
export class DrawableEntry implements PassMember {
  readonly pass: CorePass;
  readonly order: number;
  readonly depth: boolean;
  readonly readsDepth: boolean;
  readonly readsColor: boolean;
  /** `CoreDrawable.writes` as a mask. */
  readonly writes: number;
  private readonly bundles: Recorded[] = [];

  constructor(
    readonly drawable: CoreDrawable,
    private readonly host: DrawableHost,
    pass: CorePass,
  ) {
    this.pass = pass;
    this.order = drawable.order ?? 0;
    this.depth = drawable.depth ?? true;
    this.readsDepth = !!drawable.readsDepth;
    this.readsColor = !!drawable.readsColor;
    this.writes = coreTargetMask(drawable.writes);
    if (this.readsDepth && pass.depth === 'write') {
      throw new Error(
        `${drawable.label ?? 'drawable'}: readsDepth needs a pass whose depth is 'read' or 'none' (${pass.id} writes)`,
      );
    }
  }

  get count(): number {
    return this.drawable.active ? 1 : 0;
  }

  encoding(): string {
    return this.drawable.encoding ?? 'bundle';
  }

  inView(group: number): boolean {
    const b = this.drawable.bounds;
    if (!b) return true;
    return sphereInPlanes(
      this.host.viewData,
      this.host.groupPlanes(group),
      b[0]!,
      b[1]!,
      b[2]!,
      b[3]!,
    );
  }

  bundle(
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    readOnly: boolean,
    aux = 0,
  ): GPURenderBundle {
    const host = this.host;
    const bind = host.drawGroup(group);
    const version = this.drawable.version;
    const targets = host.targetsVersion;
    let entry: Recorded | undefined;
    for (let i = 0; i < this.bundles.length; i++) {
      const b = this.bundles[i]!;
      if (
        b.group === group &&
        b.color === color &&
        b.depth === depth &&
        b.readOnly === readOnly &&
        b.aux === aux
      ) {
        entry = b;
        break;
      }
    }
    if (entry && entry.version === version && entry.targets === targets && entry.bind === bind) {
      return entry.bundle;
    }
    const enc = host.device.createRenderBundleEncoder({
      label: `${this.drawable.label ?? 'drawable'} bundle`,
      colorFormats: coreColorFormats(color, aux),
      depthStencilFormat: depth,
      depthReadOnly: readOnly,
      stencilReadOnly: readOnly,
    });
    const n = this.drawable.record(enc, this.context(group, bind, color, depth, readOnly, aux));
    host.stats.bundleCalls += n;
    host.stats.bundleBuilds++;
    const bundle = enc.finish();
    if (entry) {
      entry.bind = bind;
      entry.version = version;
      entry.targets = targets;
      entry.bundle = bundle;
    } else {
      this.bundles.push({
        group,
        bind,
        color,
        depth,
        readOnly,
        aux,
        version,
        targets,
        bundle,
      });
    }
    return bundle;
  }

  encodeDirect(
    pass: GPURenderPassEncoder,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    aux = 0,
  ): void {
    const host = this.host;
    const readOnly = depth !== undefined && this.pass.depth === 'read';
    const n = this.drawable.record(
      pass,
      this.context(group, host.drawGroup(group), color, depth, readOnly, aux),
    );
    host.stats.calls += n;
    host.stats.directDraws++;
  }

  /** Targets warmed (`warm`). */
  private readonly warmed: {
    color: GPUTextureFormat;
    depth: GPUTextureFormat | undefined;
    readOnly: boolean;
    aux: number;
    reversed: boolean;
  }[] = [];

  warm(
    warmer: PipelineWarmer,
    group: number,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    aux = 0,
  ): number {
    const d = this.drawable;
    if (!d.warm || !warmer.enabled) return 0;
    const readOnly = depth !== undefined && this.pass.depth === 'read';
    const reversed = this.pass.reversedZ;
    const w = this.warmed;
    for (let i = 0; i < w.length; i++) {
      const e = w[i]!;
      if (
        e.color === color &&
        e.depth === depth &&
        e.readOnly === readOnly &&
        e.aux === aux &&
        e.reversed === reversed
      ) {
        return 0;
      }
    }
    w.push({ color, depth, readOnly, aux, reversed });
    queueDrawableWarm(
      warmer,
      d,
      this.host.ctx,
      this.host.drawGroup(group),
      group,
      color,
      depth,
      readOnly,
      reversed,
      aux,
    );
    return 1;
  }

  private context(
    group: number,
    bind: GPUBindGroup,
    color: GPUTextureFormat,
    depth: GPUTextureFormat | undefined,
    readOnly: boolean,
    aux: number,
  ): CoreDrawContext {
    const ctx = this.host.ctx;
    ctx.aux = aux;
    ctx.group = group;
    ctx.viewGroup = bind;
    ctx.color = color;
    ctx.depth = depth;
    ctx.depthReadOnly = readOnly;
    ctx.reversedZ = this.pass.reversedZ;
    return ctx;
  }
}

/**
 * Render pipelines of one drawable by target: colour format × depth format × read-only × the
 * pass's extra targets (`aux`, ws/core-targets) × its depth convention (`reversedZ`, ws/fx-fit),
 * made on first use by `make` (pass `depthWrite` on to `GPUDepthStencilState.depthWriteEnabled`
 * only when the pass is not read-only; list the colour targets with
 * `coreColorTargets(color, aux, writes)`; test depth with `coreDepthCompare(reversedZ, orEqual)`).
 */
export class DrawablePipelines {
  private readonly list: {
    color: GPUTextureFormat;
    depth: GPUTextureFormat | undefined;
    readOnly: boolean;
    aux: number;
    reversedZ: boolean;
    pipeline: GPURenderPipeline;
  }[] = [];

  constructor(
    private readonly make: (
      color: GPUTextureFormat,
      depth: GPUTextureFormat | undefined,
      readOnly: boolean,
      aux: number,
      reversedZ: boolean,
    ) => GPURenderPipeline,
  ) {}

  /** The pipeline for `ctx`'s target. */
  get(ctx: CoreDrawContext): GPURenderPipeline {
    const l = this.list;
    const aux = ctx.aux ?? 0;
    const reversedZ = ctx.reversedZ === true;
    for (let i = 0; i < l.length; i++) {
      const e = l[i]!;
      if (
        e.color === ctx.color &&
        e.depth === ctx.depth &&
        e.readOnly === ctx.depthReadOnly &&
        e.aux === aux &&
        e.reversedZ === reversedZ
      ) {
        return e.pipeline;
      }
    }
    const pipeline = this.make(ctx.color, ctx.depth, ctx.depthReadOnly, aux, reversedZ);
    l.push({
      color: ctx.color,
      depth: ctx.depth,
      readOnly: ctx.depthReadOnly,
      aux,
      reversedZ,
      pipeline,
    });
    return pipeline;
  }
}

/**
 * Bind `n` scratch vertex buffers at slots 0 … n-1 for a drawable's empty warm draw
 * (`CoreDrawable.warm`); returns the calls made.
 */
export function warmBindings(enc: GPURenderPassEncoder, ctx: CoreDrawContext, n: number): number {
  if (n === 0) return 0;
  const b = pipelineWarmer(ctx.core.device).scratchVertex();
  for (let i = 0; i < n; i++) enc.setVertexBuffer(i, b);
  return n;
}

/** Floats per view in `CoreViewExtras`: inverse view-projection, right, up, forward, spare. */
export const VIEW_EXTRA_FLOATS = 32;

/**
 * WGSL for `CoreViewExtras`: `struct CoreViewExtra` (`invViewProj`, `right`, `up`, `forward`
 * (xyz; unit), padding). Bind the buffer as `var<storage, read> extras:
 * array<CoreViewExtra>` and read `extras[view.index]`.
 */
export const CORE_VIEW_EXTRA_WGSL = /* wgsl */ `
struct CoreViewExtra {
  invViewProj: mat4x4f,
  right: vec4f,
  up: vec4f,
  forward: vec4f,
  _pad: vec4f,
};
`;

const extrasByCore = new WeakMap<RenderCore, CoreViewExtras>();

/**
 * Per-view data `CoreView` has no room for, for effects that unproject depth or face the eye:
 * one storage buffer of `MAX_VIEWS` × `VIEW_EXTRA_FLOATS` floats, written from the core's view
 * slots (camera-relative when the core has an origin grid). Shared per core
 * (`CoreViewExtras.of(core)`); `update()` from a drawable's `prepare` writes it at most once a
 * frame, and only when a view's view-projection (or the view count, or the depth convention)
 * changed since the last write (ws/g6-asks): a still camera costs no upload.
 */
export class CoreViewExtras {
  readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(MAX_VIEWS * VIEW_EXTRA_FLOATS);
  private readonly inv = new Float32Array(16);
  /** The view-projections last written from (NaN until the first write). */
  private readonly from = new Float32Array(MAX_VIEWS * 16).fill(Number.NaN);
  private fromCount = -1;
  private fromNear = -1;
  private frame = -1;

  /** The device the buffer lives on: `of` makes new extras after `core.restore` (ws/core-decals). */
  private readonly device: GPUDevice;

  private constructor(private readonly core: RenderCore) {
    this.device = core.device;
    this.buffer = core.device.createBuffer({
      label: 'core view extras',
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /** The core's shared extras (made on first use, and again on a restored core's new device). */
  static of(core: RenderCore): CoreViewExtras {
    let e = extrasByCore.get(core);
    if (!e || e.device !== core.device) {
      e = new CoreViewExtras(core);
      extrasByCore.set(core, e);
    }
    return e;
  }

  /**
   * Write this frame's views: once a frame however many drawables call it, and only when they
   * changed since the last write (the buffer keeps what was written). No allocation.
   */
  update(): void {
    const core = this.core;
    if (this.frame === core.frame) return;
    this.frame = core.frame;
    const n = core.viewCount;
    const src = core.viewData;
    const d = this.data;
    const inv = this.inv;
    const near = core.passes.reversedZ ? 1 : 0;
    let same = n === this.fromCount && near === this.fromNear;
    const from = this.from;
    for (let i = 0; i < n; i++) {
      const at = i * VIEW_SLOT_FLOATS + VIEW_SLOT.viewProj;
      for (let k = 0; k < 16; k++) {
        const v = src[at + k]!;
        if (from[i * 16 + k] !== v) {
          same = false;
          from[i * 16 + k] = v;
        }
      }
    }
    if (same) return;
    this.fromCount = n;
    this.fromNear = near;
    for (let i = 0; i < n; i++) {
      const at = i * VIEW_SLOT_FLOATS + VIEW_SLOT.viewProj;
      if (!mat4.invert(inv, src.subarray(at, at + 16))) mat4.identity(inv);
      const o = i * VIEW_EXTRA_FLOATS;
      d.set(inv, o);
      // The image plane's axes: the far-plane points left of / above the centre, minus it.
      axis(inv, 1, 0, d, o + 16);
      axis(inv, 0, 1, d, o + 20);
      // Forward: from the near-plane centre to the mid-depth one (an infinite far has no far
      // plane). Near is depth 1 under reversed-Z (ws/fx-fit).
      unproject(inv, 0, 0, near, d, o + 24);
      const nx = d[o + 24]!;
      const ny = d[o + 25]!;
      const nz = d[o + 26]!;
      unproject(inv, 0, 0, 0.5, d, o + 24);
      norm3(d, o + 24, d[o + 24]! - nx, d[o + 25]! - ny, d[o + 26]! - nz);
    }
    core.device.queue.writeBuffer(this.buffer, 0, d, 0, n * VIEW_EXTRA_FLOATS);
  }

  destroy(): void {
    this.buffer.destroy();
    extrasByCore.delete(this.core);
  }
}

function unproject(
  inv: Float32Array,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  o: number,
): void {
  const w = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!;
  const s = Math.abs(w) < 1e-12 ? 1 : 1 / w;
  out[o] = (inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!) * s;
  out[o + 1] = (inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!) * s;
  out[o + 2] = (inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!) * s;
  out[o + 3] = 0;
}

function axis(inv: Float32Array, x: number, y: number, out: Float32Array, o: number): void {
  // At mid depth (0.5) both ends lie on one plane parallel to the image plane.
  unproject(inv, 0, 0, 0.5, out, o);
  const cx = out[o]!;
  const cy = out[o + 1]!;
  const cz = out[o + 2]!;
  unproject(inv, x, y, 0.5, out, o);
  norm3(out, o, out[o]! - cx, out[o + 1]! - cy, out[o + 2]! - cz);
}

function norm3(out: Float32Array, o: number, x: number, y: number, z: number): void {
  const l = Math.hypot(x, y, z) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  out[o + 3] = 0;
}

/**
 * Queue a drawable's empty first draw (`DrawableEntry.warm`). Its own function, so `warm` makes
 * no closure context on a call that queues nothing. The core's draw context is one reused
 * object: the warm, which runs later, gets its own copy.
 */
function queueDrawableWarm(
  warmer: PipelineWarmer,
  d: CoreDrawable,
  ctx: CoreDrawContext,
  bind: GPUBindGroup,
  group: number,
  color: GPUTextureFormat,
  depth: GPUTextureFormat | undefined,
  readOnly: boolean,
  reversed: boolean,
  aux: number,
): void {
  const own: CoreDrawContext = {
    core: ctx.core,
    group,
    viewGroup: bind,
    viewLayout: ctx.viewLayout,
    color,
    aux,
    depth,
    depthReadOnly: readOnly,
    reversedZ: reversed,
  };
  warmer.job({ color: coreColorFormats(color, aux), depth }, (enc) => d.warm!(enc, own));
}
