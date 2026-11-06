/**
 * World-panel widgets: painted with Canvas2D from theme tokens, hit by panel px. Each widget
 * owns its options; `set(patch)` writes only the fields that changed and marks its rect dirty, so
 * a game may call it every tick. Hover, pressed and focus are flags the panel sets before a paint.
 */
import type { PanelRect } from './layout';
import type { Painter, PanelTheme } from './paint';

/** Where a widget lives: it asks for a repaint of its rect or a new layout pass. */
export interface WorldWidgetHost {
  readonly painter: Painter;
  invalidate(widget: WorldWidget): void;
  relayout(): void;
}

export type WorldWidgetTone = 'text' | 'muted' | 'accent' | 'info' | 'success' | 'warn' | 'danger';
export type WorldWidgetSize = 's' | 'm' | 'l';
export type WorldWidgetAlign = 'left' | 'center' | 'right';

/** A key event the panel forwards (`KeyboardEvent` fits). */
export interface PanelKeyEvent {
  key: string;
  shiftKey?: boolean;
}

const HOVER_TINT = 'rgba(255, 255, 255, 0.07)';
const PRESS_TINT = 'rgba(0, 0, 0, 0.18)';
const DISABLED_ALPHA = 0.45;

function toneColor(t: PanelTheme, tone: WorldWidgetTone | undefined): string {
  const k = t.tokens;
  switch (tone) {
    case 'muted':
      return k.colorTextMuted;
    case 'accent':
      return k.colorAccent;
    case 'info':
      return k.colorInfo;
    case 'success':
      return k.colorSuccess;
    case 'warn':
      return k.colorWarn;
    case 'danger':
      return k.colorDanger;
    default:
      return k.colorText;
  }
}

function fontSize(t: PanelTheme, size: WorldWidgetSize | undefined): number {
  return size === 's' ? t.fontSizeS : size === 'l' ? t.fontSizeL : t.fontSizeM;
}

/**
 * Base of every panel widget. `O` is its options object; subclasses say which keys change the
 * height (`layoutKeys`) so `set` can ask for a layout pass only then.
 */
export abstract class WorldWidget<O extends object = object> {
  /** An explicit place in panel px; `null` lets the flow place it. */
  rect: PanelRect | null = null;
  /** Where the panel put it (the flow or `rect`). */
  readonly layoutRect: PanelRect = { x: 0, y: 0, w: 0, h: 0 };
  hover = false;
  pressed = false;
  focused = false;
  /** @internal set by the panel on `add`. */
  host: WorldWidgetHost | null = null;
  protected theme: PanelTheme | null = null;
  protected readonly opts: O;
  protected readonly layoutKeys: ReadonlySet<string>;

  protected constructor(opts: O, layoutKeys: readonly (keyof O & string)[] = []) {
    this.opts = opts;
    this.layoutKeys = new Set(layoutKeys);
    const r = (opts as { rect?: PanelRect }).rect;
    if (r) this.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  /** The current options (read-only view). */
  get options(): Readonly<O> {
    return this.opts;
  }

  /** Whether the widget takes focus and pointer presses. */
  get focusable(): boolean {
    return false;
  }

  /** Disabled widgets paint faded and ignore input. */
  get disabled(): boolean {
    return (this.opts as { disabled?: boolean }).disabled === true;
  }

  /** @internal */
  attach(host: WorldWidgetHost): void {
    this.host = host;
    this.theme = host.painter.theme;
  }

  /** @internal */
  detach(): void {
    this.host = null;
    this.hover = false;
    this.pressed = false;
    this.focused = false;
  }

  /** Mark the widget's rect dirty. */
  invalidate(): void {
    this.host?.invalidate(this);
  }

  /**
   * Write the fields of `patch` that differ (`!==`) from the current options. Only a change marks
   * the rect dirty; a change to a layout key also re-runs the flow. Returns whether anything changed.
   */
  set(patch: Partial<O>): boolean {
    let changed = false;
    let relayout = false;
    const o = this.opts as Record<string, unknown>;
    for (const key of Object.keys(patch) as (keyof O & string)[]) {
      const v = (patch as Record<string, unknown>)[key];
      if (o[key] === v) continue;
      o[key] = v;
      changed = true;
      if (this.layoutKeys.has(key)) relayout = true;
      if (key === 'rect') {
        const r = v as PanelRect | null | undefined;
        this.rect = r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
        relayout = true;
      }
    }
    if (changed) {
      this.changed();
      if (relayout) this.host?.relayout();
      else this.invalidate();
    }
    return changed;
  }

  /** Hook after `set` wrote something (clamp derived state). */
  protected changed(): void {}

  /** The height wanted for `width` px (needs the theme, so after `attach`). */
  abstract measure(width: number): number;

  /** Paint into `r` (the widget's layout rect) with the panel's painter. */
  abstract paint(p: Painter, r: PanelRect): void;

  /** Pointer went down at panel px (inside the rect). */
  pointerDown(_x: number, _y: number): void {}

  /** Pointer moved; `down` while this widget holds the press. */
  pointerMove(_x: number, _y: number, _down: boolean): void {}

  /** The press ended; `inside` when the release was over this widget. */
  pointerUp(_x: number, _y: number, _inside: boolean): void {}

  /** Wheel over the widget, `dy` in px (positive scrolls down). Returns whether it was used. */
  wheel(_dy: number): boolean {
    return false;
  }

  /** The pad's A / Enter / Space on the focused widget. */
  activate(): void {}

  /** A key on the focused widget; true when consumed. */
  key(_event: PanelKeyEvent): boolean {
    return false;
  }

  protected get t(): PanelTheme {
    const t = this.theme;
    if (!t) throw new Error('world panel widget: not added to a panel');
    return t;
  }

  /** The row height a control uses: the M font plus `space3` above and below. */
  protected controlHeight(): number {
    const t = this.t;
    return Math.round(t.fontSizeM + t.space3 * 2);
  }

  /** The background, hover and pressed layers of a control, then the border. */
  protected paintControl(p: Painter, r: PanelRect, fill: string, radius: number): void {
    const t = this.t;
    p.fillRoundRect(r, radius, fill);
    if (this.pressed) p.fillRoundRect(r, radius, PRESS_TINT);
    else if (this.hover) p.fillRoundRect(r, radius, HOVER_TINT);
    p.strokeRoundRect(r, radius, t.tokens.colorBorder, t.borderWidth);
  }

  /** Run `paint` at the disabled alpha when disabled; the focus ring after. */
  protected frame(p: Painter, r: PanelRect, radius: number, paint: () => void): void {
    const ctx = p.ctx;
    const dis = this.disabled;
    if (dis) {
      ctx.save();
      ctx.globalAlpha = DISABLED_ALPHA;
    }
    paint();
    if (dis) ctx.restore();
    if (this.focused && !dis) p.focusRing(r, radius);
  }
}

// ---------------------------------------------------------------------------------------------
// Label

export interface WorldLabelOptions {
  text: string;
  /** `s`, `m` (default) or `l`: the theme's font sizes. */
  size?: WorldWidgetSize;
  align?: WorldWidgetAlign;
  tone?: WorldWidgetTone;
  rect?: PanelRect;
}

export class WorldLabel extends WorldWidget<WorldLabelOptions> {
  constructor(opts: WorldLabelOptions) {
    super({ ...opts }, ['size']);
  }

  measure(): number {
    return Math.round(fontSize(this.t, this.opts.size) * 1.4);
  }

  paint(p: Painter, r: PanelRect): void {
    const o = this.opts;
    p.text(o.text, r, fontSize(this.t, o.size), toneColor(this.t, o.tone), o.align ?? 'left');
  }
}

// ---------------------------------------------------------------------------------------------
// Button

export interface WorldButtonOptions {
  text: string;
  /** Fires on release over the button (and on `activate`), never on the press. */
  onPress?: () => void;
  disabled?: boolean;
  rect?: PanelRect;
}

export class WorldButton extends WorldWidget<WorldButtonOptions> {
  constructor(opts: WorldButtonOptions) {
    super({ ...opts });
  }

  override get focusable(): boolean {
    return !this.disabled;
  }

  measure(): number {
    return this.controlHeight();
  }

  paint(p: Painter, r: PanelRect): void {
    const t = this.t;
    this.frame(p, r, t.radiusM, () => {
      const k = t.tokens;
      this.paintControl(p, r, this.pressed ? k.colorAccent : k.colorSurfaceAlt, t.radiusM);
      p.text(
        this.opts.text,
        r,
        t.fontSizeM,
        this.pressed ? k.colorAccentText : k.colorText,
        'center',
        0,
        600,
      );
    });
  }

  override pointerUp(_x: number, _y: number, inside: boolean): void {
    if (inside) this.activate();
  }

  override activate(): void {
    if (!this.disabled) this.opts.onPress?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Toggle

export interface WorldToggleOptions {
  text: string;
  value: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  rect?: PanelRect;
}

export class WorldToggle extends WorldWidget<WorldToggleOptions> {
  constructor(opts: WorldToggleOptions) {
    super({ ...opts });
  }

  override get focusable(): boolean {
    return !this.disabled;
  }

  measure(): number {
    return this.controlHeight();
  }

  paint(p: Painter, r: PanelRect): void {
    const t = this.t;
    this.frame(p, r, t.radiusM, () => {
      const k = t.tokens;
      this.paintControl(p, r, k.colorSurfaceAlt, t.radiusM);
      p.text(this.opts.text, r, t.fontSizeM, k.colorText, 'left', t.space3);
      // The pill: twice as wide as tall, the knob at the on side when `value`.
      const h = Math.round(t.fontSizeM * 0.9);
      const w = h * 2;
      const pill: PanelRect = { x: r.x + r.w - t.space3 - w, y: r.y + (r.h - h) / 2, w, h };
      const on = this.opts.value;
      p.fillRoundRect(pill, h / 2, on ? k.colorAccent : k.colorSurface);
      p.strokeRoundRect(pill, h / 2, k.colorBorder, t.borderWidth);
      const pad = t.borderWidth + 1;
      const d = h - pad * 2;
      const knob: PanelRect = {
        x: on ? pill.x + w - pad - d : pill.x + pad,
        y: pill.y + pad,
        w: d,
        h: d,
      };
      p.fillRoundRect(knob, d / 2, on ? k.colorAccentText : k.colorTextMuted);
    });
  }

  override pointerUp(_x: number, _y: number, inside: boolean): void {
    if (inside) this.activate();
  }

  override activate(): void {
    if (this.disabled) return;
    const v = !this.opts.value;
    this.set({ value: v });
    this.opts.onChange?.(v);
  }
}

// ---------------------------------------------------------------------------------------------
// Slider

export interface WorldSliderOptions {
  min: number;
  max: number;
  value: number;
  /** Snap to multiples of `step` from `min`; 0 or unset for continuous. */
  step?: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  rect?: PanelRect;
}

export class WorldSlider extends WorldWidget<WorldSliderOptions> {
  private dragging = false;

  constructor(opts: WorldSliderOptions) {
    super({ ...opts });
    this.opts.value = this.snap(this.opts.value);
  }

  override get focusable(): boolean {
    return !this.disabled;
  }

  measure(): number {
    return this.controlHeight();
  }

  /** The value for a panel px `x` inside `r`. */
  private valueAt(x: number): number {
    const r = this.layoutRect;
    const t = this.t;
    const inset = t.space3;
    const span = Math.max(1, r.w - inset * 2);
    const f = Math.min(1, Math.max(0, (x - r.x - inset) / span));
    const o = this.opts;
    return this.snap(o.min + f * (o.max - o.min));
  }

  private snap(v: number): number {
    const o = this.opts;
    const lo = Math.min(o.min, o.max);
    const hi = Math.max(o.min, o.max);
    let out = Math.min(hi, Math.max(lo, v));
    const step = o.step ?? 0;
    if (step > 0) {
      out = o.min + Math.round((out - o.min) / step) * step;
      out = Math.min(hi, Math.max(lo, out));
      // Round away float dust (0.30000000000000004).
      const digits = Math.min(10, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
      out = Number(out.toFixed(digits));
    }
    return out;
  }

  protected override changed(): void {
    const v = this.snap(this.opts.value);
    if (v !== this.opts.value) this.opts.value = v;
  }

  private commit(v: number): void {
    if (v === this.opts.value) return;
    this.opts.value = v;
    this.invalidate();
    this.opts.onChange?.(v);
  }

  paint(p: Painter, r: PanelRect): void {
    const t = this.t;
    this.frame(p, r, t.radiusM, () => {
      const k = t.tokens;
      const o = this.opts;
      const inset = t.space3;
      const trackH = Math.max(2, Math.round(t.space2));
      const track: PanelRect = {
        x: r.x + inset,
        y: r.y + (r.h - trackH) / 2,
        w: r.w - inset * 2,
        h: trackH,
      };
      p.fillRoundRect(track, trackH / 2, k.colorSurfaceAlt);
      p.strokeRoundRect(track, trackH / 2, k.colorBorder, 1);
      const span = o.max - o.min;
      const f = span === 0 ? 0 : Math.min(1, Math.max(0, (o.value - o.min) / span));
      const fill: PanelRect = { x: track.x, y: track.y, w: track.w * f, h: track.h };
      if (fill.w > 0) p.fillRoundRect(fill, trackH / 2, k.colorAccent);
      const d = Math.round(t.fontSizeM * 0.9);
      const knob: PanelRect = {
        x: track.x + track.w * f - d / 2,
        y: r.y + (r.h - d) / 2,
        w: d,
        h: d,
      };
      p.fillRoundRect(knob, d / 2, this.pressed ? k.colorFocus : k.colorAccent);
      if (this.hover && !this.pressed) p.fillRoundRect(knob, d / 2, HOVER_TINT);
      p.strokeRoundRect(knob, d / 2, k.colorAccentText, 1);
    });
  }

  override pointerDown(x: number): void {
    if (this.disabled) return;
    this.dragging = true;
    this.commit(this.valueAt(x));
  }

  override pointerMove(x: number, _y: number, down: boolean): void {
    if (this.dragging && down) this.commit(this.valueAt(x));
  }

  override pointerUp(x: number): void {
    if (this.dragging) {
      this.dragging = false;
      if (Number.isFinite(x)) this.commit(this.valueAt(x));
    }
  }

  override key(e: PanelKeyEvent): boolean {
    if (this.disabled) return false;
    const o = this.opts;
    const step = o.step && o.step > 0 ? o.step : (o.max - o.min) / 20;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      this.commit(this.snap(o.value - step));
      return true;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      this.commit(this.snap(o.value + step));
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// List

export interface WorldListOptions {
  items: readonly string[];
  /** Index of the selected item, -1 for none. */
  selected?: number;
  onSelect?: (index: number) => void;
  /** Rows shown; the rest scroll (drag or wheel). Default 4. */
  visibleRows?: number;
  disabled?: boolean;
  rect?: PanelRect;
}

/** Px a press may travel before it is a scroll drag rather than a tap. */
const LIST_DRAG_PX = 4;

export class WorldList extends WorldWidget<WorldListOptions> {
  /** Scroll offset in px from the top of the items. */
  scroll = 0;
  private pressY = 0;
  private pressScroll = 0;
  private dragging = false;
  private down = false;

  constructor(opts: WorldListOptions) {
    super({ selected: -1, visibleRows: 4, ...opts }, ['visibleRows']);
  }

  override get focusable(): boolean {
    return !this.disabled;
  }

  /** Row height in px. */
  get rowHeight(): number {
    const t = this.t;
    return Math.round(t.fontSizeM + t.space2 * 2);
  }

  /** The largest `scroll` that still shows a full last row. */
  get maxScroll(): number {
    const rows = this.opts.visibleRows ?? 4;
    return Math.max(0, (this.opts.items.length - rows) * this.rowHeight);
  }

  measure(): number {
    return this.rowHeight * (this.opts.visibleRows ?? 4) + this.t.borderWidth * 2;
  }

  protected override changed(): void {
    this.setScroll(this.scroll);
  }

  /** Set the scroll offset, clamped to `[0, maxScroll]`; dirty only when it moved. */
  setScroll(px: number): void {
    const v = Math.min(this.maxScroll, Math.max(0, px));
    if (v === this.scroll) return;
    this.scroll = v;
    this.invalidate();
  }

  /** Select `index` (clamped; -1 clears), scroll it into view and fire `onSelect` when it changed. */
  select(index: number): void {
    const n = this.opts.items.length;
    const i = index < 0 || n === 0 ? -1 : Math.min(n - 1, Math.max(0, Math.floor(index)));
    if (i >= 0) {
      const rh = this.rowHeight;
      const rows = this.opts.visibleRows ?? 4;
      if (i * rh < this.scroll) this.setScroll(i * rh);
      else if ((i + 1) * rh > this.scroll + rows * rh) this.setScroll((i + 1) * rh - rows * rh);
    }
    if (i === this.opts.selected) return;
    this.opts.selected = i;
    this.invalidate();
    this.opts.onSelect?.(i);
  }

  /** The item index under panel px `y`, or -1 between/after the items. */
  rowAt(y: number): number {
    const r = this.layoutRect;
    const i = Math.floor((y - r.y - this.t.borderWidth + this.scroll) / this.rowHeight);
    return i >= 0 && i < this.opts.items.length ? i : -1;
  }

  paint(p: Painter, r: PanelRect): void {
    const t = this.t;
    this.frame(p, r, t.radiusS, () => {
      const k = t.tokens;
      const o = this.opts;
      p.fillRoundRect(r, t.radiusS, k.colorSurfaceAlt);
      const ctx = p.ctx;
      ctx.save();
      const bw = t.borderWidth;
      const inner: PanelRect = { x: r.x + bw, y: r.y + bw, w: r.w - bw * 2, h: r.h - bw * 2 };
      ctx.beginPath();
      ctx.rect(inner.x, inner.y, inner.w, inner.h);
      ctx.clip();
      const rh = this.rowHeight;
      const first = Math.floor(this.scroll / rh);
      const last = Math.min(o.items.length - 1, Math.ceil((this.scroll + inner.h) / rh));
      const row: PanelRect = { x: inner.x, y: 0, w: inner.w, h: rh };
      for (let i = first; i <= last; i++) {
        row.y = inner.y + i * rh - this.scroll;
        if (i === o.selected) p.fillRoundRect(row, 0, k.colorAccent);
        else if (i % 2 === 1) p.fillRoundRect(row, 0, 'rgba(255, 255, 255, 0.03)');
        p.text(
          o.items[i]!,
          row,
          t.fontSizeM,
          i === o.selected ? k.colorAccentText : k.colorText,
          'left',
          t.space3,
        );
      }
      ctx.restore();
      if (this.hover) p.fillRoundRect(r, t.radiusS, HOVER_TINT);
      p.strokeRoundRect(r, t.radiusS, k.colorBorder, bw);
      // Scrollbar when the items overflow.
      const max = this.maxScroll;
      if (max > 0) {
        const total = o.items.length * rh;
        const barH = Math.max(rh, (inner.h * inner.h) / total);
        const barY = inner.y + (this.scroll / max) * (inner.h - barH);
        const bar: PanelRect = {
          x: inner.x + inner.w - t.space2 - 2,
          y: barY,
          w: t.space2,
          h: barH,
        };
        p.fillRoundRect(bar, t.space2 / 2, k.colorTextMuted);
      }
    });
  }

  override pointerDown(_x: number, y: number): void {
    if (this.disabled) return;
    this.down = true;
    this.dragging = false;
    this.pressY = y;
    this.pressScroll = this.scroll;
  }

  override pointerMove(_x: number, y: number, down: boolean): void {
    if (!this.down || !down) return;
    const dy = y - this.pressY;
    if (!this.dragging && Math.abs(dy) > LIST_DRAG_PX) this.dragging = true;
    if (this.dragging) this.setScroll(this.pressScroll - dy);
  }

  override pointerUp(_x: number, y: number, inside: boolean): void {
    if (!this.down) return;
    this.down = false;
    if (this.dragging) {
      this.dragging = false;
      return;
    }
    if (inside) {
      const i = this.rowAt(y);
      if (i >= 0) this.select(i);
    }
  }

  override wheel(dy: number): boolean {
    if (this.disabled || this.maxScroll === 0) return false;
    this.setScroll(this.scroll + dy);
    return true;
  }

  override activate(): void {
    if (this.disabled) return;
    const i = this.opts.selected ?? -1;
    if (i >= 0) this.opts.onSelect?.(i);
  }

  override key(e: PanelKeyEvent): boolean {
    if (this.disabled || this.opts.items.length === 0) return false;
    const sel = this.opts.selected ?? -1;
    if (e.key === 'ArrowDown') {
      this.select(Math.min(this.opts.items.length - 1, sel + 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      this.select(Math.max(0, sel - 1));
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Progress

export interface WorldProgressOptions {
  /** 0..1. */
  value: number;
  tone?: WorldWidgetTone;
  rect?: PanelRect;
}

export class WorldProgress extends WorldWidget<WorldProgressOptions> {
  constructor(opts: WorldProgressOptions) {
    super({ ...opts });
  }

  measure(): number {
    return Math.round(this.t.space4);
  }

  paint(p: Painter, r: PanelRect): void {
    const t = this.t;
    const k = t.tokens;
    const radius = r.h / 2;
    p.fillRoundRect(r, radius, k.colorSurfaceAlt);
    const f = Math.min(1, Math.max(0, this.opts.value));
    if (f > 0) {
      const fill: PanelRect = { x: r.x, y: r.y, w: Math.max(r.h, r.w * f), h: r.h };
      p.fillRoundRect(fill, radius, toneColor(t, this.opts.tone ?? 'accent'));
    }
    p.strokeRoundRect(r, radius, k.colorBorder, t.borderWidth);
  }
}

// ---------------------------------------------------------------------------------------------
// Factories (the names a game reaches for)

export function label(opts: WorldLabelOptions): WorldLabel {
  return new WorldLabel(opts);
}
export function button(opts: WorldButtonOptions): WorldButton {
  return new WorldButton(opts);
}
export function toggle(opts: WorldToggleOptions): WorldToggle {
  return new WorldToggle(opts);
}
export function slider(opts: WorldSliderOptions): WorldSlider {
  return new WorldSlider(opts);
}
export function list(opts: WorldListOptions): WorldList {
  return new WorldList(opts);
}
export function progress(opts: WorldProgressOptions): WorldProgress {
  return new WorldProgress(opts);
}
