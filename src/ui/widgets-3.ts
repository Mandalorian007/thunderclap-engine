/**
 * The third set of HUD widgets (ws/ui-4): a radial progress ring and a compass strip. Both are
 * placed in a layout region (`region`, like the meter and the heading strip) and write the DOM
 * only when a value changed. Sizes are design px (`themePx`); colours and spacing come from the
 * theme tokens. `WIDGETS3_CSS` is injected on first use (`ensureWidgets3Styles`).
 */
import { h } from './dom';
import { themePx, wrapDegrees } from './hud';
import type { Layout, RegionName, WidgetHandle } from './layout';

/** What these widgets need from their overlay (`Overlay` fits). */
export interface Widgets3Host {
  readonly layers: { readonly hud: HTMLElement };
  readonly layout: Layout;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------------ ring

export interface RingOptions {
  /** Outer radius, design px. Default 48. */
  radius?: number;
  /** Ring thickness, design px. Default 8. */
  thickness?: number;
  /** Initial fill, 0..1. Default 0. */
  value?: number;
  /** Text in the middle; also the accessible name. */
  label?: string;
  /** Fill colour. Default `var(--tc-color-accent)`. */
  color?: string;
  /** Layout region. Default `bottom`. */
  region?: RegionName;
  order?: number;
}

export interface Ring {
  readonly el: HTMLElement;
  /** 0..1 as last set. */
  readonly value: number;
  /** Clamped to 0..1; `aria-valuenow` follows. */
  set(value: number): void;
  setLabel(label: string): void;
  remove(): void;
}

/**
 * A radial progress ring: a conic gradient fills clockwise from the top by `value`, masked to a
 * ring of `thickness`, with a label in the middle. `role="progressbar"` with `aria-valuenow`.
 */
export function createRing(host: Widgets3Host, opts: RingOptions = {}): Ring {
  ensureWidgets3Styles(host.layers.hud.ownerDocument);
  const radius = opts.radius ?? 48;
  const thickness = opts.thickness ?? 8;
  const labelEl = h('span', { class: 'tc-ring-label' }, opts.label ?? '');
  const fill = h('div', { class: 'tc-ring-fill', 'aria-hidden': 'true' });
  const el = h(
    'div',
    {
      class: 'tc-ring',
      role: 'progressbar',
      'aria-label': opts.label,
      'aria-valuemin': '0',
      'aria-valuemax': '1',
      style: {
        '--tc-ring-size': themePx(radius * 2),
        '--tc-ring-thickness': themePx(thickness),
        ...(opts.color ? { '--tc-ring-color': opts.color } : {}),
      },
    },
    fill,
    labelEl,
  );
  let value = Number.NaN;
  const set = (v: number) => {
    const next = clamp01(v);
    if (next === value) return;
    value = next;
    el.setAttribute('aria-valuenow', String(next));
    fill.style.setProperty('--tc-ring-value', String(next));
  };
  set(opts.value ?? 0);
  const handle: WidgetHandle = host.layout.add(el, {
    place: { default: opts.region ?? 'bottom' },
    order: opts.order,
  });
  return {
    el,
    get value() {
      return value;
    },
    set,
    setLabel(label) {
      if (labelEl.textContent === label) return;
      labelEl.textContent = label;
      el.setAttribute('aria-label', label);
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ compass

export interface CompassMarker {
  name: string;
  /** Bearing of the thing, degrees clockwise from north. */
  bearingDeg: number;
  /** Text (or a glyph) shown at the bearing; default the name's first character. */
  icon?: string;
}

export interface CompassOptions {
  /** Visible width, design px. Default 480. */
  width?: number;
  /**
   * Degrees visible to each side of the heading: the strip spans `2 × fov`. Default 180, the
   * whole circle (a marker 90° off sits a quarter of the width from the centre); 45 shows only
   * what is roughly in front.
   */
  fov?: number;
  /** Initial heading, degrees clockwise from north. Default 0. */
  headingDeg?: number;
  markers?: readonly CompassMarker[];
  /** Cardinal labels, N E S W. */
  labels?: readonly [string, string, string, string];
  /** Layout region. Default `top`. */
  region?: RegionName;
  order?: number;
}

export interface Compass {
  readonly el: HTMLElement;
  /** Degrees, wrapped to 0..360. */
  readonly heading: number;
  /** Scroll the strip so `deg` sits under the centre mark; markers move with it. */
  setHeading(deg: number): void;
  /** Replace the markers (nodes are reused by index). */
  setMarkers(markers: readonly CompassMarker[]): void;
  /**
   * Where a marker sits, design px right of the centre (negative: left), or null when it is not
   * a marker. Beyond half the width it is hidden.
   */
  offsetOf(name: string): number | null;
  remove(): void;
}

/** The signed difference `bearing − heading`, wrapped to −180..180. */
export function bearingOffset(bearingDeg: number, headingDeg: number): number {
  const d = wrapDegrees(bearingDeg - headingDeg);
  return d > 180 ? d - 360 : d;
}

/**
 * A compass strip: the cardinal ticks scroll under a centre mark as the heading turns, and each
 * marker sits at its bearing's distance from the heading (`width / (2 × fov)` px per degree),
 * hidden once it leaves the strip. `role="img"` labelled with the heading.
 */
export function createCompass(host: Widgets3Host, opts: CompassOptions = {}): Compass {
  ensureWidgets3Styles(host.layers.hud.ownerDocument);
  const width = opts.width ?? 480;
  const fov = opts.fov ?? 180;
  const labels = opts.labels ?? ['N', 'E', 'S', 'W'];
  const ppd = width / (2 * fov);
  const half = width / 2;
  const strip = h('div', { class: 'tc-compass-strip', 'aria-hidden': 'true' });
  // Ticks from −180 to 540 so the strip is covered at any heading (its offset is in 0..360).
  for (let deg = -180; deg <= 540; deg += 15) {
    const major = deg % 90 === 0;
    strip.append(
      h('span', {
        class: 'tc-compass-tick',
        'data-major': major,
        style: { left: themePx(deg * ppd) },
      }),
    );
    if (major) {
      strip.append(
        h(
          'span',
          { class: 'tc-compass-label', style: { left: themePx(deg * ppd) } },
          labels[wrapDegrees(deg) / 90] ?? '',
        ),
      );
    }
  }
  const markerLayer = h('div', { class: 'tc-compass-markers', 'aria-hidden': 'true' });
  const el = h(
    'div',
    {
      class: 'tc-compass',
      role: 'img',
      'aria-label': 'Compass',
      style: { '--tc-compass-width': themePx(width) },
    },
    strip,
    markerLayer,
    h('span', { class: 'tc-compass-mark', 'aria-hidden': 'true' }),
  );

  interface Node {
    el: HTMLElement;
    marker: CompassMarker;
    offset: number;
    shown: boolean;
  }
  const nodes: Node[] = [];
  let heading = Number.NaN;
  let stripOffset = Number.NaN;

  const placeMarker = (n: Node) => {
    const off = bearingOffset(n.marker.bearingDeg, heading) * ppd;
    const shown = Math.abs(off) <= half;
    if (shown !== n.shown) {
      n.shown = shown;
      n.el.hidden = !shown;
    }
    if (!shown || off === n.offset) return;
    n.offset = off;
    n.el.style.transform = `translate3d(${themePx(off)}, 0, 0) translateX(-50%)`;
  };

  const setHeading = (deg: number) => {
    const next = wrapDegrees(deg);
    if (next === heading) return;
    heading = next;
    // The strip's 0° tick sits `heading` degrees left of the centre.
    const off = half - next * ppd;
    if (off !== stripOffset) {
      stripOffset = off;
      strip.style.transform = `translate3d(${themePx(off)}, 0, 0)`;
    }
    el.setAttribute('aria-label', `Compass ${Math.round(next)}°`);
    for (const n of nodes) placeMarker(n);
  };

  const setMarkers = (markers: readonly CompassMarker[]) => {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i]!;
      let n = nodes[i];
      if (!n) {
        const node = h('span', { class: 'tc-compass-marker', hidden: true });
        markerLayer.append(node);
        n = { el: node, marker: m, offset: Number.NaN, shown: false };
        nodes.push(n);
      }
      n.marker = m;
      n.el.textContent = m.icon ?? m.name.charAt(0);
      n.el.dataset.name = m.name;
      n.offset = Number.NaN;
      placeMarker(n);
    }
    while (nodes.length > markers.length) nodes.pop()!.el.remove();
  };

  setHeading(opts.headingDeg ?? 0);
  setMarkers(opts.markers ?? []);
  const handle: WidgetHandle = host.layout.add(el, {
    place: { default: opts.region ?? 'top' },
    order: opts.order,
  });
  return {
    el,
    get heading() {
      return heading;
    },
    setHeading,
    setMarkers,
    offsetOf(name) {
      const n = nodes.find((x) => x.marker.name === name);
      return n ? bearingOffset(n.marker.bearingDeg, heading) * ppd : null;
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ styles

/**
 * Stylesheet for these widgets (theme tokens).
 */
export const WIDGETS3_CSS = `
.tc-overlay .tc-ring { position: relative; display: grid; place-items: center; width: var(--tc-ring-size); height: var(--tc-ring-size);
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text); }
.tc-overlay .tc-ring-fill { position: absolute; inset: 0; border-radius: 50%; --tc-ring-value: 0;
  background: conic-gradient(var(--tc-ring-color, var(--tc-color-accent)) calc(var(--tc-ring-value) * 360deg), var(--tc-color-border) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--tc-ring-thickness) - 0.5px), #000 calc(100% - var(--tc-ring-thickness) + 0.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--tc-ring-thickness) - 0.5px), #000 calc(100% - var(--tc-ring-thickness) + 0.5px)); }
.tc-overlay .tc-ring-label { position: relative; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7); }

.tc-overlay .tc-compass { position: relative; width: var(--tc-compass-width, ${themePx(480)}); height: var(--tc-space-6); overflow: hidden;
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); color: var(--tc-color-text-muted);
  -webkit-mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
  mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent); }
.tc-overlay .tc-compass-strip, .tc-overlay .tc-compass-markers { position: absolute; left: 0; top: 0; height: 100%; will-change: transform; }
.tc-overlay .tc-compass-markers { left: 50%; }
.tc-overlay .tc-compass-tick { position: absolute; bottom: 0; width: var(--tc-border-width); height: var(--tc-space-2);
  background: var(--tc-color-text-muted); transform: translateX(-50%); }
.tc-overlay .tc-compass-tick[data-major] { height: var(--tc-space-3); background: var(--tc-color-text); }
.tc-overlay .tc-compass-label { position: absolute; top: 0; transform: translateX(-50%); line-height: 1.2; font-weight: 600; letter-spacing: 0.08em; }
.tc-overlay .tc-compass-marker { position: absolute; top: 0; bottom: var(--tc-space-3); display: grid; place-items: center; min-width: var(--tc-space-4);
  padding: 0 var(--tc-space-1); border-radius: var(--tc-radius-s); background: var(--tc-color-accent); color: var(--tc-color-accent-text);
  font-weight: 700; line-height: 1; will-change: transform; }
.tc-overlay .tc-compass-marker[hidden] { display: none; }
.tc-overlay .tc-compass-mark { position: absolute; left: 50%; top: 0; bottom: 0; width: var(--tc-border-width); transform: translateX(-50%);
  background: var(--tc-color-accent); }
`;

const STYLE_ID = 'tc-ui-widgets-3';

/** Add `WIDGETS3_CSS` to `doc` once (the first ring or compass does it). */
export function ensureWidgets3Styles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = WIDGETS3_CSS;
  doc.head.appendChild(style);
}
