/**
 * A canvas text atlas: strings rasterised once with `CanvasRenderingContext2D.fillText` into
 * one square canvas, packed on shelves, cached by text and style, with least-recently-used
 * eviction when the canvas is full. No GPU and no DOM beyond the canvas itself: the owner
 * uploads `canvas` when `dirty` is set (`Billboards` does it once per frame at most).
 */

/** How a string is drawn into the atlas. Colours are CSS colour strings (the canvas's). */
export interface TextStyle {
  /** CSS font family (and weight), e.g. `'bold sans-serif'`. Default: the atlas's font. */
  font?: string;
  /** Font size in atlas px. Default 32. */
  size?: number;
  /** Fill colour. Default `'#fff'`. */
  color?: string;
  /** Outline colour; none when unset. */
  stroke?: string;
  /** Outline width in atlas px. Default 0 (none even with `stroke`). */
  strokeWidth?: number;
  /** Transparent px kept around the glyphs on every side. Default 2. */
  padding?: number;
}

/**
 * A rectangle of the atlas: the uv rect to sample (`u0, v0` top left, `u1, v1` bottom right, v
 * down as in the canvas) and its size in atlas px, for a billboard's aspect ratio.
 */
export interface AtlasRegion {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Size in atlas px. */
  width: number;
  height: number;
}

/** The subset of the canvas 2D context the atlas draws with (so tests can stub it). */
export interface AtlasContext2D {
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/** The canvas the atlas draws into: an `OffscreenCanvas`, an `HTMLCanvasElement` or a stub. */
export interface AtlasCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): AtlasContext2D | null;
}

export interface TextAtlasOptions {
  /** Canvas side in px (square). Default 1024. */
  size?: number;
  /** Default font family for styles without one. Default `'sans-serif'`. */
  font?: string;
  /**
   * The canvas to draw into. Default: an `OffscreenCanvas` when the platform has one, else a
   * `document.createElement('canvas')`. Tests pass a stub with a fake 2D context.
   */
  canvas?: AtlasCanvas;
}

/** One cached string: its region plus the bookkeeping for packing and eviction. */
class Entry implements AtlasRegion {
  u0 = 0;
  v0 = 0;
  u1 = 0;
  v1 = 0;
  width = 0;
  height = 0;
  /** Atlas px of the top-left corner. */
  x = 0;
  y = 0;
  /** `TextAtlas.tick` when last requested or touched. */
  lastUsed = 0;
  shelf: Shelf | null = null;
  key = '';
  /** An owned cell's resolved style (`TextAtlas.cell`); null for a cached string. */
  style: Resolved | null = null;
}

/** A `TextStyle` with every default applied. */
interface Resolved {
  font: string;
  size: number;
  color: string;
  stroke: string;
  sw: number;
  pad: number;
}

/** An owned cell's width is rounded up to this many atlas px, headroom for `rewrite`. */
const CELL_STEP = 32;

/** A row of the canvas: fixed height, entries packed left to right. */
class Shelf {
  /** Next free x. */
  used = 0;
  readonly entries: Entry[] = [];
  constructor(
    readonly y: number,
    readonly height: number,
  ) {}
}

function makeCanvas(size: number): AtlasCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  }
  throw new Error('TextAtlas: no canvas available (pass `canvas`)');
}

/**
 * Text rendered once into a canvas and shared by every quad that shows it. `text(text, style)`
 * returns the cached `AtlasRegion` or rasterises and packs a new one; when the canvas is full the
 * least recently used shelf is cleared and reused. Read `dirty` and `canvas` to upload, then
 * call `markUploaded()`.
 */
export class TextAtlas {
  readonly size: number;
  readonly canvas: AtlasCanvas;
  /** The canvas has text the GPU has not seen yet. */
  dirty = false;
  /** Strings currently cached. */
  count = 0;
  /** Evictions so far (shelves cleared because the canvas was full). */
  evictions = 0;
  private readonly ctx: AtlasContext2D;
  private readonly font: string;
  private readonly cache = new Map<string, Entry>();
  private readonly shelves: Shelf[] = [];
  /** Next free y for a new shelf. */
  private top = 0;
  private tick = 0;
  /** Owned cells made so far (their cache keys). */
  private cells = 0;

  constructor(opts: TextAtlasOptions = {}) {
    this.size = Math.max(16, Math.floor(opts.size ?? 1024));
    this.font = opts.font ?? 'sans-serif';
    this.canvas = opts.canvas ?? makeCanvas(this.size);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('TextAtlas: no 2d context');
    this.ctx = ctx;
  }

  /** Atlas px in use, as a share of the canvas (shelf area, 0..1). */
  get used(): number {
    let area = 0;
    for (const s of this.shelves) area += s.used * s.height;
    return area / (this.size * this.size);
  }

  /**
   * The region for `text` in `style`: cached, or rasterised now. Returns `null` only when the
   * string is wider or taller than the whole canvas.
   */
  text(text: string, style: TextStyle = {}): AtlasRegion | null {
    const r = this.resolve(style);
    const key = `${text}\u0001${r.font}\u0001${r.size}\u0001${r.color}\u0001${r.stroke}\u0001${r.sw}\u0001${r.pad}`;
    this.tick++;
    const hit = this.cache.get(key);
    if (hit) {
      hit.lastUsed = this.tick;
      return hit;
    }
    const w = this.measure(text, r);
    const h = this.lineHeight(r);
    if (w > this.size || h > this.size) return null;
    const e = this.make(key, w, h);
    this.draw(e, text, r);
    return e;
  }

  /**
   * An **owned** cell for text that changes (ws/fx-4): not shared through the cache, its width
   * rounded up for headroom, the region covering the whole cell with `text` centred in it.
   * Change its text with `rewrite`; `release` it when done. Evicted like any string when the
   * canvas is full and it is the least recently used (`touch` keeps it). Returns `null` only
   * when the text is larger than the whole canvas.
   */
  cell(text: string, style: TextStyle = {}): AtlasRegion | null {
    return this.makeCell(text, this.resolve(style));
  }

  /** The size in atlas px `cell(text, style)` would get, without placing anything. */
  cellSize(text: string, style: TextStyle = {}): { width: number; height: number } {
    const r = this.resolve(style);
    const tw = this.measure(text, r);
    return {
      width: Math.min(this.size, Math.ceil(tw / CELL_STEP) * CELL_STEP),
      height: this.lineHeight(r),
    };
  }

  /**
   * Redraw an owned cell with `text`, in place (the same region object, nothing allocated) when
   * it fits the cell, else in a new wider cell (the old one released). Also a new cell when
   * `cell` was evicted since. Returns `null` when the text is larger than the whole canvas.
   */
  rewrite(cell: AtlasRegion, text: string): AtlasRegion | null {
    const e = cell as Entry;
    if (!e.style) throw new Error('TextAtlas.rewrite: not an owned cell (use `cell`)');
    const r = e.style;
    this.tick++;
    if (this.has(e) && this.measure(text, r) <= e.width) {
      e.lastUsed = this.tick;
      this.draw(e, text, r);
      return e;
    }
    this.release(e);
    return this.makeCell(text, r);
  }

  /** Give back an owned cell (a no-op for a cached string or one already released/evicted). */
  release(cell: AtlasRegion): void {
    const e = cell as Entry;
    if (!e.style || !this.has(e)) return;
    this.cache.delete(e.key);
    const s = e.shelf!;
    const at = s.entries.indexOf(e);
    if (at >= 0) s.entries.splice(at, 1);
    this.ctx.clearRect(e.x, e.y, e.width, e.height);
    this.recycle(e);
    this.count--;
    this.dirty = true;
  }

  /** Mark `region` as used now, so a live quad's text is not the first evicted. */
  touch(region: AtlasRegion): void {
    (region as Entry).lastUsed = this.tick;
  }

  /** Is `region` still what it was made for (not evicted since)? */
  has(region: AtlasRegion): boolean {
    const e = region as Entry;
    return e.shelf !== null && this.cache.get(e.key) === e;
  }

  /** The owner uploaded `canvas`. */
  markUploaded(): void {
    this.dirty = false;
  }

  /** Forget every string and clear the canvas. */
  clear(): void {
    for (const e of this.cache.values()) this.recycle(e);
    this.cache.clear();
    this.shelves.length = 0;
    this.top = 0;
    this.count = 0;
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.dirty = true;
  }

  private resolve(style: TextStyle): Resolved {
    const stroke = style.stroke ?? '';
    return {
      font: style.font ?? this.font,
      size: style.size ?? 32,
      color: style.color ?? '#fff',
      stroke,
      sw: stroke ? (style.strokeWidth ?? 0) : 0,
      pad: style.padding ?? 2,
    };
  }

  private measure(text: string, r: Resolved): number {
    this.ctx.font = `${r.size}px ${r.font}`;
    return Math.ceil(this.ctx.measureText(text).width + 2 * r.pad + r.sw);
  }

  private lineHeight(r: Resolved): number {
    return Math.ceil(r.size * 1.25 + 2 * r.pad + r.sw);
  }

  private makeCell(text: string, r: Resolved): Entry | null {
    const h = this.lineHeight(r);
    const tw = this.measure(text, r);
    if (tw > this.size || h > this.size) return null;
    const w = Math.min(this.size, Math.ceil(tw / CELL_STEP) * CELL_STEP);
    const e = this.make(`\u0002cell#${this.cells++}`, w, h);
    e.style = r;
    this.draw(e, text, r);
    return e;
  }

  /** Place, size and cache a `w × h` entry under `key`. */
  private make(key: string, w: number, h: number): Entry {
    const e = this.place(w, h);
    e.key = key;
    e.lastUsed = this.tick;
    e.width = w;
    e.height = h;
    const inv = 1 / this.size;
    e.u0 = e.x * inv;
    e.v0 = e.y * inv;
    e.u1 = (e.x + w) * inv;
    e.v1 = (e.y + h) * inv;
    this.cache.set(key, e);
    this.count++;
    return e;
  }

  /** Clear `e`'s rect and draw `text` centred in it. */
  private draw(e: Entry, text: string, r: Resolved): void {
    const ctx = this.ctx;
    ctx.clearRect(e.x, e.y, e.width, e.height);
    ctx.font = `${r.size}px ${r.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    if (r.sw > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = r.sw;
      ctx.strokeStyle = r.stroke;
      ctx.strokeText(text, cx, cy);
    }
    ctx.fillStyle = r.color;
    ctx.fillText(text, cx, cy);
    this.dirty = true;
  }

  /** Find or make room for a `w × h` rect: a fitting shelf, a new shelf, or an evicted one. */
  private place(w: number, h: number): Entry {
    const fit = this.fit(w, h);
    if (fit) return this.alloc(fit, w, h);
    if (this.top + h <= this.size) {
      const s = new Shelf(this.top, h);
      this.top += h;
      this.shelves.push(s);
      return this.alloc(s, w, h);
    }
    // Full: clear least-recently-used shelves until one fits.
    for (;;) {
      let victim: Shelf | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const s of this.shelves) {
        if (s.height < h || s.entries.length === 0) continue;
        let newest = 0;
        for (const e of s.entries) if (e.lastUsed > newest) newest = e.lastUsed;
        if (newest < oldest) {
          oldest = newest;
          victim = s;
        }
      }
      if (!victim) {
        // No shelf is tall enough: start over.
        this.clear();
        const s = new Shelf(0, h);
        this.top = h;
        this.shelves.push(s);
        return this.alloc(s, w, h);
      }
      this.evict(victim);
      if (victim.used + w <= this.size) return this.alloc(victim, w, h);
    }
  }

  private fit(w: number, h: number): Shelf | null {
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.height >= h && s.used + w <= this.size && (!best || s.height < best.height)) best = s;
    }
    return best;
  }

  private alloc(s: Shelf, w: number, h: number): Entry {
    // A fresh object per string: an evicted region stays stale (`has` is false) rather than
    // silently becoming another string's rect. Eviction is rare, never per frame.
    const e = new Entry();
    e.x = s.used;
    e.y = s.y;
    e.shelf = s;
    s.used += w;
    s.entries.push(e);
    this.ctx.clearRect(e.x, e.y, w, h);
    return e;
  }

  private evict(s: Shelf): void {
    for (const e of s.entries) {
      this.cache.delete(e.key);
      this.recycle(e);
      this.count--;
    }
    s.entries.length = 0;
    s.used = 0;
    this.ctx.clearRect(0, s.y, this.size, s.height);
    this.evictions++;
    this.dirty = true;
  }

  private recycle(e: Entry): void {
    e.shelf = null;
  }
}
