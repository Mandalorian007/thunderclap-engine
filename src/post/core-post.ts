import { type Mat4, mat4 } from '../core/math';
import type { RenderCore } from '../render/core/core';
import type { CorePass, CoreResolveContext } from '../render/core/pass-list';
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
 * and the last frame's of the same view index); jitter is 0. Set `time` / `dt` each frame.
 * No allocation per frame.
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

  constructor(core: RenderCore, processor: PostProcessor, opts: CorePostOptions = {}) {
    this.core = core;
    this.processor = processor;
    this.emissive = opts.emissive ?? null;
    for (let i = 0; i < VIEW_POST_MAX; i++) {
      this.views.push({
        viewProj: new Float32Array(16),
        invViewProj: new Float32Array(16),
        previousViewProj: new Float32Array(16),
        previousView: new Float32Array(16),
        jitter: [0, 0],
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

    const rv = ctx.view;
    const v = this.views[i]!;
    v.viewProj.set(rv.viewProj);
    if (!mat4.invert(this.inv, rv.viewProj)) mat4.identity(this.inv);
    v.invViewProj.set(this.inv);
    if (!this.seen[i]) {
      // A view's first frame: its "previous" is itself (no motion).
      v.previousViewProj.set(rv.viewProj);
      if (rv.view) this.lastView[i]!.set(rv.view);
      this.seen[i] = 1;
    }
    v.previousView.set(this.lastView[i]!);
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
      p.near = p14 / p10;
      if (p.proj[11] === 0) {
        p.far = (p14 - 1) / p10;
      } else {
        const k = p10 + 1;
        p.far = Math.abs(k) < 1e-7 ? Number.POSITIVE_INFINITY : p14 / k;
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
    this.resolves++;

    // This frame's matrices are the next frame's "previous" for this view.
    v.previousViewProj.set(rv.viewProj);
    if (rv.view) this.lastView[i]!.set(rv.view);
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
