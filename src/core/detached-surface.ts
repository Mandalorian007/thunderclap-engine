/**
 * The surface behind `createGame({ overlay: false })` (ws/core-9): the letterbox maths of
 * `Surface` on a virtual container, with no canvas, no root element and no DOM listener. The
 * container is the design size until `resizeContainer` changes it, at a pixel ratio of 1, so
 * client px are design px by default. Internal: it implements the `Surface` interface with no
 * cast (ws/platform-surface), and `ctx.surface` is typed `Surface`; reading its `root` or
 * `canvas` throws.
 */
import {
  type BackbufferSize,
  clientToLogical,
  computeBackbuffer,
  computeLetterbox,
  type Letterbox,
  logicalToClient,
  type Surface,
  type SurfaceOptions,
  type SurfaceSize,
  type Vec2,
} from '../platform';

type Rect = { x: number; y: number; width: number; height: number };

export class DetachedSurface implements Surface {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  rect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  fitRect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  backbuffer: BackbufferSize = { width: 1, height: 1, pixelRatio: 1 };
  private containerW: number;
  private containerH: number;
  private frame: Rect | null = null;
  private readonly maxDpr: number;
  private readonly maxPixels: number;
  private readonly listeners = new Set<(size: SurfaceSize) => void>();

  constructor(opts: SurfaceOptions = {}) {
    this.logicalWidth = opts.logicalWidth ?? 1920;
    this.logicalHeight = opts.logicalHeight ?? 1080;
    this.maxDpr = opts.maxDpr ?? 2;
    this.maxPixels = opts.maxPixels ?? 2560 * 1440;
    this.containerW = this.logicalWidth;
    this.containerH = this.logicalHeight;
    this.layout();
  }

  get root(): HTMLElement {
    throw new Error(NO_DOM('ctx.surface.root'));
  }

  get canvas(): HTMLCanvasElement {
    throw new Error(NO_DOM('ctx.surface.canvas'));
  }

  /** The virtual container's size in CSS px (a test's viewport); lays out again at once. */
  resizeContainer(width: number, height: number): void {
    this.containerW = width;
    this.containerH = height;
    this.layout();
  }

  onResize(fn: (size: SurfaceSize) => void): () => void {
    this.listeners.add(fn);
    fn({ rect: this.rect, backbuffer: this.backbuffer });
    return () => this.listeners.delete(fn);
  }

  /** The container sits at the client origin, so client coordinates are container ones. */
  clientToLogical(clientX: number, clientY: number, out?: Vec2): Vec2 {
    return clientToLogical(this.rect, this.logicalWidth, this.logicalHeight, clientX, clientY, out);
  }

  logicalToClient(x: number, y: number, out?: Vec2): Vec2 {
    return logicalToClient(this.rect, this.logicalWidth, this.logicalHeight, x, y, out);
  }

  containsLogical(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.logicalWidth && p.y <= this.logicalHeight;
  }

  setFrame(frame: Rect | null): void {
    const f = this.frame;
    if (
      f === frame ||
      (f &&
        frame &&
        f.x === frame.x &&
        f.y === frame.y &&
        f.width === frame.width &&
        f.height === frame.height)
    )
      return;
    this.frame = frame
      ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
      : null;
    this.layout();
  }

  layout(): void {
    const cw = this.containerW;
    const ch = this.containerH;
    this.fitRect = computeLetterbox(cw, ch, this.logicalWidth, this.logicalHeight);
    const fr = this.frame;
    const w = fr ? Math.max(1, Math.min(fr.width, cw)) : cw;
    const h = fr ? Math.max(1, Math.min(fr.height, ch)) : ch;
    let rect = fr ? computeLetterbox(w, h, this.logicalWidth, this.logicalHeight) : this.fitRect;
    if (fr) rect = { ...rect, x: rect.x + fr.x, y: rect.y + fr.y };
    const bb = computeBackbuffer(rect.width, rect.height, 1, this.maxDpr, this.maxPixels);
    const r = this.rect;
    const b = this.backbuffer;
    if (
      rect.x === r.x &&
      rect.y === r.y &&
      rect.width === r.width &&
      rect.height === r.height &&
      bb.width === b.width &&
      bb.height === b.height
    )
      return;
    this.rect = rect;
    this.backbuffer = bb;
    const size = { rect, backbuffer: bb };
    for (const fn of this.listeners) fn(size);
  }

  destroy(): void {
    this.listeners.clear();
  }
}

/** The error a DOM-only member throws with `overlay: false`. */
export const NO_DOM = (what: string): string =>
  `${what}: this game was created with \`overlay: false\`, which has no overlay and no DOM`;
