/**
 * Hold, tap and wheel primitives (ws/intents-quality, D1 §2.13), pure and allocation-free: the
 * still-press classifier that tells a tap from a hold from a drag, the specs intents read
 * (`stillHold`, `stickSideHold`), the stick-side rule and wheel steps. Generalized from Forge
 * Wilds' play/gestures.ts; no DOM, so they are tested on their own and `createIntents` drives them.
 */

/** What a press is so far: still (`pending`), moved past its tolerance (`drag`), or held still long enough (`hold`). */
export type StillPressKind = 'pending' | 'drag' | 'hold';

/** How a still press becomes a hold: within `tolerancePx` (CSS px from the down point) for `ms`. */
export interface StillHoldOptions {
  /** A press may wander this far (CSS px) and still tap or hold. Default 10 (a finger). */
  tolerancePx?: number;
  /** Still this long (ms) it is a hold; lifted sooner, a tap. Default 300. */
  ms?: number;
}

/** A `stillHold(...)`: the resolved tolerance and time, read by `createIntents` and `StillPress`. */
export interface StillHoldSpec {
  readonly type: 'still';
  readonly tolerancePx: number;
  readonly ms: number;
}

/** Defaults of `stillHold()`: a finger's slop and hold time. */
export const STILL_HOLD_DEFAULTS = { tolerancePx: 10, ms: 300 } as const;

/** A still hold: a press within `tolerancePx` for `ms` is a hold, lifted sooner a tap, moved farther a drag. */
export function stillHold(opts: StillHoldOptions = {}): StillHoldSpec {
  return {
    type: 'still',
    tolerancePx: opts.tolerancePx ?? STILL_HOLD_DEFAULTS.tolerancePx,
    ms: opts.ms ?? STILL_HOLD_DEFAULTS.ms,
  };
}

/** `stickSideHold`'s options: a still hold plus the game's test of where the thumb landed. */
export interface StickSideHoldOptions<Aim = unknown> extends StillHoldOptions {
  /**
   * Whether a thumb landing on the move stick's side at this aim may hold there (the game's
   * test: something in reach to act on). Read once, when the thumb lands.
   */
  when: (aim: Aim) => boolean;
}

/** A `stickSideHold(...)`: a hold the move stick's thumb may make. */
export interface StickSideHoldSpec<Aim = unknown> {
  readonly type: 'stickSide';
  readonly tolerancePx: number;
  readonly ms: number;
  readonly when: (aim: Aim) => boolean;
}

/**
 * A stick-side hold: a thumb that lands in the move stick's zone where `when(aim)` is true and
 * stays still for `ms` stops walking and holds there (the stick frees for the next thumb). If it
 * drags first it stays the stick.
 */
export function stickSideHold<Aim = unknown>(
  opts: StickSideHoldOptions<Aim>,
): StickSideHoldSpec<Aim> {
  return {
    type: 'stickSide',
    tolerancePx: opts.tolerancePx ?? STILL_HOLD_DEFAULTS.tolerancePx,
    ms: opts.ms ?? STILL_HOLD_DEFAULTS.ms,
    when: opts.when,
  };
}

/**
 * Tells a tap from a hold from a drag. A press is `pending` until it moves past the tolerance (a
 * drag) or stays still for the hold time (a hold). Once decided it never changes: a drag never
 * holds, and a hold that then moves stays a hold (it follows the pointer).
 *
 * Times are ms on any one clock. A press whose timer never ran (a stalled main thread) is still a
 * hold when its next move or its lift comes late. The lift's own point counts as a move: WebKit can
 * deliver a quick flick's travel only with its lift, and that is a drag, never a tap.
 */
export class StillPress {
  kind: StillPressKind = 'pending';
  /** Where and when the press started. */
  x0 = 0;
  y0 = 0;
  t0 = 0;
  /** The last position seen. */
  x = 0;
  y = 0;
  tolerancePx: number;
  /** How long a still press takes to become a hold; a change applies from the next `begin`. */
  holdMs: number;

  constructor(spec: StillHoldOptions = {}) {
    this.tolerancePx = spec.tolerancePx ?? STILL_HOLD_DEFAULTS.tolerancePx;
    this.holdMs = spec.ms ?? STILL_HOLD_DEFAULTS.ms;
  }

  /** Use `spec`'s tolerance and time from now on. */
  set(spec: StillHoldOptions): void {
    if (spec.tolerancePx !== undefined) this.tolerancePx = spec.tolerancePx;
    if (spec.ms !== undefined) this.holdMs = spec.ms;
  }

  begin(x: number, y: number, t: number): void {
    this.kind = 'pending';
    this.x0 = this.x = x;
    this.y0 = this.y = y;
    this.t0 = t;
  }

  /** The press is still down at `t`: a pending press becomes a hold once still for the hold time. True if it just did. */
  tick(t: number): boolean {
    if (this.kind !== 'pending' || t - this.t0 < this.holdMs) return false;
    this.kind = 'hold';
    return true;
  }

  /** The press moved to (`x`, `y`) at `t`. Returns the kind before the move, so a caller sees one that just changed. */
  move(x: number, y: number, t: number): StillPressKind {
    const was = this.kind;
    this.tick(t);
    if (this.kind === 'pending' && Math.hypot(x - this.x0, y - this.y0) >= this.tolerancePx) {
      this.kind = 'drag';
    }
    this.x = x;
    this.y = y;
    return was;
  }

  /** The press lifted at `t` (at `x`, `y` when the lift says where): a still press lifted before the hold time taps. */
  end(t: number, x?: number, y?: number): 'tap' | 'drag' | 'hold' {
    if (x !== undefined && y !== undefined) this.move(x, y, t);
    else this.tick(t);
    return this.kind === 'pending' ? 'tap' : this.kind;
  }
}

/** Which side of the screen a move stick lives on. */
export type StickSide = 'left' | 'right';

/**
 * Whether a touch landing at client `x` on a `width`-wide area starts the move stick: inside the
 * `zone` share of the width from the stick's `side` (default 0.5, `Look`'s half), unless another
 * touch already holds the stick.
 */
export function inStickZone(
  x: number,
  width: number,
  side: StickSide,
  stickTaken = false,
  zone = 0.5,
): boolean {
  if (stickTaken) return false;
  return side === 'left' ? x < width * zone : x > width * (1 - zone);
}

/** `WheelSteps` options. */
export interface WheelStepsOptions {
  /** Pixels of scroll (a trackpad's stream) that make one step. Default 50. */
  pixelsPerStep?: number;
  /** A pause longer than this (ms) starts counting afresh. Default 250. */
  idleMs?: number;
}

/**
 * Turns wheel input into whole steps (a hotbar, a weapon cycle): a mouse wheel's notch is one
 * step, a trackpad's stream of small scrolls one step per `pixelsPerStep`, at most one per call, so
 * a fling does not spin the selection round.
 */
export class WheelSteps {
  private acc = 0;
  private last = Number.NEGATIVE_INFINITY;
  private readonly perStep: number;
  private readonly idleMs: number;

  constructor(opts: WheelStepsOptions = {}) {
    this.perStep = opts.pixelsPerStep ?? 50;
    this.idleMs = opts.idleMs ?? 250;
  }

  /** Steps for one event or tick: `deltaY` in `deltaMode` units (0 pixels, else lines or pages) at `t` ms. -1, 0 or 1. */
  add(deltaY: number, deltaMode: number, t: number): number {
    const idle = t - this.last > this.idleMs;
    this.last = t;
    if (deltaY === 0) return 0;
    const per = this.perStep;
    if (deltaMode !== 0 || (idle && Math.abs(deltaY) >= per)) {
      this.acc = 0;
      return Math.sign(deltaY);
    }
    if (idle) this.acc = 0;
    this.acc += deltaY;
    if (Math.abs(this.acc) < per) return 0;
    const step = Math.sign(this.acc);
    this.acc -= step * per;
    // A long fling leaves at most one more step's worth behind.
    if (Math.abs(this.acc) > per) this.acc = step * per;
    return step;
  }

  /** Forget any partial scroll. */
  reset(): void {
    this.acc = 0;
    this.last = Number.NEGATIVE_INFINITY;
  }
}
