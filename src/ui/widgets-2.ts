/**
 * The second set of widgets (ws/ui-widgets): what a game's HUD and settings build themselves
 * otherwise. Reticle, bar, segmented choice, select, key prompt, stepper and cooldown. Plain
 * DOM through `h`, each a small handle over one element, nothing in the panel stack or the
 * overlay changes. Classes are `tc-ui-*`; sizes are design px (`toFrameUnits`), colours and
 * spacing come from the theme tokens in `styles.ts`; `WIDGETS2_CSS` is injected once by
 * `createOverlay` (`ensureWidgets2Styles`). `set` on every handle writes the DOM only when the
 * value changed and allocates nothing but the attribute string it writes.
 */
import { h } from './dom';
import { toFrameUnits } from './text-scale';
import { button } from './widgets';

/** A choice for `segmented` and `select`. */
export interface ChoiceOption<T extends string = string> {
  value: T;
  label: string;
}

/** Colour of a `bar`: the accent, or one of the toast tones. */
export type WidgetTone = 'accent' | 'info' | 'success' | 'warn' | 'danger';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- reticle

export interface WidgetReticleOptions {
  /** Box the lines fit in at spread 0, design px. Default 48. */
  size?: number;
  /** Line thickness, design px. Default 2. */
  thickness?: number;
  /** Gap from the centre to each line at spread 0, design px. Default 6. */
  gap?: number;
  /** Centre dot. Default true. */
  dot?: boolean;
  /** Any CSS colour. Default the theme's text colour. */
  color?: string;
}

export interface WidgetReticle {
  element: HTMLDivElement;
  /** Open the lines: 0 is the resting gap, 1 is a quarter of the size further out. */
  set(spread: number): void;
  /** Play the hit flash once (restarts if running). */
  hit(): void;
  hide(): void;
  show(): void;
}

/**
 * A four-line reticle with a centre dot, drawn with CSS only and centred in its parent
 * (`position: absolute; left: 50%; top: 50%`), so it goes on the `hud` layer or any positioned
 * box. Decorative: `aria-hidden`. `set(spread)` opens the lines; `hit()` flashes them.
 */
export function reticle(opts: WidgetReticleOptions = {}): WidgetReticle {
  const { size = 48, thickness = 2, gap = 6, dot = true, color } = opts;
  const style: Record<string, string> = {
    '--tc-ui-size': String(size),
    '--tc-ui-thickness': String(thickness),
    '--tc-ui-gap': String(gap),
  };
  if (color) style['--tc-ui-color'] = color;
  const element = h(
    'div',
    { class: 'tc-ui-reticle', 'aria-hidden': 'true', style },
    ...(['top', 'right', 'bottom', 'left'] as const).map((side) =>
      h('span', { class: 'tc-ui-reticle-line', dataset: { side } }),
    ),
    dot ? h('span', { class: 'tc-ui-reticle-dot' }) : null,
  );
  element.addEventListener('animationend', () => element.removeAttribute('data-hit'));
  let spread = -1;
  return {
    element,
    set(s) {
      s = clamp01(s);
      if (s === spread) return;
      spread = s;
      element.style.setProperty('--tc-ui-spread', String(s));
    },
    hit() {
      if (element.hasAttribute('data-hit')) {
        element.removeAttribute('data-hit');
        // Restart the animation: a reflow between the remove and the add.
        void element.offsetWidth;
      }
      element.setAttribute('data-hit', '');
    },
    hide() {
      element.hidden = true;
    },
    show() {
      element.hidden = false;
    },
  };
}

// ---------------------------------------------------------------- bar

export interface BarOptions {
  min?: number;
  max?: number;
  /** Draw the track in this many segments (pips). */
  segments?: number;
  tone?: WidgetTone;
  /** Text for `aria-valuetext` and the visible value. Default a whole percent. */
  format?: (v: number) => string;
}

export interface Bar {
  element: HTMLDivElement;
  set(value: number): void;
  tone(t: WidgetTone): void;
}

/**
 * A labelled progress or health bar: `role=progressbar`, `aria-valuemin/max/now` and
 * `aria-valuetext` (from `format`, else a percent). The fill is a `scaleX` transform driven by
 * `--tc-ui-fill`; `segments` overlays pips; `tone` picks the fill colour.
 */
export function bar(label: string, value: number, opts: BarOptions = {}): Bar {
  const { min = 0, max = 1, segments, tone, format } = opts;
  const span = max - min || 1;
  const valueText = h('span', { class: 'tc-ui-bar-value', 'aria-hidden': 'true' });
  const fill = h('span', { class: 'tc-ui-bar-fill' });
  const element = h(
    'div',
    {
      class: 'tc-ui-bar',
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': String(min),
      'aria-valuemax': String(max),
      dataset: {
        ...(tone ? { tone } : {}),
        ...(segments && segments > 1 ? { segments: String(segments) } : {}),
      },
      style: segments && segments > 1 ? { '--tc-ui-segments': String(segments) } : undefined,
    },
    h('span', { class: 'tc-ui-bar-head' }, h('span', { class: 'tc-ui-label' }, label), valueText),
    h('span', { class: 'tc-ui-bar-track' }, fill),
  );
  let current = Number.NaN;
  const set = (v: number) => {
    v = Math.min(max, Math.max(min, v));
    if (v === current) return;
    current = v;
    const f = (v - min) / span;
    element.style.setProperty('--tc-ui-fill', String(f));
    element.setAttribute('aria-valuenow', String(v));
    const text = format ? format(v) : `${Math.round(f * 100)}%`;
    element.setAttribute('aria-valuetext', text);
    if (format) valueText.textContent = text;
  };
  set(value);
  return {
    element,
    set,
    tone(t) {
      if (t === 'accent') delete element.dataset.tone;
      else element.dataset.tone = t;
    },
  };
}

// ---------------------------------------------------------------- segmented

export interface Segmented<T extends string = string> {
  element: HTMLDivElement;
  /** Select `value` without calling `onChange`. */
  set(value: T): void;
  readonly value: T;
}

/**
 * A segmented choice: `role=radiogroup` with one `role=radio` button per option, roving
 * tabindex (only the selected one is in the tab order), ArrowLeft/ArrowRight to move (wrapping)
 * and a click to pick. Consumes only those two arrows, so a panel's ArrowUp/Down walk passes.
 * `onChange` fires on user changes only.
 */
export function segmented<T extends string>(
  label: string,
  options: ChoiceOption<T>[],
  value: T,
  onChange: (value: T) => void,
): Segmented<T> {
  let current = value;
  const radios = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tc-ui-segment',
        role: 'radio',
        'aria-checked': 'false',
        tabindex: '-1',
        dataset: { value: o.value },
      },
      o.label,
    ),
  );
  const apply = (v: T) => {
    current = v;
    for (let i = 0; i < radios.length; i++) {
      const on = options[i].value === v;
      radios[i].setAttribute('aria-checked', on ? 'true' : 'false');
      radios[i].tabIndex = on ? 0 : -1;
    }
  };
  const choose = (v: T, focus: boolean) => {
    if (v === current) return;
    apply(v);
    if (focus) radios[options.findIndex((o) => o.value === v)]?.focus();
    onChange(v);
  };
  const element = h(
    'div',
    {
      class: 'tc-ui-segmented',
      role: 'radiogroup',
      'aria-label': label,
      on: {
        click: (e) => {
          const b = (e.target as HTMLElement).closest<HTMLElement>('.tc-ui-segment');
          if (b && element.contains(b)) choose(b.dataset.value as T, false);
        },
        keydown: (e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          e.stopPropagation();
          const i = options.findIndex((o) => o.value === current);
          const n = options.length;
          choose(options[(i + dir + n) % n].value, true);
        },
      },
    },
    h('span', { class: 'tc-ui-label' }, label),
    h('span', { class: 'tc-ui-segments' }, ...radios),
  );
  apply(value);
  return {
    element,
    set(v) {
      if (v !== current) apply(v);
    },
    get value() {
      return current;
    },
  };
}

// ---------------------------------------------------------------- select

export interface Select<T extends string = string> {
  element: HTMLLabelElement;
  select: HTMLSelectElement;
  /** Select `value` without calling `onChange`. */
  set(value: T): void;
}

/** A labelled native `<select>` in the theme (`.tc-field.tc-ui-select`). */
export function select<T extends string>(
  label: string,
  options: ChoiceOption<T>[],
  value: T,
  onChange: (value: T) => void,
): Select<T> {
  const sel = h(
    'select',
    { class: 'tc-ui-select-input' },
    ...options.map((o) => h('option', { value: o.value }, o.label)),
  );
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  const element = h(
    'label',
    { class: 'tc-field tc-ui-select' },
    h('span', { class: 'tc-ui-label' }, label),
    sel,
  );
  return {
    element,
    select: sel,
    set(v) {
      sel.value = v;
    },
  };
}

// ---------------------------------------------------------------- key prompt

export interface KeyPromptOptions {
  /** The bound key's text (`'E'`, `'Space'`). */
  key?: string;
  /** The pad button's glyph text (`'Ⓐ'`, `'RT'`). */
  pad?: string;
}

export interface KeyPrompt {
  element: HTMLSpanElement;
  /** Show `key` in the key chip and `pad` (or nothing) in the pad chip. */
  set(key: string, pad?: string): void;
}

/**
 * An action with its binding: a key chip (`<kbd>`), a pad chip when a pad glyph is given, and
 * the action's text. Strings in; no icon font. An empty chip hides itself.
 */
export function keyPrompt(action: string, opts: KeyPromptOptions = {}): KeyPrompt {
  const key = h('kbd', { class: 'tc-ui-key', dataset: { kind: 'key' } });
  const pad = h('kbd', { class: 'tc-ui-key', dataset: { kind: 'pad' } });
  const element = h(
    'span',
    { class: 'tc-ui-key-prompt' },
    key,
    pad,
    h('span', { class: 'tc-ui-key-action' }, action),
  );
  let k = '';
  let p = '';
  const set = (nk: string, np = '') => {
    if (nk !== k) key.textContent = k = nk;
    if (np !== p) pad.textContent = p = np;
  };
  set(opts.key ?? '', opts.pad);
  return { element, set };
}

// ---------------------------------------------------------------- stepper

export interface StepperOptions {
  min: number;
  max: number;
  step: number;
  /** Text for the value and `aria-valuetext`. Default the number. */
  format?: (v: number) => string;
}

export interface Stepper {
  element: HTMLDivElement;
  /** Set the value (clamped and snapped to `step`) without calling `onChange`. */
  set(value: number): void;
  readonly value: number;
}

/**
 * A numeric stepper: a `−` button, a focusable `role=spinbutton` value and a `+` button.
 * ArrowUp/ArrowDown step, Home/End jump to the bounds; only those four keys are consumed.
 * Values snap to `step` from `min` and clamp; the buttons disable at the bounds. `onChange`
 * fires on user changes only.
 */
export function stepper(
  label: string,
  value: number,
  onChange: (value: number) => void,
  opts: StepperOptions,
): Stepper {
  const { min, max, step, format } = opts;
  const decimals = (String(step).split('.')[1] ?? '').length;
  const snap = (v: number) => {
    const k = Math.round((v - min) / step);
    const s = Number((min + k * step).toFixed(decimals));
    return Math.min(max, Math.max(min, s));
  };
  let current = Number.NaN;
  const field = h('span', {
    class: 'tc-ui-stepper-value',
    role: 'spinbutton',
    tabindex: '0',
    'aria-label': label,
    'aria-valuemin': String(min),
    'aria-valuemax': String(max),
  });
  const dec = button('−', () => choose(current - step), { className: 'tc-ui-stepper-button' });
  const inc = button('+', () => choose(current + step), { className: 'tc-ui-stepper-button' });
  const apply = (v: number) => {
    v = snap(v);
    if (v === current) return false;
    current = v;
    const text = format ? format(v) : String(v);
    field.textContent = text;
    field.setAttribute('aria-valuenow', String(v));
    field.setAttribute('aria-valuetext', text);
    dec.disabled = v <= min;
    inc.disabled = v >= max;
    return true;
  };
  const choose = (v: number) => {
    if (apply(v)) onChange(current);
  };
  field.addEventListener('keydown', (e) => {
    let next: number;
    switch (e.key) {
      case 'ArrowUp':
        next = current + step;
        break;
      case 'ArrowDown':
        next = current - step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    choose(next);
  });
  const element = h(
    'div',
    { class: 'tc-ui-stepper' },
    h('span', { class: 'tc-ui-label' }, label),
    dec,
    field,
    inc,
  );
  apply(value);
  return {
    element,
    set(v) {
      apply(v);
    },
    get value() {
      return current;
    },
  };
}

// ---------------------------------------------------------------- cooldown

export interface WidgetCooldownOptions {
  /** Diameter, design px. Default 64. */
  size?: number;
}

export interface WidgetCooldown {
  element: HTMLDivElement;
  /** 0 is just used, 1 is ready; the sweep fills clockwise. */
  set(fraction: number): void;
  /** True once `set` reached 1. */
  readonly ready: boolean;
}

/**
 * @deprecated (ws/api-core, E-036) Use `WidgetCooldown`: `core` exports the scheduler's
 * `Cooldown`. Removed next minor.
 */
export type Cooldown = WidgetCooldown;
/** @deprecated (ws/api-core, E-036) Use `WidgetCooldownOptions`. Removed next minor. */
export type CooldownOptions = WidgetCooldownOptions;

/**
 * A radial cooldown: a disc whose `conic-gradient` sweep follows `--tc-ui-sweep`, lit when
 * ready (`data-ready`). Decorative (`aria-hidden`): the game announces readiness itself.
 */
export function cooldown(opts: WidgetCooldownOptions = {}): WidgetCooldown {
  const element = h('div', {
    class: 'tc-ui-cooldown',
    'aria-hidden': 'true',
    style: { '--tc-ui-size': String(opts.size ?? 64) },
  });
  let fraction = -1;
  const set = (f: number) => {
    f = clamp01(f);
    if (f === fraction) return;
    const wasReady = fraction >= 1;
    fraction = f;
    element.style.setProperty('--tc-ui-sweep', String(f));
    if (f >= 1 !== wasReady) element.toggleAttribute('data-ready', f >= 1);
  };
  set(1);
  return {
    element,
    set,
    get ready() {
      return fraction >= 1;
    },
  };
}

// ---------------------------------------------------------------- styles

/**
 * Stylesheet for these widgets in design px (`toFrameUnits`: every `px` here is one `--tc-unit`;
 * `--tc-ui-px` carries that unit into the `calc`s on the size custom properties).
 *
 * @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const WIDGETS2_CSS = toFrameUnits(`
.tc-ui-label { font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text); }

.tc-ui-reticle { position: absolute; left: 50%; top: 50%; translate: -50% -50%; pointer-events: none;
  --tc-ui-px: 1px; --tc-ui-spread: 0; --tc-ui-len: calc((var(--tc-ui-size) / 2 - var(--tc-ui-gap)) * var(--tc-ui-px));
  --tc-ui-offset: calc((var(--tc-ui-gap) + var(--tc-ui-spread) * var(--tc-ui-size) / 4) * var(--tc-ui-px));
  --tc-ui-thick: calc(var(--tc-ui-thickness) * var(--tc-ui-px));
  width: calc(var(--tc-ui-size) * var(--tc-ui-px)); height: calc(var(--tc-ui-size) * var(--tc-ui-px));
  color: var(--tc-ui-color, var(--tc-color-text)); }
.tc-ui-reticle[hidden] { display: none; }
.tc-ui-reticle-line, .tc-ui-reticle-dot { position: absolute; left: 50%; top: 50%; background: currentColor;
  border-radius: calc(var(--tc-ui-thick) / 2); transition: translate var(--tc-duration-fast) var(--tc-easing); }
.tc-ui-reticle-line[data-side="top"], .tc-ui-reticle-line[data-side="bottom"] { width: var(--tc-ui-thick); height: var(--tc-ui-len); }
.tc-ui-reticle-line[data-side="left"], .tc-ui-reticle-line[data-side="right"] { width: var(--tc-ui-len); height: var(--tc-ui-thick); }
.tc-ui-reticle-line[data-side="top"] { translate: -50% calc(-100% - var(--tc-ui-offset)); }
.tc-ui-reticle-line[data-side="bottom"] { translate: -50% var(--tc-ui-offset); }
.tc-ui-reticle-line[data-side="left"] { translate: calc(-100% - var(--tc-ui-offset)) -50%; }
.tc-ui-reticle-line[data-side="right"] { translate: var(--tc-ui-offset) -50%; }
.tc-ui-reticle-dot { width: var(--tc-ui-thick); height: var(--tc-ui-thick); translate: -50% -50%; border-radius: 50%; }
.tc-ui-reticle[data-hit] { animation: tc-ui-hit var(--tc-duration-normal) var(--tc-easing); }
@keyframes tc-ui-hit { 30% { color: var(--tc-color-accent); scale: 1.25; } }

.tc-ui-bar { display: flex; flex-direction: column; gap: var(--tc-space-1); min-width: 240px;
  --tc-ui-fill: 0; --tc-ui-tone: var(--tc-color-accent); }
.tc-ui-bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--tc-space-2); }
.tc-ui-bar-value { font-family: var(--tc-font-mono); font-size: var(--tc-font-size-s); color: var(--tc-color-text-muted); }
.tc-ui-bar-value:empty { display: none; }
.tc-ui-bar-track { position: relative; display: block; height: 16px; overflow: hidden;
  background: var(--tc-color-surface-alt); border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-s); }
.tc-ui-bar-fill { position: absolute; inset: 0; background: var(--tc-ui-tone); transform-origin: left center;
  transform: scaleX(var(--tc-ui-fill)); transition: transform var(--tc-duration-fast) var(--tc-easing); }
.tc-ui-bar[data-segments] .tc-ui-bar-track::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(to right, transparent 0, transparent calc(100% / var(--tc-ui-segments) - 2px),
    var(--tc-color-bg) calc(100% / var(--tc-ui-segments) - 2px), var(--tc-color-bg) calc(100% / var(--tc-ui-segments))); }
.tc-ui-bar[data-tone="info"] { --tc-ui-tone: var(--tc-color-info); }
.tc-ui-bar[data-tone="success"] { --tc-ui-tone: var(--tc-color-success); }
.tc-ui-bar[data-tone="warn"] { --tc-ui-tone: var(--tc-color-warn); }
.tc-ui-bar[data-tone="danger"] { --tc-ui-tone: var(--tc-color-danger); }

.tc-ui-segmented { display: inline-flex; align-items: center; gap: var(--tc-space-3); pointer-events: auto; }
.tc-ui-segments { display: inline-flex; overflow: hidden; background: var(--tc-color-surface-alt);
  border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-m); }
.tc-ui-segment { font: inherit; font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text);
  background: transparent; border: 0; padding: var(--tc-space-2) var(--tc-space-4); min-height: 48px; cursor: pointer;
  transition: background var(--tc-duration-fast), color var(--tc-duration-fast); }
.tc-ui-segment + .tc-ui-segment { border-left: var(--tc-border-width) solid var(--tc-color-border); }
.tc-ui-segment:hover { color: var(--tc-color-accent); }
.tc-ui-segment[aria-checked="true"] { background: var(--tc-color-accent); color: var(--tc-color-accent-text); }
.tc-ui-segment:focus-visible { outline-offset: -4px; }

.tc-ui-select select { font: inherit; font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text);
  background: var(--tc-color-surface-alt); border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-m);
  padding: var(--tc-space-2) var(--tc-space-3); min-height: 48px; cursor: pointer; }
.tc-ui-select select:hover { border-color: var(--tc-color-accent); }

.tc-ui-key-prompt { display: inline-flex; align-items: center; gap: var(--tc-space-2);
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text-muted); }
.tc-ui-key { font-family: var(--tc-font-mono); font-size: 0.85em; line-height: 1.3; color: var(--tc-color-text); text-align: center;
  min-width: 40px; padding: 2px 10px; background: var(--tc-color-surface-alt);
  border: var(--tc-border-width) solid var(--tc-color-border); border-bottom-width: calc(var(--tc-border-width) * 2); border-radius: var(--tc-radius-s); }
.tc-ui-key[data-kind="pad"] { border-radius: 999px; color: var(--tc-color-accent); }
.tc-ui-key:empty { display: none; }

.tc-ui-stepper { display: inline-flex; align-items: center; gap: var(--tc-space-2); pointer-events: auto; }
.tc-ui-stepper .tc-ui-label { margin-right: var(--tc-space-1); }
.tc-ui-stepper .tc-button { min-height: 48px; min-width: 48px; padding: 0 var(--tc-space-2); font-family: var(--tc-font-mono); }
.tc-ui-stepper-value { display: inline-flex; align-items: center; justify-content: center; min-width: 96px; min-height: 48px;
  padding: var(--tc-space-1) var(--tc-space-2); font-family: var(--tc-font-mono); font-size: var(--tc-font-size-s); color: var(--tc-color-text);
  background: var(--tc-color-surface-alt); border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-s); }

.tc-ui-cooldown { --tc-ui-px: 1px; --tc-ui-sweep: 0; width: calc(var(--tc-ui-size) * var(--tc-ui-px)); height: calc(var(--tc-ui-size) * var(--tc-ui-px));
  border-radius: 50%; border: var(--tc-border-width) solid var(--tc-color-border); pointer-events: none;
  background: conic-gradient(var(--tc-color-accent) calc(var(--tc-ui-sweep) * 360deg), var(--tc-color-surface-alt) 0);
  transition: box-shadow var(--tc-duration-fast) var(--tc-easing); }
.tc-ui-cooldown[data-ready] { border-color: var(--tc-color-accent); box-shadow: 0 0 12px var(--tc-color-accent); }
`);

const STYLE_ID = 'tc-ui-widgets-2';

/** Add `WIDGETS2_CSS` to `doc` once (`createOverlay` calls it beside `ensureStyles`). */
export function ensureWidgets2Styles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = WIDGETS2_CSS;
  doc.head.appendChild(style);
}
