/**
 * Touch zones: the left half of the screen is a floating stick that only reads sideways, the right
 * half is the jump button, and the top third of the right half is dash. Pure: it reads the pointer
 * list the engine's router keeps (`ctx.pointers.pointers`) and produces an `Intent`-shaped
 * reading; the scene merges it with the keyboard and pad actions.
 *
 * Why not `gesture` bindings: the engine's gestures treat two fingers as a pinch and suppress taps
 * while both are down, and a platformer holds one thumb on the stick while the other jumps. The
 * router's multitouch list is the primitive that fits.
 */

export interface TouchPointer {
  readonly key: number;
  readonly device: string;
  readonly x: number;
  readonly y: number;
  readonly select: boolean;
}

export interface TouchReading {
  move: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  dashPressed: boolean;
  /** Any finger down this tick (so the scene knows touch is live). */
  active: boolean;
}

export interface TouchZones {
  readonly reading: TouchReading;
  /** Call once per fixed step with the router's live pointers. */
  update(pointers: readonly TouchPointer[]): void;
}

/** Stick travel: dead zone and full deflection, screen px. */
const DEAD = 12;
const FULL = 64;

export function createTouchZones(screenW: number, screenH: number): TouchZones {
  const reading: TouchReading = {
    move: 0,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    active: false,
  };
  let stickKey = -1;
  let stickOriginX = 0;
  let jumpKey = -1;
  let dashKey = -1;
  return {
    reading,
    update(pointers) {
      reading.jumpPressed = false;
      reading.dashPressed = false;
      reading.active = false;
      let stickSeen = false;
      let jumpSeen = false;
      let dashSeen = false;
      let move = 0;
      for (const p of pointers) {
        if (p.device !== 'touch' || !p.select || Number.isNaN(p.x)) continue;
        reading.active = true;
        if (p.key === stickKey) {
          stickSeen = true;
          move = deflect(p.x - stickOriginX);
          continue;
        }
        if (p.key === jumpKey) {
          jumpSeen = true;
          continue;
        }
        if (p.key === dashKey) {
          dashSeen = true;
          continue;
        }
        // A new finger: assign it by where it landed.
        if (p.x < screenW / 2) {
          if (stickKey < 0) {
            stickKey = p.key;
            stickOriginX = p.x;
            stickSeen = true;
          }
        } else if (p.y < screenH / 3) {
          if (dashKey < 0) {
            dashKey = p.key;
            dashSeen = true;
            reading.dashPressed = true;
          }
        } else if (jumpKey < 0) {
          jumpKey = p.key;
          jumpSeen = true;
          reading.jumpPressed = true;
        }
      }
      if (!stickSeen) stickKey = -1;
      if (!jumpSeen) jumpKey = -1;
      if (!dashSeen) dashKey = -1;
      reading.move = move;
      reading.jumpHeld = jumpSeen;
    },
  };
}

function deflect(dx: number): number {
  const a = Math.abs(dx);
  if (a <= DEAD) return 0;
  const v = Math.min(1, (a - DEAD) / (FULL - DEAD));
  return dx < 0 ? -v : v;
}
