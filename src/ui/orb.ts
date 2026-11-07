/**
 * Orb meter (ws/ui-5): `ui.meter({ shape: 'orb' })`, the round fill gauge an action-RPG HUD puts
 * either side of its ability row. The fill rises from the bottom of a round well with a bright
 * meniscus line on its surface; an optional damage `trail` (a lighter band) holds where the value
 * was for `delay` ms, then drains to it over `duration` ms. A readout in the middle shows the value,
 * a percent or nothing.
 *
 * Everything moves by `transform` on CSS transitions, so an orb costs nothing per frame: a `set`
 * writes two custom properties and the compositor does the rest. `trail` (the trail's value now)
 * is computed from the same clock and timings as the transition, so a test or a game reads where
 * the band is without measuring it. `prefers-reduced-motion` (or `reducedMotion: true`) turns the
 * trail and the fill's easing off.
 *
 * The trail model is shared with the bar meter (`createMeter` with `trail`).
 */
import { h } from './dom';
import type { HudHost, Meter, MeterOptions, MeterTrailOptions } from './hud';
import {
  type FormFactor,
  formSize,
  type RegionName,
  type WidgetHandle,
  type WidgetOptions,
} from './layout';
import { prefersReducedMotion } from './styles';

/** `n` theme px (the same `calc` as `themePx` in `hud.ts`, kept local to avoid an import cycle). */
const tpx = (n: number) => `calc(${n} * var(--tc-space-1) / 4)`;

/**
 * Where a lagging band is, from the times of the last change: it holds at `from` for `delay` ms
 * after `t0`, then moves linearly to `to` over `duration` ms (a CSS `linear` transition with that
 * delay draws the same curve). @internal
 */
export class TrailClock {
  from = 0;
  to = 0;
  t0 = -1e12;
  constructor(
    readonly delay: number,
    readonly duration: number,
    private readonly now: () => number,
  ) {}

  /** The band's value at time `t` (default now). */
  at(t: number = this.now()): number {
    const k = this.duration > 0 ? (t - this.t0 - this.delay) / this.duration : 1;
    if (k <= 0) return this.from;
    if (k >= 1) return this.to;
    return this.from + (this.to - this.from) * k;
  }

  /** Retarget to `to` from wherever the band is now, as a restarted CSS transition does. */
  retarget(to: number): void {
    const t = this.now();
    this.from = this.at(t);
    this.to = to;
    this.t0 = t;
  }

  /** Jump to `v` with no lag. */
  reset(v: number): void {
    this.from = v;
    this.to = v;
    this.t0 = -1e12;
  }

  /** The clock's time now, ms. */
  time(): number {
    return this.now();
  }
}

/**
 * Restart a trail band's CSS transition where `clock` has it (ws/ui-11). Moving a node (the
 * layout putting a meter in another region) cancels its transitions, so the band would jump to
 * the value; this puts it back where the model is and runs the rest of the hold and the drain,
 * on the same curve. `prefix` is `orb` or `meter`: `--tc-<prefix>-trail` goes on `valueEl`, the
 * timings (`--tc-<prefix>-trail-delay`, `-duration`) on `timingEl`. Returns whether it re-armed
 * (the caller puts the configured timings back on its next change). @internal
 */
export function rearmTrail(
  clock: TrailClock,
  band: HTMLElement,
  prefix: 'orb' | 'meter',
  valueEl: HTMLElement,
  timingEl: HTMLElement,
): boolean {
  const t = clock.time();
  const v = clock.at(t);
  if (v === clock.to) return false;
  const since = t - clock.t0;
  band.style.transition = 'none';
  valueEl.style.setProperty(`--tc-${prefix}-trail`, String(v));
  // One style read so the jump lands before the transition comes back (off the frame path).
  void band.ownerDocument.defaultView?.getComputedStyle(band).transform;
  band.style.transition = '';
  timingEl.style.setProperty(`--tc-${prefix}-trail-delay`, `${Math.max(0, clock.delay - since)}ms`);
  timingEl.style.setProperty(
    `--tc-${prefix}-trail-duration`,
    `${clock.duration - Math.max(0, since - clock.delay)}ms`,
  );
  valueEl.style.setProperty(`--tc-${prefix}-trail`, String(clock.to));
  return true;
}

/** A meter's layout placement: `MeterOptions.place`, else `region` (default `bottom`). @internal */
export function meterPlace(
  place: RegionName | WidgetOptions['place'] | undefined,
  region: RegionName | undefined,
): WidgetOptions['place'] {
  if (typeof place === 'string') return { default: place };
  return place ?? { default: region ?? 'bottom' };
}

/** Resolve `MeterOptions.trail` into timings, or null when off (or under reduced motion). */
export function trailTimings(
  opts: MeterOptions,
  reduced: boolean,
): Required<MeterTrailOptions> | null {
  if (!opts.trail || reduced) return null;
  const t = opts.trail === true ? {} : opts.trail;
  return { delay: Math.max(0, t.delay ?? 400), duration: Math.max(0, t.duration ?? 600) };
}

export function meterClock(opts: MeterOptions): () => number {
  return opts.now ?? (() => globalThis.performance?.now() ?? Date.now());
}

export function meterReducedMotion(host: HudHost, opts: MeterOptions): boolean {
  return (
    opts.reducedMotion ??
    prefersReducedMotion(host.layers.hud.ownerDocument.defaultView ?? undefined)
  );
}

const STYLE_ID = 'tc-ui-orb';

/**
 * The orb stylesheet, under `.tc-overlay` and in `--tc-*` tokens. `--tc-orb-color` is the fill
 * (the tone's token, or the per-call `color`); `--tc-color-meter-trail` the trail band.
 *
 * @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const ORB_CSS = `
.tc-overlay .tc-orb { position: relative; width: var(--tc-orb-size, ${tpx(128)}); height: var(--tc-orb-size, ${tpx(128)});
  flex: none; pointer-events: none; font-family: var(--tc-font-ui); color: var(--tc-color-text);
  --tc-orb-tone: var(--tc-color-accent); --tc-orb-color: var(--tc-meter-color, var(--tc-orb-tone)); }
.tc-overlay .tc-orb[data-tone="info"] { --tc-orb-tone: var(--tc-color-info); }
.tc-overlay .tc-orb[data-tone="success"] { --tc-orb-tone: var(--tc-color-success); }
.tc-overlay .tc-orb[data-tone="warn"] { --tc-orb-tone: var(--tc-color-warn); }
.tc-overlay .tc-orb[data-tone="danger"] { --tc-orb-tone: var(--tc-color-danger); }
.tc-overlay .tc-orb-well { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; isolation: isolate;
  background: radial-gradient(circle at 50% 60%, var(--tc-color-surface-alt), var(--tc-color-bg));
  border: calc(var(--tc-border-width) * 1.5) solid var(--tc-color-border);
  box-shadow: var(--tc-shadow), inset 0 0 ${tpx(18)} rgba(0, 0, 0, 0.8); }
.tc-overlay .tc-orb-fill, .tc-overlay .tc-orb-trail { position: absolute; left: 0; right: 0; top: 0; height: 100%;
  will-change: transform; transform: translateY(calc((1 - var(--tc-orb-value, 1)) * 100%)); }
.tc-overlay .tc-orb-trail { transform: translateY(calc((1 - var(--tc-orb-trail, 1)) * 100%));
  background: var(--tc-color-meter-trail); transition: transform var(--tc-orb-trail-duration, 600ms) linear var(--tc-orb-trail-delay, 400ms); }
.tc-overlay .tc-orb-fill { transition: transform var(--tc-duration-fast) var(--tc-easing);
  background: radial-gradient(circle at 38% 30%, color-mix(in srgb, var(--tc-orb-color) 55%, white), var(--tc-orb-color) 45%,
    color-mix(in srgb, var(--tc-orb-color) 40%, black)); }
.tc-overlay .tc-orb-fill::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: ${tpx(3)};
  background: color-mix(in srgb, var(--tc-orb-color) 30%, white); box-shadow: 0 0 ${tpx(6)} color-mix(in srgb, var(--tc-orb-color) 50%, white);
  opacity: 0.9; }
.tc-overlay .tc-orb[data-empty] .tc-orb-fill::before { display: none; }
.tc-overlay .tc-orb-gloss { position: absolute; inset: 8% 22% 56% 18%; border-radius: 50%; pointer-events: none;
  background: linear-gradient(rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0)); }
.tc-overlay .tc-orb-readout { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 700;
  font-size: var(--tc-font-size-m); line-height: 1; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 ${tpx(4)} rgba(0, 0, 0, 0.6);
  font-variant-numeric: tabular-nums; }
.tc-overlay .tc-orb-readout:empty { display: none; }
.tc-overlay .tc-orb[data-reduced] .tc-orb-fill { transition: none; }
@media (prefers-reduced-motion: reduce) {
  .tc-overlay .tc-orb-fill { transition: none; }
  .tc-overlay .tc-orb-trail { display: none; }
}
`;

/** Add `ORB_CSS` to `doc` once (the first orb does it). */
export function ensureOrbStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = ORB_CSS;
  doc.head.appendChild(style);
}

/** What a readout shows for `value` of `max`. @internal */
export function readoutText(
  mode: MeterOptions['readout'],
  value: number,
  max: number,
  format?: (value: number, max: number) => string,
): string {
  if (mode === 'none') return '';
  if (mode === 'percent') return `${Math.round(max > 0 ? (value / max) * 100 : 0)}%`;
  return format ? format(value, max) : String(Math.round(value));
}

/**
 * The orb (see the module comment). `ui.meter({ shape: 'orb' })` and `createMeter(host, { shape:
 * 'orb' })` come here; it returns the same `Meter` handle as the bar.
 */
export function createOrbMeter(host: HudHost, opts: MeterOptions = {}): Meter {
  const doc = host.layers.hud.ownerDocument;
  ensureOrbStyles(doc);
  let max = Math.max(0, opts.max ?? 1);
  let value = Math.min(max, Math.max(0, opts.value ?? max));
  const reduced = meterReducedMotion(host, opts);
  const timings = trailTimings(opts, reduced);
  const clock = timings ? new TrailClock(timings.delay, timings.duration, meterClock(opts)) : null;
  const mode = opts.readout ?? 'value';

  const fill = h('div', { class: 'tc-orb-fill' });
  const trailEl = clock ? h('div', { class: 'tc-orb-trail' }) : null;
  const readout = h('span', { class: 'tc-orb-readout', 'aria-hidden': 'true' });
  const well = h(
    'div',
    { class: 'tc-orb-well' },
    trailEl,
    fill,
    h('div', { class: 'tc-orb-gloss' }),
  );
  const style: Record<string, string> = {};
  if (opts.color) style['--tc-meter-color'] = opts.color;
  if (timings) {
    style['--tc-orb-trail-delay'] = `${timings.delay}ms`;
    style['--tc-orb-trail-duration'] = `${timings.duration}ms`;
  }
  const el = h(
    'div',
    {
      class: 'tc-orb',
      role: 'meter',
      'aria-label': opts.label,
      'aria-valuemin': '0',
      dataset: { tone: opts.tone ?? 'accent', shape: 'orb', ...(reduced ? { reduced: '' } : {}) },
      style,
    },
    well,
    readout,
  );

  const frac = (v: number) => (max > 0 ? v / max : 0);
  /** The band's timings were rewritten by a re-arm after a move (ws/ui-11). */
  let rearmed = false;
  const write = () => {
    el.setAttribute('aria-valuenow', String(value));
    el.setAttribute('aria-valuemax', String(max));
    const f = frac(value);
    el.style.setProperty('--tc-orb-value', String(f));
    el.toggleAttribute('data-empty', f <= 0);
    const text = readoutText(mode, value, max, opts.format);
    if (readout.textContent !== text) readout.textContent = text;
    if (opts.format) el.setAttribute('aria-valuetext', opts.format(value, max));
    else if (mode === 'percent') el.setAttribute('aria-valuetext', text);
    if (clock && timings) {
      if (rearmed) {
        rearmed = false;
        el.style.setProperty('--tc-orb-trail-delay', `${timings.delay}ms`);
        el.style.setProperty('--tc-orb-trail-duration', `${timings.duration}ms`);
      }
      clock.retarget(f);
      el.style.setProperty('--tc-orb-trail', String(f));
    }
  };
  // The diameter in the current form factor (ws/ui-10): written now and on every re-layout,
  // before the layout measures, so a content bar or rail sizes to it.
  let size = opts.size;
  let sized = '';
  const writeSize = (ff: FormFactor): boolean => {
    const v = size === undefined ? '' : tpx(formSize(size, ff));
    if (v === sized) return false;
    sized = v;
    if (v) el.style.setProperty('--tc-orb-size', v);
    else el.style.removeProperty('--tc-orb-size');
    return true;
  };
  writeSize(host.layout.formFactor);
  clock?.reset(frac(value));
  if (trailEl) el.style.setProperty('--tc-orb-trail', String(frac(value)));
  write();

  const handle: WidgetHandle = host.layout.add(el, {
    place: meterPlace(opts.place, opts.region),
    order: opts.order,
    onForm: writeSize,
    // A move cancels the band's transition: run the rest of it from where the model is.
    onMove: () => {
      if (clock && trailEl && rearmTrail(clock, trailEl, 'orb', el, el)) rearmed = true;
    },
  });

  return {
    el,
    shape: 'orb',
    get value() {
      return value;
    },
    get max() {
      return max;
    },
    get trail() {
      // The band never shows under the fill, so a rising value reads as the value.
      return clock ? Math.max(value, clock.at() * max) : value;
    },
    get size() {
      return size ?? 128;
    },
    get region() {
      return handle.region;
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
    },
    setSize(next) {
      size = next;
      if (writeSize(host.layout.formFactor)) host.layout.refresh();
    },
    setPlace(place) {
      handle.setPlace(meterPlace(place, undefined));
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}
