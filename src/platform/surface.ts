import {
  type BackbufferSize,
  clientToLogical,
  computeBackbuffer,
  computeFillWidth,
  computeLetterbox,
  type FillWidthOptions,
  type Letterbox,
  logicalToClient,
  type Vec2,
} from './letterbox';

export interface SurfaceOptions {
  /** Logical design width. Default 1920. */
  logicalWidth?: number;
  /** Logical design height. Default 1080. */
  logicalHeight?: number;
  /** Cap on devicePixelRatio. Default 2. */
  maxDpr?: number;
  /** Cap on drawing-buffer pixel count. Default 2560×1440. */
  maxPixels?: number;
  /** CSS colour of the letterbox bars (the container background). Default near-black ink. */
  barColor?: string;
}

export interface SurfaceSize {
  /** Letterboxed rect in CSS px relative to the container. */
  rect: Letterbox;
  /** Drawing-buffer size in physical pixels. */
  backbuffer: BackbufferSize;
}

/**
 * A canvas mounted in a container, letterboxed to a fixed logical aspect, DPR-aware.
 * Owns the canvas element and keeps its CSS box + drawing buffer in sync with the container.
 *
 * Other systems (input, DOM overlay) hook in via `rect`, `onResize` and `clientToLogical`.
 */
export class Surface {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  /** Letterboxed rect, CSS px, relative to `root`. Updated in place on resize. */
  rect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  /** The plain contain fit for the current container (what `rect` is unless a fill is set). */
  fitRect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  backbuffer: BackbufferSize = { width: 1, height: 1, pixelRatio: 1 };

  private fill: FillWidthOptions | null = null;
  private frame: { x: number; y: number; width: number; height: number } | null = null;
  private readonly maxDpr: number;
  private readonly maxPixels: number;
  private readonly listeners = new Set<(size: SurfaceSize) => void>();
  private readonly ro: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = () => {
    this.watchDpr();
    this.layout();
  };
  private readonly onWindowResize = () => this.layout();

  constructor(root: HTMLElement, opts: SurfaceOptions = {}) {
    this.root = root;
    this.logicalWidth = opts.logicalWidth ?? 1920;
    this.logicalHeight = opts.logicalHeight ?? 1080;
    this.maxDpr = opts.maxDpr ?? 2;
    this.maxPixels = opts.maxPixels ?? 2560 * 1440;

    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.style.overflow = 'hidden';
    if (opts.barColor) root.style.background = opts.barColor;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0; // focusable so key handling can be scoped to the game (itch iframe)
    canvas.style.outline = 'none';
    canvas.setAttribute('aria-label', 'Game view');
    root.appendChild(canvas);
    this.canvas = canvas;

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(root);
    window.addEventListener('resize', this.onWindowResize);
    this.watchDpr();
    this.layout();
  }

  /** Subscribe to size changes. Called immediately with the current size. Returns unsubscribe. */
  onResize(fn: (size: SurfaceSize) => void): () => void {
    this.listeners.add(fn);
    fn({ rect: this.rect, backbuffer: this.backbuffer });
    return () => this.listeners.delete(fn);
  }

  /**
   * Convert viewport coordinates (e.g. `PointerEvent.clientX/Y`) to logical design space.
   * Pass `out` to avoid allocation in hot paths.
   */
  clientToLogical(clientX: number, clientY: number, out?: Vec2): Vec2 {
    const r = this.root.getBoundingClientRect();
    return clientToLogical(
      this.rect,
      this.logicalWidth,
      this.logicalHeight,
      clientX - r.left,
      clientY - r.top,
      out,
    );
  }

  /** Convert logical coordinates to viewport coordinates (CSS px, same space as clientX/Y). */
  logicalToClient(x: number, y: number, out?: Vec2): Vec2 {
    const r = this.root.getBoundingClientRect();
    const p = logicalToClient(this.rect, this.logicalWidth, this.logicalHeight, x, y, out);
    p.x += r.left;
    p.y += r.top;
    return p;
  }

  /** True if a logical point is inside the design space. */
  containsLogical(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.logicalWidth && p.y <= this.logicalHeight;
  }

  /**
   * Fill the width and crop top and bottom (`computeFillWidth`; with `minVisibleWidth`, a tall
   * container or frame fills its height and crops the sides), or `null` for the plain letterbox. Lays out again at once if the result changes.
   */
  setFill(fill: FillWidthOptions | null): void {
    const f = this.fill;
    if (
      f === fill ||
      (f &&
        fill &&
        f.minVisible === fill.minVisible &&
        f.focusY === fill.focusY &&
        f.minVisibleWidth === fill.minVisibleWidth &&
        f.focusX === fill.focusX)
    )
      return;
    this.fill = fill ? { ...fill } : null;
    this.layout();
  }

  /**
   * Keep the canvas inside a part of the container (CSS px, relative to `root`), e.g. the
   * world's region of a layout (`Layout.freeRect`) when UI regions take the rest of the screen.
   * The letterbox and fill are computed inside it; `null` (the default) uses the whole
   * container. `fitRect` is always the whole container's fit, so device-mode decisions do not
   * depend on the frame. Lays out again at once if the result changes.
   */
  setFrame(frame: { x: number; y: number; width: number; height: number } | null): void {
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

  /** Force a re-layout (e.g. after fullscreen toggles). */
  layout(): void {
    const cw = this.root.clientWidth;
    const ch = this.root.clientHeight;
    this.fitRect = computeLetterbox(cw, ch, this.logicalWidth, this.logicalHeight);
    const fr = this.frame;
    const w = fr ? Math.max(1, Math.min(fr.width, cw)) : cw;
    const h = fr ? Math.max(1, Math.min(fr.height, ch)) : ch;
    let rect = this.fill
      ? computeFillWidth(w, h, this.logicalWidth, this.logicalHeight, this.fill)
      : fr
        ? computeLetterbox(w, h, this.logicalWidth, this.logicalHeight)
        : this.fitRect;
    if (fr) rect = { ...rect, x: rect.x + fr.x, y: rect.y + fr.y };
    const bb = computeBackbuffer(
      rect.width,
      rect.height,
      window.devicePixelRatio,
      this.maxDpr,
      this.maxPixels,
    );
    const same =
      rect.x === this.rect.x &&
      rect.y === this.rect.y &&
      rect.width === this.rect.width &&
      rect.height === this.rect.height &&
      bb.width === this.backbuffer.width &&
      bb.height === this.backbuffer.height;
    if (same) return;
    this.rect = rect;
    this.backbuffer = bb;
    const s = this.canvas.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.canvas.width = bb.width;
    this.canvas.height = bb.height;
    const size = { rect, backbuffer: bb };
    for (const fn of this.listeners) fn(size);
  }

  destroy(): void {
    this.ro.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.listeners.clear();
    this.canvas.remove();
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }
}

export function mountSurface(root: HTMLElement, opts?: SurfaceOptions): Surface {
  return new Surface(root, opts);
}
