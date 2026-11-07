/**
 * Floating text (ws/ui-5): damage, healing and pickup numbers that rise from a world point and
 * fade. `createFloats(host, camera)` returns a `Floats` whose labels are a fixed pool of DOM nodes
 * on the hud layer (`max`, default 64), projected each `update(dt)` through the overlay's
 * `Anchors` (`anchors.project`, the path `ui.anchors` places its elements on) and hidden when
 * the point is behind the camera or off screen.
 *
 * - Each spawn takes its own `color`, `size` (a factor on the theme's `--tc-font-size-m`),
 *   `rise` (design px over the life), `life` (seconds) and `crit` (a scale pop on arrival).
 * - `stack` (on by default) fans out spawns landing on one point while earlier ones are still
 *   young: alternately right and left, each a step higher, so a burst of hits stays readable.
 * - Past `max` the oldest label is recycled. `update` writes `transform` (Typed OM where it
 *   exists) and `opacity` from a table of precomputed strings, so a steady frame allocates
 *   nothing; a spawn writes the text (and the colour or size only when they change).
 * - `prefers-reduced-motion` keeps the labels still: no rise, no pop, only the fade.
 */
import { type AnchorCamera, type Anchors, type TypedTransform, typedTransform } from './anchor';
import { h } from './dom';
import { prefersReducedMotionIn } from './styles';
import { toFrameUnits } from './text-scale';

/** What floats need from their overlay (`Overlay` fits). */
export interface FloatsHost {
  readonly layers: { readonly hud: HTMLElement };
  /** The overlay's `Anchors`; the first call needs a camera. */
  anchors(camera?: () => AnchorCamera): Anchors;
}

export interface FloatsOptions {
  /** Pool size: the most labels in flight at once. Default 64. */
  max?: number;
  /** Default life, seconds. Default 1. */
  life?: number;
  /** Default rise over the life, design px. Default 56. */
  rise?: number;
  /** World distance under which two spawns count as one point for `stack`. Default 0.35. */
  stackRadius?: number;
  /** Horizontal and vertical fan step for `stack`, design px. Default 30 and 18. */
  stackStep?: readonly [number, number];
  /** An extra class on every label (a game's own style). */
  style?: string;
  /** Keep labels still (no rise, no pop). Default: `prefers-reduced-motion`. */
  reducedMotion?: boolean;
}

export interface FloatTextOptions {
  /** CSS colour. Default the theme text colour (`--tc-color-text`). */
  color?: string;
  /** Font size factor on `--tc-font-size-m`. Default 1 (1.3 for a crit). */
  size?: number;
  /** Rise over the life, design px. Default `FloatsOptions.rise`. */
  rise?: number;
  /** Life, seconds. Default `FloatsOptions.life`. */
  life?: number;
  /** Pop in scale on arrival and draw a touch larger. Default false. */
  crit?: boolean;
  /** Fan out from younger labels at the same point. Default true. */
  stack?: boolean;
}

export interface Floats {
  /** Labels in flight. */
  readonly live: number;
  /** Nodes made so far (never more than `max`). */
  readonly pooled: number;
  readonly max: number;
  /** Start a label at the world point (copied). Past `max` the oldest is recycled. */
  spawn(text: string, world: ArrayLike<number>, opts?: FloatTextOptions): void;
  /** Age, place and retire the labels; call once per update with the step in seconds. */
  update(dt: number): void;
  /** Retire every label now. */
  clear(): void;
  /** `clear()` and take the nodes out of the layer. */
  dispose(): void;
}

interface Node {
  readonly el: HTMLElement;
  readonly world: Float32Array;
  live: boolean;
  seq: number;
  age: number;
  life: number;
  rise: number;
  crit: boolean;
  /** Fan offset, design px. */
  ox: number;
  oy: number;
  color: string;
  size: number;
  x: number;
  y: number;
  s: number;
  q: number;
  typed: TypedTransform | null;
}

/** Opacity steps, precomputed so a fade writes no new string. */
const STEPS = 32;
const OPACITY: string[] = [];
for (let i = 0; i <= STEPS; i++) OPACITY.push(String(i / STEPS));

/** The fade: full for the first 60 % of the life, then down to 0. @internal */
export function floatOpacity(t: number): number {
  return t <= 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
}

/** The crit pop: 0.6 → 1.5 over the first 8 % of the life, back to 1.15 by 20 %. @internal */
export function critScale(t: number): number {
  if (t < 0.08) return 0.6 + (1.5 - 0.6) * (t / 0.08);
  if (t < 0.2) return 1.5 + (1.15 - 1.5) * ((t - 0.08) / 0.12);
  return 1.15;
}

const pt = { x: 0, y: 0 };

/**
 * The floats (see the module comment). `camera` is handed to `host.anchors(camera)` once, so the
 * overlay's anchors project through it; without one the anchors must already exist or the
 * overlay have a default (`OverlayOptions.camera`, which `createGame` sets).
 */
export function createFloats(
  host: FloatsHost,
  camera?: () => AnchorCamera,
  opts: FloatsOptions = {},
): Floats {
  const layer = host.layers.hud;
  const doc = layer.ownerDocument;
  ensureFloatsStyles(doc);
  if (camera) host.anchors(camera);
  const max = Math.max(1, Math.floor(opts.max ?? 64));
  const life = Math.max(1e-3, opts.life ?? 1);
  const rise = opts.rise ?? 56;
  const r2 = (opts.stackRadius ?? 0.35) ** 2;
  const [stepX, stepY] = opts.stackStep ?? [30, 18];
  const still = opts.reducedMotion ?? prefersReducedMotionIn(doc.defaultView ?? undefined);
  const nodes: Node[] = [];
  const free: Node[] = [];
  let live = 0;
  let seq = 0;
  let disposed = false;

  const make = (): Node => {
    const el = h('span', {
      class: opts.style ? `tc-floats ${opts.style}` : 'tc-floats',
      'aria-hidden': 'true',
      hidden: true,
    });
    layer.append(el);
    const n: Node = {
      el,
      world: new Float32Array(3),
      live: false,
      seq: 0,
      age: 0,
      life,
      rise,
      crit: false,
      ox: 0,
      oy: 0,
      color: '',
      size: 1,
      x: Number.NaN,
      y: Number.NaN,
      s: Number.NaN,
      q: -1,
      typed: typedTransform(el, 0.5, 1),
    };
    nodes.push(n);
    return n;
  };

  const retire = (n: Node) => {
    if (!n.live) return;
    n.live = false;
    live--;
    n.el.hidden = true;
    n.x = Number.NaN;
    n.y = Number.NaN;
    free.push(n);
  };

  const take = (): Node => {
    const f = free.pop();
    if (f) return f;
    if (nodes.length < max) return make();
    // Full: recycle the oldest.
    let oldest = nodes[0]!;
    for (const n of nodes) if (n.seq < oldest.seq) oldest = n;
    retire(oldest);
    free.pop();
    return oldest;
  };

  /** Younger labels within `stackRadius` of the point: the fan index of a new one. */
  const stackIndex = (x: number, y: number, z: number): number => {
    let k = 0;
    for (const n of nodes) {
      if (!n.live || n.age > n.life * 0.5) continue;
      const dx = n.world[0]! - x;
      const dy = n.world[1]! - y;
      const dz = n.world[2]! - z;
      if (dx * dx + dy * dy + dz * dz <= r2) k++;
    }
    return k;
  };

  const floats: Floats = {
    get live() {
      return live;
    },
    get pooled() {
      return nodes.length;
    },
    max,
    spawn(text, world, o = {}) {
      if (disposed) return;
      const x = world[0] ?? 0;
      const y = world[1] ?? 0;
      const z = world[2] ?? 0;
      const k = o.stack === false ? 0 : stackIndex(x, y, z);
      const n = take();
      n.live = true;
      live++;
      n.seq = ++seq;
      n.age = 0;
      n.life = Math.max(1e-3, o.life ?? life);
      n.rise = still ? 0 : (o.rise ?? rise);
      n.crit = o.crit === true;
      n.ox = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * stepX;
      n.oy = -k * stepY;
      n.world[0] = x;
      n.world[1] = y;
      n.world[2] = z;
      n.x = Number.NaN;
      n.s = Number.NaN;
      n.q = -1;
      if (n.el.textContent !== text) n.el.textContent = text;
      const color = o.color ?? '';
      if (color !== n.color) {
        n.color = color;
        n.el.style.color = color;
      }
      const size = o.size ?? (n.crit ? 1.3 : 1);
      if (size !== n.size) {
        n.size = size;
        n.el.style.fontSize = size === 1 ? '' : `calc(var(--tc-font-size-m) * ${size})`;
      }
      n.el.toggleAttribute('data-crit', n.crit);
      // Placed (and shown) by the next update.
    },
    update(dt) {
      if (disposed || live === 0) return;
      const anchors = host.anchors();
      const f = anchors.frame;
      const unit = f.width > 0 ? f.rect.width / f.width : 1;
      for (const n of nodes) {
        if (!n.live) continue;
        n.age += dt;
        if (n.age >= n.life) {
          retire(n);
          continue;
        }
        const inside = anchors.project(n.world[0]!, n.world[1]!, n.world[2]!, pt);
        if (!inside) {
          if (!n.el.hidden) n.el.hidden = true;
          continue;
        }
        const t = n.age / n.life;
        const x = pt.x + n.ox * unit;
        const y = pt.y + (n.oy - n.rise * t) * unit;
        const s = n.crit && !still ? critScale(t) : 1;
        const q = Math.round(floatOpacity(t) * STEPS);
        if (n.el.hidden) n.el.hidden = false;
        if (q !== n.q) {
          n.q = q;
          n.el.style.opacity = OPACITY[q]!;
        }
        if (x === n.x && y === n.y && s === n.s) continue;
        n.x = x;
        n.y = y;
        n.s = s;
        const ty = n.typed;
        if (ty) {
          ty.x.value = x;
          ty.y.value = y;
          ty.s.value = s;
          n.el.attributeStyleMap.set('transform', ty.value);
        } else {
          n.el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s}) translate(-50%, -100%)`;
        }
      }
    },
    clear() {
      for (const n of nodes) retire(n);
    },
    dispose() {
      if (disposed) return;
      floats.clear();
      disposed = true;
      for (const n of nodes) n.el.remove();
      nodes.length = 0;
      free.length = 0;
    },
  };
  return floats;
}

/**
 * Stylesheet for the labels (design px, theme tokens).
 *
 * @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const FLOATS_CSS = toFrameUnits(`
.tc-floats { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform, opacity;
  pointer-events: none; white-space: nowrap; font-family: var(--tc-font-display); font-size: var(--tc-font-size-m);
  font-weight: 800; line-height: 1; color: var(--tc-color-text); font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 3px rgba(0, 0, 0, 0.85), 0 0 6px rgba(0, 0, 0, 0.5); }
.tc-floats[hidden] { display: none; }
.tc-floats[data-crit] { letter-spacing: 0.02em; text-shadow: 0 2px 3px rgba(0, 0, 0, 0.9), 0 0 10px var(--tc-color-warn); }
`);

const STYLE_ID = 'tc-ui-floats';

/** Add `FLOATS_CSS` to `doc` once (the first `createFloats` does it). */
export function ensureFloatsStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FLOATS_CSS;
  doc.head.appendChild(style);
}
