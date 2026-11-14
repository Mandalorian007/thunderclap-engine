/**
 * Two controllers' sticks and buttons read as moves (ws/xr-merge, from Forge Wilds' XR scheme):
 * one hand's stick walks (head-relative), the other's turns (snap or smooth) and flicks up or
 * down (next, previous), and every button's press is an edge. It reads the xr-standard gamepad
 * layout: buttons trigger 0, grip 1, stick 3, A/X 4, B/Y 5; the stick is axes 2 and 3.
 *
 * It names no action: the game maps `move`, `turn`, `flick` and the edges to its own. Pure: the
 * game hands in each hand's pad (`XrPad`, from `readPads` or a fake), nothing allocates per frame.
 */
import type { Hand } from '../input/types';

/** A stick inside this is at rest. */
export const STICK_DEAD = 0.15;
/** A snap turn or a flick fires past this, and re-arms under `REARM`. */
export const SNAP_AT = 0.6;
export const REARM = 0.3;

/** xr-standard button indices. */
export const XR_BUTTON = { trigger: 0, grip: 1, stick: 3, primary: 4, secondary: 5 } as const;
export type XrButtonName = keyof typeof XR_BUTTON;

/** One hand's pad: its buttons' pressed state and its axes (xr-standard). */
export interface XrPad {
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value?: number }>;
  readonly axes: ArrayLike<number>;
}

export interface XrSticksOptions {
  /** The hand that walks (default left); the other turns. */
  moveHand?: Hand;
  /** `'snap'` (default) or `'smooth'`. */
  turn?: 'snap' | 'smooth';
  /** A snap turn's angle, degrees (default 30). */
  snapDeg?: number;
  /** A smooth turn's rate at full stick, degrees/s (default 120). */
  smoothDegS?: number;
}

const BUTTONS = 6;

function axis(v: number | undefined): number {
  const a = v ?? 0;
  if (Math.abs(a) < STICK_DEAD) return 0;
  return (a - Math.sign(a) * STICK_DEAD) / (1 - STICK_DEAD);
}

/** Sticks and buttons into moves. Call `frame` once a frame with both hands' pads (or null). */
export class XrSticks {
  moveHand: Hand;
  turnMode: 'snap' | 'smooth';
  snapDeg: number;
  smoothDegS: number;
  /** The walk this frame in the stick's own frame: x right, y forward (-1 to 1, dead zone out). */
  readonly move: [number, number] = [0, 0];
  /** The yaw turn this frame (radians, positive to the right). */
  turn = 0;
  /** A snap turn fired this frame (`Vignette.snapped`). */
  snapped = false;
  /** A flick this frame: 1 up (next), -1 down (previous), 0 none. */
  flick = 0;
  /** Anything pressed or moved this frame on either hand. */
  any = false;
  private readonly down = [new Uint8Array(BUTTONS), new Uint8Array(BUTTONS)];
  private readonly was = [new Uint8Array(BUTTONS), new Uint8Array(BUTTONS)];
  private snapArmed = true;
  private flickArmed = true;

  constructor(opts: XrSticksOptions = {}) {
    this.moveHand = opts.moveHand ?? 'left';
    this.turnMode = opts.turn ?? 'snap';
    this.snapDeg = opts.snapDeg ?? 30;
    this.smoothDegS = opts.smoothDegS ?? 120;
  }

  /** A frame of `dt` seconds with each hand's pad (null: not tracked). */
  frame(left: XrPad | null, right: XrPad | null, dt: number): void {
    this.any = false;
    for (let h = 0; h < 2; h++) {
      const pad = h === 0 ? left : right;
      const down = this.down[h]!;
      const was = this.was[h]!;
      for (let b = 0; b < BUTTONS; b++) {
        was[b] = down[b]!;
        const btn = pad ? pad.buttons[b] : undefined;
        down[b] = btn?.pressed ? 1 : 0;
        if (down[b]) this.any = true;
      }
    }
    const movePad = this.moveHand === 'left' ? left : right;
    const turnPad = this.moveHand === 'left' ? right : left;
    this.move[0] = movePad ? axis(movePad.axes[2]) : 0;
    this.move[1] = movePad ? 0 - axis(movePad.axes[3]) : 0;
    const tx = turnPad ? axis(turnPad.axes[2]) : 0;
    const ty = turnPad ? -axis(turnPad.axes[3]) : 0;
    if (this.move[0] !== 0 || this.move[1] !== 0 || tx !== 0 || ty !== 0) this.any = true;
    this.turn = 0;
    this.snapped = false;
    const rawX = turnPad ? (turnPad.axes[2] ?? 0) : 0;
    const rawY = turnPad ? -(turnPad.axes[3] ?? 0) : 0;
    // Turn and flick share a stick: whichever way it's pushed further wins.
    const sideways = Math.abs(rawX) >= Math.abs(rawY);
    if (this.turnMode === 'smooth') {
      if (sideways) this.turn = ((tx * this.smoothDegS * Math.PI) / 180) * Math.max(0, dt);
    } else if (this.snapArmed && sideways && Math.abs(rawX) > SNAP_AT) {
      this.turn = (Math.sign(rawX) * this.snapDeg * Math.PI) / 180;
      this.snapped = true;
      this.snapArmed = false;
    }
    if (Math.abs(rawX) < REARM) this.snapArmed = true;
    this.flick = 0;
    if (this.flickArmed && !sideways && Math.abs(rawY) > SNAP_AT) {
      this.flick = Math.sign(rawY);
      this.flickArmed = false;
    }
    if (Math.abs(rawY) < REARM) this.flickArmed = true;
  }

  /** The button is held on that hand. */
  held(hand: Hand, button: XrButtonName): boolean {
    return this.down[hand === 'left' ? 0 : 1]![XR_BUTTON[button]] === 1;
  }

  /** The button went down this frame on that hand. */
  pressed(hand: Hand, button: XrButtonName): boolean {
    const h = hand === 'left' ? 0 : 1;
    const b = XR_BUTTON[button];
    return this.down[h]![b] === 1 && this.was[h]![b] === 0;
  }

  /** The button came up this frame on that hand. */
  released(hand: Hand, button: XrButtonName): boolean {
    const h = hand === 'left' ? 0 : 1;
    const b = XR_BUTTON[button];
    return this.down[h]![b] === 0 && this.was[h]![b] === 1;
  }
}

/**
 * The head's yaw (radians, 0 facing -z, positive turning right) from its orientation quaternion
 * (x, y, z, w): the facing on the ground, whatever the pitch. Looking straight up or down there
 * is none: `keep` (the last yaw) is returned.
 */
export function headYawOf(q: ArrayLike<number>, keep = 0): number {
  const x = q[0]!;
  const y = q[1]!;
  const z = q[2]!;
  const w = q[3]!;
  // The head's forward (-z) rotated by q, on the ground.
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  if (fx * fx + fz * fz < 1e-10) return keep;
  return Math.atan2(fx, -fz);
}

/**
 * A stick's move (x right, y forward) turned by a yaw (radians, `headYawOf`) into world x, z on
 * the ground (-z is forward at yaw 0), into `out`.
 */
export function headRelative(
  move: ArrayLike<number>,
  yaw: number,
  out: [number, number],
): [number, number] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const mx = move[0]!;
  const my = move[1]!;
  out[0] = mx * c + my * s;
  out[1] = mx * s - my * c;
  return out;
}
