import {
  type BackbufferSize,
  type CoverOptions,
  clientToLogical,
  computeBackbuffer,
  computeCover,
  computeLetterbox,
  type Letterbox,
  type LetterboxRect,
  logicalToClient,
  type Vec2,
  visibleLogicalRect,
} from './letterbox';

/**
 * How the design fits the container (or the frame given to `setFrame`). `'contain'` (the
 * default) letterboxes: the whole design shows, with bars. `'cover'` fills the frame and crops
 * the design; `CoverOptions` is cover with a band that must stay on screen (`'cover'` is `{}`).
 * `'fill'` (ws/kit-fit) has no design size: the canvas is the whole frame, no bars and no crop,
 * and the logical size is the frame's size in CSS px (a 3D game, or one that lays out its own
 * screen).
 */
export type SurfaceFit = 'contain' | 'cover' | 'fill' | CoverOptions;

export interface SurfaceOptions {
  /** Logical design width. Default 1920. */
  logicalWidth?: number;
  /** Logical design height. Default 1080. */
  logicalHeight?: number;
  /** Cap on devicePixelRatio. Default 2. */
  maxDpr?: number;
  /**
   * Cap on drawing-buffer pixel count. Default 2560×1440; under `fit: 'fill'` none (only
   * `maxDpr` caps the buffer, as `computeBackbuffer` does: a game that fills the window scales
   * its own resolution).
   */
  maxPixels?: number;
  /** CSS colour of the letterbox bars (the container background). Default near-black ink. */
  barColor?: string;
  /**
   * How the design fits: `'contain'` (default, letterbox), a cover fit that fills the frame
   * and crops the design to a band (#1), or `'fill'`: the whole frame with no design size
   * (`logicalWidth` / `logicalHeight` then follow the frame in CSS px). Change it later with
   * `Surface.setFit`.
   */
  fit?: SurfaceFit;
}

export interface SurfaceSize {
  /** The canvas rect in CSS px relative to the container (past it under a cover fit). */
  rect: Letterbox;
  /** Drawing-buffer size in physical pixels. */
  backbuffer: BackbufferSize;
}

/**
 * What a surface is to the engine (ws/platform-surface): a letterboxed logical design space, the
 * drawing-buffer size, and the resize events and coordinate maps over them. `EngineCtx.surface`,
 * `BootResult.surface` and `mountSurface` are typed with it.
 *
 * `new Surface(root, opts)` (the DOM canvas below) implements it, and so can anything else with
 * these members, with no cast: core's no-DOM surface (`createGame({ overlay: false })`) and a
 * game's own surface. A surface with no DOM throws from `root` and `canvas`.
 */
export interface Surface {
  /** The container the canvas letterboxes in. */
  readonly root: HTMLElement;
  /** The canvas the renderer draws to. */
  readonly canvas: HTMLCanvasElement;
  /** Logical design width (under `fit: 'fill'`, the frame's width in CSS px). */
  readonly logicalWidth: number;
  /** Logical design height (under `fit: 'fill'`, the frame's height in CSS px). */
  readonly logicalHeight: number;
  /**
   * The canvas rect, CSS px, relative to `root`: the letterbox, or under a cover fit a rect that
   * overflows the frame (negative `x` / `y`). Replaced on resize.
   */
  rect: Letterbox;
  /** The plain contain fit for the whole container (what `rect` is unless a frame is set). */
  fitRect: Letterbox;
  /** Drawing-buffer size in device px, and the pixel ratio used. */
  backbuffer: BackbufferSize;
  /** Subscribe to size changes. Called immediately with the current size. Returns unsubscribe. */
  onResize(fn: (size: SurfaceSize) => void): () => void;
  /** Viewport coordinates (e.g. `PointerEvent.clientX/Y`) to logical design space. */
  clientToLogical(clientX: number, clientY: number, out?: Vec2): Vec2;
  /** Logical coordinates to viewport coordinates (CSS px, same space as clientX/Y). */
  logicalToClient(x: number, y: number, out?: Vec2): Vec2;
  /** True if a logical point is inside the design space (under a cover fit, its visible part). */
  containsLogical(p: Vec2): boolean;
  /** Letterbox inside a part of the container (CSS px, relative to `root`); `null` is all of it. */
  setFrame(frame: { x: number; y: number; width: number; height: number } | null): void;
  /**
   * The part of the design on screen, in logical units: all of it under `'contain'`; under a
   * cover fit, the canvas clipped to the frame and the container. Optional on the interface (a
   * game's own surface may leave it out); the DOM surface always has it.
   */
  readonly visibleRect?: Readonly<LetterboxRect>;
  /**
   * Switch the fit (`SurfaceOptions.fit`) and lay out again, e.g. a per-scene band. Optional on
   * the interface; the DOM surface always has it.
   */
  setFit?(fit: SurfaceFit): void;
  /** Force a re-layout (e.g. after fullscreen toggles). */
  layout(): void;
  /** Stop listening and release what the surface owns. */
  destroy(): void;
}

/**
 * A canvas mounted in a container, letterboxed to a fixed logical aspect, DPR-aware.
 * Owns the canvas element and keeps its CSS box + drawing buffer in sync with the container.
 *
 * Other systems (input, DOM overlay) hook in via `rect`, `onResize` and `clientToLogical`.
 * Exported as the value `Surface`; its private state stays off the `Surface` type.
 */
class DomSurface implements Surface {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The design size the options gave (what contain and cover fit, and `fitRect` measures). */
  private readonly designW: number;
  private readonly designH: number;
  /** The logical size: the design's, or the frame's under `'fill'`. */
  private lw: number;
  private lh: number;
  /** The canvas rect, CSS px, relative to `root` (see `Surface.rect`). Replaced on resize. */
  rect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  /** The plain contain fit for the whole container (what `rect` is unless a frame is set). */
  fitRect: Letterbox = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  backbuffer: BackbufferSize = { width: 1, height: 1, pixelRatio: 1 };

  private frame: { x: number; y: number; width: number; height: number } | null = null;
  /** The cover band, or null to letterbox (or fill). */
  private cover: CoverOptions | null = null;
  /** `fit: 'fill'`: the canvas is the frame, the logical size its CSS size. */
  private fill = false;
  private readonly visible: LetterboxRect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly clip: LetterboxRect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly maxDpr: number;
  /** `SurfaceOptions.maxPixels`, or undefined for the fit's default. */
  private readonly maxPixelsOpt: number | undefined;
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
    this.designW = opts.logicalWidth ?? 1920;
    this.designH = opts.logicalHeight ?? 1080;
    this.lw = this.designW;
    this.lh = this.designH;
    this.maxDpr = opts.maxDpr ?? 2;
    this.maxPixelsOpt = opts.maxPixels;
    this.cover = coverOf(opts.fit);
    this.fill = opts.fit === 'fill';

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

  /** Logical width: the design's, or the frame's CSS width under `fit: 'fill'`. */
  get logicalWidth(): number {
    return this.lw;
  }

  /** Logical height: the design's, or the frame's CSS height under `fit: 'fill'`. */
  get logicalHeight(): number {
    return this.lh;
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

  /** True if a logical point is inside the design space (under a cover fit, its visible part). */
  containsLogical(p: Vec2): boolean {
    const v = this.visible;
    return p.x >= v.x && p.y >= v.y && p.x <= v.x + v.width && p.y <= v.y + v.height;
  }

  /** The part of the design on screen, in logical units (see `Surface.visibleRect`). */
  get visibleRect(): Readonly<LetterboxRect> {
    return this.visible;
  }

  /** Switch the fit and lay out again (see `SurfaceOptions.fit`). */
  setFit(fit: SurfaceFit): void {
    this.cover = coverOf(fit);
    this.fill = fit === 'fill';
    this.layout();
  }

  /**
   * Keep the canvas inside a part of the container (CSS px, relative to `root`), e.g. the
   * world's region of a layout (`Layout.freeRect`) when UI regions take the rest of the screen.
   * The letterbox is computed inside it; `null` (the default) uses the whole
   * container. Under a cover fit the canvas covers the frame instead, and the frame is not
   * clamped to the container (the visible part is clipped to both). `fitRect` is always the whole container's fit, so device-mode decisions do not
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
    // `fitRect` measures the design size under every fit, so device-mode decisions read it alike.
    this.fitRect = computeLetterbox(cw, ch, this.designW, this.designH);
    const fr = this.frame;
    const cover = this.cover;
    let rect: Letterbox;
    const v = this.visible;
    // The design size, or under `'fill'` the frame's (set below).
    const lw = this.designW;
    const lh = this.designH;
    this.lw = lw;
    this.lh = lh;
    if (this.fill) {
      // The whole frame (clamped to the container, like the letterbox's), one logical unit per
      // CSS px: no bars, nothing cropped.
      const w = fr ? Math.max(1, Math.min(fr.width, cw)) : cw;
      const h = fr ? Math.max(1, Math.min(fr.height, ch)) : ch;
      rect = { x: fr ? fr.x : 0, y: fr ? fr.y : 0, width: w, height: h, scale: 1 };
      this.lw = w;
      this.lh = h;
      v.x = 0;
      v.y = 0;
      v.width = w;
      v.height = h;
    } else if (
      cover &&
      !(cover.belowScale !== undefined && this.fitRect.scale >= cover.belowScale)
    ) {
      const fw = fr ? Math.max(1, fr.width) : cw;
      const fh = fr ? Math.max(1, fr.height) : ch;
      rect = computeCover(fw, fh, lw, lh, cover);
      if (fr) rect = { ...rect, x: rect.x + fr.x, y: rect.y + fr.y };
      // What shows: the canvas inside the frame, inside the container.
      const c = this.clip;
      c.x = Math.max(0, fr ? fr.x : 0);
      c.y = Math.max(0, fr ? fr.y : 0);
      c.width = Math.min(cw, fr ? fr.x + fw : cw) - c.x;
      c.height = Math.min(ch, fr ? fr.y + fh : ch) - c.y;
      visibleLogicalRect(rect, c, lw, lh, v);
    } else {
      const w = fr ? Math.max(1, Math.min(fr.width, cw)) : cw;
      const h = fr ? Math.max(1, Math.min(fr.height, ch)) : ch;
      rect = fr ? computeLetterbox(w, h, lw, lh) : this.fitRect;
      if (fr) rect = { ...rect, x: rect.x + fr.x, y: rect.y + fr.y };
      v.x = 0;
      v.y = 0;
      v.width = lw;
      v.height = lh;
    }
    const bb = computeBackbuffer(
      rect.width,
      rect.height,
      window.devicePixelRatio,
      this.maxDpr,
      this.maxPixelsOpt ?? (this.fill ? Number.POSITIVE_INFINITY : DEFAULT_MAX_PIXELS),
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

/** `SurfaceFit` as the cover band the layout reads, or null for the letterbox. */
/** `SurfaceOptions.maxPixels`' default outside `fit: 'fill'`. */
const DEFAULT_MAX_PIXELS = 2560 * 1440;

function coverOf(fit: SurfaceFit | undefined): CoverOptions | null {
  if (fit === undefined || fit === 'contain' || fit === 'fill') return null;
  return fit === 'cover' ? {} : { ...fit };
}

/**
 * The DOM surface's constructor: `new Surface(root, opts)` mounts a letterboxed canvas in
 * `root`. A class may extend it.
 */
export const Surface: {
  new (root: HTMLElement, opts?: SurfaceOptions): Surface;
  readonly prototype: Surface;
} = DomSurface;

export function mountSurface(root: HTMLElement, opts?: SurfaceOptions): Surface {
  return new Surface(root, opts);
}
