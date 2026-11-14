import { type Mat4, mat4 } from '../core/math';
import type { RenderCore } from '../render/core/core';
import type { CorePass, CoreResolveContext } from '../render/core/pass-list';
import { VIEW_SLOT_FLOATS, writeViewSlot } from '../render/core/view';
import type { PostInputs, PostProcessor, PostProjection, PostView } from '../render/renderer';
import type { SceneTargetViewport } from '../render/scene-target';
import type { TextureLike } from '../render/texture';
import { VIEW_POST_MAX, ViewPost } from './view-post';

/** Options for `createCorePost`. */
export interface CorePostOptions {
  /** The pass id (default `'post'`). */
  id?: string;
  /**
   * The pass it follows (default `'transparent'`): passes after it (`overlay`, UI) draw into
   * the post's output.
   */
  after?: string;
  /**
   * The scene's emissive (bloom source) when the game draws one outside the core. Without it
   * bloom reads the core's `emissive` target (`RenderCoreOptions.targets`), else a black texel.
   */
  emissive?: TextureLike | null;
  /**
   * What the velocity target's motion holds of the jitter (ws/post-fit; with `setJitter`):
   * `'keep'` (default) passes it on as written; `'remove'` tells TAA the jitter delta the views
   * were drawn with (`PostView.velocityJitter`), which it takes out. Use `'remove'` when the
   * velocity is computed from the jittered matrices (`core_velocity` over jittered views).
   */
  velocityJitter?: 'keep' | 'remove';
  /**
   * Hand the processor the view matrices relative to the core's frame origin (ws/post-fit;
   * `RenderCoreOptions.originGrid`), as the core draws them, so a world far from 0 keeps its
   * float32 precision in the depth passes. Default false (absolute, as before). Without an
   * `originGrid` the origin is zero and nothing changes.
   */
  relativeToOrigin?: boolean;
}

interface Tex {
  view: GPUTextureView;
  width: number;
  height: number;
}

/**
 * Post on the retained core (ws/core-passes): a resolve pass in the core's `PassList` that hands
 * each view's colour and depth, and the core's extra targets (ws/core-targets: emissive feeds
 * bloom, velocity TAA and motion blur, roughMetal SSR), to a post processor (a `PostStack`, FXAA, TAA, or a `ViewPost` of
 * them) and writes `CoreTarget.output`. With a `ViewPost` every view (each eye of a stereo pair)
 * runs its own processor, so no history is shared between eyes; a plain processor serves view 0
 * and is used for every view. The view's matrices come from the core's `RenderView` (this frame's
 * and the last frame's of the same view index). Jitter is 0 unless `setJitter` gives the frame's
 * (ws/post-fit): the view's `viewProj` is then taken as jittered, and the "previous" matrix is
 * last frame's with its jitter removed. Set `time` / `dt` each frame. No allocation per frame.
 */
export class CorePost {
  readonly pass: CorePass;
  readonly processor: PostProcessor;
  /** Seconds, for time-driven effects (grain); the caller sets it each frame. */
  time = 0;
  /** The frame's step in seconds. */
  dt = 0;
  /** The scene's emissive, or null for none (`CorePostOptions.emissive`). */
  emissive: TextureLike | null;
  /** Resolves run so far. */
  resolves = 0;
  private readonly core: RenderCore;
  private readonly inputs: PostInputs;
  private readonly color: Tex = {
    view: undefined as unknown as GPUTextureView,
    width: 1,
    height: 1,
  };
  private readonly depth: Tex = {
    view: undefined as unknown as GPUTextureView,
    width: 1,
    height: 1,
  };
  /** The core's extra targets (ws/core-targets): emissive, roughMetal, velocity. */
  private readonly aux: Tex[] = [0, 1, 2].map(() => ({
    view: undefined as unknown as GPUTextureView,
    width: 1,
    height: 1,
  }));
  private readonly projection: PostProjection = { near: 0, far: 0, proj: new Float32Array(16) };
  private readonly views: PostView[] = [];
  /** Per view: whether `previous*` holds a real frame. */
  private readonly seen = new Uint8Array(VIEW_POST_MAX);
  private readonly lastView: Float32Array[] = [];
  private readonly vp: SceneTargetViewport = { x: 0, y: 0, width: 1, height: 1 };
  private width = 0;
  private height = 0;
  private readonly inv: Mat4 = mat4.create();
  /** A 1×1 texel of zeros (WebGPU clears new textures): the emissive when the game gives none. */
  private black: Tex | null = null;
  private blackDevice: GPUDevice | null = null;
  /** Per view: this frame's jitter in px (`setJitter`), and the last resolved frame's. */
  private readonly jitterPx = new Float32Array(2 * VIEW_POST_MAX);
  private readonly lastJitterPx = new Float32Array(2 * VIEW_POST_MAX);
  private readonly removeVelocityJitter: boolean;
  private readonly relative: boolean;
  /** Per view: the frame origin `previousViewProj` is relative to (`relativeToOrigin`). */
  private readonly lastOrigin = new Float64Array(3 * VIEW_POST_MAX);
  private readonly slot = new Float32Array(VIEW_SLOT_FLOATS);
  private readonly slotU32 = new Uint32Array(this.slot.buffer);
  private readonly cur: Mat4 = mat4.create();
  /** The resolve's timestamps for the processor's passes (`PostInputs.timestamps`). */
  private stampCtx: CoreResolveContext | null = null;
  private readonly stamps = (label: string): GPURenderPassTimestampWrites | undefined =>
    this.stampCtx?.timestamps?.(label, this.pass.id);

  constructor(core: RenderCore, processor: PostProcessor, opts: CorePostOptions = {}) {
    this.core = core;
    this.processor = processor;
    this.emissive = opts.emissive ?? null;
    this.removeVelocityJitter = opts.velocityJitter === 'remove';
    this.relative = opts.relativeToOrigin === true;
    for (let i = 0; i < VIEW_POST_MAX; i++) {
      this.views.push({
        viewProj: new Float32Array(16),
        invViewProj: new Float32Array(16),
        previousViewProj: new Float32Array(16),
        previousView: new Float32Array(16),
        jitter: [0, 0],
        velocityJitter: [0, 0],
      });
      this.lastView.push(new Float32Array(16));
    }
    this.inputs = {
      color: this.color,
      emissive: this.color,
      time: 0,
      dt: 0,
      depth: null,
      projection: null,
      view: null,
      roughMetal: null,
      velocity: null,
    };
    this.pass = core.definePass({
      id: opts.id ?? 'post',
      after: opts.after ?? 'transparent',
      depth: 'none',
      resolve: (encoder, ctx) => this.resolve(encoder, ctx),
    });
  }

  /**
   * The sub-pixel jitter this frame's views were drawn with (ws/post-fit), in target px (+x
   * right, +y down; the clip offset is `(2x / width, -2y / height)`, as `Camera.jitterClip`):
   * for `viewIndex`, or every view when omitted. Kept until changed; `setJitter(0, 0)` clears.
   * TAA reads it (`PostView.jitter`) and the "previous" matrix is the view's without it.
   */
  setJitter(x: number, y: number, viewIndex?: number): void {
    const j = this.jitterPx;
    if (viewIndex === undefined) {
      for (let i = 0; i < VIEW_POST_MAX; i++) {
        j[2 * i] = x;
        j[2 * i + 1] = y;
      }
      return;
    }
    if (viewIndex < 0 || viewIndex >= VIEW_POST_MAX) {
      throw new Error(`CorePost.setJitter: view ${viewIndex} (0 to ${VIEW_POST_MAX - 1})`);
    }
    j[2 * viewIndex] = x;
    j[2 * viewIndex + 1] = y;
  }

  private blackTexel(): Tex {
    const device = this.core.device;
    if (this.black && this.blackDevice === device) return this.black;
    const t = device.createTexture({
      label: 'core-post-black',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.black = { view: t.createView(), width: 1, height: 1 };
    this.blackDevice = device;
    return this.black;
  }

  private target(k: number, view: GPUTextureView | null, ctx: CoreResolveContext): Tex | null {
    if (!view) return null;
    const t = this.aux[k]!;
    t.view = view;
    t.width = ctx.width;
    t.height = ctx.height;
    return t;
  }

  private resolve(encoder: GPUCommandEncoder, ctx: CoreResolveContext): void {
    const i = ctx.viewIndex;
    if (i >= VIEW_POST_MAX) throw new Error(`CorePost: view ${i} (0 to ${VIEW_POST_MAX - 1})`);
    const proc = this.processor instanceof ViewPost ? this.processor.forView(i) : this.processor;
    if (ctx.width !== this.width || ctx.height !== this.height) {
      this.width = ctx.width;
      this.height = ctx.height;
      this.processor.resize(ctx.width, ctx.height);
    }
    const inputs = this.inputs;
    const c = this.color;
    c.view = ctx.color;
    c.width = ctx.width;
    c.height = ctx.height;
    inputs.color = c;
    inputs.emissive = this.emissive ?? this.target(0, ctx.emissive, ctx) ?? this.blackTexel();
    inputs.roughMetal = this.target(1, ctx.roughMetal, ctx);
    inputs.velocity = this.target(2, ctx.velocity, ctx);
    inputs.time = this.time;
    inputs.dt = this.dt;
    this.stampCtx = ctx;
    inputs.timestamps = ctx.timestamps ? this.stamps : null;

    const rv = ctx.view;
    const v = this.views[i]!;
    // This frame's matrix: absolute, or relative to the core's origin (`relativeToOrigin`).
    const cur = this.cur;
    const origin = this.core.origin;
    if (this.relative) {
      writeViewSlot(this.slot, this.slotU32, 0, rv, origin, this.core.originGrid > 0);
      for (let k = 0; k < 16; k++) cur[k] = this.slot[k]!;
    } else {
      cur.set(rv.viewProj);
    }
    v.viewProj.set(cur);
    if (!mat4.invert(this.inv, cur)) mat4.identity(this.inv);
    v.invViewProj.set(this.inv);
    const jx = this.jitterPx[2 * i]!;
    const jy = this.jitterPx[2 * i + 1]!;
    // The jitter-free matrix (what the next frame's "previous" is): the clip offset taken out.
    if (jx !== 0 || jy !== 0) unjitter(cur, (2 * jx) / ctx.width, (-2 * jy) / ctx.height);
    if (!this.seen[i]) {
      // A view's first frame: its "previous" is itself (no motion).
      v.previousViewProj.set(cur);
      if (rv.view) this.lastView[i]!.set(rv.view);
      this.lastJitterPx[2 * i] = jx;
      this.lastJitterPx[2 * i + 1] = jy;
      this.lastOrigin.set(origin, 3 * i);
      this.seen[i] = 1;
    } else if (this.relative) {
      // Last frame's matrix was relative to last frame's origin: move it to this frame's.
      shiftOrigin(v.previousViewProj, origin, this.lastOrigin, 3 * i);
    }
    v.previousView.set(this.lastView[i]!);
    v.jitter[0] = jx;
    v.jitter[1] = jy;
    const vj = v.velocityJitter!;
    vj[0] = this.removeVelocityJitter ? jx - this.lastJitterPx[2 * i]! : 0;
    vj[1] = this.removeVelocityJitter ? jy - this.lastJitterPx[2 * i + 1]! : 0;
    inputs.view = v;

    inputs.depth = null;
    inputs.projection = null;
    if (ctx.depth && rv.proj) {
      const d = this.depth;
      d.view = ctx.depth;
      d.width = ctx.width;
      d.height = ctx.height;
      const p = this.projection;
      p.proj.set(rv.proj);
      // As the renderer's: near = p14 / p10; far = p14 / (p10 + 1) (perspective, ∞ at p10 =
      // -1) or (p14 - 1) / p10 (orthographic, p11 = 0).
      const p10 = p.proj[10]!;
      const p14 = p.proj[14]!;
      const ortho = p.proj[11] === 0;
      p.reversedZ = ctx.reversedZ;
      if (!ctx.reversedZ) {
        p.near = p14 / p10;
        if (ortho) {
          p.far = (p14 - 1) / p10;
        } else {
          const k = p10 + 1;
          p.far = Math.abs(k) < 1e-7 ? Number.POSITIVE_INFINITY : p14 / k;
        }
      } else if (ortho) {
        // Reversed-Z (ws/post-fit): depth 1 at near, 0 at far (z_ndc = p10·z + p14).
        p.near = (p14 - 1) / p10;
        p.far = p14 / p10;
      } else {
        // z_ndc = (p10·z + p14) / -z: 1 at near, 0 at far (∞ at p10 = 0).
        p.near = p14 / (1 + p10);
        p.far = Math.abs(p10) < 1e-7 ? Number.POSITIVE_INFINITY : p14 / p10;
      }
      inputs.depth = d;
      inputs.projection = p;
    }

    let viewport: SceneTargetViewport | undefined;
    const ov = ctx.outputViewport;
    if (ov) {
      const r = this.vp;
      r.x = ov.x;
      r.y = ov.y;
      r.width = ov.width;
      r.height = ov.height;
      viewport = r;
    }
    proc.encode(encoder, inputs, ctx.output, viewport);
    this.stampCtx = null;
    this.resolves++;

    // This frame's matrices (without jitter) are the next frame's "previous" for this view.
    v.previousViewProj.set(cur);
    if (rv.view) this.lastView[i]!.set(rv.view);
    this.lastJitterPx[2 * i] = jx;
    this.lastJitterPx[2 * i + 1] = jy;
    this.lastOrigin.set(origin, 3 * i);
  }
}

/** Take a clip-space offset `(dx, dy)` out of the column-major `m` (rows 0 and 1 lose `d·row 3`). */
function unjitter(m: Mat4, dx: number, dy: number): void {
  for (let c = 0; c < 16; c += 4) {
    m[c] = m[c]! - dx * m[c + 3]!;
    m[c + 1] = m[c + 1]! - dy * m[c + 3]!;
  }
}

/**
 * Move `m` (relative to the origin at `last[at..at+3)`) to be relative to `origin`: its last
 * column becomes `m · (origin − last, 1)`.
 */
function shiftOrigin(m: Float32Array, origin: Float64Array, last: Float64Array, at: number): void {
  const dx = origin[0]! - last[at]!;
  const dy = origin[1]! - last[at + 1]!;
  const dz = origin[2]! - last[at + 2]!;
  if (dx === 0 && dy === 0 && dz === 0) return;
  for (let r = 0; r < 4; r++) {
    m[12 + r] = m[r]! * dx + m[4 + r]! * dy + m[8 + r]! * dz + m[12 + r]!;
  }
}

/**
 * `new CorePost(core, processor, opts)`: post as a resolve pass on the core (ws/core-passes).
 * Draw with a `CoreTarget` whose `view` is the HDR scene (`rgba16float`, `TEXTURE_BINDING`) and
 * whose `output` is the swapchain view (or an eye's rectangle of an XR layer, `outputViewport`).
 */
export function createCorePost(
  core: RenderCore,
  processor: PostProcessor,
  opts?: CorePostOptions,
): CorePost {
  return new CorePost(core, processor, opts);
}
