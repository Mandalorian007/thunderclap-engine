/**
 * Minimap (ws/ui-4): a round map of the world's ground plane (x, z) around a centre, in a layout
 * region. Markers are pooled DOM nodes moved by `transform` into the circle (`worldRadius` world
 * units to the rim); one past the radius is held on the rim with the `tc-minimap-outside` class.
 * With `rotate` the map turns so the heading points up (the background turns with it); otherwise
 * north (−z) is up. The game paints the `background` (an image or a canvas it draws on) however
 * it likes; the map only clips and turns it.
 */
import { h } from './dom';
import { themePx } from './hud';
import type { Layout, RegionName, WidgetHandle } from './layout';

/** What the minimap needs from its overlay (`Overlay` fits). */
export interface MinimapHost {
  readonly layers: { readonly hud: HTMLElement };
  readonly layout: Layout;
}

export type MinimapMarkerKind = 'self' | 'ally' | 'enemy' | 'objective' | 'info';

export interface MinimapOptions {
  /** Diameter, design px. Default 200. */
  size?: number;
  /** World units from the centre to the rim. Default 50. */
  worldRadius?: number;
  /** Turn the map with the heading (heading up) instead of keeping north up. Default false. */
  rotate?: boolean;
  /** The ground picture, clipped to the circle; the game paints a canvas and passes it. */
  background?: HTMLImageElement | HTMLCanvasElement;
  /** Layout region. Default `right`. */
  region?: RegionName;
  order?: number;
}

export interface MinimapMarkerOptions {
  /** Default `'info'`. */
  kind?: MinimapMarkerKind;
  /** Text (or a glyph) in the marker; default none (a dot). */
  icon?: string;
}

/** Where a marker sits, as of its last placement. */
export interface MinimapMarkerPlace {
  /** Map px from the centre, design px; x right, y down. */
  x: number;
  y: number;
  /** True while held on the rim. */
  outside: boolean;
}

export interface Minimap {
  readonly el: HTMLElement;
  readonly size: number;
  readonly worldRadius: number;
  /** Centre the map on a world point, with the heading (degrees clockwise from north). */
  setCenter(x: number, z: number, headingDeg?: number): void;
  /** Place (or move) a marker; a new id takes a pooled node. */
  setMarker(id: string, x: number, z: number, opts?: MinimapMarkerOptions): void;
  removeMarker(id: string): void;
  /** Remove every marker. */
  clear(): void;
  /** The marker's place on the map, or null for an unknown id. */
  markerAt(id: string): MinimapMarkerPlace | null;
  remove(): void;
}

interface Node {
  readonly el: HTMLElement;
  id: string;
  wx: number;
  wz: number;
  x: number;
  y: number;
  outside: boolean;
}

const DEG = Math.PI / 180;

/** The map (see the module comment). Also reachable as `ui.minimap(opts)`. */
export function createMinimap(host: MinimapHost, opts: MinimapOptions = {}): Minimap {
  ensureMinimapStyles(host.layers.hud.ownerDocument);
  const size = opts.size ?? 200;
  const worldRadius = Math.max(1e-6, opts.worldRadius ?? 50);
  const rotate = opts.rotate === true;
  const half = size / 2;
  const scale = half / worldRadius;
  const ground = h('div', { class: 'tc-minimap-ground', 'aria-hidden': 'true' });
  if (opts.background) ground.append(opts.background);
  const markers = h('div', { class: 'tc-minimap-markers', 'aria-hidden': 'true' });
  // The centre arrow: up on a turning map, else turned to the heading.
  const self = h('span', { class: 'tc-minimap-self', 'aria-hidden': 'true' });
  const el = h(
    'div',
    {
      class: 'tc-minimap',
      role: 'img',
      'aria-label': 'Map',
      dataset: { rotate: String(rotate) },
      style: { '--tc-minimap-size': themePx(size) },
    },
    ground,
    markers,
    self,
  );

  let cx = 0;
  let cz = 0;
  let heading = 0;
  let groundTurn = Number.NaN;
  let groundX = Number.NaN;
  let groundY = Number.NaN;
  let selfTurn = Number.NaN;
  const live = new Map<string, Node>();
  const free: Node[] = [];

  const place = (n: Node) => {
    let dx = n.wx - cx;
    let dz = n.wz - cz;
    if (rotate && heading !== 0) {
      // Turn the world by −heading so the heading points up (−y on the map).
      const a = -heading * DEG;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = dx * c - dz * s;
      const rz = dx * s + dz * c;
      dx = rx;
      dz = rz;
    }
    const d = Math.hypot(dx, dz);
    const outside = d > worldRadius;
    const k = outside ? worldRadius / d : 1;
    // North is −z: up on the map.
    const x = dx * k * scale;
    const y = dz * k * scale;
    if (outside !== n.outside) {
      n.outside = outside;
      n.el.classList.toggle('tc-minimap-outside', outside);
    }
    if (x === n.x && y === n.y) return;
    n.x = x;
    n.y = y;
    n.el.style.transform = `translate3d(${themePx(x)}, ${themePx(y)}, 0) translate(-50%, -50%)`;
  };

  const placeGround = () => {
    const turn = rotate ? -heading : 0;
    const st = rotate ? 0 : heading;
    if (st !== selfTurn) {
      selfTurn = st;
      self.style.transform = `translate(-50%, -50%) rotate(${st}deg)`;
    }
    const gx = -cx * scale;
    const gy = -cz * scale;
    if (turn === groundTurn && gx === groundX && gy === groundY) return;
    groundTurn = turn;
    groundX = gx;
    groundY = gy;
    // The picture's origin is the world's (0, 0) at the map's centre: shift it by the centre,
    // then turn the whole thing about the centre.
    ground.style.transform = `rotate(${turn}deg) translate3d(${themePx(gx)}, ${themePx(gy)}, 0)`;
  };

  const handle: WidgetHandle = host.layout.add(el, {
    place: { default: opts.region ?? 'right' },
    order: opts.order,
  });
  placeGround();

  return {
    el,
    size,
    worldRadius,
    setCenter(x, z, headingDeg = heading) {
      const h = ((headingDeg % 360) + 360) % 360;
      if (x === cx && z === cz && h === heading) return;
      cx = x;
      cz = z;
      heading = h;
      placeGround();
      for (const n of live.values()) place(n);
    },
    setMarker(id, x, z, o = {}) {
      let n = live.get(id);
      if (!n) {
        n = free.pop() ?? {
          el: h('span', { class: 'tc-minimap-marker' }),
          id,
          wx: 0,
          wz: 0,
          x: Number.NaN,
          y: Number.NaN,
          outside: false,
        };
        n.id = id;
        n.x = Number.NaN;
        n.y = Number.NaN;
        n.outside = false;
        n.el.classList.remove('tc-minimap-outside');
        n.el.hidden = false;
        live.set(id, n);
        if (!n.el.isConnected) markers.append(n.el);
      }
      const kind = o.kind ?? 'info';
      if (n.el.dataset.kind !== kind) n.el.dataset.kind = kind;
      const icon = o.icon ?? '';
      if (n.el.textContent !== icon) n.el.textContent = icon;
      n.wx = x;
      n.wz = z;
      place(n);
    },
    removeMarker(id) {
      const n = live.get(id);
      if (!n) return;
      live.delete(id);
      n.el.hidden = true;
      free.push(n);
    },
    clear() {
      for (const n of live.values()) {
        n.el.hidden = true;
        free.push(n);
      }
      live.clear();
    },
    markerAt(id) {
      const n = live.get(id);
      return n ? { x: n.x, y: n.y, outside: n.outside } : null;
    },
    remove() {
      handle.remove();
      el.remove();
    },
  };
}

export const MINIMAP_CSS = `
.tc-overlay .tc-minimap { position: relative; width: var(--tc-minimap-size); height: var(--tc-minimap-size); border-radius: 50%; overflow: hidden;
  background: var(--tc-color-surface); border: var(--tc-border-width) solid var(--tc-color-border); box-shadow: var(--tc-shadow);
  box-sizing: border-box; font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); }
.tc-overlay .tc-minimap-ground { position: absolute; left: 50%; top: 50%; width: 0; height: 0; will-change: transform; transform-origin: 0 0; }
.tc-overlay .tc-minimap-ground > * { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); max-width: none; }
.tc-overlay .tc-minimap-markers { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.tc-overlay .tc-minimap-marker { position: absolute; left: 0; top: 0; display: grid; place-items: center; min-width: var(--tc-space-3); height: var(--tc-space-3);
  padding: 0 var(--tc-space-1); box-sizing: border-box; border-radius: var(--tc-radius-s); background: var(--tc-color-info); color: var(--tc-color-accent-text);
  font-weight: 700; line-height: 1; will-change: transform; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
.tc-overlay .tc-minimap-marker[hidden] { display: none; }
.tc-overlay .tc-minimap-marker:empty { border-radius: 50%; min-width: var(--tc-space-3); padding: 0; }
.tc-overlay .tc-minimap-marker[data-kind="self"] { background: var(--tc-color-text); }
.tc-overlay .tc-minimap-marker[data-kind="ally"] { background: var(--tc-color-success); }
.tc-overlay .tc-minimap-marker[data-kind="enemy"] { background: var(--tc-color-danger); }
.tc-overlay .tc-minimap-marker[data-kind="objective"] { background: var(--tc-color-accent); }
.tc-overlay .tc-minimap-marker.tc-minimap-outside { opacity: 0.6; border-radius: 50%; }
.tc-overlay .tc-minimap-self { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform: translate(-50%, -50%);
  border-left: var(--tc-space-2) solid transparent; border-right: var(--tc-space-2) solid transparent; border-bottom: var(--tc-space-3) solid var(--tc-color-accent);
  transform-origin: 50% 66%; filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.8)); }
`;

const STYLE_ID = 'tc-ui-minimap';

/** Add `MINIMAP_CSS` to `doc` once (the first map does it). */
export function ensureMinimapStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MINIMAP_CSS;
  doc.head.appendChild(style);
}
