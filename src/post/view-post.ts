import type { PostInputs, PostProcessor } from '../render/renderer';
import type { SceneTargetViewport } from '../render/scene-target';

/** The most views (eyes, panes) one `ViewPost` keeps a processor for. */
export const VIEW_POST_MAX = 8;

/**
 * Post per view (ws/core-passes): one processor per view, so each view keeps its own history
 * (TAA's previous frame, auto-exposure's adapted level, motion blur's last matrices) and no
 * eye of a stereo pair reprojects the other's. Set it as `renderer.post`: each distinct
 * `viewport` given to `encode` (one per eye when `renderer.resolve` writes two eyes into one
 * XR layer) gets its own processor, made on first use with `make(viewIndex)`; a call without
 * a viewport is view 0. A core user picks one with `forView(i)`. `resize` reaches every
 * processor made so far and is remembered for those made later.
 */
export class ViewPost implements PostProcessor {
  readonly wantsJitter: boolean;
  /** Processors made so far, by view index. */
  readonly views: PostProcessor[] = [];
  private readonly make: (viewIndex: number) => PostProcessor;
  /** Per view: its viewport's x, y, width, height; NaN for "no viewport". */
  private readonly keys = new Float64Array(VIEW_POST_MAX * 4);
  /** Views whose viewport is known (`keys`), in the order first seen. */
  private assigned = 0;
  private width = 0;
  private height = 0;

  constructor(make: (viewIndex: number) => PostProcessor) {
    this.make = make;
    const first = make(0);
    this.views.push(first);
    this.wantsJitter = first.wantsJitter === true;
  }

  /** The processor of view `index`, made now if it does not exist yet. */
  forView(index: number): PostProcessor {
    if (index < 0 || index >= VIEW_POST_MAX) {
      throw new Error(`ViewPost: view ${index} (0 to ${VIEW_POST_MAX - 1})`);
    }
    while (this.views.length <= index) {
      const p = this.make(this.views.length);
      if (this.width > 0) p.resize(this.width, this.height);
      this.views.push(p);
    }
    return this.views[index]!;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (const p of this.views) p.resize(width, height);
  }

  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    this.forView(this.indexOf(viewport)).encode(encoder, inputs, output, viewport);
  }

  /** The view a viewport belongs to: the one first seen with it, else the next free one. */
  private indexOf(vp: SceneTargetViewport | undefined): number {
    const k = this.keys;
    const n = this.assigned;
    const x = vp ? vp.x : Number.NaN;
    const y = vp ? vp.y : Number.NaN;
    const w = vp ? vp.width : Number.NaN;
    const h = vp ? vp.height : Number.NaN;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (same(k[o]!, x) && same(k[o + 1]!, y) && same(k[o + 2]!, w) && same(k[o + 3]!, h)) {
        return i;
      }
    }
    const at = n;
    if (at >= VIEW_POST_MAX) throw new Error(`ViewPost: more than ${VIEW_POST_MAX} viewports`);
    const o = at * 4;
    k[o] = x;
    k[o + 1] = y;
    k[o + 2] = w;
    k[o + 3] = h;
    this.assigned++;
    return at;
  }
}

function same(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** `new ViewPost(make)`: one post processor per view, no shared history. */
export function createViewPost(make: (viewIndex: number) => PostProcessor): ViewPost {
  return new ViewPost(make);
}
