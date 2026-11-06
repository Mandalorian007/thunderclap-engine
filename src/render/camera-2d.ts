/**
 * 2D camera follow (ws/ergo-2d-2): the platformer camera every 2D game rewrote. A dead zone
 * the target moves inside without the view moving, look-ahead toward the target's velocity,
 * exponential smoothing, and a world rectangle the view never leaves. It drives an ortho2d
 * `Camera` through `camera.x` and `camera.y` only (the view's top-left in design px) and reads
 * `camera.screen` and `camera.zoom` for the view size; nothing else on the camera is touched.
 *
 * Per `update(dt, targetX, targetY, velX, velY)`:
 *  1. the anchor moves just enough to keep the target inside the dead zone (none: it tracks);
 *  2. the look-ahead eases toward `sign(vel) × lookAhead` with time constant `lookAheadSmoothing`;
 *  3. the view centre eases toward `anchor + lookAhead` with time constant `smoothing`;
 *  4. the view rect is clamped inside `bounds` (a view wider than the bounds is centred).
 * Every easing is `1 - exp(-dt / tau)`, so the result depends on `dt` alone. `teleport` puts
 * everything at a point with no easing. No allocation per frame.
 */
import type { Camera } from './camera';

/** What the follow needs from a `Camera`. */
export type Follow2DCamera = Pick<Camera, 'x' | 'y' | 'zoom' | 'screen'>;

export interface Follow2DBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Follow2DOptions {
  /** Box around the anchor (world px) the target moves inside freely. Default `0 × 0`. */
  deadZone?: { w: number; h: number };
  /** How far ahead of the target (world px) the view leads along each moving axis. Default 0. */
  lookAhead?: { x: number; y: number };
  /** Time constant (s) of the look-ahead easing. Default 0.25; 0 is instant. */
  lookAheadSmoothing?: number;
  /** Time constant (s) of the view's easing toward its goal. Default 0 (instant). */
  smoothing?: number;
  /** World rect the view stays inside. Mutate `follow.bounds` later to change it. */
  bounds?: Follow2DBounds;
  /** First `update` snaps to the target instead of easing from the camera's position. Default true. */
  snapOnStart?: boolean;
}

export interface Follow2D {
  /** View centre, world px (what the camera shows at its middle). */
  readonly x: number;
  readonly y: number;
  /** Dead-zone centre, world px. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Current look-ahead offset, world px. */
  readonly lookX: number;
  readonly lookY: number;
  readonly deadZone: { w: number; h: number };
  readonly lookAhead: { x: number; y: number };
  lookAheadSmoothing: number;
  smoothing: number;
  bounds: Follow2DBounds | null;
  /** Advance by `dt` seconds toward `(targetX, targetY)` moving at `(velX, velY)`; writes the camera. */
  update(dt: number, targetX: number, targetY: number, velX?: number, velY?: number): void;
  /** Put the anchor and the view at `(x, y)` with no easing and no look-ahead; writes the camera. */
  teleport(x: number, y: number): void;
}

function ease(dt: number, tau: number): number {
  return tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
}

/** Make a `Follow2D` over `camera`. Allocates once. */
export function createFollow2D(camera: Follow2DCamera, opts: Follow2DOptions = {}): Follow2D {
  const deadZone = { w: opts.deadZone?.w ?? 0, h: opts.deadZone?.h ?? 0 };
  const lookAhead = { x: opts.lookAhead?.x ?? 0, y: opts.lookAhead?.y ?? 0 };
  let started = !(opts.snapOnStart ?? true);
  let ax = camera.x + camera.screen.width / 2;
  let ay = camera.y + camera.screen.height / 2;
  let x = ax;
  let y = ay;
  let lx = 0;
  let ly = 0;

  function clampAndWrite(): void {
    const b = follow.bounds;
    if (b) {
      const hw = camera.screen.width / (2 * camera.zoom);
      const hh = camera.screen.height / (2 * camera.zoom);
      x =
        b.maxX - b.minX <= 2 * hw
          ? (b.minX + b.maxX) / 2
          : Math.min(Math.max(x, b.minX + hw), b.maxX - hw);
      y =
        b.maxY - b.minY <= 2 * hh
          ? (b.minY + b.maxY) / 2
          : Math.min(Math.max(y, b.minY + hh), b.maxY - hh);
    }
    camera.x = x - camera.screen.width / 2;
    camera.y = y - camera.screen.height / 2;
  }

  const follow: Follow2D = {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get anchorX() {
      return ax;
    },
    get anchorY() {
      return ay;
    },
    get lookX() {
      return lx;
    },
    get lookY() {
      return ly;
    },
    deadZone,
    lookAhead,
    lookAheadSmoothing: opts.lookAheadSmoothing ?? 0.25,
    smoothing: opts.smoothing ?? 0,
    bounds: opts.bounds ?? null,
    update(dt, tx, ty, vx = 0, vy = 0) {
      if (!started) {
        started = true;
        follow.teleport(tx, ty);
        return;
      }
      const hw = deadZone.w / 2;
      const hh = deadZone.h / 2;
      if (tx < ax - hw) ax = tx + hw;
      else if (tx > ax + hw) ax = tx - hw;
      if (ty < ay - hh) ay = ty + hh;
      else if (ty > ay + hh) ay = ty - hh;
      const kl = ease(dt, follow.lookAheadSmoothing);
      lx += (Math.sign(vx) * lookAhead.x - lx) * kl;
      ly += (Math.sign(vy) * lookAhead.y - ly) * kl;
      const k = ease(dt, follow.smoothing);
      x += (ax + lx - x) * k;
      y += (ay + ly - y) * k;
      clampAndWrite();
    },
    teleport(px, py) {
      started = true;
      ax = px;
      ay = py;
      x = px;
      y = py;
      lx = 0;
      ly = 0;
      clampAndWrite();
    },
  };
  return follow;
}
