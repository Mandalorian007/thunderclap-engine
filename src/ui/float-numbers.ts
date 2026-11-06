/**
 * Float numbers (ws/ui-4): short-lived text that rises from a world point and fades, as damage,
 * healing and pickups do. A fixed pool of DOM nodes on the hud layer (`max`, default 64) is
 * reused in spawn order: a spawn past the pool recycles the oldest. Each `update(dt)` projects
 * the live nodes through the overlay's `Anchors` (`anchors.project`) and writes `transform` only
 * (Typed OM where it exists, so a frame allocates nothing); the fade is a CSS animation on
 * opacity. Kinds map to theme classes: `damage` (danger), `heal` (success), `crit` (warn, larger)
 * and `info` (text). `ui.floats` is the overlay's pool with the defaults.
 */
import { type Anchors, type TypedTransform, typedTransform } from './anchor';
import { h } from './dom';
import { toFrameUnits } from './text-scale';

export type FloatKind = 'damage' | 'heal' | 'crit' | 'info';

export interface FloatNumbersOptions {
  /** Pool size: the most numbers in flight at once. Default 64. */
  max?: number;
  /** Lifetime, seconds. Default 1. */
  duration?: number;
  /** How far a number rises over its life, design px. Default 48. */
  rise?: number;
  /** An extra class on every node (a game's own style). */
  style?: string;
}

export interface FloatSpawnOptions {
  /** Default `'info'`. */
  kind?: FloatKind;
}

export interface FloatNumbers {
  /** Numbers in flight. */
  readonly live: number;
  /** Nodes made so far (never more than `max`). */
  readonly pooled: number;
  readonly max: number;
  /** Start a number at the world point; past `max` the oldest is recycled. */
  spawn(x: number, y: number, z: number, text: string, opts?: FloatSpawnOptions): void;
  /** Age, place and retire the numbers; call once per update with the step in seconds. */
  update(dt: number): void;
  /** Retire every number now. */
  clear(): void;
  /** `clear()` and take the nodes out of the layer. */
  dispose(): void;
}

/** What the float numbers need from their overlay (`Overlay` fits). */
export interface FloatNumbersHost {
  readonly layers: { readonly hud: HTMLElement };
  /** The overlay's `Anchors`; throws until a camera built it. */
  anchors(): Anchors;
}

interface Node {
  readonly el: HTMLElement;
  readonly world: Float32Array;
  age: number;
  x: number;
  y: number;
  typed: TypedTransform | null;
}

const pt = { x: 0, y: 0 };

/** The pool (see the module comment). Also reachable as `ui.floats`. */
export function createFloatNumbers(
  host: FloatNumbersHost,
  opts: FloatNumbersOptions = {},
): FloatNumbers {
  const layer = host.layers.hud;
  ensureFloatStyles(layer.ownerDocument);
  const max = Math.max(1, Math.floor(opts.max ?? 64));
  const duration = opts.duration ?? 1;
  const rise = opts.rise ?? 48;
  const ring: (Node | null)[] = new Array<Node | null>(max).fill(null);
  let head = 0;
  let count = 0;
  let pooled = 0;
  let disposed = false;

  const make = (): Node => {
    const el = h('span', {
      class: opts.style ? `tc-float ${opts.style}` : 'tc-float',
      'aria-hidden': 'true',
      hidden: true,
      style: { '--tc-float-duration': `${duration}s` },
    });
    layer.append(el);
    pooled++;
    return {
      el,
      world: new Float32Array(3),
      age: 0,
      x: Number.NaN,
      y: Number.NaN,
      typed: typedTransform(el, 0.5, 1),
    };
  };

  const retire = (n: Node) => {
    n.el.hidden = true;
    n.x = Number.NaN;
    n.y = Number.NaN;
  };

  const floats: FloatNumbers = {
    get live() {
      return count;
    },
    get pooled() {
      return pooled;
    },
    max,
    spawn(x, y, z, text, o = {}) {
      if (disposed) return;
      let n: Node;
      if (count === max) {
        // Full: the oldest (at the head) starts over at the tail.
        n = ring[head]!;
        head = (head + 1) % max;
        count--;
        retire(n);
        // A node still showing restarts its fade only once it is laid out again.
        void n.el.offsetWidth;
      } else {
        const i = (head + count) % max;
        n = ring[i] ?? make();
        ring[i] = n;
      }
      ring[(head + count) % max] = n;
      count++;
      n.age = 0;
      n.world[0] = x;
      n.world[1] = y;
      n.world[2] = z;
      n.el.textContent = text;
      n.el.dataset.kind = o.kind ?? 'info';
      // Placed by the next update, where it shows.
    },
    update(dt) {
      if (disposed || count === 0) return;
      // Retire from the head: the ring is in spawn order, so ages fall along it.
      while (count > 0) {
        const n = ring[head]!;
        n.age += dt;
        if (n.age < duration) break;
        retire(n);
        head = (head + 1) % max;
        count--;
      }
      if (count === 0) return;
      const anchors = host.anchors();
      const f = anchors.frame;
      const unit = f.width > 0 ? f.rect.width / f.width : 1;
      // The head aged above; the rest age here.
      for (let i = 0; i < count; i++) {
        const n = ring[(head + i) % max]!;
        if (i > 0) n.age += dt;
        const inside = anchors.project(n.world[0]!, n.world[1]!, n.world[2]!, pt);
        if (!inside) {
          if (!n.el.hidden) n.el.hidden = true;
          continue;
        }
        const t = Math.min(1, n.age / duration);
        const x = pt.x;
        const y = pt.y - rise * unit * t;
        if (n.el.hidden) n.el.hidden = false;
        if (x === n.x && y === n.y) continue;
        n.x = x;
        n.y = y;
        const ty = n.typed;
        if (ty) {
          ty.x.value = x;
          ty.y.value = y;
          n.el.attributeStyleMap.set('transform', ty.value);
        } else {
          n.el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1) translate(-50%, -100%)`;
        }
      }
    },
    clear() {
      while (count > 0) {
        retire(ring[head]!);
        head = (head + 1) % max;
        count--;
      }
    },
    dispose() {
      if (disposed) return;
      floats.clear();
      disposed = true;
      for (const n of ring) n?.el.remove();
      ring.fill(null);
    },
  };
  return floats;
}

/** Stylesheet for the float nodes (design px, theme tokens). */
export const FLOAT_CSS = toFrameUnits(`
.tc-float { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform, opacity;
  pointer-events: none; white-space: nowrap; font-family: var(--tc-font-display); font-size: var(--tc-font-size-m);
  font-weight: 700; color: var(--tc-color-text); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 0 4px rgba(0, 0, 0, 0.5);
  animation: tc-float-fade var(--tc-float-duration, 1s) ease-in forwards; }
.tc-float[hidden] { display: none; }
.tc-float[data-kind="damage"] { color: var(--tc-color-danger); }
.tc-float[data-kind="heal"] { color: var(--tc-color-success); }
.tc-float[data-kind="crit"] { color: var(--tc-color-warn); font-size: var(--tc-font-size-l); }
@keyframes tc-float-fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .tc-float { animation-timing-function: steps(1, end); } }
`);

const STYLE_ID = 'tc-ui-float';

/** Add `FLOAT_CSS` to `doc` once (the first pool does it). */
export function ensureFloatStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FLOAT_CSS;
  doc.head.appendChild(style);
}
