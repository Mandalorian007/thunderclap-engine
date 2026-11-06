/**
 * HUD widgets for a first- or third-person game (ws/ui-hud): a reticle at the centre of the
 * frame, a meter, a strip of slots and a sliding heading indicator. Built on the overlay's
 * layers, regions and theme tokens; noun-free (a meter is a meter, a strip is a strip).
 *
 * Lengths are **theme px**: `n` theme px is `n * var(--tc-space-1) / 4`, which is `n` design px
 * of the frame on the `hud` layer, `n` CSS px in a region in `frame` units and `n / 2` CSS px in
 * `css` units (phones), the same way the theme's own sizes follow `ui.units`.
 *
 * The reticle lives in `layers.hud` and hides itself while a modal panel is open (the layer is
 * also `inert` then). Meters, slots and the heading go through `ui.layout` like other widgets,
 * so they follow the regions and the modal rule the layout already applies.
 */
import { h } from './dom';
import type { Layout, RegionName, WidgetHandle } from './layout';
import {
  createOrbMeter,
  meterClock,
  meterReducedMotion,
  readoutText,
  TrailClock,
  trailTimings,
} from './orb';
import type { PanelStack } from './stack';

/** What the HUD factories need from the overlay. */
export interface HudHost {
  readonly layers: { hud: HTMLElement };
  readonly layout: Layout;
  readonly stack: PanelStack;
}

/** `n` theme px (see the module comment). */
export function themePx(n: number): string {
  return `calc(${n} * var(--tc-space-1) / 4)`;
}

const STYLE_ID = 'tc-ui-hud';

/**
 * The HUD stylesheet, under `.tc-overlay` and in `--tc-*` tokens only. Injected once per document
 * by the first HUD widget (`ensureHudStyles`), next to the overlay's base sheet.
 */
export const HUD_CSS = `
.tc-overlay .tc-reticle { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: var(--tc-reticle-size); height: var(--tc-reticle-size); color: var(--tc-reticle-color, var(--tc-color-text));
  pointer-events: none; filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.7)); }
.tc-overlay .tc-reticle[hidden], .tc-overlay .tc-reticle[data-modal] { display: none; }
.tc-overlay .tc-reticle::before, .tc-overlay .tc-reticle::after { content: ''; position: absolute; background: currentColor; }
.tc-overlay .tc-reticle[data-style="dot"]::before { inset: 25%; border-radius: 50%; }
.tc-overlay .tc-reticle[data-style="dot"]::after { display: none; }
.tc-overlay .tc-reticle[data-style="circle"]::before { inset: 0; border-radius: 50%; background: none;
  border: var(--tc-reticle-stroke) solid currentColor; }
.tc-overlay .tc-reticle[data-style="circle"]::after { left: 50%; top: 50%; width: var(--tc-reticle-stroke); height: var(--tc-reticle-stroke);
  transform: translate(-50%, -50%); border-radius: 50%; }
.tc-overlay .tc-reticle[data-style="cross"]::before { left: 0; right: 0; top: 50%; height: var(--tc-reticle-stroke); transform: translateY(-50%);
  -webkit-mask: linear-gradient(90deg, #000 calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% + var(--tc-reticle-gap) / 2), #000 calc(50% + var(--tc-reticle-gap) / 2));
  mask: linear-gradient(90deg, #000 calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% + var(--tc-reticle-gap) / 2), #000 calc(50% + var(--tc-reticle-gap) / 2)); }
.tc-overlay .tc-reticle[data-style="cross"]::after { top: 0; bottom: 0; left: 50%; width: var(--tc-reticle-stroke); transform: translateX(-50%);
  -webkit-mask: linear-gradient(180deg, #000 calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% + var(--tc-reticle-gap) / 2), #000 calc(50% + var(--tc-reticle-gap) / 2));
  mask: linear-gradient(180deg, #000 calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% - var(--tc-reticle-gap) / 2), transparent calc(50% + var(--tc-reticle-gap) / 2), #000 calc(50% + var(--tc-reticle-gap) / 2)); }
.tc-overlay .tc-reticle.tc-reticle-pulse { animation: tc-reticle-pulse var(--tc-duration-normal) var(--tc-easing); }
@keyframes tc-reticle-pulse { 50% { transform: translate(-50%, -50%) scale(1.5); color: var(--tc-color-accent); } }

.tc-overlay .tc-meter { display: flex; flex-direction: column; gap: var(--tc-space-1); width: var(--tc-meter-width, ${themePx(240)});
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text); pointer-events: none; }
.tc-overlay .tc-meter-label { display: flex; justify-content: space-between; gap: var(--tc-space-2); line-height: 1.2;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
.tc-overlay .tc-meter-label:empty { display: none; }
.tc-overlay .tc-meter-track { position: relative; height: var(--tc-space-3); overflow: hidden; border-radius: var(--tc-radius-s);
  background: var(--tc-color-surface); border: var(--tc-border-width) solid var(--tc-color-border); }
.tc-overlay .tc-meter-fill { position: absolute; inset: 0; transform-origin: left center; transform: scaleX(var(--tc-meter-value, 1));
  background: var(--tc-color-accent); transition: transform var(--tc-duration-fast) var(--tc-easing); }
.tc-overlay .tc-meter[data-tone="info"] .tc-meter-fill { background: var(--tc-color-info); }
.tc-overlay .tc-meter[data-tone="success"] .tc-meter-fill { background: var(--tc-color-success); }
.tc-overlay .tc-meter[data-tone="warn"] .tc-meter-fill { background: var(--tc-color-warn); }
.tc-overlay .tc-meter[data-tone="danger"] .tc-meter-fill { background: var(--tc-color-danger); }
.tc-overlay .tc-meter-trail { position: absolute; inset: 0; transform-origin: left center; transform: scaleX(var(--tc-meter-trail, 1));
  background: var(--tc-color-meter-trail); transition: transform var(--tc-meter-trail-duration, 600ms) linear var(--tc-meter-trail-delay, 400ms); }
.tc-overlay .tc-meter[data-color] .tc-meter-fill { background: var(--tc-meter-color); }
.tc-overlay .tc-meter[data-reduced] .tc-meter-fill { transition: none; }
@media (prefers-reduced-motion: reduce) { .tc-overlay .tc-meter-trail { display: none; } }

.tc-overlay .tc-slots { display: flex; gap: var(--tc-space-2); pointer-events: none; font-family: var(--tc-font-ui); }
.tc-overlay .tc-slot { position: relative; display: grid; place-items: center; width: var(--tc-slot-size, ${themePx(72)}); height: var(--tc-slot-size, ${themePx(72)});
  border-radius: var(--tc-radius-m); background: var(--tc-color-surface); border: var(--tc-border-width) solid var(--tc-color-border);
  color: var(--tc-color-text); font-size: var(--tc-font-size-s); overflow: hidden;
  transition: border-color var(--tc-duration-fast), transform var(--tc-duration-fast), box-shadow var(--tc-duration-fast); }
.tc-overlay .tc-slot[data-selected] { border-color: var(--tc-color-accent); box-shadow: 0 0 0 var(--tc-focus-ring) var(--tc-color-accent);
  transform: translateY(calc(-1 * var(--tc-space-1))); }
.tc-overlay .tc-slot-content { display: grid; place-items: center; width: 100%; height: 100%; text-align: center; line-height: 1.1; }
.tc-overlay .tc-slot-content > canvas, .tc-overlay .tc-slot-content > img { max-width: 100%; max-height: 100%; }
.tc-overlay .tc-slot-hint { position: absolute; left: var(--tc-space-1); top: var(--tc-space-1); padding: 0 var(--tc-space-1);
  border-radius: var(--tc-radius-s); background: var(--tc-color-surface-alt); color: var(--tc-color-text-muted);
  font-size: calc(var(--tc-font-size-s) * 0.7); line-height: 1.4; }
.tc-overlay .tc-slot-hint:empty { display: none; }

.tc-overlay .tc-heading { position: relative; width: var(--tc-heading-width, ${themePx(480)}); height: var(--tc-space-6); overflow: hidden;
  pointer-events: none; font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text);
  -webkit-mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
  mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
.tc-overlay .tc-heading-strip { position: absolute; left: 0; top: 0; height: 100%; will-change: transform; }
.tc-overlay .tc-heading-tick { position: absolute; bottom: 0; width: var(--tc-border-width); height: var(--tc-space-2);
  background: var(--tc-color-text-muted); transform: translateX(-50%); }
.tc-overlay .tc-heading-tick[data-major] { height: var(--tc-space-3); background: var(--tc-color-text); }
.tc-overlay .tc-heading-label { position: absolute; top: 0; transform: translateX(-50%); line-height: 1.2; font-weight: 600; letter-spacing: 0.08em; }
.tc-overlay .tc-heading-mark { position: absolute; left: 50%; top: 0; bottom: 0; width: var(--tc-border-width); transform: translateX(-50%);
  background: var(--tc-color-accent); }
`;

/** Add the HUD stylesheet to `doc` once. */
export function ensureHudStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HUD_CSS;
  doc.head.appendChild(style);
}

// ------------------------------------------------------------------ reticle

export type ReticleStyle = 'dot' | 'cross' | 'circle';

export interface ReticleOptions {
  style?: ReticleStyle;
  /** Overall size, theme px. Default 24. */
  size?: number;
  /** Gap between the arms of a `cross`, theme px. Default 6. */
  gap?: number;
  /** CSS colour. Default `var(--tc-color-text)`. */
  color?: string;
}

export interface Reticle {
  readonly el: HTMLElement;
  /** The reticle's own state; it also hides while a modal is open (`data-modal`). */
  readonly visible: boolean;
  readonly style: ReticleStyle;
  show(): void;
  hide(): void;
  /** A short scale-and-tint flash (`tc-reticle-pulse`), e.g. on a hit. */
  pulse(): void;
  setStyle(style: ReticleStyle): void;
  remove(): void;
}

const PULSE_CLASS = 'tc-reticle-pulse';
const PULSE_FALLBACK_MS = 400;

/** A reticle centred on the frame, on the `hud` layer; hidden while a modal panel is open. */
export function createReticle(host: HudHost, opts: ReticleOptions = {}): Reticle {
  const doc = host.layers.hud.ownerDocument;
  ensureHudStyles(doc);
  const size = opts.size ?? 24;
  const el = h('div', {
    class: 'tc-reticle',
    'aria-hidden': 'true',
    dataset: { style: opts.style ?? 'dot' },
    style: {
      '--tc-reticle-size': themePx(size),
      '--tc-reticle-gap': themePx(opts.gap ?? 6),
      '--tc-reticle-stroke': themePx(Math.max(2, Math.round(size / 12))),
      ...(opts.color ? { '--tc-reticle-color': opts.color } : {}),
    },
  });
  host.layers.hud.append(el);

  const modal = () => el.toggleAttribute('data-modal', host.stack.hasModal);
  modal();
  const unwatch = host.stack.onChange(modal);

  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  const endPulse = () => {
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = null;
    el.classList.remove(PULSE_CLASS);
  };
  el.addEventListener('animationend', endPulse);

  return {
    el,
    get visible() {
      return !el.hidden;
    },
    get style() {
      return el.dataset.style as ReticleStyle;
    },
    show() {
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
    pulse() {
      // Restart: drop the class, reflow, add it again.
      endPulse();
      void el.offsetWidth;
      el.classList.add(PULSE_CLASS);
      // Reduced motion (or a test DOM) fires no animationend: time it out.
      pulseTimer = setTimeout(endPulse, PULSE_FALLBACK_MS);
    },
    setStyle(style) {
      el.dataset.style = style;
    },
    remove() {
      endPulse();
      unwatch();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ meter

export type MeterTone = 'accent' | 'info' | 'success' | 'warn' | 'danger';

export interface MeterOptions {
  /** Visible label; also the accessible name. */
  label?: string;
  /** Default 1. */
  max?: number;
  /** Initial value. Default `max`. */
  value?: number;
  /** Layout region. Default `bottom`. */
  region?: RegionName;
  order?: number;
  /** Fill colour token. Default `accent`. */
  tone?: MeterTone;
  /** Width, theme px. Default 240. */
  width?: number;
  /** Show the value as text beside the label (`v => \`${v}/${max}\``). Default none. */
  format?: (value: number, max: number) => string;
  /** `'bar'` (default) or `'orb'`, a round fill gauge (`ui/orb.ts`, ws/ui-5). */
  shape?: MeterShape;
  /**
   * A lagging damage band behind the fill: it holds where the value was, then drains to it.
   * `true` for the defaults (`delay` 400 ms, `duration` 600 ms). Off under reduced motion.
   */
  trail?: boolean | MeterTrailOptions;
  /**
   * What the readout shows: the value (`format`, else the rounded value), a whole percent or
   * nothing. Default `'value'` on an orb; a bar shows `format` only, as before.
   */
  readout?: MeterReadout;
  /** A CSS colour for the fill, over the `tone` token. */
  color?: string;
  /** An orb's diameter, theme px. Default 128. */
  size?: number;
  /** Turn the trail and the fill's easing off. Default: `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** The clock the trail is read on, ms. Default `performance.now`. */
  now?: () => number;
}

/** A meter's shape: a horizontal bar or a round orb. */
export type MeterShape = 'bar' | 'orb';

/** What a meter's readout shows. */
export type MeterReadout = 'value' | 'percent' | 'none';

/** The damage trail's timing, ms. */
export interface MeterTrailOptions {
  /** How long the band holds before it drains. Default 400. */
  delay?: number;
  /** How long it takes to drain. Default 600. */
  duration?: number;
}

export interface Meter {
  readonly el: HTMLElement;
  readonly shape: MeterShape;
  readonly value: number;
  readonly max: number;
  /** Where the damage trail is now (same units as `value`); `value` without a trail. */
  readonly trail: number;
  /** Clamped to `[0, max]`; a new `max` re-clamps. */
  set(value: number, max?: number): void;
  setTone(tone: MeterTone): void;
  /** A CSS colour for the fill over the tone, or null for the tone's token. */
  setColor(color: string | null): void;
  remove(): void;
}

/** A labelled bar with `role="meter"`, in a layout region. */
export function createMeter(host: HudHost, opts: MeterOptions = {}): Meter {
  if (opts.shape === 'orb') return createOrbMeter(host, opts);
  ensureHudStyles(host.layers.hud.ownerDocument);
  let max = opts.max ?? 1;
  let value = Math.min(max, Math.max(0, opts.value ?? max));
  const reduced = opts.trail || opts.reducedMotion ? meterReducedMotion(host, opts) : false;
  const timings = trailTimings(opts, reduced);
  const clock = timings ? new TrailClock(timings.delay, timings.duration, meterClock(opts)) : null;
  const label = h('span', null, opts.label ?? '');
  const readout = h('span', { class: 'tc-meter-readout' });
  const fill = h('div', { class: 'tc-meter-fill' });
  const trailEl = clock ? h('div', { class: 'tc-meter-trail' }) : null;
  const style: Record<string, string> = {};
  if (opts.width !== undefined) style['--tc-meter-width'] = themePx(opts.width);
  if (opts.color) style['--tc-meter-color'] = opts.color;
  if (timings) {
    style['--tc-meter-trail-delay'] = `${timings.delay}ms`;
    style['--tc-meter-trail-duration'] = `${timings.duration}ms`;
  }
  const el = h(
    'div',
    {
      class: 'tc-meter',
      role: 'meter',
      'aria-label': opts.label,
      'aria-valuemin': '0',
      dataset: {
        tone: opts.tone ?? 'accent',
        ...(reduced ? { reduced: '' } : {}),
        ...(opts.color ? { color: '' } : {}),
      },
      style: Object.keys(style).length > 0 ? style : undefined,
    },
    h('div', { class: 'tc-meter-label' }, label, readout),
    h('div', { class: 'tc-meter-track' }, trailEl, fill),
  );
  const frac = () => (max > 0 ? value / max : 0);
  if (clock && trailEl) {
    clock.reset(frac());
    trailEl.style.setProperty('--tc-meter-trail', String(frac()));
  }
  const write = () => {
    el.setAttribute('aria-valuenow', String(value));
    el.setAttribute('aria-valuemax', String(max));
    fill.style.setProperty('--tc-meter-value', String(frac()));
    if (opts.format) {
      const text = opts.format(value, max);
      el.setAttribute('aria-valuetext', text);
      readout.textContent = text;
    } else if (opts.readout && opts.readout !== 'none') {
      const text = readoutText(opts.readout, value, max);
      if (opts.readout === 'percent') el.setAttribute('aria-valuetext', text);
      readout.textContent = text;
    }
    if (clock && trailEl) {
      clock.retarget(frac());
      trailEl.style.setProperty('--tc-meter-trail', String(frac()));
    }
  };
  write();
  const handle: WidgetHandle = host.layout.add(el, {
    place: { default: opts.region ?? 'bottom' },
    order: opts.order,
  });
  return {
    el,
    shape: 'bar',
    get value() {
      return value;
    },
    get max() {
      return max;
    },
    get trail() {
      return clock ? Math.max(value, clock.at() * max) : value;
    },
    set(v, m) {
      if (m !== undefined) max = Math.max(0, m);
      const next = Math.min(max, Math.max(0, v));
      if (next === value && m === undefined) return;
      value = next;
      write();
    },
    setTone(tone) {
      el.dataset.tone = tone;
    },
    setColor(color) {
      if (color) el.style.setProperty('--tc-meter-color', color);
      else el.style.removeProperty('--tc-meter-color');
      el.toggleAttribute('data-color', !!color);
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ slots

export interface SlotsOptions {
  count: number;
  /** Layout region. Default `bottom`. */
  region?: RegionName;
  order?: number;
  /** Key-hint badge per slot (`['1', '2', …]`). */
  hints?: string[];
  /** Accessible name of the strip. Default `Slots`. */
  label?: string;
  /** Initially selected index. Default 0. */
  selected?: number;
  /** Slot size, theme px. Default 72. */
  size?: number;
}

export interface Slots {
  readonly el: HTMLElement;
  readonly count: number;
  readonly selected: number;
  /** Wraps: `select(count)` is slot 0 and `select(-1)` the last, so a wheel can cycle. */
  select(i: number): void;
  /** Replace a slot's content (text or an element); an empty string clears it. */
  setContent(i: number, content: string | HTMLElement): void;
  setHint(i: number, hint: string): void;
  remove(): void;
}

/** A strip of equal slots with key-hint badges and one selected highlight. */
export function createSlots(host: HudHost, opts: SlotsOptions): Slots {
  ensureHudStyles(host.layers.hud.ownerDocument);
  const count = Math.max(0, Math.floor(opts.count));
  const items: HTMLElement[] = [];
  const contents: HTMLElement[] = [];
  const hints: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const hint = h('span', { class: 'tc-slot-hint', 'aria-hidden': 'true' }, opts.hints?.[i] ?? '');
    const content = h('div', { class: 'tc-slot-content' });
    const item = h(
      'div',
      { class: 'tc-slot', role: 'option', 'aria-selected': 'false', dataset: { index: String(i) } },
      hint,
      content,
    );
    items.push(item);
    contents.push(content);
    hints.push(hint);
  }
  const el = h(
    'div',
    {
      class: 'tc-slots',
      role: 'listbox',
      'aria-label': opts.label ?? 'Slots',
      style: opts.size !== undefined ? { '--tc-slot-size': themePx(opts.size) } : undefined,
    },
    ...items,
  );
  let selected = -1;
  const wrap = (i: number) => (count === 0 ? -1 : ((Math.trunc(i) % count) + count) % count);
  const select = (i: number) => {
    const next = wrap(i);
    if (next === selected) return;
    const prev = items[selected];
    if (prev) {
      prev.removeAttribute('data-selected');
      prev.setAttribute('aria-selected', 'false');
    }
    selected = next;
    const cur = items[selected];
    if (cur) {
      cur.setAttribute('data-selected', '');
      cur.setAttribute('aria-selected', 'true');
    }
  };
  select(opts.selected ?? 0);
  const handle = host.layout.add(el, {
    place: { default: opts.region ?? 'bottom' },
    order: opts.order,
  });
  return {
    el,
    count,
    get selected() {
      return selected;
    },
    select,
    setContent(i, content) {
      const c = contents[i];
      if (!c) return;
      if (content === '') c.replaceChildren();
      else c.replaceChildren(content);
    },
    setHint(i, hint) {
      const hEl = hints[i];
      if (hEl) hEl.textContent = hint;
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ heading

export interface HeadingOptions {
  /** Layout region. Default `top`. */
  region?: RegionName;
  order?: number;
  /** Visible width, theme px. Default 480. */
  width?: number;
  /** Degrees of heading shown across the width. Default 90. */
  span?: number;
  /** Degrees between ticks. Default 15. */
  tickEvery?: number;
  /** The four cardinal labels, clockwise from yaw 0. Default `['N', 'E', 'S', 'W']`. */
  labels?: [string, string, string, string];
}

export interface Heading {
  readonly el: HTMLElement;
  /** The strip that slides. */
  readonly strip: HTMLElement;
  /** Last yaw set, radians. */
  readonly yaw: number;
  /** Where the strip sits, theme px (`translate3d(offset, 0, 0)`). */
  readonly offset: number;
  /**
   * Yaw in radians, clockwise from the first label (0 is `N`, π/2 is `E`). Any value: it wraps.
   */
  setYaw(radians: number): void;
  remove(): void;
}

/** Degrees in `[0, 360)`. */
export function wrapDegrees(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** The strip offset (theme px) for a yaw, given the visible width and span. */
export function headingOffset(yawRadians: number, width: number, span: number): number {
  const deg = wrapDegrees((yawRadians * 180) / Math.PI);
  return width / 2 - deg * (width / span);
}

/**
 * A sliding cardinal strip: the four labels and ticks at every `tickEvery` degrees, drawn over
 * two turns (−180° to 540°) so the strip never jumps at north. The centre mark shows the yaw.
 */
export function createHeading(host: HudHost, opts: HeadingOptions = {}): Heading {
  ensureHudStyles(host.layers.hud.ownerDocument);
  const width = opts.width ?? 480;
  const span = opts.span ?? 90;
  const tickEvery = opts.tickEvery ?? 15;
  const labels = opts.labels ?? ['N', 'E', 'S', 'W'];
  const ppd = width / span;
  const strip = h('div', { class: 'tc-heading-strip', 'aria-hidden': 'true' });
  for (let deg = -180; deg <= 540; deg += tickEvery) {
    const major = deg % 90 === 0;
    strip.append(
      h('span', {
        class: 'tc-heading-tick',
        'data-major': major,
        style: { left: themePx(deg * ppd) },
      }),
    );
    if (major) {
      const label = labels[wrapDegrees(deg) / 90] ?? '';
      strip.append(
        h('span', { class: 'tc-heading-label', style: { left: themePx(deg * ppd) } }, label),
      );
    }
  }
  const el = h(
    'div',
    {
      class: 'tc-heading',
      role: 'img',
      'aria-label': 'Heading',
      style: { '--tc-heading-width': themePx(width) },
    },
    strip,
    h('span', { class: 'tc-heading-mark', 'aria-hidden': 'true' }),
  );
  let yaw = Number.NaN;
  let offset = Number.NaN;
  let lastDeg = -1;
  const setYaw = (radians: number) => {
    yaw = radians;
    const next = headingOffset(radians, width, span);
    if (next === offset) return;
    offset = next;
    strip.style.transform = `translate3d(${themePx(offset)}, 0, 0)`;
    const deg = Math.round(wrapDegrees((radians * 180) / Math.PI));
    if (deg !== lastDeg) {
      lastDeg = deg;
      el.setAttribute('aria-label', `Heading ${deg}°`);
    }
  };
  setYaw(0);
  const handle = host.layout.add(el, {
    place: { default: opts.region ?? 'top' },
    order: opts.order,
  });
  return {
    el,
    strip,
    get yaw() {
      return yaw;
    },
    get offset() {
      return offset;
    },
    setYaw,
    remove() {
      handle.remove();
      el.remove();
    },
  };
}
