/**
 * The DOM presenter (ws/ui-spec): draws a `SpecPanel` as real elements, one per word, each
 * absolutely placed at its box times `scale`. Buttons, slots and tabs are `<button>`s, a field an
 * `<input>` (or `<textarea>`), a range an `<input type=range>`, a meter `role=meter`: the browser's
 * own focus order, the overlay's `PadNav` and arrow keys, screen readers and the overlay's
 * control ids (`data-tc-id` is `<panel>/<word>`, `:<row>` in a list) all work as they do on the
 * overlay's widgets. A list is a real scroller whose rows are pooled by row key: a scroll writes
 * nothing, a resort moves rows, a changed field writes only the words that bind it.
 *
 * Each apply writes only what changed: every box when the layout ran, then each dirty key's bound
 * words and each dirty row's dirty fields. An idle frame never reaches it (`SpecPanel.apply`
 * returns first). `writes` counts what it wrote, for the budgets.
 */

import type { SpecModel, SpecRow, SpecValue } from './model';
import type { SpecPanel, SpecPresenter } from './panel';
import { SpecPressable, type SpecTimer } from './press';
import { type SpecTheme, theme } from './theme';
import {
  cut,
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
  R_AGAIN,
  R_BADGE,
  R_COUNT,
  R_ENABLED,
  R_ITEM,
  R_KEY,
  R_LABEL,
  R_MARK,
  R_ON,
  R_PLACEHOLDER,
  R_RING,
  R_SELECTED,
  R_SHOW,
  R_STATE,
  R_TEXT,
  R_TINT,
  R_VALUE,
  R_VALUETEXT,
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
  type SpecRange,
  type SpecSlot,
  type SpecStack,
  type SpecTabs,
  type SpecText,
  viewOf,
} from './words';

/** How a panel is drawn on the page. */
export interface DomOptions {
  /** CSS px per unit (default 1). `setScale` changes it. */
  scale?: number;
  /** Its look (default `theme()`). */
  theme?: SpecTheme;
  /**
   * `content` (default): the host is sized to the panel's boxes (frame it with `panel.frame(w, 0)`,
   * or `w` 0 for its natural width). `host`: the host's own size frames the panel (a
   * `ResizeObserver` calls `panel.frame`); give the host a size.
   */
  fit?: 'content' | 'host';
  /** Draws a slot's item (its picture) into `el`; '' is an empty slot. Default: its words. */
  slotArt?: (el: HTMLElement, item: string) => void;
  /** A clock for holds (tests). */
  timer?: SpecTimer;
}

const STYLE_ID = 'tc-spec-style';
const SVG = 'http://www.w3.org/2000/svg';

/** The structural sheet: placement, clamps and states, every colour a `--tcs-*` token. */
function css(): string {
  let types = '';
  for (const [style, t] of Object.entries(SPEC_TYPE)) {
    const fam = t.family === 'serif' ? 'serif' : t.family === 'mono' ? 'mono' : 'sans';
    types += `.tcs-t-${style}{font:${t.weight} calc(${t.px}px * var(--tcs-scale) * var(--tcs-text)) var(--tcs-font-${fam})}`;
  }
  return `
.tcs-host{position:relative;color:var(--tcs-text);font-family:var(--tcs-font-sans);box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.tcs-host *{box-sizing:border-box}
.tcs-w{position:absolute;margin:0}
.tcs-w[data-off]{display:none!important}
.tcs-btn,.tcs-slot,.tcs-tab,.tcs-field,.tcs-range,.tcs-scroll,.tcs-surface,.tcs-w[data-tc-id]{pointer-events:auto}
.tcs-surface{background:var(--tcs-surface);border:var(--tcs-border-width) solid var(--tcs-border);border-radius:var(--tcs-radius);box-shadow:var(--tcs-shadow)}
.tcs-scroll{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.tcs-inner{position:relative;width:100%}
.tcs-text{overflow:hidden;overflow-wrap:anywhere;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical}
.tcs-text[data-one]{display:block;white-space:nowrap;text-overflow:ellipsis}
.tcs-text[data-align=center]{text-align:center}.tcs-text[data-align=end]{text-align:end}
.tcs-t-note,.tcs-t-count{color:var(--tcs-text-muted)}.tcs-t-warn{color:var(--tcs-warn)}
.tcs-lit{color:var(--tcs-accent)}
.tcs-term{float:left;color:var(--tcs-text-muted)}
.tcs-flash{animation:tcs-flash 2.4s forwards}
@keyframes tcs-flash{0%,70%{opacity:1}100%{opacity:0}}
.tcs-again{animation:tcs-again var(--tcs-fast) ease-out}
@keyframes tcs-again{0%{filter:brightness(1.8)}100%{filter:none}}
.tcs-btn,.tcs-slot,.tcs-tab{appearance:none;font:inherit;color:inherit;background:var(--tcs-surface-alt);border:var(--tcs-border-width) solid var(--tcs-border);border-radius:var(--tcs-radius);display:flex;align-items:center;justify-content:center;gap:calc(6px * var(--tcs-scale));padding:0 var(--tcs-pad-x);cursor:pointer;overflow:hidden;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.tcs-btn .tcs-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tcs-btn[aria-pressed=true],.tcs-tab[aria-selected=true],.tcs-slot[data-state=on]{background:var(--tcs-surface-on);border-color:var(--tcs-accent)}
.tcs-btn:disabled,.tcs-slot[aria-disabled=true],.tcs-tablist[aria-disabled=true],.tcs-field:disabled,.tcs-range:disabled{opacity:.45;cursor:default}
.tcs-btn:focus-visible,.tcs-slot:focus-visible,.tcs-tab:focus-visible,.tcs-field:focus-visible,.tcs-range:focus-visible{outline:var(--tcs-focus-ring) solid var(--tcs-focus);outline-offset:1px}
.tcs-btn svg,.tcs-icon svg{width:1.4em;height:1.4em;flex:none}
.tcs-icon svg{width:100%;height:100%}
.tcs-icon path,.tcs-btn path{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.tcs-icon path[data-fill]{fill:currentColor;stroke:none}
.tcs-key{font-size:.8em;color:var(--tcs-text-muted);border:1px solid var(--tcs-border);border-radius:3px;padding:0 3px;line-height:1.3}
.tcs-slot{padding:0;position:absolute}
.tcs-slot .tcs-key{position:absolute;left:2px;top:2px;border:none;padding:0}
.tcs-slot .tcs-count{position:absolute;right:3px;bottom:1px;font-size:calc(11px * var(--tcs-scale) * var(--tcs-text));font-weight:600}
.tcs-slot .tcs-art{max-width:100%;padding:2px;font-size:calc(10px * var(--tcs-scale) * var(--tcs-text));text-align:center;overflow:hidden;overflow-wrap:anywhere}
.tcs-badge{position:absolute;right:-1px;top:-1px;min-width:1.4em;padding:0 3px;border-radius:9px;background:var(--tcs-accent);color:var(--tcs-accent-text);font-size:.75em;font-weight:700;line-height:1.4}
.tcs-badge:empty{display:none}
.tcs-ring{position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:conic-gradient(color-mix(in srgb,var(--tcs-accent) 35%,transparent) calc(var(--tcs-ring,0) * 1turn),transparent 0)}
.tcs-ring[data-ring=run]{animation:tcs-ring var(--tcs-ring-ms) linear forwards}
.tcs-ring[data-ring=full]{--tcs-ring:1}
@property --tcs-ring{syntax:'<number>';inherits:false;initial-value:0}
@keyframes tcs-ring{from{--tcs-ring:0}to{--tcs-ring:1}}
.tcs-meter{background:var(--tcs-track);border-radius:calc(var(--tcs-radius) / 2);overflow:visible}
.tcs-fill{position:absolute;inset:0;transform-origin:0 50%;background:var(--tcs-tint,var(--tcs-accent));border-radius:inherit;transition:transform var(--tcs-fast) ease-out}
.tcs-mark{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:var(--tcs-text)}
.tcs-icon{color:var(--tcs-tint,currentColor)}
.tcs-field{font:inherit;font-size:calc(13px * var(--tcs-scale) * var(--tcs-text));color:var(--tcs-text);background:var(--tcs-surface-alt);border:var(--tcs-border-width) solid var(--tcs-border);border-radius:var(--tcs-radius);padding:0 var(--tcs-pad-x);resize:none}
textarea.tcs-field{padding-top:6px}
.tcs-range{accent-color:var(--tcs-accent);padding:0}
.tcs-tablist{display:flex}
.tcs-tab{position:absolute;top:0;bottom:0;border-radius:0}
.tcs-tab:first-child{border-radius:var(--tcs-radius) 0 0 var(--tcs-radius)}
.tcs-tab:last-child{border-radius:0 var(--tcs-radius) var(--tcs-radius) 0}
.tcs-body[data-fade]{transition:opacity var(--tcs-fade) ease}
.tcs-body[data-gone]{opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){.tcs-host *{transition:none!important;animation-duration:1ms!important}}
${types}`;
}

/** Adds the structural sheet to `doc` once. */
function ensureSpecStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = css();
  doc.head.appendChild(s);
}

/** One word's elements in one view (the panel's own, or one list row's). */
interface Part {
  el: HTMLElement;
  /** Where its words go (a text's, a button's label). */
  text: HTMLElement | null;
  /** A scroll col's or a list's content. */
  inner: HTMLElement | null;
  count: HTMLElement | null;
  key: HTMLElement | null;
  badge: HTMLElement | null;
  fill: HTMLElement | null;
  ring: HTMLElement | null;
  marks: HTMLElement[] | null;
  input: HTMLInputElement | HTMLTextAreaElement | null;
  /** A text's term. */
  term: HTMLElement | null;
}

/** A view: the panel's, or a list row's (its words by node index; others null). */
interface View {
  readonly parts: (Part | null)[];
  /** The row's key (null: the panel's own view). */
  key: string | null;
  /** The row's element (a list row's root word's). */
  el: HTMLElement | null;
  /** Whether it is the heading word's. */
  head: boolean;
}

/** A list's (or tabs') rows on the page. */
interface ListView {
  readonly ord: number;
  readonly node: number;
  readonly byKey: Map<string, View>;
  readonly pool: View[];
  readonly headPool: View[];
}

/** Text with `{w}…{/}` runs lit. */
function writeMarked(el: HTMLElement, s: string): void {
  if (!s.includes('{')) {
    el.textContent = s;
    return;
  }
  el.textContent = '';
  const doc = el.ownerDocument;
  let lit = false;
  for (const piece of s.split(/(\{w\}|\{\/\})/)) {
    if (piece === '{w}') lit = true;
    else if (piece === '{/}') lit = false;
    else if (piece !== '') {
      if (lit) {
        const span = doc.createElement('span');
        span.className = 'tcs-lit';
        span.textContent = piece;
        el.appendChild(span);
      } else el.appendChild(doc.createTextNode(piece));
    }
  }
}

function glyph(doc: Document, icon: Pick<SpecIcon, 'glyph' | 'view'>): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  const [vw, vh] = viewOf(icon as SpecIcon);
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const part of partsOf(icon)) {
    const p = doc.createElementNS(SVG, 'path');
    p.setAttribute('d', part.d);
    if (part.cls) p.setAttribute('class', part.cls);
    if (!part.line) p.setAttribute('data-fill', '');
    svg.appendChild(p);
  }
  return svg;
}

function isBind(v: string | number | boolean | Bind): v is Bind {
  return typeof v === 'object';
}

/** The DOM presenter of one panel (`presentDom`). */
export class DomPresenter implements SpecPresenter {
  /** The host it draws in (given; `.tcs-host` is added). */
  readonly host: HTMLElement;
  /** DOM writes made (for the budgets): a property, an attribute, a style or a text each. */
  writes = 0;
  /** Rows built (a pool that grows); a row reused from the pool is not counted. */
  rowsBuilt = 0;
  private readonly p: SpecPanel;
  private readonly m: SpecModel;
  private readonly doc: Document;
  private scale: number;
  private readonly opts: DomOptions;
  private readonly top: View;
  private readonly lists: ListView[] = [];
  private readonly listOfNode: Int32Array;
  private fresh = true;
  private readonly press: SpecPressable;
  /** The word and row a press is on. */
  private pressNode = -1;
  private pressRow: string | null = null;
  /** A held button down now (its node and row), or -1. */
  private heldNode = -1;
  private heldRow: string | null = null;
  private heldPointers = 0;
  private readonly tabW = new Float64Array(32);
  private observer: ResizeObserver | null = null;
  private readonly off: (() => void)[] = [];
  private shown = true;

  constructor(panel: SpecPanel, host: HTMLElement, opts: DomOptions = {}) {
    this.p = panel;
    this.m = panel.model;
    this.host = host;
    this.doc = host.ownerDocument;
    this.opts = opts;
    this.scale = opts.scale ?? 1;
    ensureSpecStyles(this.doc);
    const c = panel.spec;
    this.listOfNode = new Int32Array(c.n).fill(-1);
    host.classList.add('tcs-host');
    host.setAttribute('data-tc-page', c.id);
    host.style.setProperty('--tcs-scale', String(this.scale));
    host.style.setProperty('--tcs-text', String(panel.text));
    for (const [k, v] of (opts.theme ?? theme()).vars) host.style.setProperty(k, v);
    if (c.fade > 0) host.style.setProperty('--tcs-fade', `${c.fade}ms`);
    this.top = { parts: new Array<Part | null>(c.n).fill(null), key: null, el: null, head: false };
    for (let i = 0; i < c.listNodes.length; i++) {
      const node = c.listNodes[i]!;
      this.listOfNode[node] = i;
      this.lists.push({ ord: i, node, byKey: new Map(), pool: [], headPool: [] });
    }
    this.build(0, this.top, host);
    const body = this.top.parts[0]!.el;
    body.classList.add('tcs-body');
    if (c.fade > 0) body.setAttribute('data-fade', '');
    this.press = new SpecPressable(false, opts.timer);
    this.press.onTap = (shift) => this.tap(shift);
    this.press.onHold = () => this.emit(this.pressNode, this.pressRow, 'hold', null);
    this.listen();
    if (opts.fit === 'host' && typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.fitHost());
      this.observer.observe(host);
      this.fitHost();
    }
    panel.presenters.push(this);
    // Drawn whole at the next apply (the model may hold values set before it came).
    this.m.relayout = true;
    this.m.changed();
  }

  /** CSS px per unit now. */
  get unitScale(): number {
    return this.scale;
  }

  /** Draws at `scale` CSS px per unit (every box written again at the next apply). */
  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.host.style.setProperty('--tcs-scale', String(scale));
    if (this.opts.fit === 'host') this.fitHost();
    this.m.relayout = true;
    this.m.changed();
  }

  apply(relaid: boolean): void {
    const c = this.p.spec;
    const m = this.m;
    if (this.fresh) {
      this.fresh = false;
      // Every key held, every list whole.
      for (let k = 0; k < c.keys.length; k++) if (m.vals[k] !== null) this.writeKey(k);
      for (let o = 0; o < this.lists.length; o++) this.sync(this.lists[o]!);
      this.placeAll();
    } else {
      for (let o = 0; o < this.lists.length; o++) {
        const lv = this.lists[o]!;
        const l = m.lists[o]!;
        // A resort or a new row, then the fields that changed in rows already drawn.
        if (l.order) this.sync(lv);
        if (l.dirtyN > 0) this.writeRows(lv);
      }
      if (relaid) this.placeAll();
      for (let j = 0; j < m.dirtyN; j++) this.writeKey(m.dirtyKeys[j]!);
    }
    if (m.focusing !== undefined) this.focusField(m.focusing);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const f of this.off) f();
    this.off.length = 0;
    this.press.cancel();
    this.host.textContent = '';
    this.host.classList.remove('tcs-host');
    const i = this.p.presenters.indexOf(this);
    if (i !== -1) this.p.presenters.splice(i, 1);
  }

  // Building.

  private part(el: HTMLElement): Part {
    return {
      el,
      text: null,
      inner: null,
      count: null,
      key: null,
      badge: null,
      fill: null,
      ring: null,
      marks: null,
      input: null,
      term: null,
    };
  }

  private span(cls: string, parent: HTMLElement): HTMLElement {
    const s = this.doc.createElement('span');
    s.className = cls;
    parent.appendChild(s);
    return s;
  }

  /** Builds word `i` (and its words) into `view`, its element appended to `parent`. */
  private build(i: number, view: View, parent: HTMLElement): void {
    const c = this.p.spec;
    const node = c.nodes[i]!;
    const doc = this.doc;
    const k = c.kind[i]!;
    let el: HTMLElement;
    let part: Part;
    switch (k) {
      case K_BUTTON: {
        const b = node as SpecButton;
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'tcs-btn';
        el = btn;
        part = this.part(el);
        if (b.icon) btn.appendChild(glyph(doc, { glyph: b.icon }));
        if (b.text !== undefined) {
          part.text = this.span('tcs-label tcs-t-label', btn);
          if (!isBind(b.text)) part.text.textContent = b.text;
        }
        if (b.keyLabel !== undefined) {
          part.key = this.span('tcs-key', btn);
          if (!isBind(b.keyLabel)) part.key.textContent = b.keyLabel;
        }
        if (b.badge) part.badge = this.span('tcs-badge', btn);
        if (b.ring) part.ring = this.span('tcs-ring', btn);
        if (b.press === 'toggle') btn.setAttribute('aria-pressed', 'false');
        break;
      }
      case K_SLOT: {
        const s = node as SpecSlot;
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'tcs-slot';
        el = btn;
        part = this.part(el);
        part.text = this.span('tcs-art', btn);
        if (s.keyLabel !== undefined) {
          part.key = this.span('tcs-key', btn);
          if (!isBind(s.keyLabel)) part.key.textContent = s.keyLabel;
        }
        if (s.count) part.count = this.span('tcs-count', btn);
        break;
      }
      case K_TEXT: {
        const t = node as SpecText;
        el = doc.createElement('div');
        el.className = `tcs-text tcs-t-${t.style}`;
        if (t.textAlign) el.setAttribute('data-align', t.textAlign);
        part = this.part(el);
        if (t.term !== undefined) {
          part.term = this.span('tcs-term', el);
          part.term.textContent = t.term;
          part.text = this.span('', el);
        } else part.text = el;
        if (!isBind(t.text)) {
          if (t.marked) writeMarked(part.text, t.text);
          else part.text.textContent = t.text;
        }
        break;
      }
      case K_METER: {
        const mt = node as SpecMeter;
        el = doc.createElement('div');
        el.className = 'tcs-meter';
        el.setAttribute('role', 'meter');
        el.setAttribute('aria-valuemin', '0');
        el.setAttribute('aria-valuemax', '1');
        part = this.part(el);
        part.fill = this.span('tcs-fill', el);
        if (!isBind(mt.value)) this.meterValue(part, mt.value);
        if (mt.marks) {
          part.marks = mt.marks.map((mk) => {
            const e = this.span(`tcs-mark${mk.cls ? ` ${mk.cls}` : ''}`, el);
            if (!isBind(mk.at)) e.style.left = `${mk.at * 100}%`;
            return e;
          });
        }
        break;
      }
      case K_ICON: {
        const ic = node as SpecIcon;
        el = doc.createElement('div');
        el.className = 'tcs-icon';
        el.appendChild(glyph(doc, ic));
        part = this.part(el);
        if (!ic.label) el.setAttribute('aria-hidden', 'true');
        else el.setAttribute('role', 'img');
        break;
      }
      case K_FIELD: {
        const f = node as SpecField;
        const input =
          f.kind === 'long' ? doc.createElement('textarea') : doc.createElement('input');
        if (input instanceof HTMLInputElement) {
          input.type = f.kind === 'search' ? 'search' : f.kind === 'url' ? 'url' : 'text';
          input.enterKeyHint = f.kind === 'chat' ? 'send' : f.kind === 'search' ? 'search' : 'done';
        }
        input.className = 'tcs-field';
        input.autocomplete = 'off';
        input.spellcheck = f.kind === 'long' || f.kind === 'chat';
        if (f.max) input.maxLength = f.max;
        if (f.placeholder !== undefined && !isBind(f.placeholder))
          input.placeholder = f.placeholder;
        el = input;
        part = this.part(el);
        part.input = input;
        break;
      }
      case K_RANGE: {
        const r = node as SpecRange;
        const input = doc.createElement('input');
        input.type = 'range';
        input.className = 'tcs-range';
        input.min = String(r.min);
        input.max = String(r.max);
        input.step = String(r.step);
        el = input;
        part = this.part(el);
        part.input = input;
        break;
      }
      case K_TABS: {
        el = doc.createElement('div');
        el.className = 'tcs-tablist';
        el.setAttribute('role', 'tablist');
        part = this.part(el);
        break;
      }
      case K_LIST: {
        el = doc.createElement('div');
        el.className = 'tcs-scroll';
        el.setAttribute('role', 'list');
        part = this.part(el);
        part.inner = doc.createElement('div');
        part.inner.className = 'tcs-inner';
        el.appendChild(part.inner);
        break;
      }
      default: {
        // A col, a row, a grid.
        const st = node as SpecStack;
        el = doc.createElement('div');
        part = this.part(el);
        if ((k === K_COL || k === K_ROW) && st.role) el.setAttribute('role', st.role);
        if (c.scrolls[i] === 1) {
          el.classList.add('tcs-scroll');
          part.inner = doc.createElement('div');
          part.inner.className = 'tcs-inner';
          el.appendChild(part.inner);
        }
        if (k === K_GRID && !node.label) el.setAttribute('role', 'group');
        break;
      }
    }
    el.classList.add('tcs-w');
    if (node.cls) for (const cl of node.cls.split(' ')) if (cl) el.classList.add(cl);
    el.setAttribute('data-tcs', String(i));
    const id = node.id;
    if (
      id &&
      (k === K_BUTTON ||
        k === K_SLOT ||
        k === K_FIELD ||
        k === K_RANGE ||
        (k <= K_ROW && (node as SpecStack).tap))
    ) {
      el.setAttribute(
        'data-tc-id',
        view.key === null ? `${c.id}/${id}` : `${c.id}/${id}:${view.key}`,
      );
    }
    if (node.label !== undefined && !isBind(node.label)) {
      el.setAttribute('aria-label', node.label);
      if (k !== K_TEXT) el.title = node.label;
    }
    if (node.tint !== undefined && !isBind(node.tint))
      el.style.setProperty('--tcs-tint', node.tint);
    view.parts[i] = part;
    parent.appendChild(el);
    if (k === K_COL || k === K_ROW || k === K_GRID) {
      const into = part.inner ?? el;
      for (let ch = c.first[i]!; ch !== -1; ch = c.next[ch]!) this.build(ch, view, into);
    }
  }

  // Placing.

  /** Every box: the panel's view, then every list row. */
  private placeAll(): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const s = this.scale;
    const host = this.host.style;
    const text = String(this.p.text);
    if (host.getPropertyValue('--tcs-text') !== text) {
      host.setProperty('--tcs-text', text);
      this.writes++;
    }
    if (this.opts.fit !== 'host') {
      host.width = `${bx.w[0]! * s}px`;
      host.height = `${bx.h[0]! * s}px`;
      this.writes += 2;
    }
    this.placeView(this.top, 0, c.n);
    for (let o = 0; o < this.lists.length; o++) this.placeRows(this.lists[o]!);
  }

  /** Places the words `from` (and its subtree, up to `end`) of `view`. */
  private placeView(view: View, from: number, end: number): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const s = this.scale;
    for (let i = from; i < end; i++) {
      const part = view.parts[i];
      if (!part) continue;
      // The panel's view leaves list rows to their own views.
      if (view.key === null && c.inList[i] !== -1) continue;
      const st = part.el.style;
      const on = bx.on[i] === 1;
      if (i === 0 && view.key === null) {
        // The body: the host's box; hidden by its show (faded with `fade`).
        if (on !== this.shown) {
          this.shown = on;
          if (c.fade > 0) part.el.toggleAttribute('data-gone', !on);
          else part.el.toggleAttribute('data-off', !on);
          this.writes++;
        }
      } else if (!on) {
        part.el.setAttribute('data-off', '');
        this.writes++;
        continue;
      } else if (part.el.hasAttribute('data-off')) {
        part.el.removeAttribute('data-off');
        this.writes++;
      }
      const p = c.parent[i]!;
      // The row's root sits at its cell (placed by `placeRows`).
      const rowRoot = view.key !== null && (p === -1 || c.kind[p] === K_LIST);
      if (!rowRoot) {
        const ox = p === -1 ? 0 : bx.x[p]!;
        const oy = p === -1 ? 0 : bx.y[p]!;
        st.left = `${(bx.x[i]! - ox) * s}px`;
        st.top = `${(bx.y[i]! - oy) * s}px`;
        this.writes += 2;
      }
      st.width = `${bx.w[i]! * s}px`;
      st.height = `${bx.h[i]! * s}px`;
      this.writes += 2;
      const k = c.kind[i]!;
      if (k === K_TEXT) {
        const lines = bx.lines[i]!;
        st.lineHeight = `${bx.lineH[i]! * s}px`;
        st.setProperty('-webkit-line-clamp', String(lines));
        part.el.toggleAttribute('data-one', lines === 1 && c.termW[i] === 0);
        if (part.term) part.term.style.width = `${bx.termW[i]! * s}px`;
        this.writes += 3;
      } else if (part.inner && k !== K_LIST) {
        part.inner.style.height = `${Math.max(bx.content[i]!, bx.h[i]!) * s}px`;
        this.writes++;
      } else if (k === K_TABS) this.placeTabs(i);
    }
  }

  /** A list's content height and each row at its cell. */
  private placeRows(lv: ListView): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const s = this.scale;
    const i = lv.node;
    if (c.kind[i] === K_TABS) return;
    const part = this.top.parts[i]!;
    part.inner!.style.height = `${bx.content[i]! * s}px`;
    this.writes++;
    const keys = this.m.lists[lv.ord]!.keys;
    const first = c.first[i]!;
    const head = c.head[i]!;
    const end = head !== -1 ? head : this.subtreeEnd(first);
    const headEnd = head !== -1 ? this.subtreeEnd(head) : end;
    const cols = (c.nodes[i] as SpecList).cols ?? 1;
    const gap = c.gap[i]!;
    const tops = head !== -1 ? bx.tops(i) : null;
    for (let r = 0; r < keys.length; r++) {
      const v = lv.byKey.get(keys[r]!)!;
      const st = v.el!.style;
      const x = cols === 1 ? 0 : (r % cols) * (bx.cellW[i]! + gap);
      const y = tops ? tops[r]! : Math.floor(r / cols) * (bx.rowH[i]! + gap);
      st.left = `${x * s}px`;
      st.top = `${y * s}px`;
      this.writes += 2;
      if (v.head) this.placeView(v, head, headEnd);
      else this.placeView(v, first, end);
    }
  }

  /** The tabs' options across its box (`fill`: shared by `tabShares`). */
  private placeTabs(i: number): void {
    const c = this.p.spec;
    const bx = this.p.boxes;
    const t = c.nodes[i] as SpecTabs;
    const lv = this.lists[c.listOrd[i]!]!;
    const l = this.m.lists[lv.ord]!;
    const n = l.keys.length;
    if (n === 0) return;
    const w = bx.w[i]!;
    const out = n <= this.tabW.length ? this.tabW : new Float64Array(n);
    if (t.fill) {
      const labels = l.fieldIndex.get('label')!;
      tabShares(
        n,
        t.optionW,
        w,
        t.weigh ? (j) => String(l.rows.get(l.keys[j]!)!.vals[labels] ?? '').length || 1 : () => 1,
        out,
      );
    } else for (let j = 0; j < n; j++) out[j] = t.optionW;
    let x = 0;
    for (let j = 0; j < n; j++) {
      const st = lv.byKey.get(l.keys[j]!)!.el!.style;
      st.left = `${x * this.scale}px`;
      st.width = `${cut(out[j]!) * this.scale}px`;
      x += out[j]!;
      this.writes += 2;
    }
  }

  private subtreeEnd(i: number): number {
    const c = this.p.spec;
    // Pre-order: a subtree ends at the next node whose parent chain leaves `i`.
    let e = i + 1;
    while (e < c.n && this.within(e, i)) e++;
    return e;
  }

  private within(j: number, i: number): boolean {
    const c = this.p.spec;
    for (let p = j; p !== -1; p = c.parent[p]!) if (p === i) return true;
    return false;
  }

  // Lists.

  /** A list's rows are its keys now: rows kept by key, new ones from the pool, gone ones back. */
  private sync(lv: ListView): void {
    const c = this.p.spec;
    const l = this.m.lists[lv.ord]!;
    const isTabs = c.kind[lv.node] === K_TABS;
    const part = this.top.parts[lv.node]!;
    const into = isTabs ? part.el : part.inner!;
    const scroller = part.el;
    // Following its end (`tail`): at its end before, at its end after.
    const tail = !isTabs && (c.nodes[lv.node] as SpecList).tail === true;
    const atEnd = tail && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    // Rows no longer listed go back to their pools.
    for (const [key, v] of lv.byKey) {
      const r = l.rows.get(key);
      if (r !== undefined && r.index !== -1 && l.keys[r.index] === key) continue;
      lv.byKey.delete(key);
      v.el!.setAttribute('data-off', '');
      (v.head ? lv.headPool : lv.pool).push(v);
      this.writes++;
    }
    const head = c.head[lv.node]!;
    for (let r = 0; r < l.keys.length; r++) {
      const key = l.keys[r]!;
      const isHead = head !== -1 && key.charCodeAt(0) === 35;
      let v = lv.byKey.get(key);
      if (!v) {
        v = (isHead ? lv.headPool : lv.pool).pop() ?? this.newRow(lv, isHead, into);
        v.key = key;
        v.el!.removeAttribute('data-off');
        v.el!.setAttribute('data-tcs-row', key);
        if (isTabs) v.el!.setAttribute('data-tc-id', `${c.id}/${c.ids[lv.node]}:${key}`);
        else this.rekey(v);
        lv.byKey.set(key, v);
        this.writes += 2;
        this.writeRowAll(lv, v, l.rows.get(key)!);
      }
      // Keep the DOM order the list's (focus order, screen readers).
      if (into.children[r] !== v.el) {
        into.insertBefore(v.el!, into.children[r] ?? null);
        this.writes++;
      }
    }
    // Top-level keys bound inside rows: written into the new rows.
    for (let k = 0; k < c.keys.length; k++) {
      if (this.m.vals[k] === null) continue;
      const binds = c.keyBinds[k]!;
      for (let j = 0; j < binds.length; j += 2)
        if (c.inList[binds[j]!] === lv.node) this.writeKey(k);
    }
    if (isTabs) {
      // The selected option.
      const sel = c.keyIndex.get((c.nodes[lv.node] as SpecTabs).selected.b)!;
      this.writeKey(sel);
    } else {
      if (l.how === 'top') scroller.scrollTop = 0;
      else if (atEnd) scroller.scrollTop = scroller.scrollHeight;
    }
    // Rows moved: placed again (the layout may not have run: a fixed-height list).
    if (!this.m.relayout) {
      if (isTabs) this.placeTabs(lv.node);
      else this.placeRows(lv);
    }
  }

  private newRow(lv: ListView, isHead: boolean, into: HTMLElement): View {
    const c = this.p.spec;
    const v: View = {
      parts: new Array<Part | null>(c.n).fill(null),
      key: '',
      el: null,
      head: isHead,
    };
    this.rowsBuilt++;
    if (c.kind[lv.node] === K_TABS) {
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'tcs-tab tcs-w';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('data-tcs', String(lv.node));
      const part = this.part(btn);
      part.text = this.span('tcs-label tcs-t-label', btn);
      v.parts[lv.node] = part;
      v.el = btn;
      into.appendChild(btn);
      return v;
    }
    const root = isHead ? c.head[lv.node]! : c.first[lv.node]!;
    this.build(root, v, into);
    v.el = v.parts[root]!.el;
    v.el.setAttribute('role', 'listitem');
    v.el.setAttribute('data-tcs-list', String(lv.ord));
    // Its words are placed now (a row from the pool keeps its boxes).
    const end = this.subtreeEnd(root);
    this.placeView(v, root, end);
    return v;
  }

  /** A pooled row's control ids follow its new key. */
  private rekey(v: View): void {
    const c = this.p.spec;
    for (let i = 0; i < v.parts.length; i++) {
      const part = v.parts[i];
      if (!part?.el.hasAttribute('data-tc-id')) continue;
      part.el.setAttribute('data-tc-id', `${c.id}/${c.ids[i]}:${v.key}`);
    }
  }

  /** Every field of row `r` into view `v` (a new or reused row). */
  private writeRowAll(lv: ListView, v: View, r: SpecRow): void {
    const c = this.p.spec;
    const binds = c.fieldBinds[lv.ord]!;
    for (let f = 0; f < binds.length; f++) {
      const val = r.vals[f];
      if (val === null || val === undefined) continue;
      const b = binds[f]!;
      for (let j = 0; j < b.length; j += 2) {
        const node = b[j]!;
        const part = v.parts[node];
        if (part) this.write(part, node, b[j + 1]!, val);
      }
    }
  }

  /** Each dirty row's dirty fields. */
  private writeRows(lv: ListView): void {
    const c = this.p.spec;
    const l = this.m.lists[lv.ord]!;
    const binds = c.fieldBinds[lv.ord]!;
    for (let d = 0; d < l.dirtyN; d++) {
      const r = l.dirtyRows[d]!;
      const v = lv.byKey.get(r.key);
      if (!v) continue;
      for (let f = 0; f < binds.length; f++) {
        if ((r.dirty & (1 << f)) === 0) continue;
        const val = r.vals[f]!;
        const b = binds[f]!;
        for (let j = 0; j < b.length; j += 2) {
          const node = b[j]!;
          const part = v.parts[node];
          if (part) this.write(part, node, b[j + 1]!, val);
        }
      }
      // A tabs' option's label moves the shares.
      if (c.kind[lv.node] === K_TABS && (c.nodes[lv.node] as SpecTabs).weigh)
        this.placeTabs(lv.node);
    }
  }

  // Writing.

  /** Key `k`'s value into every word it binds (in each row, for a word in a list's row). */
  private writeKey(k: number): void {
    const c = this.p.spec;
    const v = this.m.vals[k];
    if (v === null || v === undefined) return;
    const binds = c.keyBinds[k]!;
    for (let j = 0; j < binds.length; j += 2) {
      const node = binds[j]!;
      const role = binds[j + 1]!;
      const list = c.inList[node]!;
      if (list === -1) {
        const part = this.top.parts[node];
        if (part) this.write(part, node, role, v);
      } else {
        for (const view of this.lists[c.listOrd[list]!]!.byKey.values()) {
          const part = view.parts[node];
          if (part) this.write(part, node, role, v);
        }
      }
    }
  }

  private meterValue(part: Part, v: number): void {
    const x = v < 0 ? 0 : Math.min(v, 1);
    part.fill!.style.transform = `scaleX(${x})`;
    part.el.setAttribute('aria-valuenow', String(Math.round(x * 1000) / 1000));
    this.writes += 2;
  }

  /** Writes value `v` in role `role` of word `i`'s elements `part`. */
  private write(part: Part, i: number, role: number, v: SpecValue): void {
    const el = part.el;
    const c = this.p.spec;
    const k = c.kind[i]!;
    this.writes++;
    switch (role) {
      case R_TEXT: {
        const s = String(v);
        if (k === K_TEXT && (c.nodes[i] as SpecText).marked) writeMarked(part.text!, s);
        else part.text!.textContent = s;
        if (k === K_TEXT && (c.nodes[i] as SpecText).flash) {
          el.classList.remove('tcs-flash');
          if (s !== '') {
            void el.offsetWidth;
            el.classList.add('tcs-flash');
          }
        }
        return;
      }
      case R_VALUE:
        if (k === K_METER) {
          this.writes--;
          this.meterValue(part, Number(v));
        } else if (part.input && part.input.value !== String(v)) part.input.value = String(v);
        return;
      case R_SHOW:
        // A row field's show (a top-level show moves boxes: the layout's).
        el.toggleAttribute('data-off', v !== true);
        return;
      case R_STATE:
        if (v === '') el.removeAttribute('data-state');
        else el.setAttribute('data-state', String(v));
        return;
      case R_LABEL:
        el.setAttribute('aria-label', String(v));
        if (k !== K_TEXT) el.title = String(v);
        return;
      case R_ON:
        el.setAttribute('aria-pressed', v === true ? 'true' : 'false');
        return;
      case R_ENABLED:
        if (part.input) part.input.disabled = v !== true;
        else if (el instanceof HTMLButtonElement && k === K_BUTTON) el.disabled = v !== true;
        else el.setAttribute('aria-disabled', v === true ? 'false' : 'true');
        if (k === K_TABS) {
          const lv = this.lists[c.listOrd[i]!]!;
          for (const o of lv.byKey.values()) (o.el as HTMLButtonElement).disabled = v !== true;
        }
        return;
      case R_BADGE:
        part.badge!.textContent = String(v);
        return;
      case R_PLACEHOLDER:
        if (part.input) part.input.placeholder = String(v);
        return;
      case R_ITEM: {
        const item = String(v);
        if (this.opts.slotArt) this.opts.slotArt(part.text!, item);
        else part.text!.textContent = item;
        el.toggleAttribute('data-empty', item === '');
        const label = (c.nodes[i] as SpecSlot).label;
        if (label === undefined) el.setAttribute('aria-label', item === '' ? 'empty' : item);
        return;
      }
      case R_COUNT:
        part.count!.textContent = v === 0 || v === 1 || v === '' ? '' : String(v);
        return;
      case R_SELECTED: {
        const lv = this.lists[c.listOrd[i]!]!;
        for (const [key, o] of lv.byKey) {
          const sel = key === v;
          o.el!.setAttribute('aria-selected', sel ? 'true' : 'false');
          o.el!.tabIndex = sel ? 0 : -1;
        }
        return;
      }
      case R_TINT:
        el.style.setProperty('--tcs-tint', String(v));
        return;
      case R_RING: {
        const ring = part.ring!;
        const n = Number(v);
        ring.removeAttribute('data-ring');
        if (n > 0) {
          ring.style.setProperty('--tcs-ring-ms', `${n}ms`);
          void ring.offsetWidth;
          ring.setAttribute('data-ring', 'run');
        } else if (n < 0) ring.setAttribute('data-ring', 'full');
        return;
      }
      case R_KEY:
        part.key!.textContent = String(v);
        return;
      case R_VALUETEXT:
        el.setAttribute('aria-valuetext', String(v));
        return;
      case R_AGAIN:
        el.classList.remove('tcs-again');
        void el.offsetWidth;
        el.classList.add('tcs-again');
        return;
      default:
        if (role >= R_MARK && part.marks) {
          const m = (role - R_MARK) % 3;
          const mark = part.marks[Math.floor((role - R_MARK) / 3)]!;
          if (m === 0) mark.style.left = `${Number(v) * 100}%`;
          else if (m === 1) mark.setAttribute('data-state', String(v));
          else mark.title = String(v);
          return;
        }
        // A bound line count or maxRows: the layout's.
        this.writes--;
    }
  }

  private focusField(id: string | null): void {
    const c = this.p.spec;
    if (id === null) {
      const a = this.doc.activeElement;
      if (a instanceof HTMLElement && this.host.contains(a)) a.blur();
      return;
    }
    const i = c.ids.indexOf(id);
    const part = i === -1 ? null : this.top.parts[i];
    part?.el.focus();
  }

  private fitHost(): void {
    const r = this.host.getBoundingClientRect();
    this.p.frame(r.width / this.scale, r.height / this.scale, this.p.text);
  }

  // Events.

  /** The word and row an event is on: [node, row key] (node -1: none). */
  private target(e: Event): [number, string | null] {
    const t = e.target;
    if (!(t instanceof Element)) return [-1, null];
    const w = t.closest('[data-tcs]');
    if (!w || !this.host.contains(w)) return [-1, null];
    const row = w.closest('[data-tcs-row]');
    return [Number(w.getAttribute('data-tcs')), row ? row.getAttribute('data-tcs-row') : null];
  }

  /** The pressable word an event is on: itself, or a tap stack it is in. */
  private pressTarget(e: Event): [number, string | null] {
    const [i, row] = this.target(e);
    if (i === -1) return [-1, null];
    const c = this.p.spec;
    for (let j = i; j !== -1; j = c.parent[j]!) {
      const k = c.kind[j]!;
      if (k === K_BUTTON || k === K_SLOT || k === K_TABS) return [j, row];
      if ((k === K_COL || k === K_ROW) && (c.nodes[j] as SpecStack).tap) return [j, row];
      if (k === K_LIST) break;
    }
    // A tap stack the row is in (a row's word that is no button, in a tap row).
    return [-1, null];
  }

  private enabled(i: number, row: string | null): boolean {
    const node = this.p.spec.nodes[i] as { enabled?: { b: string } };
    if (!node.enabled) return true;
    const key = node.enabled.b;
    if (key.startsWith('row.') && row !== null) {
      const lo = this.p.spec.inList[i]!;
      return (
        this.m.list(this.p.spec.listIds[this.p.spec.listOrd[lo]!]!).row(row).get(key.slice(4)) ===
        true
      );
    }
    return this.m.get(key) === true;
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

  private tap(shift: boolean): void {
    const i = this.pressNode;
    if (i === -1) return;
    const c = this.p.spec;
    const node = c.nodes[i]!;
    if (!this.enabled(i, this.pressRow)) return;
    if (node.k === 'tabs') {
      if (this.pressRow !== null) this.emit(i, this.pressRow, 'pick', this.pressRow);
      return;
    }
    if (node.k === 'button' && node.press === 'toggle') {
      const on = node.on ? this.m.get(node.on.b) === true : false;
      this.emit(i, this.pressRow, 'toggle', !on, shift || undefined);
      return;
    }
    if (node.k === 'button' && node.press === 'held') return;
    this.emit(i, this.pressRow, 'tap', null, shift || undefined);
  }

  private holds(i: number): boolean {
    const n = this.p.spec.nodes[i]!;
    return (n.k === 'button' || n.k === 'slot') && n.hold === true;
  }

  private isHeld(i: number): boolean {
    const n = this.p.spec.nodes[i]!;
    return n.k === 'button' && n.press === 'held';
  }

  private letGo(): void {
    if (this.heldNode === -1) return;
    const i = this.heldNode;
    this.heldNode = -1;
    this.emit(i, this.heldRow, 'up', null);
  }

  private on<K extends keyof HTMLElementEventMap>(
    type: K,
    f: (e: HTMLElementEventMap[K]) => void,
    target: HTMLElement | Document = this.host,
  ): void {
    const g = f as EventListener;
    target.addEventListener(type, g);
    this.off.push(() => target.removeEventListener(type, g));
  }

  private listen(): void {
    const c = this.p.spec;
    this.on('pointerdown', (e) => {
      if (c.held && this.heldPointers++ === 0) this.emit(-1, null, 'held', true);
      const [i, row] = this.pressTarget(e);
      this.press.begin();
      if (i === -1) return;
      this.pressNode = i;
      this.pressRow = row;
      if (this.isHeld(i) && e.button === 0 && this.enabled(i, row)) {
        this.heldNode = i;
        this.heldRow = row;
        this.emit(i, row, 'down', null);
        return;
      }
      this.press.holds = this.holds(i) && this.enabled(i, row);
      this.press.down(e.clientX, e.clientY, e.button);
    });
    this.on('pointermove', (e) => this.press.move(e.clientX, e.clientY));
    const up = (): void => {
      this.press.cancel();
      this.letGo();
    };
    this.on('pointerup', up);
    this.on('pointercancel', up);
    this.on('pointerleave', () => this.press.cancel());
    const release = (): void => {
      if (c.held && this.heldPointers > 0 && --this.heldPointers === 0)
        this.emit(-1, null, 'held', false);
    };
    this.on('pointerup', release, this.doc);
    this.on('pointercancel', release, this.doc);
    this.on('click', (e) => {
      const [i, row] = this.pressTarget(e);
      if (i === -1) return;
      // A keyboard's click (Enter, Space) or a pad's (PadNav) has no pointerdown.
      if (i !== this.pressNode || row !== this.pressRow) this.press.begin();
      this.pressNode = i;
      this.pressRow = row;
      const tab = c.kind[i] === K_TABS ? (e.target as Element).closest('[data-tcs-row]') : null;
      if (c.kind[i] === K_TABS && !tab) return;
      this.press.click(e.shiftKey);
    });
    this.on('contextmenu', (e) => {
      const [i, row] = this.pressTarget(e);
      if (i === -1 || !this.holds(i)) return;
      e.preventDefault();
      this.pressNode = i;
      this.pressRow = row;
      this.press.holds = this.enabled(i, row);
      this.press.context();
    });
    this.on('keydown', (e) => {
      const [i, row] = this.target(e);
      if (i === -1) return;
      const k = c.kind[i]!;
      if (this.isHeld(i) && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (!e.repeat && this.heldNode === -1 && this.enabled(i, row)) {
          this.heldNode = i;
          this.heldRow = row;
          this.emit(i, row, 'down', null);
        }
        return;
      }
      if (k === K_FIELD && e.key === 'Enter' && !e.isComposing) {
        const f = c.nodes[i] as SpecField;
        if (f.kind === 'long' && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const value = (e.target as HTMLInputElement).value;
        this.emit(i, row, 'enter', value);
        // A button that this field submits: pressed.
        for (let j = 0; j < c.n; j++) {
          const n = c.nodes[j]!;
          if (n.k === 'button' && n.submits === f.id && this.enabled(j, null)) {
            this.emit(j, null, 'tap', null);
            break;
          }
        }
      }
    });
    this.on('keyup', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && this.heldNode !== -1) this.letGo();
    });
    this.on('focusout', (e) => {
      const [i, row] = this.target(e);
      if (i === -1) return;
      if (i === this.heldNode) this.letGo();
      if (c.kind[i] === K_FIELD) this.emit(i, row, 'blur', (e.target as HTMLInputElement).value);
    });
    this.on('focusin', (e) => {
      const [i, row] = this.target(e);
      if (i !== -1 && c.kind[i] === K_FIELD)
        this.emit(i, row, 'focus', (e.target as HTMLInputElement).value);
    });
    this.on('input', (e) => {
      const [i, row] = this.target(e);
      if (i === -1) return;
      const k = c.kind[i]!;
      const input = e.target as HTMLInputElement;
      if (k === K_FIELD) {
        const f = c.nodes[i] as SpecField;
        if (f.value && !f.value.b.startsWith('row.'))
          this.m.follow(c.keyIndex.get(f.value.b)!, input.value);
        this.emit(i, row, 'input', input.value);
      } else if (k === K_RANGE) {
        const r = c.nodes[i] as SpecRange;
        const v = Number(input.value);
        if (!r.value.b.startsWith('row.')) this.m.follow(c.keyIndex.get(r.value.b)!, v);
        this.emit(i, row, 'change', v);
      }
    });
    // A scroll moves nothing: the boxes hear of it (a world presenter's hit test reads it).
    this.host.addEventListener(
      'scroll',
      (e) => {
        const [i] = this.target(e);
        if (i === -1) return;
        const k = c.kind[i]!;
        if (k === K_LIST || c.scrolls[i] === 1) {
          this.p.boxes.scroll[i] = (e.target as HTMLElement).scrollTop / this.scale;
        }
      },
      { capture: true, passive: true },
    );
  }
}

/**
 * Draws `panel` in `host` (ws/ui-spec): real elements at the panel's boxes, written only where the
 * model changed. Frame the panel (`panel.frame(w, 0)`; `w` 0 for its natural width) unless
 * `fit: 'host'`. Its events arrive on `panel.onEvent`. `dispose()` takes it down.
 */
export function presentDom(
  panel: SpecPanel,
  host: HTMLElement,
  opts: DomOptions = {},
): DomPresenter {
  return new DomPresenter(panel, host, opts);
}
