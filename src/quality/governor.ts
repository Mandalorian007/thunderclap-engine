/**
 * The frame governor (ws/intents-quality, D1 §2.12): one service that sheds and restores work
 * when frames run long, so modules don't each adapt on their own and fight. Modules register
 * knobs (`Knob`: dynamic resolution, a particle count, a draw distance); the governor steps the
 * cheapest one down when frames miss for the GPU's sake and steps the last one back up after a
 * long clean spell.
 *
 * It needs no GPU timestamps (WebKit has none), only frame intervals and, when the platform gives
 * them, main-thread time and submit-to-done latency. Over a window (2 s):
 * - a frame is late when its interval is over 1.25 targets;
 * - a late frame whose own main-thread work took most of a target is the main thread's (a GC,
 *   streaming): shedding GPU work wouldn't help, so it isn't counted;
 * - a window whose average latency (minus main-thread time) stayed under half a target had a GPU
 *   with time to spare, so its misses are someone else's (a capped frame rate, the compositor).
 *
 * Hysteresis is asymmetric and sticky: down one step when over 10% of a window's frames missed
 * for the GPU; up one step after 20 s under 1% late; a step shed twice within 2 minutes of being
 * restored stays shed 5 minutes; at most one change every 2 s and four in a minute.
 *
 * Pure: the caller passes the clock (`frame(now, …)`), so it is tested on synthetic traces. A frame
 * costs a few comparisons and no allocation; a change allocates its record.
 *
 * Generalized from Forge Wilds' render/governor.ts (its rungs are one-step knobs here).
 */

/**
 * Something the governor may turn down. `step(true)` gives up one step of work (fewer particles,
 * a lower render scale) and `step(false)` takes one back; each returns false (and changes
 * nothing) when it is already at its limit. `cost` is what the player loses per step: the lowest
 * is stepped down first (default 1; ties go in registration order).
 */
export interface Knob {
  readonly name: string;
  step(down: boolean): boolean;
  readonly cost?: number;
}

/** A change the governor made, for an overlay and tests. */
export interface GovernorChange {
  readonly at: number;
  /** Steps shed after it. */
  readonly shed: number;
  /** The knob stepped. */
  readonly knob: string;
  readonly dir: 'down' | 'up';
}

export interface GovernorOptions {
  /** The frame interval aimed for, ms. Default 1000/60 (a display capped at 30 Hz sets 33.3). */
  targetMs?: number;
  /** Knobs to start with (more join through `register`). */
  rungs?: readonly Knob[];
  /** One judging window, ms. Default 2000. */
  windowMs?: number;
  /** Share of a window's frames missed for the GPU that sheds a step. Default 0.1. */
  downShare?: number;
  /** Clean time (at most `upShare` late) before a step comes back, ms. Default 20000. */
  upAfterMs?: number;
  /** Default 0.01. */
  upShare?: number;
  /** The least time between two changes, ms. Default 2000. */
  minGapMs?: number;
  /** At most this many changes in any `rateWindowMs`. Defaults 4 and 60000. */
  maxChanges?: number;
  rateWindowMs?: number;
  /** A step shed this many times within `stickyWithinMs` of being restored… Defaults 2 and 120000. */
  stickyFailures?: number;
  stickyWithinMs?: number;
  /** …stays shed this long, ms. Default 300000. */
  stickyForMs?: number;
}

/** What `createGovernor` returns. Call `frame` once per drawn frame. */
export interface Governor {
  /** The frame interval aimed for, ms; may change (a display's refresh rate became known). */
  targetMs: number;
  /** Off: frames aren't judged and nothing changes. */
  enabled: boolean;
  /** Adds a knob. Removing it (the returned function) first restores every step it gave up. */
  register(knob: Knob): () => void;
  /**
   * A frame was drawn at `now` (ms), `intervalMs` after the one before, the main thread busy
   * `cpuMs` for it; `latencyMs` is its submit-to-done latency when it was measured (`null` when
   * not). Returns the change made, if any.
   */
  frame(
    now: number,
    intervalMs: number,
    cpuMs?: number,
    latencyMs?: number | null,
  ): GovernorChange | null;
  /** Sheds (or restores) steps until `count` are shed, at once (tests, a dev console); `now` starts the gap. */
  set(count: number, now?: number): void;
  /** Steps shed now. */
  readonly shed: number;
  /** The knobs, in the order they are stepped down. */
  readonly knobs: readonly Knob[];
  /** The knobs stepped down now, in the order they were, one entry per step. */
  readonly stack: readonly Knob[];
  /** The last few changes, newest last (at most 16). */
  readonly changes: readonly GovernorChange[];
  /** One line for an overlay. */
  readonly line: string;
}

/** Intervals longer than this aren't frames (a hidden tab, a stall): they start the window over. */
const GAP_MS = 250;
/** A window with fewer frames than this says nothing. */
const MIN_FRAMES = 10;
const MAX_CHANGES_KEPT = 16;

/** A frame governor over `rungs` (more join with `register`); see the module doc. */
export function createGovernor(options: GovernorOptions = {}): Governor {
  const o = {
    windowMs: options.windowMs ?? 2000,
    downShare: options.downShare ?? 0.1,
    upAfterMs: options.upAfterMs ?? 20_000,
    upShare: options.upShare ?? 0.01,
    minGapMs: options.minGapMs ?? 2000,
    maxChanges: options.maxChanges ?? 4,
    rateWindowMs: options.rateWindowMs ?? 60_000,
    stickyFailures: options.stickyFailures ?? 2,
    stickyWithinMs: options.stickyWithinMs ?? 120_000,
    stickyForMs: options.stickyForMs ?? 300_000,
  };
  const knobs: Knob[] = [];
  const order = new Map<Knob, number>();
  let registered = 0;
  const stack: Knob[] = [];
  // Sticky state per depth (the step shed when `stack.length` was that).
  const restoredAt: number[] = [];
  const failures: number[] = [];
  const holdUntil: number[] = [];
  const changes: GovernorChange[] = [];

  let windowStart = -1;
  let frames = 0;
  let missed = 0;
  let latencySum = 0;
  let latencyN = 0;
  let cleanSince = -1;
  let cleanFrames = 0;
  let cleanMissed = 0;
  let lastChange = Number.NEGATIVE_INFINITY;

  const depth = (d: number): void => {
    while (restoredAt.length <= d) {
      restoredAt.push(Number.NEGATIVE_INFINITY);
      failures.push(0);
      holdUntil.push(Number.NEGATIVE_INFINITY);
    }
  };

  const sort = (): void => {
    knobs.sort((a, b) => (a.cost ?? 1) - (b.cost ?? 1) || order.get(a)! - order.get(b)!);
  };

  /** Steps the cheapest knob that can still give: the knob, or null at every limit. */
  const stepDown = (): Knob | null => {
    for (const k of knobs) {
      if (k.step(true)) {
        stack.push(k);
        return k;
      }
    }
    return null;
  };

  const stepUp = (): Knob | null => {
    const k = stack.pop();
    if (!k) return null;
    k.step(false);
    return k;
  };

  const mayChange = (now: number): boolean => {
    if (now - lastChange < o.minGapMs) return false;
    const n = changes.length;
    return n < o.maxChanges || now - changes[n - o.maxChanges]!.at >= o.rateWindowMs;
  };

  const record = (now: number, k: Knob, dir: 'down' | 'up'): GovernorChange => {
    lastChange = now;
    const c: GovernorChange = { at: now, shed: stack.length, knob: k.name, dir };
    if (changes.length >= MAX_CHANGES_KEPT) changes.shift();
    changes.push(c);
    return c;
  };

  const down = (now: number): GovernorChange | null => {
    const d = stack.length;
    const k = stepDown();
    if (!k) return null;
    depth(d);
    // Shed again soon after it came back: a failure; twice, and it stays shed a while.
    if (now - restoredAt[d]! <= o.stickyWithinMs) {
      failures[d]!++;
      if (failures[d]! >= o.stickyFailures) {
        holdUntil[d] = now + o.stickyForMs;
        failures[d] = 0;
      }
    } else {
      failures[d] = 0;
    }
    return record(now, k, 'down');
  };

  const up = (now: number): GovernorChange | null => {
    const k = stepUp();
    if (!k) return null;
    depth(stack.length);
    restoredAt[stack.length] = now;
    return record(now, k, 'up');
  };

  const g: Governor = {
    targetMs: options.targetMs ?? 1000 / 60,
    enabled: true,
    register(knob) {
      if (order.has(knob)) return () => {};
      order.set(knob, registered++);
      knobs.push(knob);
      sort();
      return () => {
        if (!order.has(knob)) return;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i] === knob) {
            knob.step(false);
            stack.splice(i, 1);
          }
        }
        knobs.splice(knobs.indexOf(knob), 1);
        order.delete(knob);
      };
    },
    frame(now, intervalMs, cpuMs = 0, latencyMs = null) {
      if (!g.enabled || knobs.length === 0) return null;
      if (intervalMs > GAP_MS || intervalMs <= 0) {
        windowStart = -1;
        cleanSince = -1;
        return null;
      }
      const t = g.targetMs;
      if (windowStart < 0) {
        windowStart = now;
        frames = missed = latencySum = latencyN = 0;
      }
      if (cleanSince < 0) {
        cleanSince = now;
        cleanFrames = cleanMissed = 0;
      }
      frames++;
      cleanFrames++;
      const late = intervalMs > t * 1.25;
      // A miss the main thread made (its own work took most of the frame) isn't the GPU's.
      if (late && cpuMs < t * 0.6) missed++;
      if (late) cleanMissed++;
      if (latencyMs !== null) {
        latencySum += Math.max(0, latencyMs - cpuMs);
        latencyN++;
      }
      let change: GovernorChange | null = null;
      if (now - windowStart >= o.windowMs) {
        const enough = frames >= MIN_FRAMES;
        // A GPU with time to spare (latency well under a frame) didn't make the misses.
        const gpuIdle = latencyN > 0 && latencySum / latencyN < t * 0.5;
        const shedNow = enough && !gpuIdle && missed > frames * o.downShare;
        windowStart = now;
        frames = missed = latencySum = latencyN = 0;
        if (shedNow) {
          cleanSince = -1;
          if (mayChange(now)) change = down(now);
        }
      }
      if (!change && cleanSince >= 0 && now - cleanSince >= o.upAfterMs) {
        const clean = cleanFrames >= MIN_FRAMES && cleanMissed <= cleanFrames * o.upShare;
        const top = stack.length - 1;
        if (
          clean &&
          top >= 0 &&
          mayChange(now) &&
          now >= (holdUntil[top] ?? Number.NEGATIVE_INFINITY)
        ) {
          change = up(now);
        }
        // Judge the next spell afresh either way.
        cleanSince = now;
        cleanFrames = cleanMissed = 0;
      }
      return change;
    },
    set(count, now = 0) {
      const n = Math.max(0, Math.floor(count));
      while (stack.length < n && stepDown()) {}
      while (stack.length > n) stepUp();
      lastChange = now;
    },
    get shed() {
      return stack.length;
    },
    knobs,
    stack,
    changes,
    get line() {
      if (!g.enabled) return 'governor off';
      if (stack.length === 0) return 'governor: full quality';
      const parts: string[] = [];
      for (const k of knobs) {
        let n = 0;
        for (const s of stack) if (s === k) n++;
        if (n > 0) parts.push(n > 1 ? `${k.name} ×${n}` : k.name);
      }
      return `governor: shed ${parts.join(', ')}`;
    },
  };
  for (const k of options.rungs ?? []) g.register(k);
  return g;
}
