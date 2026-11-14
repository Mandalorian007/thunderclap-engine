/**
 * One layout for every panel (ws/ui-spec, from Forge Wilds' `ui/spec/layout/boxes.ts`): a compiled
 * spec, the frame it is laid out in and its model in; flat boxes out. Pure arithmetic: text never
 * sizes a box (each text is its lines times its line height), so the boxes are the same in Node,
 * on the page and in a world presenter, and CI holds them. It runs in two passes over typed
 * arrays, natural sizes bottom-up and boxes top-down, with nothing allocated: on open, on a frame
 * change and when the model says a box moved (`SpecModel.relayout`), never on a value change and
 * never on a scroll.
 *
 * A list's row is laid out once, in the coordinates of its own cell (row 0's): the presenter puts
 * row i at its cell inside a real scroller, so the number of boxes doesn't grow with the rows.
 * Boxes are Float64, and shares of free length are cut to 1/64 px, the page's own layout unit.
 */

import type { CompiledSpec } from './compile';
import type { SpecModel } from './model';
import {
  A_CENTER,
  A_END,
  A_STRETCH,
  cut,
  K_COL,
  K_GRID,
  K_ICON,
  K_LIST,
  K_METER,
  K_ROW,
  K_SLOT,
  K_TABS,
  K_TEXT,
  type Measure,
  MIN_TARGET,
  TERM_GAP,
  TERM_MIN,
  typeMeasure,
} from './units';
import type { SpecTextStyle } from './words';

/**
 * A panel's boxes: each node's x, y, width and height (units; a list row's
 * nodes in their cell's coordinates, the rest in the panel's), and whether
 * it is shown. Lists also have their content height, their cells' width,
 * their rows' count (at layout) and their scroll.
 */
export class SpecBoxes {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly w: Float64Array;
  readonly h: Float64Array;
  readonly on: Uint8Array;
  /** A text's line height (units, at this text scale). */
  readonly lineH: Float64Array;
  /** A list's or a scroll col's content height (a scroll col's: its children's, its natural height); a list's cell width, its row height (its `rowH`, or its row's own height if taller: larger text) and its rows' count. */
  readonly content: Float64Array;
  readonly cellW: Float64Array;
  readonly rowH: Float64Array;
  /** A list's headings' height (0: none). */
  readonly headH: Float64Array;
  readonly rows: Int32Array;
  /** A list's or a scroll col's scroll (units): the world presenter's own; on screens the page scrolls (its presenter says it here). */
  readonly scroll: Float64Array;
  /** The natural sizes (layout's scratch). */
  readonly nw: Float64Array;
  readonly nh: Float64Array;
  /** A text's lines (a wrap text's: as measured), and a wrap text's term column (units; 0: none). */
  readonly lines: Uint16Array;
  readonly termW: Float64Array;
  /** The type a wrap text's lines are counted in: the presenter's (it sets its type), else its style's (`typeMeasure`). */
  measure: Measure = typeMeasure;
  /** Layouts run (for the budgets), and wrap texts measured. */
  runs = 0;
  measured = 0;
  /** `hit`'s row: the index in its list of the row hit, or -1. */
  hitRow = -1;
  private readonly c: CompiledSpec;
  private readonly model: SpecModel;
  /** Each list's tops (`tops`), by ordinal, and what they were summed for: its keys' generation, row and heading heights. */
  private readonly topsOf: (Float64Array | null)[];
  private readonly topsGen: Float64Array;
  private readonly topsRowH: Float64Array;
  private readonly topsHeadH: Float64Array;
  /** What each wrap text was last measured for (its words, width, line height and measure). */
  private readonly wrapText: (string | null)[];
  private readonly wrapW: Float64Array;
  private readonly wrapLH: Float64Array;
  private wrapBy: Measure | null = null;

  constructor(c: CompiledSpec, model: SpecModel) {
    const n = c.n;
    this.c = c;
    this.model = model;
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.w = new Float64Array(n);
    this.h = new Float64Array(n);
    this.on = new Uint8Array(n);
    this.lineH = new Float64Array(n);
    this.content = new Float64Array(n);
    this.cellW = new Float64Array(n);
    this.rowH = new Float64Array(n);
    this.headH = new Float64Array(n);
    this.rows = new Int32Array(n);
    this.scroll = new Float64Array(n);
    this.nw = new Float64Array(n);
    this.nh = new Float64Array(n);
    this.lines = new Uint16Array(n);
    for (let i = 0; i < n; i++) this.lines[i] = c.lines[i]!;
    this.termW = new Float64Array(n);
    this.wrapText = new Array<string | null>(n).fill(null);
    this.wrapW = new Float64Array(n).fill(-1);
    this.wrapLH = new Float64Array(n).fill(-1);
    const lists = c.listNodes.length;
    this.topsOf = new Array<Float64Array | null>(lists).fill(null);
    this.topsGen = new Float64Array(lists).fill(-1);
    this.topsRowH = new Float64Array(lists);
    this.topsHeadH = new Float64Array(lists);
  }

  /**
   * Where each row of one-column list `list` stands in its content (units,
   * by index; the content's height at [count]): a heading's key ("#…") is
   * its `headH` high, a row its `rowH`, with the gap between. Summed again
   * only when the keys or heights changed since (allocating only to grow).
   */
  tops(list: number): Float64Array {
    const c = this.c;
    const o = c.listOrd[list]!;
    const l = this.model.lists[o]!;
    const rowH = this.rowH[list]!;
    const headH = this.headH[list]!;
    let t = this.topsOf[o]!;
    if (
      t !== null &&
      this.topsGen[o] === l.gen &&
      this.topsRowH[o] === rowH &&
      this.topsHeadH[o] === headH &&
      t.length > l.keys.length
    )
      return t;
    const keys = l.keys;
    const n = keys.length;
    if (t === null || t.length <= n) {
      t = new Float64Array(Math.max(16, (n + 1) * 2));
      this.topsOf[o] = t;
    }
    const gap = c.gap[list]!;
    const heads = c.head[list] !== -1;
    let y = 0;
    for (let i = 0; i < n; i++) {
      t[i] = y;
      y += (heads && keys[i]!.charCodeAt(0) === 35 ? headH : rowH) + gap;
    }
    t[n] = n > 0 ? y - gap : 0;
    this.topsGen[o] = l.gen;
    this.topsRowH[o] = rowH;
    this.topsHeadH[o] = headH;
    return t;
  }

  /** The index of the row of one-column list `list` at `y` in its content (by `tops`), or -1 past its end. */
  rowAt(list: number, y: number): number {
    const t = this.tops(list);
    const n = this.model.lists[this.c.listOrd[list]!]!.keys.length;
    if (y < 0 || y >= t[n]!) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * What a press at (x, y) (panel units) lands on: the topmost shown
   * pressable node, or -1; `hitRow` is its row in its list (-1 outside one).
   */
  hit(px: number, py: number): number {
    const c = this.c;
    const p = c.pressables;
    for (let j = p.length - 1; j >= 0; j--) {
      const i = p[j]!;
      if (this.on[i] === 0) continue;
      // In a scroll col: only inside its box, moved by its scroll.
      const sc = c.scroller[i]!;
      let y = py;
      if (sc !== -1) {
        if (
          px < this.x[sc]! ||
          px >= this.x[sc]! + this.w[sc]! ||
          py < this.y[sc]! ||
          py >= this.y[sc]! + this.h[sc]!
        )
          continue;
        y = py + this.scroll[sc]!;
      }
      const x = px;
      const list = c.inList[i]!;
      if (list === -1) {
        if (
          x >= this.x[i]! &&
          x < this.x[i]! + this.w[i]! &&
          y >= this.y[i]! &&
          y < this.y[i]! + this.h[i]!
        ) {
          this.hitRow = -1;
          return i;
        }
        continue;
      }
      if (this.on[list] === 0) continue;
      const lx = x - this.x[list]!;
      const ly = y - this.y[list]!;
      if (lx < 0 || ly < 0 || lx >= this.w[list]! || ly >= this.h[list]!) continue;
      const cy = ly + this.scroll[list]!;
      if (c.head[list] !== -1) {
        // Headings among the rows: where each stands is a sum.
        const index = this.rowAt(list, cy);
        if (index === -1) continue;
        const keys = this.model.lists[c.listOrd[list]!]!.keys;
        // A node of the heading's word only in a heading, the row's only in a row.
        const inHead = i >= c.head[list]!;
        if (inHead !== (keys[index]!.charCodeAt(0) === 35)) continue;
        const iy = cy - this.tops(list)[index]!;
        if (
          lx >= this.x[i]! &&
          lx < this.x[i]! + this.w[i]! &&
          iy >= this.y[i]! &&
          iy < this.y[i]! + this.h[i]!
        ) {
          this.hitRow = index;
          return i;
        }
        continue;
      }
      const cols = (c.nodes[list] as { cols?: number }).cols ?? 1;
      const gap = c.gap[list]!;
      const stepX = this.cellW[list]! + gap;
      const stepY = this.rowH[list]! + gap;
      const col = Math.floor(lx / stepX);
      const row = Math.floor(cy / stepY);
      const index = row * cols + col;
      if (col >= cols || index >= this.model.lists[c.listOrd[list]!]!.keys.length) continue;
      const ix = lx - col * stepX;
      const iy = cy - row * stepY;
      if (
        ix >= this.x[i]! &&
        ix < this.x[i]! + this.w[i]! &&
        iy >= this.y[i]! &&
        iy < this.y[i]! + this.h[i]!
      ) {
        this.hitRow = index;
        return i;
      }
    }
    this.hitRow = -1;
    return -1;
  }

  /** Lays the panel out in a frame `w` wide (0: its natural width) (and `h` high, or 0 for its natural height) at text scale `text`. */
  layout(w: number, h: number, text: number): void {
    layoutSpec(this.c, this.model, w, h, text, this);
  }

  /**
   * Counts each shown wrap text's lines at its width now (measured again
   * only when its words, width or line height changed, or the measure):
   * whether a count changed (the layout then runs again).
   */
  rewrap(): boolean {
    const c = this.c;
    const m = this.model;
    const by = this.measure;
    const again = by !== this.wrapBy;
    this.wrapBy = by;
    let changed = false;
    for (let j = 0; j < c.wraps.length; j++) {
      const i = c.wraps[j]!;
      if (this.on[i] === 0) continue;
      const node = c.nodes[i] as {
        text: unknown;
        style: SpecTextStyle;
        term?: string;
        lines?: number;
      };
      const k = c.textKey[i]!;
      const text = k === -1 ? (node.text as string) : String(m.vals[k] ?? '');
      const w = this.w[i]!;
      const lh = this.lineH[i]!;
      if (!again && this.wrapText[i] === text && this.wrapW[i] === w && this.wrapLH[i] === lh)
        continue;
      this.wrapText[i] = text;
      this.wrapW[i] = w;
      this.wrapLH[i] = lh;
      this.measured++;
      let tw = 0;
      let lines = 1;
      const share = c.termW[i]!;
      if (w <= 0) {
        // Not laid out yet (no width): its least.
      } else if (share > 0) {
        tw = Math.min(Math.floor(w / 2), Math.max(TERM_MIN, Math.floor(w * share)));
        lines = Math.max(
          text === '' ? 1 : by(text, node.style, w - tw, lh, i, false),
          by(node.term!, node.style, tw - TERM_GAP, lh, i, true),
        );
      } else if (text !== '') lines = by(text, node.style, w, lh, i, false);
      this.termW[i] = tw;
      lines = Math.max(lines, node.lines ?? 1);
      if (lines !== this.lines[i]) {
        this.lines[i] = lines;
        changed = true;
      }
    }
    return changed;
  }
}

/** Whether node `i` is shown by its own `show` (its ancestors aside). */
function shownSelf(c: CompiledSpec, m: SpecModel, i: number): boolean {
  const k = c.showKey[i]!;
  return k === -1 || m.vals[k] === true;
}

/** A text's lines now: fixed, or its bound key's (a whole number, at least 1, at most 255; 1 until set). */
function linesAt(c: CompiledSpec, m: SpecModel, i: number): number {
  const k = c.linesKey[i]!;
  if (k === -1) return c.lines[i]!;
  const v = m.vals[k];
  return typeof v === 'number' && v >= 1 ? Math.min(255, Math.floor(v)) : 1;
}

/** A list's `maxRows` now: fixed (Infinity: none), or its bound key's (a whole number, at least 1; none until set). */
export function maxRowsAt(c: CompiledSpec, m: SpecModel, i: number): number {
  const k = c.linesKey[i]!;
  if (k === -1) {
    const most = (c.nodes[i] as { maxRows?: number }).maxRows;
    return most ?? Infinity;
  }
  const v = m.vals[k];
  return typeof v === 'number' && v >= 1 ? Math.floor(v) : Infinity;
}

/**
 * Lays `c` out in a frame `frameW` wide (or 0: its natural width; `frameH` high, or 0: its natural
 * height) at text scale `text`, from `m`'s shows and list lengths, into
 * `out`. Allocates nothing.
 */
export function layoutSpec(
  c: CompiledSpec,
  m: SpecModel,
  frameW: number,
  frameH: number,
  text: number,
  out: SpecBoxes,
): void {
  out.runs++;
  layoutOnce(c, m, frameW, frameH, text, out);
  // Wrap texts: laid out at their last counts, counted at their widths, and laid out again if a count changed (widths never follow heights: twice does).
  if (c.wraps.length === 0) return;
  for (let pass = 1; pass < 3 && out.rewrap(); pass++) layoutOnce(c, m, frameW, frameH, text, out);
}

/** One pass of `layout`: natural sizes, then boxes. */
function layoutOnce(
  c: CompiledSpec,
  m: SpecModel,
  frameW: number,
  frameH: number,
  text: number,
  out: SpecBoxes,
): void {
  const n = c.n;
  const { nw, nh } = out;
  const kind = c.kind;
  // Natural sizes, children before parents (pre-order backwards).
  for (let i = n - 1; i >= 0; i--) {
    const fw = c.fw[i]!;
    const fh = c.fh[i]!;
    let w = 0;
    let h = 0;
    const k = kind[i]!;
    if (k === K_COL || k === K_ROW) {
      const across = k === K_ROW;
      let count = 0;
      for (let ch = c.first[i]!; ch !== -1; ch = c.next[ch]!) {
        if (!shownSelf(c, m, ch)) continue;
        count++;
        if (across) {
          w += nw[ch]!;
          if (nh[ch]! > h) h = nh[ch]!;
        } else {
          h += nh[ch]!;
          if (nw[ch]! > w) w = nw[ch]!;
        }
      }
      const gaps = count > 1 ? (count - 1) * c.gap[i]! : 0;
      if (across) w += gaps;
      else h += gaps;
      w += c.padL[i]! + c.padR[i]!;
      h += c.padT[i]! + c.padB[i]!;
      if (c.scrolls[i] === 1) {
        // Its content is its children; growing, it takes what its stack leaves (they scroll in it).
        out.content[i] = h;
        if (c.grow[i]! > 0) h = 0;
      }
    } else if (k === K_GRID) {
      const g = c.nodes[i] as { cols: number; cell: number; cellH?: number };
      let count = 0;
      for (let ch = c.first[i]!; ch !== -1; ch = c.next[ch]!) count++;
      const rows = Math.ceil(count / g.cols);
      const gap = c.gap[i]!;
      w = g.cols * g.cell + (g.cols - 1) * gap;
      h = rows > 0 ? rows * (g.cellH ?? g.cell) + (rows - 1) * gap : 0;
    } else if (k === K_LIST) {
      const l = c.nodes[i] as { rowH: number; cols?: number };
      const count = m.lists[c.listOrd[i]!]!.keys.length;
      const rows = Math.ceil(count / (l.cols ?? 1));
      // Growing, it takes what its stack leaves (its rows scroll in it).
      const shown = c.grow[i]! > 0 ? 0 : Math.min(rows, maxRowsAt(c, m, i));
      // Its row's own height, if taller (text larger than the row was made for): never cut.
      const first = c.first[i]!;
      const rowH = !Number.isNaN(c.fh[first]) || nh[first]! <= l.rowH ? l.rowH : nh[first]!;
      out.rowH[i] = rowH;
      // Its headings (one column): each its word's own height, counted in the content.
      const hd = c.head[i]!;
      const headH = hd === -1 ? 0 : nh[hd]!;
      out.headH[i] = headH;
      let heads = 0;
      if (hd !== -1) {
        const keys = m.lists[c.listOrd[i]!]!.keys;
        for (let k = 0; k < count; k++) if (keys[k]!.charCodeAt(0) === 35) heads++;
      }
      h = shown > 0 ? shown * rowH + (shown - 1) * c.gap[i]! : 0;
      out.rows[i] = count;
      out.content[i] =
        rows > 0 ? (rows - heads) * rowH + heads * headH + (rows - 1) * c.gap[i]! : 0;
    } else if (k === K_TEXT) {
      const lh = text === 1 ? c.lineH[i]! : Math.round(c.lineH[i]! * text);
      out.lineH[i] = lh;
      // Its lines now: fixed, bound (the game's count) or, a wrap text's, as measured.
      if (c.linesKey[i] !== -1) out.lines[i] = linesAt(c, m, i);
      h = out.lines[i]! * lh;
    } else if (k === K_SLOT || k === K_ICON) {
      w = h = (c.nodes[i] as { size: number }).size;
    } else if (k === K_METER) {
      h = 16;
    } else if (k === K_TABS) {
      const t = c.nodes[i] as { optionW: number };
      const count = m.lists[c.listOrd[i]!]!.keys.length;
      out.rows[i] = count;
      w = count * t.optionW;
      h = MIN_TARGET;
    } else {
      // A button, a field, a range.
      h = MIN_TARGET;
    }
    nw[i] = !Number.isNaN(fw) ? fw : w;
    nh[i] = !Number.isNaN(fh) ? fh : h;
  }
  // Boxes, parents before children.
  out.x[0] = 0;
  out.y[0] = 0;
  out.w[0] = frameW > 0 ? frameW : nw[0]!;
  out.h[0] = frameH > 0 ? frameH : nh[0]!;
  out.on[0] = shownSelf(c, m, 0) ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const k = kind[i]!;
    const first = c.first[i]!;
    if (first === -1) continue;
    const on = out.on[i]!;
    const x = out.x[i]!;
    const y = out.y[i]!;
    const w = out.w[i]!;
    const h = out.h[i]!;
    if (k === K_COL || k === K_ROW) {
      const across = k === K_ROW;
      const ix = x + c.padL[i]!;
      const iy = y + c.padT[i]!;
      const iw = w - c.padL[i]! - c.padR[i]!;
      // A scroll col's children are laid out in its content (never less than its box).
      const ih =
        (c.scrolls[i] === 1 && out.content[i]! > h ? out.content[i]! : h) - c.padT[i]! - c.padB[i]!;
      const gap = c.gap[i]!;
      const align = c.align[i]!;
      // The free length along the stack, and the shares that take it.
      let used = 0;
      let grow = 0;
      let count = 0;
      let lastGrow = -1;
      for (let ch = first; ch !== -1; ch = c.next[ch]!) {
        if (!shownSelf(c, m, ch)) continue;
        count++;
        used += across ? nw[ch]! : nh[ch]!;
        if (c.grow[ch]! > 0) {
          grow += c.grow[ch]!;
          lastGrow = ch;
        }
      }
      if (count > 1) used += (count - 1) * gap;
      const free = Math.max(0, (across ? iw : ih) - used);
      let given = 0;
      let at = across ? ix : iy;
      for (let ch = first; ch !== -1; ch = c.next[ch]!) {
        if (!shownSelf(c, m, ch)) {
          hide(out, ch);
          continue;
        }
        out.on[ch] = on;
        let len = across ? nw[ch]! : nh[ch]!;
        if (grow > 0 && c.grow[ch]! > 0) {
          const share = ch === lastGrow ? free - given : cut((free * c.grow[ch]!) / grow);
          given += share;
          len += share;
        }
        // Across the stack: stretched (unless fixed), or placed.
        const room = across ? ih : iw;
        const fixed = across ? c.fh[ch]! : c.fw[ch]!;
        let size =
          align === A_STRETCH && Number.isNaN(fixed)
            ? room
            : Math.min(across ? nh[ch]! : nw[ch]!, room);
        if (size < 0) size = 0;
        const off = align === A_CENTER ? cut((room - size) / 2) : align === A_END ? room - size : 0;
        if (across) {
          out.x[ch] = at;
          out.y[ch] = iy + off;
          out.w[ch] = len;
          out.h[ch] = size;
        } else {
          out.x[ch] = ix + off;
          out.y[ch] = at;
          out.w[ch] = size;
          out.h[ch] = len;
        }
        at += len + gap;
      }
    } else if (k === K_GRID) {
      const g = c.nodes[i] as { cols: number; cell: number; cellH?: number };
      const gap = c.gap[i]!;
      const cellH = g.cellH ?? g.cell;
      let j = 0;
      for (let ch = first; ch !== -1; ch = c.next[ch]!) {
        out.on[ch] = on === 1 && shownSelf(c, m, ch) ? 1 : 0;
        out.x[ch] = x + (j % g.cols) * (g.cell + gap);
        out.y[ch] = y + Math.floor(j / g.cols) * (cellH + gap);
        out.w[ch] = g.cell;
        out.h[ch] = cellH;
        j++;
      }
    } else if (k === K_LIST) {
      // The row, once, in its cell's own coordinates.
      const l = c.nodes[i] as { cols?: number };
      const cols = l.cols ?? 1;
      const cellW = cols === 1 ? w : cut((w - (cols - 1) * c.gap[i]!) / cols);
      out.cellW[i] = cellW;
      out.on[first] = on;
      out.x[first] = 0;
      out.y[first] = 0;
      out.w[first] = !Number.isNaN(c.fw[first]) ? c.fw[first]! : cellW;
      out.h[first] = out.rowH[i]!;
      // The headings' word, the same way.
      const hd = c.head[i]!;
      if (hd !== -1) {
        out.on[hd] = on;
        out.x[hd] = 0;
        out.y[hd] = 0;
        out.w[hd] = !Number.isNaN(c.fw[hd]) ? c.fw[hd]! : cellW;
        out.h[hd] = out.headH[i]!;
      }
    }
  }
}

/** Node `i`, hidden: no box (what is in it is hidden with it: `on` passes down in pre-order). */
function hide(out: SpecBoxes, i: number): void {
  out.on[i] = 0;
  out.w[i] = 0;
  out.h[i] = 0;
}
