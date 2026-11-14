/**
 * The world presenter (ws/ui-world): a spec panel painted with Canvas2D on a `WorldPanel` (a
 * textured quad in the scene, one drawable drawn in every view), hit by rays. It reads the same
 * `SpecBoxes` the DOM presenter places elements at, so a spec looks the same on a page, on a quad
 * in the world and in a headset; and a ray's press, hover and keys give the same `PanelEvent`s in
 * the same focus order as the page's pointer and keyboard.
 *
 * Cheap: an apply marks only the boxes of dirty keys and rows (`invalidateRect`), the surface
 * repaints only that rect and uploads only it, and an idle frame paints and uploads nothing.
 */

import type { PanelRect } from '../world-panel/layout';
import { type Painter, type PanelContext2D, roundRectPath } from '../world-panel/paint';
import type { WorldPanel } from '../world-panel/panel';
import { type PanelKeyEvent, WorldWidget } from '../world-panel/widgets';
import type { SpecBoxes } from './boxes';
import { wrapText } from './measure';
import type { SpecRow, SpecValue } from './model';
import { SPEC_SLIDE_MAX, SPEC_SLIDE_MS, specEaseOut, specNow, specStill } from './motion';
import type { SpecPanel, SpecPresenter } from './panel';
import { SpecPressable, type SpecTimer } from './press';
import { type SpecTheme, type SpecTokens, theme as specTheme } from './theme';
import {
  K_BUTTON,
  K_COL,
  K_FIELD,
  K_GRID,
  K_ICON,
  K_LIST,
  K_METER,
  K_RANGE,
  K_ROW,
  K_SLOT,
  K_TABS,
  K_TEXT,
  tabShares,
} from './units';
import {
  type Bind,
  type PanelEvent,
  partsOf,
  SPEC_TYPE,
  type SpecButton,
  type SpecField,
  type SpecIcon,
  type SpecList,
  type SpecMeter,
  type SpecNode,
  type SpecRange,
  type SpecSlot,
  type SpecStack,
  type SpecTabs,
  type SpecText,
  type SpecTextStyle,
  viewOf,
} from './words';

/** How a panel is drawn on a world surface. */
export interface WorldOptions {
  /** Canvas px per panel unit (default 1). */
  scale?: number;
  /** Where on the surface, canvas px (default all of it). */
  rect?: PanelRect;
  /**
   * `surface` (default): the panel framed to its rect. `natural`: framed to its natural size
   * (`w` units wide, 0: natural) and placed by `place` after each layout. `none`: the panel's
   * frame is left as it is (another presenter frames it: the page beside a headset).
   */
  fit?: 'surface' | 'natural' | 'none';
  /** With `fit: 'natural'`: its width in units (0: natural). */
  w?: number;
  /** With `fit: 'natural'`: where a box `w` by `h` px goes (write `out`'s x and y). */
  place?: (w: number, h: number, out: PanelRect) => void;
  /** Its look (default `theme()`: the DOM presenter's default). */
  theme?: SpecTheme;
  /** A slot's item drawn (default: its name in small type). */
  slotArt?: (ctx: PanelContext2D, item: string, r: PanelRect) => void;
  /** The hold timer (tests). */
  timer?: SpecTimer;
  /** Escape while it has focus (a modal closes; default: the key goes on). */
  onEscape?: () => void;
  /**
   * Whether the last press was a finger's (a field's close key types then). Default: never (a
   * ray or a keyboard).
   */
  touching?: () => boolean;
  /** Runs `f` next frame while something moves (a slide; default `requestAnimationFrame`). */
  frame?: (f: () => void) => void;
  /** The clock motion reads, ms (tests; default `performance.now()`). */
  now?: () => number;
}

const HOVER_TINT = 'rgba(255, 255, 255, 0.07)';
const PRESS_TINT = 'rgba(0, 0, 0, 0.18)';
const DISABLED_ALPHA = 0.45;
/** A ray's press drifts more than a finger's (units). */
const RAY_SLOP = 14;
const NO_ROW = -1;

function isBind(v: unknown): v is Bind {
  return typeof v === 'object' && v !== null;
}

/** A `--tcs-*` token named in a tint (`var(--tcs-good)`), else the colour as given. */
function tintColor(t: SpecTokens, v: string): string {
  const m = /^var\(--tcs-([a-z-]+)\)$/.exec(v.trim());
  if (!m) return v;
  const name = m[1]!.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase()) as keyof SpecTokens;
  const tok = t[name];
  return typeof tok === 'string' ? tok : v;
}

/** The surface the presenter paints through: one widget over its rect. */
class SpecWidget extends WorldWidget {
  constructor(private readonly w: WorldPresenter) {
    super({});
  }
  override get focusable(): boolean {
    return true;
  }
  measure(): number {
    return this.layoutRect.h;
  }
  paint(p: Painter, r: PanelRect): void {
    this.w.paint(p, r);
  }
  override pointerDown(x: number, y: number): void {
    this.w.pointerDown(x, y);
  }
  override pointerMove(x: number, y: number, down: boolean): void {
    this.w.pointerMove(x, y, down);
  }
  override pointerUp(x: number, y: number, inside: boolean): void {
    this.w.pointerUp(x, y, inside);
  }
  override wheel(dy: number): boolean {
    return this.w.wheel(dy);
  }
  override activate(): void {
    this.w.activate();
  }
  override keyFirst(e: PanelKeyEvent): boolean {
    return this.w.key(e);
  }
}

/** The world presenter of one panel (`presentWorld`). */
export class WorldPresenter implements SpecPresenter {
  /** The surface it paints on. */
  readonly surface: WorldPanel;
  /** The widget it paints through (its rect is the panel's). */
  readonly widget: WorldWidget;
  /** Paints of its rect (or part of it), and rects marked dirty: for the budgets. */
  paints = 0;
  marks = 0;
  private readonly p: SpecPanel;
  private readonly tokens: SpecTokens;
  private readonly opts: WorldOptions;
  private scale: number;
  private readonly fit: 'surface' | 'natural' | 'none';
  private readonly rect: PanelRect;
  private fresh = true;
  private readonly press: SpecPressable;
  private pressNode = -1;
  private pressRow: string | null = null;
  private heldNode = -1;
  private heldRow: string | null = null;
  private heldPointers = 0;
  /** A range being dragged (-1: none) and its row. */
  private dragNode = -1;
  private dragRow: string | null = null;
  private hoverNode = -1;
  private hoverRow: string | null = null;
  private focusNode = -1;
  private focusRow: string | null = null;
  /** The pointer's last place (units), for the wheel. */
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  /** Field text not bound to a top-level key, by `node|row`. */
  private readonly fieldText = new Map<string, string>();
  private readonly tabW = new Float64Array(32);
  private readonly scratch: PanelRect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly glyphs = new Map<string, unknown>();
  private readonly follower: (i: number, v: SpecValue, from: unknown) => void;
  private ctx: PanelContext2D | null = null;
  private clip: PanelRect = { x: 0, y: 0, w: 0, h: 0 };
  /** It is drawn given way (`SpecPanel.given`): not painted, not hit. */
  private given = false;
  /** The body's show, and when it last changed (ms; NaN: no slide running). */
  private shown = true;
  private bodyAt = Number.NaN;
  /**
   * The body's boxes when last shown (x, y, w, h, on; made at its first slide): a body sliding out
   * paints at them, since hiding it took its words' boxes away. Swapped in for that paint only.
   */
  private kept: {
    x: Float64Array;
    y: Float64Array;
    w: Float64Array;
    h: Float64Array;
    on: Uint8Array;
  } | null = null;
  private swap: {
    x: Float64Array;
    y: Float64Array;
    w: Float64Array;
    h: Float64Array;
    on: Uint8Array;
  } | null = null;
  /** Each list's rows' tops at its last order (units, by key), and a slide's offsets (units). */
  private readonly lastTops: (Map<string, number> | null)[] = [];
  private readonly slideDy: (Map<string, number> | null)[] = [];
  private readonly slideAt: Float64Array;
  private ticking = false;
  private readonly tick = (): void => this.moveFrame();

  constructor(panel: SpecPanel, surface: WorldPanel, opts: WorldOptions = {}) {
    this.p = panel;
    this.surface = surface;
    this.opts = opts;
    this.scale = opts.scale ?? 1;
    this.fit = opts.fit ?? 'surface';
    this.tokens = (opts.theme ?? specTheme()).tokens;
    const r = opts.rect ?? { x: 0, y: 0, w: surface.pxWidth, h: surface.pxHeight };
    this.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    this.press = new SpecPressable(false, opts.timer, RAY_SLOP);
    const nLists = panel.spec.listNodes.length;
    this.slideAt = new Float64Array(nLists).fill(Number.NaN);
    for (let o = 0; o < nLists; o++) {
      this.lastTops.push(null);
      this.slideDy.push(null);
    }
    this.shown = true;
    this.press.onTap = (shift) => this.tap(shift);
    this.press.onHold = () => this.emit(this.pressNode, this.pressRow, 'hold', null);
    const w = new SpecWidget(this);
    w.rect = { x: this.rect.x, y: this.rect.y, w: this.rect.w, h: this.rect.h };
    this.widget = w;
    surface.add(w);
    this.follower = (i, _v, from) => {
      if (from !== this) this.markKey(i);
    };
    panel.model.followers.push(this.follower);
    if (this.fit === 'surface')
      panel.frame(this.rect.w / this.scale, this.rect.h / this.scale, panel.text);
    else if (this.fit === 'natural') panel.frame(opts.w ?? 0, 0, panel.text);
    panel.presenters.push(this);
    panel.model.relayout = true;
    panel.model.changed();
  }

  /** Canvas px per unit now. */
  get unitScale(): number {
    return this.scale;
  }

  /** The focused word's id and row ('' and null: none). */
  get focusId(): { id: string; row: string | null } {
    return {
      id: this.focusNode === -1 ? '' : this.p.spec.ids[this.focusNode]!,
      row: this.focusRow,
    };
  }

  apply(relaid: boolean): void {
    const c = this.p.spec;
    const m = this.p.model;
    if (relaid && this.fit === 'natural') this.placeNatural();
    if (relaid && c.slide !== '' && this.p.boxes.on[0] === 1) this.keep(this.p.boxes);
    if (this.p.given !== this.given) {
      this.given = this.p.given;
      if (this.given) {
        this.press.cancel();
        this.letGo();
      }
      this.markAll();
    }
    const on = this.p.boxes.on[0] === 1;
    if (on !== this.shown) {
      this.shown = on;
      // The body slides in or out (`PanelSpec.slide`), unless this is its first draw.
      if (c.slide !== '' && !this.fresh && !specStill()) {
        this.bodyAt = this.now();
        this.run();
      }
      this.markAll();
    }
    for (let o = 0; o < m.lists.length; o++) {
      const l = m.lists[o]!;
      if (l.order && c.kind[c.listNodes[o]!] === K_LIST) this.reorder(o, l.how === 'slide');
    }
    if (this.fresh || relaid) {
      this.fresh = false;
      this.markAll();
    } else {
      for (let o = 0; o < m.lists.length; o++) {
        const l = m.lists[o]!;
        if (l.order || l.dirtyN > 0) this.markNode(c.listNodes[o]!, NO_ROW);
      }
      for (let j = 0; j < m.dirtyN; j++) this.markKey(m.dirtyKeys[j]!);
    }
    if (m.focusing !== undefined) {
      if (m.focusing === null) this.setFocus(-1, null);
      else {
        const i = c.ids.indexOf(m.focusing);
        if (i !== -1 && c.inList[i] === -1) {
          this.setFocus(i, null);
          this.surface.focus(this.widget);
        }
      }
    }
  }

  dispose(): void {
    this.press.cancel();
    this.bodyAt = Number.NaN;
    this.slideAt.fill(Number.NaN);
    this.surface.remove(this.widget);
    const f = this.p.model.followers.indexOf(this.follower);
    if (f !== -1) this.p.model.followers.splice(f, 1);
    const i = this.p.presenters.indexOf(this);
    if (i !== -1) this.p.presenters.splice(i, 1);
  }

  /** Draws at `scale` canvas px per unit (framed again with `fit: 'surface'`). */
  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    if (this.fit === 'surface') this.p.frame(this.rect.w / scale, this.rect.h / scale, this.p.text);
    this.p.model.relayout = true;
    this.p.model.changed();
  }

  /** Moves it to `r` on the surface (canvas px). */
  setRect(r: PanelRect): void {
    const o = this.rect;
    if (o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h) return;
    o.x = r.x;
    o.y = r.y;
    o.w = r.w;
    o.h = r.h;
    this.widget.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    this.surface.relayout();
    if (this.fit === 'surface') this.p.frame(r.w / this.scale, r.h / this.scale, this.p.text);
  }

  /** Focus goes to the panel's first word that takes it (and the surface's focus to the panel). */
  focusFirst(): void {
    this.surface.focus(this.widget);
    const order = this.focusOrder();
    if (order.length > 0) this.setFocus(order[0]!.i, order[0]!.row);
  }

  /**
   * Word `id`'s box on the surface, canvas px (in row `row` for a word in a list's row; a tabs'
   * option by its key): where a ray aims to press it. Null when it has none (hidden, no such row).
   */
  rectOf(id: string, row: string | null = null): PanelRect | null {
    const c = this.p.spec;
    const i = c.ids.indexOf(id);
    if (i === -1 || this.p.boxes.on[i] === 0) return null;
    const out: PanelRect = { x: 0, y: 0, w: 0, h: 0 };
    if (c.kind[i] === K_TABS && row !== null) {
      if (!this.absRect(i, NO_ROW, out)) return null;
      const l = this.p.model.lists[c.listOrd[i]!]!;
      const shares = this.shares(i);
      let ox = 0;
      for (let j = 0; j < l.keys.length; j++) {
        if (l.keys[j] === row) {
          out.x += ox * this.scale;
          out.w = shares[j]! * this.scale;
          return out;
        }
        ox += shares[j]!;
      }
      return null;
    }
    const ri = c.inList[i] === -1 ? NO_ROW : this.rowIndex(i, row);
    if (c.inList[i] !== -1 && ri < 0) return null;
    return this.absRect(i, ri, out) ? out : null;
  }

  /** List `id`'s rows in its view now (a world list paints only those), in the list's order. */
  rows(id: string): string[] {
    const c = this.p.spec;
    const ord = c.listIds.indexOf(id);
    if (ord === -1) return [];
    const L = c.listNodes[ord]!;
    const keys = this.p.model.lists[ord]!.keys;
    if (c.kind[L] === K_TABS) return keys.slice();
    const bx = this.p.boxes;
    const sc = bx.scroll[L]!;
    const out: string[] = [];
    for (let r = 0; r < keys.length; r++) {
      this.cell(L, r, this.cellAt);
      const tall = c.head[L] !== -1 && keys[r]!.charCodeAt(0) === 35 ? bx.headH[L]! : bx.rowH[L]!;
      if (this.cellAt.y + tall > sc && this.cellAt.y < sc + bx.h[L]!) out.push(keys[r]!);
    }
    return out;
  }

  /** Scrolls list `id` so row `key` is in view; false: no such row listed. */
  reveal(id: string, key: string): boolean {
    const c = this.p.spec;
    const ord = c.listIds.indexOf(id);
    if (ord === -1) return false;
    const L = c.listNodes[ord]!;
    if (c.kind[L] !== K_LIST) return false;
    const r = this.p.model.lists[ord]!.rows.get(key);
    if (!r || r.index < 0) return false;
    const bx = this.p.boxes;
    this.cell(L, r.index, this.cellAt);
    const y = this.cellAt.y;
    const tall = c.head[L] !== -1 && key.charCodeAt(0) === 35 ? bx.headH[L]! : bx.rowH[L]!;
    const at = bx.scroll[L]!;
    const view = bx.h[L]!;
    const to = y < at ? y : y + tall > at + view ? y + tall - view : at;
    const max = Math.max(0, bx.content[L]! - view);
    const v = Math.min(max, Math.max(0, to));
    if (v !== at) {
      bx.scroll[L] = v;
      this.markNode(L, NO_ROW);
      this.emit(L, null, 'scroll', v);
    }
    return true;
  }

  // Motion.

  private now(): number {
    return this.opts.now ? this.opts.now() : specNow();
  }

  /** Asks for the next frame while something moves. */
  private run(): void {
    if (this.ticking) return;
    this.ticking = true;
    const f =
      this.opts.frame ??
      (typeof requestAnimationFrame === 'function'
        ? (g: () => void) => requestAnimationFrame(() => g())
        : (g: () => void) => setTimeout(g, 16));
    f(this.tick);
  }

  /** A frame while something moves: what moves is painted again; on until it stands still. */
  private moveFrame(): void {
    this.ticking = false;
    const t = this.now();
    let moving = false;
    if (!Number.isNaN(this.bodyAt)) {
      if (t - this.bodyAt >= this.bodyMs()) this.bodyAt = Number.NaN;
      else moving = true;
      this.markAll();
    }
    for (let o = 0; o < this.slideAt.length; o++) {
      const at = this.slideAt[o]!;
      if (Number.isNaN(at)) continue;
      if (t - at >= SPEC_SLIDE_MS) {
        this.slideAt[o] = Number.NaN;
        this.slideDy[o]?.clear();
      } else moving = true;
      this.markNode(this.p.spec.listNodes[o]!, NO_ROW);
    }
    if (moving) this.run();
  }

  /** How long the body's slide takes (its fade's time, or a list's slide's). */
  private bodyMs(): number {
    const f = this.p.spec.fade;
    return f > 0 ? f : SPEC_SLIDE_MS;
  }

  /**
   * List ordinal `o`'s keys changed: with `slide`, its rows slide from their old tops to their new
   * ones and the first row in view keeps its place on the surface (even with motion reduced).
   */
  private reorder(o: number, slide: boolean): void {
    const c = this.p.spec;
    const L = c.listNodes[o]!;
    const bx = this.p.boxes;
    const keys = this.p.model.lists[o]!.keys;
    const was = this.lastTops[o];
    if (slide && was && was.size > 0) {
      // The anchor: the row at or below the old scroll nearest it.
      const at = bx.scroll[L]!;
      let anchor: string | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const [key, y] of was) {
        if (y >= at - 0.5 && y < best && this.p.model.lists[o]!.rows.has(key)) {
          best = y;
          anchor = key;
        }
      }
      let to = at;
      if (anchor !== null) {
        const r = this.p.model.lists[o]!.rows.get(anchor)!;
        if (r.index >= 0) {
          this.cell(L, r.index, this.cellAt);
          const max = Math.max(0, bx.content[L]! - bx.h[L]!);
          to = Math.min(max, Math.max(0, at + this.cellAt.y - best));
          bx.scroll[L] = to;
        }
      }
      if (!specStill()) {
        let dy = this.slideDy[o];
        if (!dy) {
          dy = new Map();
          this.slideDy[o] = dy;
        }
        dy.clear();
        for (let r = 0; r < keys.length; r++) {
          const from = was.get(keys[r]!);
          if (from === undefined) continue;
          this.cell(L, r, this.cellAt);
          const d = from - at - (this.cellAt.y - to);
          if (Math.abs(d) >= 0.5 && Math.abs(d) <= SPEC_SLIDE_MAX) dy.set(keys[r]!, d);
        }
        if (dy.size > 0) {
          this.slideAt[o] = this.now();
          this.run();
        }
      }
    }
    // Its tops now, for the next change.
    let tops = this.lastTops[o];
    if (!tops) {
      tops = new Map();
      this.lastTops[o] = tops;
    }
    tops.clear();
    for (let r = 0; r < keys.length; r++) {
      this.cell(L, r, this.cellAt);
      tops.set(keys[r]!, this.cellAt.y);
    }
  }

  /** How far row `key` of list ordinal `o` is still off its place (units). */
  private slideOff(o: number, key: string): number {
    const at = this.slideAt[o]!;
    if (Number.isNaN(at)) return 0;
    const d = this.slideDy[o]?.get(key);
    if (d === undefined) return 0;
    const t = (this.now() - at) / SPEC_SLIDE_MS;
    return t >= 1 ? 0 : d * (1 - specEaseOut(t));
  }

  /** A key let go (a held button's Enter or Space ends its press). */
  keyUp(e: PanelKeyEvent): void {
    if ((e.key === 'Enter' || e.key === ' ') && this.heldNode !== -1) this.letGo();
  }

  // Placing.

  private placeNatural(): void {
    const bx = this.p.boxes;
    const w = Math.ceil(bx.w[0]! * this.scale);
    const h = Math.ceil(bx.h[0]! * this.scale);
    const r = this.scratch;
    r.x = this.rect.x;
    r.y = this.rect.y;
    r.w = w;
    r.h = h;
    this.opts.place?.(w, h, r);
    this.setRect(r);
  }

  // Values.

  /** A word's string or bound value (in row `row` for a `row.` key). */
  private val(v: unknown, row: SpecRow | null, i: number): SpecValue | null {
    if (v === undefined) return null;
    if (!isBind(v)) return v as SpecValue;
    const key = v.b;
    if (key.startsWith('row.')) {
      if (!row) return null;
      const l = this.p.model.lists[this.p.spec.listOrd[this.p.spec.inList[i]!]!]!;
      const f = l.fieldIndex.get(key.slice(4));
      return f === undefined ? null : (row.vals[f] ?? null);
    }
    const k = this.p.spec.keyIndex.get(key);
    return k === undefined ? null : (this.p.model.vals[k] ?? null);
  }

  private str(v: unknown, row: SpecRow | null, i: number): string {
    const s = this.val(v, row, i);
    return s === null ? '' : String(s);
  }

  private rowOf(i: number, key: string | null): SpecRow | null {
    if (key === null) return null;
    const c = this.p.spec;
    const list = c.inList[i] !== -1 ? c.inList[i]! : c.kind[i] === K_TABS ? i : -1;
    if (list === -1) return null;
    const l = this.p.model.lists[c.listOrd[list]!]!;
    return l.rows.get(key) ?? null;
  }

  private enabled(i: number, row: string | null): boolean {
    const node = this.p.spec.nodes[i] as { enabled?: Bind };
    if (!node.enabled) return true;
    return this.val(node.enabled, this.rowOf(i, row), i) === true;
  }

  private fieldValue(i: number, row: string | null): string {
    const f = this.p.spec.nodes[i] as SpecField;
    if (f.value && !f.value.b.startsWith('row.')) {
      const v = this.p.model.vals[this.p.spec.keyIndex.get(f.value.b)!];
      return v === null || v === undefined ? '' : String(v);
    }
    const local = this.fieldText.get(`${i}|${row ?? ''}`);
    if (local !== undefined) return local;
    return f.value ? this.str(f.value, this.rowOf(i, row), i) : '';
  }

  // Dirty rects.

  private markAll(): void {
    this.marks++;
    this.widget.invalidate();
  }

  /** Every word key `k` binds (a word in a row: its list's box). */
  private markKey(k: number): void {
    const c = this.p.spec;
    const binds = c.keyBinds[k];
    if (!binds) return;
    for (let j = 0; j < binds.length; j += 2) {
      const node = binds[j]!;
      const list = c.inList[node]!;
      this.markNode(list === -1 ? node : list, NO_ROW);
    }
  }

  /** Word `i`'s box (in row index `ri`), grown by the focus ring. */
  private markNode(i: number, ri: number): void {
    if (!this.absRect(i, ri, this.scratch)) {
      this.markAll();
      return;
    }
    const r = this.scratch;
    const g = this.tokens.focusRing * this.scale + 2;
    r.x -= g;
    r.y -= g;
    r.w += g * 2;
    r.h += g * 2;
    this.marks++;
    this.surface.invalidateRect(r);
  }

  private markAt(i: number, row: string | null): void {
    if (i === -1) return;
    const c = this.p.spec;
    if (row !== null && c.inList[i] !== -1) {
      const r = this.rowOf(i, row);
      this.markNode(i, r ? r.index : NO_ROW);
    } else this.markNode(i, NO_ROW);
  }

  /** Where row `ri` of list `L` sits in its content (units, into `out`'s x and y). */
  private cell(L: number, ri: number, out: PanelRect): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const cols = (c.nodes[L] as SpecList).cols ?? 1;
    const gap = c.gap[L]!;
    if (c.head[L] !== -1) {
      out.x = 0;
      out.y = bx.tops(L)[ri]!;
      return;
    }
    out.x = cols === 1 ? 0 : (ri % cols) * (bx.cellW[L]! + gap);
    out.y = Math.floor(ri / cols) * (bx.rowH[L]! + gap);
  }

  /** Word `i`'s box (row index `ri` for a word in a row), canvas px; false: none to give. */
  private absRect(i: number, ri: number, out: PanelRect): boolean {
    const c = this.p.spec;
    const bx = this.p.boxes;
    let x = bx.x[i]!;
    let y = bx.y[i]!;
    const L = c.inList[i]!;
    if (L !== -1) {
      if (ri < 0) return false;
      if (!this.absRect(L, NO_ROW, out)) return false;
      const lx = (out.x - this.rect.x) / this.scale;
      const ly = (out.y - this.rect.y) / this.scale;
      this.cell(L, ri, out);
      x += lx + out.x;
      y += ly + out.y - bx.scroll[L]!;
    } else {
      const sc = c.scroller[i]!;
      if (sc !== -1) y -= bx.scroll[sc]!;
    }
    const s = this.scale;
    out.x = this.rect.x + x * s;
    out.y = this.rect.y + y * s;
    out.w = bx.w[i]! * s;
    out.h = bx.h[i]! * s;
    return true;
  }

  // Painting.

  /** @internal The widget's paint: every word that meets the dirty rect. */
  paint(p: Painter, _r: PanelRect): void {
    this.paints++;
    this.ctx = p.ctx;
    this.clip = this.surface.paintClip;
    if (this.given) return;
    const c = this.p.spec;
    const sliding = !Number.isNaN(this.bodyAt);
    if (this.p.boxes.on[0] === 0 && !sliding) return;
    if (!sliding) {
      this.paintNode(0, 0, 0, null, null);
      this.ctx = null;
      return;
    }
    // Sliding in or out from its side, faded with it.
    const bx = this.p.boxes;
    const t = Math.min(1, (this.now() - this.bodyAt) / this.bodyMs());
    const e = specEaseOut(t);
    const k = this.shown ? 1 - e : e;
    const ox = c.slide === 'left' ? -k * bx.w[0]! : c.slide === 'right' ? k * bx.w[0]! : 0;
    const oy = c.slide === 'up' ? -k * bx.h[0]! : c.slide === 'down' ? k * bx.h[0]! : 0;
    const ctx = p.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.clip();
    ctx.globalAlpha *= 1 - k;
    // Sliding out, its boxes are gone: its words paint at their boxes when it was last shown.
    const out = bx.on[0] === 0 && this.kept !== null;
    if (out) this.trade(bx);
    this.paintNode(0, ox, oy, null, null);
    if (out) this.trade(bx);
    ctx.restore();
    this.ctx = null;
  }

  /** Keeps the body's boxes as shown now (a slide's body paints at them on its way out). */
  private keep(bx: SpecBoxes): void {
    if (!this.kept) {
      const n = bx.n;
      const make = () => ({
        x: new Float64Array(n),
        y: new Float64Array(n),
        w: new Float64Array(n),
        h: new Float64Array(n),
        on: new Uint8Array(n),
      });
      this.kept = make();
      this.swap = make();
    }
    const k = this.kept;
    k.x.set(bx.x);
    k.y.set(bx.y);
    k.w.set(bx.w);
    k.h.set(bx.h);
    k.on.set(bx.on);
  }

  /** Swaps the kept boxes and the boxes now (twice: back as they were). */
  private trade(bx: SpecBoxes): void {
    const k = this.kept!;
    const t = this.swap!;
    t.x.set(bx.x);
    t.y.set(bx.y);
    t.w.set(bx.w);
    t.h.set(bx.h);
    t.on.set(bx.on);
    bx.x.set(k.x);
    bx.y.set(k.y);
    bx.w.set(k.w);
    bx.h.set(k.h);
    bx.on.set(k.on);
    this.kept = t;
    this.swap = k;
  }

  private font(style: SpecTextStyle, scale = 1): string {
    const t = SPEC_TYPE[style];
    const fam =
      t.family === 'serif'
        ? this.tokens.fontSerif
        : t.family === 'mono'
          ? this.tokens.fontMono
          : this.tokens.fontSans;
    return `${t.weight} ${t.px * this.p.text * this.scale * scale}px ${fam}`;
  }

  /** Whether canvas px rect (x, y, w, h) meets the dirty rect. */
  private meets(x: number, y: number, w: number, h: number): boolean {
    const d = this.clip;
    const g = this.tokens.focusRing * this.scale + 2;
    return !(x - g >= d.x + d.w || x + w + g <= d.x || y - g >= d.y + d.h || y + h + g <= d.y);
  }

  private rowShows(i: number, row: SpecRow | null): boolean {
    const show = (this.p.spec.nodes[i] as { show?: Bind }).show;
    if (!show || !row || !show.b.startsWith('row.')) return true;
    return this.val(show, row, i) === true;
  }

  /** Word `i` and its subtree at offset (`dx`, `dy`) units, in row `row` (key `rk`). */
  private paintNode(
    i: number,
    dx: number,
    dy: number,
    row: SpecRow | null,
    rk: string | null,
  ): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    if (bx.on[i] === 0 || !this.rowShows(i, row)) return;
    const s = this.scale;
    const ux = dx + bx.x[i]!;
    const uy = dy + bx.y[i]!;
    const x = this.rect.x + ux * s;
    const y = this.rect.y + uy * s;
    const w = bx.w[i]! * s;
    const h = bx.h[i]! * s;
    if (!this.meets(x, y, w, h)) return;
    const ctx = this.ctx!;
    const k = c.kind[i]!;
    const node = c.nodes[i]!;
    const r = this.scratch;
    r.x = x;
    r.y = y;
    r.w = w;
    r.h = h;
    switch (k) {
      case K_COL:
      case K_ROW:
      case K_GRID: {
        const st = node as SpecStack;
        if (node.cls?.includes('tcs-surface')) this.box(r, this.tokens.surface, this.tokens.border);
        if (st.tap) this.tints(i, rk, r);
        if (c.scrolls[i] === 1) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          for (let ch = c.first[i]!; ch !== -1; ch = c.next[ch]!)
            this.paintNode(ch, dx, dy - bx.scroll[i]!, row, rk);
          ctx.restore();
        } else {
          for (let ch = c.first[i]!; ch !== -1; ch = c.next[ch]!)
            this.paintNode(ch, dx, dy, row, rk);
        }
        if (st.tap) this.ringIf(i, rk, x, y, w, h);
        return;
      }
      case K_LIST:
        this.paintList(i, ux, uy);
        return;
      case K_TABS:
        this.paintTabs(i, x, y, w, h);
        return;
      case K_TEXT:
        this.paintText(i, node as SpecText, x, y, w, h, row);
        return;
      case K_BUTTON:
        this.paintButton(i, node as SpecButton, x, y, w, h, row, rk);
        return;
      case K_SLOT:
        this.paintSlot(i, node as SpecSlot, x, y, w, h, row, rk);
        return;
      case K_METER:
        this.paintMeter(i, node as SpecMeter, x, y, w, h, row);
        return;
      case K_ICON: {
        const ic = node as SpecIcon;
        const tint = this.str(ic.tint, row, i);
        if (ic.ring) this.paintRing(Number(this.val(ic.ring, row, i) ?? 0), x, y, w, h);
        this.paintGlyph(ic, x, y, w, h, tint ? tintColor(this.tokens, tint) : this.tokens.text);
        return;
      }
      case K_FIELD:
        this.paintField(i, node as SpecField, x, y, w, h, row, rk);
        return;
      case K_RANGE:
        this.paintRange(i, node as SpecRange, x, y, w, h, row, rk);
        return;
    }
  }

  private box(r: PanelRect, fill: string, stroke: string): void {
    const ctx = this.ctx!;
    const rad = this.tokens.radius * this.scale;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, rad);
    ctx.fillStyle = fill;
    ctx.fill();
    const bw = this.tokens.borderWidth * this.scale;
    if (bw > 0) {
      roundRectPath(ctx, r.x + bw / 2, r.y + bw / 2, r.w - bw, r.h - bw, Math.max(0, rad - bw / 2));
      ctx.strokeStyle = stroke;
      ctx.lineWidth = bw;
      ctx.stroke();
    }
  }

  /** The hover and press tints of word `i` in row `rk`. */
  private tints(i: number, rk: string | null, r: PanelRect): void {
    const pressed = this.widget.pressed && this.pressNode === i && this.pressRow === rk;
    const hovered = this.widget.hover && this.hoverNode === i && this.hoverRow === rk;
    if (!pressed && !hovered) return;
    const ctx = this.ctx!;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, this.tokens.radius * this.scale);
    ctx.fillStyle = pressed ? PRESS_TINT : HOVER_TINT;
    ctx.fill();
  }

  private ringIf(i: number, rk: string | null, x: number, y: number, w: number, h: number): void {
    if (!this.widget.focused || this.focusNode !== i || this.focusRow !== rk) return;
    const ctx = this.ctx!;
    const fw = this.tokens.focusRing * this.scale;
    const o = this.scale + fw / 2;
    roundRectPath(ctx, x - o, y - o, w + o * 2, h + o * 2, this.tokens.radius * this.scale + o);
    ctx.strokeStyle = this.tokens.focus;
    ctx.lineWidth = fw;
    ctx.stroke();
  }

  /** One line of `s` in `font`, cut with an ellipsis to `w`, at baseline-middle `y`. */
  private line(
    s: string,
    font: string,
    color: string,
    x: number,
    y: number,
    w: number,
    align: 'start' | 'center' | 'end',
  ): void {
    const ctx = this.ctx!;
    ctx.font = font;
    let t = s;
    if (ctx.measureText(t).width > w + 0.5) {
      let lo = 0;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${s.slice(0, mid)}…`).width <= w) lo = mid;
        else hi = mid - 1;
      }
      t = `${s.slice(0, lo)}…`;
    }
    const tw = ctx.measureText(t).width;
    const tx = align === 'center' ? x + (w - tw) / 2 : align === 'end' ? x + w - tw : x;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, tx, y);
  }

  private paintText(
    i: number,
    n: SpecText,
    x: number,
    y: number,
    w: number,
    _h: number,
    row: SpecRow | null,
  ): void {
    const bx = this.p.boxes;
    const t = this.tokens;
    let raw = this.str(n.text, row, i);
    const tint = this.str(n.tint, row, i);
    const color = tint
      ? tintColor(t, tint)
      : n.style === 'note' || n.style === 'count'
        ? t.textMuted
        : n.style === 'warn'
          ? t.warn
          : t.text;
    const font = this.font(n.style);
    const s = this.scale;
    const lh = bx.lineH[i]! * s;
    const lines = bx.lines[i]!;
    const align = n.textAlign ?? 'start';
    let tx = x;
    let tw = w;
    if (n.term !== undefined) {
      const termW = bx.termW[i]! * s;
      if (termW > 0) {
        this.line(n.term, font, t.textMuted, x, y + lh / 2, termW, 'start');
        tx += termW;
        tw -= termW;
      }
    }
    // Lit runs ({w}…{/}): a flag per character of the words without their marks.
    let lit: Uint8Array | null = null;
    if (n.marked && raw.includes('{')) {
      let plain = '';
      const flags: number[] = [];
      let on = 0;
      for (const piece of raw.split(/(\{w\}|\{\/\})/)) {
        if (piece === '{w}') on = 1;
        else if (piece === '{/}') on = 0;
        else {
          plain += piece;
          for (let j = 0; j < piece.length; j++) flags.push(on);
        }
      }
      raw = plain;
      lit = Uint8Array.from(flags);
    }
    if (lines <= 1 && !n.wrap) {
      if (lit) this.litLine(raw, 0, lit, font, color, tx, y + lh / 2, tw, align);
      else this.line(raw, font, color, tx, y + lh / 2, tw, align);
      return;
    }
    const ty = SPEC_TYPE[n.style];
    const fam =
      ty.family === 'serif' ? t.fontSerif : ty.family === 'mono' ? t.fontMono : t.fontSans;
    const ws = wrapText(raw, tw / s, ty.px * this.p.text, { weight: ty.weight, family: fam });
    const shown = Math.min(lines, ws.length);
    let at = 0;
    for (let j = 0; j < shown; j++) {
      let ln = ws[j]!;
      const from = raw.indexOf(ln, at);
      if (from !== -1) at = from + ln.length;
      if (j === shown - 1 && ws.length > shown) ln = `${ln}${ln.endsWith('…') ? '' : '…'}`;
      if (lit && from !== -1)
        this.litLine(ln, from, lit, font, color, tx, y + lh * j + lh / 2, tw, align);
      else this.line(ln, font, color, tx, y + lh * j + lh / 2, tw, align);
    }
  }

  /** A line whose characters from `from` are lit by `lit`, run by run. */
  private litLine(
    s: string,
    from: number,
    lit: Uint8Array,
    font: string,
    color: string,
    x: number,
    y: number,
    w: number,
    align: 'start' | 'center' | 'end',
  ): void {
    const ctx = this.ctx!;
    ctx.font = font;
    const total = ctx.measureText(s).width;
    if (total > w) {
      this.line(s, font, color, x, y, w, align);
      return;
    }
    let cx = align === 'center' ? x + (w - total) / 2 : align === 'end' ? x + w - total : x;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let j = 0;
    while (j < s.length) {
      const f = lit[from + j] ?? 0;
      let e = j + 1;
      while (e < s.length && (lit[from + e] ?? 0) === f) e++;
      const run = s.slice(j, e);
      ctx.fillStyle = f ? this.tokens.accent : color;
      ctx.fillText(run, cx, y);
      cx += ctx.measureText(run).width;
      j = e;
    }
  }

  private faded(on: boolean, paint: () => void): void {
    const ctx = this.ctx!;
    if (on) {
      paint();
      return;
    }
    ctx.save();
    ctx.globalAlpha = DISABLED_ALPHA;
    paint();
    ctx.restore();
  }

  private paintButton(
    i: number,
    n: SpecButton,
    x: number,
    y: number,
    w: number,
    h: number,
    row: SpecRow | null,
    rk: string | null,
  ): void {
    const t = this.tokens;
    const s = this.scale;
    const on = n.on ? this.val(n.on, row, i) === true : false;
    const r: PanelRect = { x, y, w, h };
    const ctx = this.ctx!;
    this.faded(this.enabled(i, rk), () => {
      this.box(r, on ? t.surfaceOn : t.surfaceAlt, on ? t.accent : t.border);
      this.tints(i, rk, r);
      const ring = n.ring ? Number(this.val(n.ring, row, i) ?? 0) : 0;
      if (ring < 0) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        roundRectPath(ctx, x, y, w, h, t.radius * s);
        ctx.fillStyle = t.accent;
        ctx.fill();
        ctx.restore();
      }
      const font = this.font('label');
      const label = n.text === undefined ? '' : this.str(n.text, row, i);
      const key = n.keyLabel === undefined ? '' : this.str(n.keyLabel, row, i);
      const em = SPEC_TYPE.label.px * this.p.text * s;
      const gap = 6 * s;
      const iconW = n.icon ? em * 1.4 : 0;
      const keyFont = this.font('label', 0.8);
      ctx.font = keyFont;
      const keyW = key ? ctx.measureText(key).width + 6 * s : 0;
      ctx.font = font;
      const pad = t.padX * s;
      const room = Math.max(
        0,
        w - pad * 2 - iconW - keyW - (iconW && label ? gap : 0) - (keyW ? gap : 0),
      );
      const labelW = label ? Math.min(ctx.measureText(label).width, room) : 0;
      const total =
        iconW + labelW + keyW + (iconW && label ? gap : 0) + (keyW && (label || iconW) ? gap : 0);
      let cx = x + (w - total) / 2;
      const cy = y + h / 2;
      if (n.icon) {
        this.paintGlyph(
          { k: 'icon', glyph: n.icon, size: 24 },
          cx,
          cy - iconW / 2,
          iconW,
          iconW,
          t.text,
        );
        cx += iconW + (label ? gap : 0);
      }
      if (label) {
        this.line(label, font, t.text, cx, cy, labelW, 'start');
        cx += labelW + (keyW ? gap : 0);
      }
      if (key) {
        const kh = em * 0.8 * 1.3;
        const kr: PanelRect = { x: cx, y: cy - kh / 2, w: keyW, h: kh };
        roundRectPath(ctx, kr.x, kr.y, kr.w, kr.h, 3 * s);
        ctx.strokeStyle = t.border;
        ctx.lineWidth = Math.max(1, s);
        ctx.stroke();
        this.line(key, keyFont, t.textMuted, kr.x, cy, kr.w, 'center');
      }
      const badge = n.badge ? this.str(n.badge, row, i) : '';
      if (badge) {
        const bf = `700 ${em * 0.75}px ${t.fontSans}`;
        ctx.font = bf;
        const bw = Math.max(em * 0.75 * 1.4, ctx.measureText(badge).width + 6 * s);
        const bh = em * 0.75 * 1.4;
        roundRectPath(ctx, x + w - bw + s, y - s, bw, bh, 9 * s);
        ctx.fillStyle = t.accent;
        ctx.fill();
        this.line(badge, bf, t.accentText, x + w - bw + s, y - s + bh / 2, bw, 'center');
      }
    });
    this.ringIf(i, rk, x, y, w, h);
  }

  private paintSlot(
    i: number,
    n: SpecSlot,
    x: number,
    y: number,
    w: number,
    h: number,
    row: SpecRow | null,
    rk: string | null,
  ): void {
    const t = this.tokens;
    const s = this.scale;
    const on = this.str(n.state, row, i) === 'on';
    const r: PanelRect = { x, y, w, h };
    this.faded(this.enabled(i, rk), () => {
      this.box(r, on ? t.surfaceOn : t.surfaceAlt, on ? t.accent : t.border);
      this.tints(i, rk, r);
      const item = this.str(n.item, row, i);
      if (item) {
        if (this.opts.slotArt) this.opts.slotArt(this.ctx!, item, r);
        else
          this.line(
            item,
            `400 ${10 * this.p.text * s}px ${t.fontSans}`,
            t.text,
            x + 2 * s,
            y + h / 2,
            w - 4 * s,
            'center',
          );
      }
      const count = n.count ? this.val(n.count, row, i) : null;
      if (count !== null && count !== 0 && count !== 1 && count !== '')
        this.line(
          String(count),
          `600 ${11 * this.p.text * s}px ${t.fontSans}`,
          t.text,
          x,
          y + h - 8 * s,
          w - 3 * s,
          'end',
        );
      const key = n.keyLabel === undefined ? '' : this.str(n.keyLabel, row, i);
      if (key)
        this.line(
          key,
          this.font('label', 0.8),
          t.textMuted,
          x + 2 * s,
          y + 8 * s,
          w - 4 * s,
          'start',
        );
    });
    this.ringIf(i, rk, x, y, w, h);
  }

  private paintMeter(
    i: number,
    n: SpecMeter,
    x: number,
    y: number,
    w: number,
    h: number,
    row: SpecRow | null,
  ): void {
    const t = this.tokens;
    const ctx = this.ctx!;
    const rad = (t.radius * this.scale) / 2;
    roundRectPath(ctx, x, y, w, h, rad);
    ctx.fillStyle = t.track;
    ctx.fill();
    const v = Number(this.val(n.value, row, i) ?? 0);
    const f = v < 0 || Number.isNaN(v) ? 0 : Math.min(v, 1);
    if (f > 0) {
      const tint = this.str(n.tint, row, i);
      roundRectPath(ctx, x, y, w * f, h, rad);
      ctx.fillStyle = tint ? tintColor(t, tint) : t.accent;
      ctx.fill();
    }
    if (n.marks) {
      const s = this.scale;
      ctx.fillStyle = t.text;
      for (const m of n.marks) {
        const at = Number(this.val(m.at, row, i) ?? 0);
        ctx.fillRect(x + at * w - s, y - 2 * s, 2 * s, h + 4 * s);
      }
    }
  }

  /** An icon's ring: a wedge filled `f` (0..1) of the way round from the top. */
  private paintRing(f: number, x: number, y: number, w: number, h: number): void {
    const v = f < 0 ? 0 : Math.min(f, 1);
    if (v <= 0) return;
    const ctx = this.ctx!;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    ctx.save();
    ctx.globalAlpha *= 0.35;
    ctx.fillStyle = this.tokens.accent;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private paintGlyph(
    ic: Pick<SpecIcon, 'glyph' | 'view' | 'size' | 'k'>,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
  ): void {
    const P = (globalThis as { Path2D?: new (d: string) => unknown }).Path2D;
    const ctx = this.ctx as PanelContext2D & {
      translate?: (x: number, y: number) => void;
      scale?: (x: number, y: number) => void;
      stroke: (p?: unknown) => void;
      fill: (p?: unknown) => void;
      lineCap?: string;
      lineJoin?: string;
    };
    if (!P || typeof ctx.translate !== 'function' || typeof ctx.scale !== 'function') return;
    const [vw, vh] = viewOf(ic as SpecIcon);
    const k = Math.min(w / vw, h / vh);
    ctx.save();
    ctx.translate(x + (w - vw * k) / 2, y + (h - vh * k) / 2);
    ctx.scale(k, k);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const part of partsOf(ic)) {
      let path = this.glyphs.get(part.d);
      if (path === undefined) {
        path = new P(part.d);
        this.glyphs.set(part.d, path);
      }
      if (part.line) ctx.stroke(path);
      else ctx.fill(path);
    }
    ctx.restore();
  }

  private paintField(
    i: number,
    n: SpecField,
    x: number,
    y: number,
    w: number,
    h: number,
    row: SpecRow | null,
    rk: string | null,
  ): void {
    const t = this.tokens;
    const s = this.scale;
    const ctx = this.ctx!;
    const focused = this.widget.focused && this.focusNode === i && this.focusRow === rk;
    this.faded(this.enabled(i, rk), () => {
      this.box({ x, y, w, h }, t.surfaceAlt, t.border);
      const v = this.fieldValue(i, rk);
      const font = `400 ${13 * this.p.text * s}px ${t.fontSans}`;
      const pad = t.padX * s;
      const cy = n.kind === 'long' ? y + 6 * s + 9 * this.p.text * s : y + h / 2;
      if (v) this.line(v, font, t.text, x + pad, cy, w - pad * 2, 'start');
      else if (n.placeholder !== undefined)
        this.line(
          this.str(n.placeholder, row, i),
          font,
          t.textMuted,
          x + pad,
          cy,
          w - pad * 2,
          'start',
        );
      if (focused) {
        ctx.font = font;
        const cx = x + pad + Math.min(ctx.measureText(v).width, w - pad * 2);
        const ch = 15 * this.p.text * s;
        ctx.fillStyle = t.text;
        ctx.fillRect(cx, cy - ch / 2, Math.max(1, s), ch);
      }
    });
    this.ringIf(i, rk, x, y, w, h);
  }

  private rangeValue(i: number, n: SpecRange, row: SpecRow | null): number {
    const v = Number(this.val(n.value, row, i) ?? n.min);
    return Number.isNaN(v) ? n.min : Math.min(n.max, Math.max(n.min, v));
  }

  private paintRange(
    i: number,
    n: SpecRange,
    x: number,
    y: number,
    w: number,
    h: number,
    row: SpecRow | null,
    rk: string | null,
  ): void {
    const t = this.tokens;
    const s = this.scale;
    const ctx = this.ctx!;
    const knob = 8 * s;
    const f = n.max > n.min ? (this.rangeValue(i, n, row) - n.min) / (n.max - n.min) : 0;
    const x0 = x + knob;
    const tw = Math.max(0, w - knob * 2);
    const cy = y + h / 2;
    this.faded(this.enabled(i, rk), () => {
      roundRectPath(ctx, x0, cy - 2 * s, tw, 4 * s, 2 * s);
      ctx.fillStyle = t.track;
      ctx.fill();
      roundRectPath(ctx, x0, cy - 2 * s, tw * f, 4 * s, 2 * s);
      ctx.fillStyle = t.accent;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x0 + tw * f, cy, knob * 0.85, 0, Math.PI * 2);
      ctx.fillStyle =
        this.widget.hover && this.hoverNode === i && this.hoverRow === rk ? t.focus : t.accent;
      ctx.fill();
    });
    this.ringIf(i, rk, x, y, w, h);
  }

  /** A list's rows that meet the dirty rect, clipped to its box. */
  private paintList(L: number, ux: number, uy: number): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const ctx = this.ctx!;
    const s = this.scale;
    const l = this.p.model.lists[c.listOrd[L]!]!;
    const keys = l.keys;
    const n = keys.length;
    if (n === 0) return;
    const x = this.rect.x + ux * s;
    const y = this.rect.y + uy * s;
    const h = bx.h[L]!;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, bx.w[L]! * s, h * s);
    ctx.clip();
    const sc = bx.scroll[L]!;
    const heads = c.head[L] !== -1;
    const cell = this.cellAt;
    const o = c.listOrd[L]!;
    const sliding = !Number.isNaN(this.slideAt[o]!);
    for (let r = 0; r < n; r++) {
      this.cell(L, r, cell);
      const key = keys[r]!;
      const top = cell.y - sc + (sliding ? this.slideOff(o, key) : 0);
      const isHead = heads && key.charCodeAt(0) === 35;
      const tall = isHead ? bx.headH[L]! : bx.rowH[L]!;
      if (top + tall < 0) continue;
      if (top > h && !sliding) break;
      if (top > h) continue;
      const root = isHead ? c.head[L]! : c.first[L]!;
      this.paintNode(root, ux + cell.x, uy + top, l.rows.get(key) ?? null, key);
    }
    ctx.restore();
  }

  private readonly cellAt: PanelRect = { x: 0, y: 0, w: 0, h: 0 };

  /** Tabs `i`'s options' widths (units) into `tabW` (or a larger array); returns it. */
  private shares(i: number): Float64Array {
    const c = this.p.spec;
    const t = c.nodes[i] as SpecTabs;
    const l = this.p.model.lists[c.listOrd[i]!]!;
    const n = l.keys.length;
    const out = n <= this.tabW.length ? this.tabW : new Float64Array(n);
    if (t.fill) {
      const labels = l.fieldIndex.get('label')!;
      tabShares(
        n,
        t.optionW,
        this.p.boxes.w[i]!,
        t.weigh ? (j) => String(l.rows.get(l.keys[j]!)!.vals[labels] ?? '').length || 1 : () => 1,
        out,
      );
    } else for (let j = 0; j < n; j++) out[j] = t.optionW;
    return out;
  }

  private paintTabs(i: number, x: number, y: number, _w: number, h: number): void {
    const c = this.p.spec;
    const tk = this.tokens;
    const s = this.scale;
    const ctx = this.ctx!;
    const t = c.nodes[i] as SpecTabs;
    const l = this.p.model.lists[c.listOrd[i]!]!;
    const n = l.keys.length;
    if (n === 0) return;
    const out = this.shares(i);
    const sel = this.p.model.vals[c.keyIndex.get(t.selected.b)!];
    const labels = l.fieldIndex.get('label');
    this.faded(this.enabled(i, null), () => {
      let ox = x;
      for (let j = 0; j < n; j++) {
        const key = l.keys[j]!;
        const ow = Math.floor(out[j]!) * s;
        const on = key === sel;
        const r: PanelRect = { x: ox, y, w: ow, h };
        roundRectPath(ctx, ox, y, ow, h, j === 0 || j === n - 1 ? tk.radius * s : 0);
        ctx.fillStyle = on ? tk.surfaceOn : tk.surfaceAlt;
        ctx.fill();
        const bw = tk.borderWidth * s;
        ctx.strokeStyle = on ? tk.accent : tk.border;
        ctx.lineWidth = bw;
        roundRectPath(ctx, ox + bw / 2, y + bw / 2, ow - bw, h - bw, 0);
        ctx.stroke();
        this.tints(i, key, r);
        const row = l.rows.get(key);
        const label = labels === undefined || !row ? key : String(row.vals[labels] ?? '');
        this.line(
          label,
          this.font('label'),
          tk.text,
          ox + tk.padX * s,
          y + h / 2,
          ow - tk.padX * s * 2,
          'center',
        );
        this.ringIf(i, key, ox, y, ow, h);
        ox += out[j]! * s;
      }
    });
  }

  // Input.

  /** The pressable word at canvas px (x, y), and its row key (`hitKey`); -1: none. */
  private hitKey: string | null = null;
  private hit(px: number, py: number): number {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const ux = (px - this.rect.x) / this.scale;
    const uy = (py - this.rect.y) / this.scale;
    this.lastX = ux;
    this.lastY = uy;
    this.hitKey = null;
    if (this.given) return -1;
    const i = bx.hit(ux, uy);
    if (i === -1) return -1;
    const L = c.inList[i]!;
    if (L !== -1 && bx.hitRow >= 0) {
      this.hitKey = this.p.model.lists[c.listOrd[L]!]!.keys[bx.hitRow] ?? null;
    }
    if (c.kind[i] === K_TABS) {
      // Which option: by the shares from its box's left.
      const out = this.shares(i);
      const l = this.p.model.lists[c.listOrd[i]!]!;
      let ox = bx.x[i]!;
      for (let j = 0; j < l.keys.length; j++) {
        if (ux >= ox && ux < ox + out[j]!) {
          this.hitKey = l.keys[j]!;
          break;
        }
        ox += out[j]!;
      }
    }
    return i;
  }

  private isHeld(i: number): boolean {
    const n = this.p.spec.nodes[i]!;
    return (n.k === 'button' || n.k === 'slot') && n.press === 'held';
  }

  private holds(i: number): boolean {
    const n = this.p.spec.nodes[i]!;
    return (n.k === 'button' || n.k === 'slot') && n.hold === true;
  }

  private emit(
    i: number,
    row: string | null,
    type: PanelEvent['type'],
    value: PanelEvent['value'],
    one?: boolean,
  ): void {
    const id = i === -1 ? '' : this.p.spec.ids[i]!;
    this.p.emit(
      one === undefined
        ? { panel: this.p.spec.id, id, row, type, value }
        : { panel: this.p.spec.id, id, row, type, value, one },
    );
  }

  /** The DOM presenter's `tap`, word for word. */
  private tap(shift: boolean): void {
    const i = this.pressNode;
    if (i === -1) return;
    const node = this.p.spec.nodes[i]!;
    if (!this.enabled(i, this.pressRow)) return;
    if (node.k === 'tabs') {
      if (this.pressRow !== null) this.emit(i, this.pressRow, 'pick', this.pressRow);
      return;
    }
    if (node.k === 'button' && node.press === 'toggle') {
      const on = node.on ? this.val(node.on, this.rowOf(i, this.pressRow), i) === true : false;
      this.emit(i, this.pressRow, 'toggle', !on, shift || undefined);
      return;
    }
    if ((node.k === 'button' || node.k === 'slot') && node.press === 'held') return;
    this.emit(i, this.pressRow, 'tap', null, shift || undefined);
  }

  private letGo(): void {
    if (this.heldNode === -1) return;
    const i = this.heldNode;
    this.heldNode = -1;
    this.emit(i, this.heldRow, 'up', null);
  }

  /** @internal */
  pointerDown(px: number, py: number): void {
    const c = this.p.spec;
    if (c.held && this.heldPointers++ === 0) this.emit(-1, null, 'held', true);
    const i = this.hit(px, py);
    const row = this.hitKey;
    this.press.begin();
    this.markAt(this.pressNode, this.pressRow);
    this.pressNode = i;
    this.pressRow = row;
    if (i === -1) return;
    this.markAt(i, row);
    const k = c.kind[i]!;
    // Focus follows the press (the page focuses what a pointer presses).
    if (k === K_FIELD || k === K_RANGE || k === K_BUTTON || k === K_SLOT || k === K_TABS) {
      if (this.enabled(i, row)) this.setFocus(i, row);
    }
    if (k === K_RANGE) {
      if (this.enabled(i, row)) {
        this.dragNode = i;
        this.dragRow = row;
        this.dragTo(px);
      }
      return;
    }
    if (this.isHeld(i) && this.enabled(i, row)) {
      this.heldNode = i;
      this.heldRow = row;
      this.emit(i, row, 'down', null);
      return;
    }
    this.press.holds = this.holds(i) && this.enabled(i, row);
    this.press.down(this.lastX, this.lastY, 0);
  }

  /** @internal */
  pointerMove(px: number, py: number, down: boolean): void {
    if (down) {
      const ux = (px - this.rect.x) / this.scale;
      const uy = (py - this.rect.y) / this.scale;
      if (!Number.isNaN(ux)) this.press.move(ux, uy);
      if (this.dragNode !== -1 && !Number.isNaN(px)) this.dragTo(px);
      return;
    }
    const i = this.hit(px, py);
    const row = this.hitKey;
    if (i === this.hoverNode && row === this.hoverRow) return;
    this.markAt(this.hoverNode, this.hoverRow);
    this.hoverNode = i;
    this.hoverRow = row;
    this.markAt(i, row);
  }

  /** @internal */
  pointerUp(px: number, py: number, inside: boolean): void {
    const c = this.p.spec;
    this.press.cancel();
    this.letGo();
    if (c.held && this.heldPointers > 0 && --this.heldPointers === 0)
      this.emit(-1, null, 'held', false);
    const drag = this.dragNode;
    this.dragNode = -1;
    this.markAt(this.pressNode, this.pressRow);
    if (drag !== -1 || !inside || Number.isNaN(px)) return;
    const i = this.hit(px, py);
    if (i === -1 || i !== this.pressNode || this.hitKey !== this.pressRow) return;
    const k = c.kind[i]!;
    if (k === K_FIELD || k === K_RANGE) return;
    if (k === K_TABS && this.pressRow === null) return;
    this.press.click(false);
  }

  /** @internal The wheel (`dy` px) over the list or scroll col under the pointer. */
  wheel(dy: number): boolean {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const ux = this.lastX;
    const uy = this.lastY;
    if (Number.isNaN(ux)) return false;
    let best = -1;
    for (let i = 0; i < c.n; i++) {
      if (c.inList[i] !== -1 || bx.on[i] === 0) continue;
      if (c.kind[i] !== K_LIST && c.scrolls[i] !== 1) continue;
      const sc = c.scroller[i]!;
      const y0 = bx.y[i]! - (sc !== -1 ? bx.scroll[sc]! : 0);
      if (ux >= bx.x[i]! && ux < bx.x[i]! + bx.w[i]! && uy >= y0 && uy < y0 + bx.h[i]!) best = i;
    }
    if (best === -1) return false;
    const max = Math.max(0, bx.content[best]! - bx.h[best]!);
    const v = Math.min(max, Math.max(0, bx.scroll[best]! + dy / this.scale));
    if (v === bx.scroll[best]) return false;
    bx.scroll[best] = v;
    this.markNode(best, NO_ROW);
    this.emit(best, null, 'scroll', v);
    return true;
  }

  private dragTo(px: number): void {
    const i = this.dragNode;
    const n = this.p.spec.nodes[i] as SpecRange;
    if (!this.absRect(i, this.rowIndex(i, this.dragRow), this.scratch)) return;
    const r = this.scratch;
    const knob = 8 * this.scale;
    const f = Math.min(1, Math.max(0, (px - r.x - knob) / Math.max(1, r.w - knob * 2)));
    this.setRange(i, this.dragRow, n.min + Math.round((f * (n.max - n.min)) / n.step) * n.step);
  }

  private setRange(i: number, row: string | null, value: number): void {
    const n = this.p.spec.nodes[i] as SpecRange;
    const v = Math.min(n.max, Math.max(n.min, Math.round(value / n.step) * n.step));
    const was = this.rangeValue(i, n, this.rowOf(i, row));
    if (v === was) return;
    if (!n.value.b.startsWith('row.'))
      this.p.model.follow(this.p.spec.keyIndex.get(n.value.b)!, v, this);
    this.markAt(i, row);
    this.emit(i, row, 'change', v);
  }

  private rowIndex(i: number, row: string | null): number {
    const r = this.rowOf(i, row);
    return r ? r.index : NO_ROW;
  }

  // Focus and keys.

  /**
   * The page's tab order: every shown word that takes focus, in pre-order, list rows expanded;
   * of tabs, its selected option; disabled buttons, fields and ranges left out.
   */
  focusOrder(): { i: number; row: string | null }[] {
    const out: { i: number; row: string | null }[] = [];
    this.collect(0, null, out);
    return out;
  }

  private collect(i: number, row: SpecRow | null, out: { i: number; row: string | null }[]): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    if (bx.on[i] === 0 || !this.rowShows(i, row)) return;
    const k = c.kind[i]!;
    const rk = row ? row.key : null;
    if (k === K_LIST) {
      const l = this.p.model.lists[c.listOrd[i]!]!;
      const heads = c.head[i] !== -1;
      for (const key of l.keys) {
        const root = heads && key.charCodeAt(0) === 35 ? c.head[i]! : c.first[i]!;
        this.collect(root, l.rows.get(key) ?? null, out);
      }
      return;
    }
    if (k === K_TABS) {
      const sel = this.p.model.vals[c.keyIndex.get((c.nodes[i] as SpecTabs).selected.b)!];
      const l = this.p.model.lists[c.listOrd[i]!]!;
      if (this.enabled(i, null) && typeof sel === 'string' && l.rows.has(sel))
        out.push({ i, row: sel });
      return;
    }
    if (k === K_SLOT) out.push({ i, row: rk });
    else if ((k === K_BUTTON || k === K_FIELD || k === K_RANGE) && this.enabled(i, rk))
      out.push({ i, row: rk });
    for (let ch = c.first[i]!; ch !== -1 && k <= K_GRID; ch = c.next[ch]!)
      this.collect(ch, row, out);
  }

  private setFocus(i: number, row: string | null): void {
    if (i === this.focusNode && row === this.focusRow) return;
    const c = this.p.spec;
    const was = this.focusNode;
    const wasRow = this.focusRow;
    if (was !== -1 && was === this.heldNode) this.letGo();
    this.markAt(was, wasRow);
    this.focusNode = i;
    this.focusRow = row;
    this.markAt(i, row);
    if (was !== -1 && c.kind[was] === K_FIELD)
      this.emit(was, wasRow, 'blur', this.fieldValue(was, wasRow));
    if (i !== -1 && c.kind[i] === K_FIELD) this.emit(i, row, 'focus', this.fieldValue(i, row));
  }

  private step(dir: 1 | -1): void {
    const order = this.focusOrder();
    const n = order.length;
    if (n === 0) return;
    let at = -1;
    for (let j = 0; j < n; j++)
      if (order[j]!.i === this.focusNode && order[j]!.row === this.focusRow) at = j;
    const next = at === -1 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
    this.setFocus(order[next]!.i, order[next]!.row);
  }

  /** @internal The pad's A: Enter on the focused word. */
  activate(): void {
    this.key({ key: 'Enter' });
    this.keyUp({ key: 'Enter' });
  }

  /**
   * @internal A key (the focused surface's): Tab and Shift+Tab move focus through the words,
   * wrapping (the panel is a focus trap, as a modal on the page); Enter and Space press; a field
   * takes typing, Backspace and Enter; a range takes the arrows.
   */
  key(e: PanelKeyEvent): boolean {
    const c = this.p.spec;
    if (this.given) return false;
    if (e.key === 'Escape' && this.opts.onEscape) {
      this.opts.onEscape();
      return true;
    }
    if (e.key === 'Tab') {
      this.step(e.shiftKey ? -1 : 1);
      return true;
    }
    const i = this.focusNode;
    if ((i === -1 || c.kind[i] !== K_FIELD) && this.typeAhead(e)) return true;
    if (i === -1) return false;
    const row = this.focusRow;
    const k = c.kind[i]!;
    if (!this.enabled(i, row) && k !== K_SLOT) return false;
    if (k === K_FIELD) return this.fieldKey(i, row, e);
    if (k === K_RANGE) {
      const n = c.nodes[i] as SpecRange;
      const v = this.rangeValue(i, n, this.rowOf(i, row));
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.setRange(i, row, v - n.step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.setRange(i, row, v + n.step);
      else if (e.key === 'Home') this.setRange(i, row, n.min);
      else if (e.key === 'End') this.setRange(i, row, n.max);
      else return false;
      return true;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return false;
    if (this.isHeld(i)) {
      if (this.heldNode === -1) {
        this.heldNode = i;
        this.heldRow = row;
        this.emit(i, row, 'down', null);
      }
      return true;
    }
    // A keyboard's click: the page's click event (no pointerdown before it).
    if (i !== this.pressNode || row !== this.pressRow) this.press.begin();
    this.pressNode = i;
    this.pressRow = row;
    this.press.click(e.shiftKey === true);
    return true;
  }

  /**
   * The page's type-ahead (`SpecField.typeAhead`) while no field has focus: `/` focuses the field,
   * a plain letter is typed into it.
   */
  private typeAhead(e: PanelKeyEvent): boolean {
    const c = this.p.spec;
    const a = c.ahead;
    if (a === -1 || e.repeat || e.ctrlKey || e.metaKey) return false;
    if (this.p.boxes.on[a] !== 1 || !this.enabled(a, null)) return false;
    const f = c.nodes[a] as SpecField;
    if (e.key === '/') {
      this.setFocus(a, null);
      return true;
    }
    if (e.key.length !== 1 || !/\p{L}/u.test(e.key)) return false;
    if (f.closeKey !== undefined && e.code === f.closeKey) return false;
    this.setFocus(a, null);
    const v = this.fieldValue(a, null);
    if (f.max !== undefined && v.length >= f.max) return true;
    return this.typed(a, null, v + (f.kind === 'search' ? e.key.toLowerCase() : e.key));
  }

  private fieldKey(i: number, row: string | null, e: PanelKeyEvent): boolean {
    const c = this.p.spec;
    const f = c.nodes[i] as SpecField;
    const v = this.fieldValue(i, row);
    if (
      f.closeKey !== undefined &&
      e.code === f.closeKey &&
      v === '' &&
      !e.repeat &&
      !(this.opts.touching?.() ?? false)
    ) {
      this.emit(i, row, 'close', null);
      return true;
    }
    if (e.key === 'Enter') {
      if (f.kind === 'long' && !(e.ctrlKey || e.metaKey)) return this.typed(i, row, `${v}\n`);
      this.emit(i, row, 'enter', v);
      for (let j = 0; j < c.n; j++) {
        const n: SpecNode = c.nodes[j]!;
        if (n.k === 'button' && n.submits === f.id && this.enabled(j, null)) {
          this.emit(j, null, 'tap', null);
          break;
        }
      }
      return true;
    }
    if (e.key === 'Backspace') return v === '' ? true : this.typed(i, row, v.slice(0, -1));
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (f.max !== undefined && v.length >= f.max) return true;
      return this.typed(i, row, v + e.key);
    }
    return false;
  }

  private typed(i: number, row: string | null, v: string): boolean {
    const c = this.p.spec;
    const f = c.nodes[i] as SpecField;
    if (f.value && !f.value.b.startsWith('row.'))
      this.p.model.follow(c.keyIndex.get(f.value.b)!, v, this);
    else this.fieldText.set(`${i}|${row ?? ''}`, v);
    this.markAt(i, row);
    this.emit(i, row, 'input', v);
    return true;
  }
}

/**
 * Draws `panel` on `surface` (ws/ui-world): a world panel (`createWorldPanel`) in the scene, a
 * head-following screen (`worldScreen`) in a headset. Rays from the input's router press, hover
 * and scroll it once the surface is attached (`surface.attach(input)`); keys go to it through
 * `surface.key(e)` (and `presenter.keyUp(e)` for a held button's release). The events arrive on
 * `panel.onEvent`, the same as the page's.
 */
export function presentWorld(
  panel: SpecPanel,
  surface: WorldPanel,
  opts: WorldOptions = {},
): WorldPresenter {
  return new WorldPresenter(panel, surface, opts);
}
