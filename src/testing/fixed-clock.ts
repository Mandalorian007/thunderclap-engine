/**
 * Test-only fixed-step clock (ws/testing-kit). It is a `TickClock`, so it goes wherever
 * `ctx.clock` goes: `createGestures({ clock })`, `createLook({ clock })`,
 * `createInputPlayback(input, rec, { clock })`, and as `GameLoop`'s `now`. A test moves it one
 * fixed step at a time, and N steps read exactly N × step, with no float drift.
 */
import type { TickClock } from '../input';

/** A `TickClock` that moves in whole fixed steps, plus any loose `advance(ms)`. */
export interface FixedClock extends TickClock {
  /** The step length, ms. */
  readonly stepMs: number;
  /** Whole steps taken so far (`step` only; `advance` does not count). */
  readonly ticks: number;
  /** Moves the clock by `n` steps (default 1). Negative, fractional and non-finite `n` are ignored. */
  step(n?: number): void;
}

/**
 * A fixed-step clock starting at `start` ms (default 0) with steps of `stepMs` (default
 * 1000 / 60, the engine's default fixed step). `now()` is `start + advanced + ticks × stepMs`.
 */
export function createFixedClock(stepMs = 1000 / 60, start = 0): FixedClock {
  if (!(stepMs > 0) || !Number.isFinite(stepMs)) {
    throw new RangeError(
      `createFixedClock: stepMs must be a positive finite number, got ${stepMs}`,
    );
  }
  const origin = Number.isFinite(start) ? start : 0;
  let ticks = 0;
  let loose = 0;
  return {
    stepMs,
    get ticks() {
      return ticks;
    },
    now: () => origin + loose + ticks * stepMs,
    advance(ms) {
      if (ms > 0 && Number.isFinite(ms)) loose += ms;
    },
    step(n = 1) {
      if (Number.isInteger(n) && n > 0) ticks += n;
    },
  };
}
