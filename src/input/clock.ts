/**
 * The clock gestures and look are timed on (ws/input-8). By default that is `performance.now()`
 * (wall time). A game with a fixed step passes one `createTickClock()` to both and advances it
 * from the step, so long-presses, double taps, look acceleration and `Look.onTap` run on game
 * time, and a recording replays the same gestures on the same tick indices however far apart
 * the replay's ticks are in wall time.
 */

/** A clock in ms. Only differences between readings matter; it should never go backwards. */
export interface InputClock {
  now(): number;
}

/** A clock that moves only when told: `advance(ms)` once per fixed step. */
export interface TickClock extends InputClock {
  /** Move the clock forward by `ms`. Negative and non-finite values are ignored. */
  advance(ms: number): void;
}

/** `performance.now()` (or `Date.now()` where there is no `performance`): the default clock. */
export const wallClock: InputClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

/**
 * A game-time clock for gestures and look. Call `advance(stepMs)` from the fixed step, before
 * `input.update()`, and pass the same clock to `createGestures({ clock })` and
 * `createLook({ clock })` so the two share one time base. `start` is the first reading
 * (default 0).
 *
 * ```ts
 * const clock = createTickClock();
 * const input = new Input(bindings, {
 *   gestures: createGestures({ clock }),
 *   look: createLook({ clock }),
 * });
 * // GameLoop `update(dt)`, in fixed steps of `dt` seconds:
 * clock.advance(dt * 1000);
 * input.update();
 * ```
 */
export function createTickClock(start = 0): TickClock {
  let t = Number.isFinite(start) ? start : 0;
  return {
    now: () => t,
    advance(ms) {
      if (ms > 0 && Number.isFinite(ms)) t += ms;
    },
  };
}

/**
 * The clock options gestures and look accept resolved to one clock and its bound `now`:
 * `clock` wins over the older `now` function, and with neither it is `wallClock`.
 */
export function resolveClock(
  clock: InputClock | undefined,
  now: (() => number) | undefined,
): { clock: InputClock; now: () => number } {
  if (clock) return { clock, now: () => clock.now() };
  if (now) return { clock: { now }, now };
  return { clock: wallClock, now: wallClock.now };
}
