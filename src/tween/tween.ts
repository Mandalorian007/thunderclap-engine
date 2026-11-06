/**
 * Tweens: the `Tween` handle every kind shares, and the three leaf kinds (`PropertyTween`,
 * `ValueTween`, `DelayTween`). `timeline.ts` adds the groups and the `Tweens` manager.
 *
 * A tween is driven through `advance(dt)`, which returns the part of `dt` it did not use (0
 * while running; the overflow once it finishes), so a sequence carries leftover time into the
 * next child and a loop into the next iteration. After construction nothing here allocates per
 * update: property paths are resolved to holders and keys up front, start values are captured
 * into typed arrays, and callbacks are stored in arrays that only grow in `then`.
 */
import { type Ease, isSpring, type SpringEase, stepSpring } from './ease';

export interface TweenOptions {
  /** Easing (default `ease.linear`), or `ease.spring(...)` for a duration-free spring. */
  ease?: Ease | SpringEase;
  /** Seconds to wait before the first iteration starts. Default 0. */
  delay?: number;
  /** Extra iterations after the first: `0` (default) plays once, `2` three times, `-1` forever. */
  loops?: number;
  /** Alternate direction on every other iteration (needs `loops`). Default false. */
  yoyo?: boolean;
  /** Called once, when the first iteration starts (after `delay`; start values are read then). */
  onStart?: (tween: Tween) => void;
  /** Called after every update that moved the tween, including the final one. */
  onUpdate?: (tween: Tween) => void;
  /** Called once, when the last iteration ends. Not called on `kill`. */
  onComplete?: (tween: Tween) => void;
  /** Multiplies `dt`. Default 1; `0` holds. Settable later through `tween.timeScale`. */
  timeScale?: number;
}

/** The handle every tween kind returns. Read-only fields update on every `Tweens.update`. */
export interface Tween {
  /** Linear position of the current iteration, 0..1 (a spring's position, which may overshoot). */
  readonly progress: number;
  /** Seconds into the current iteration (excluding the delay). */
  readonly elapsed: number;
  /** Seconds one iteration lasts (`Infinity` for a spring). */
  readonly duration: number;
  /** True once the last iteration has ended. */
  readonly complete: boolean;
  /** True after `kill()`: dropped from its manager or skipped by its group; never completes. */
  readonly killed: boolean;
  readonly paused: boolean;
  /** Multiplies `dt`; settable. */
  timeScale: number;
  /** Hold: `update` leaves the tween where it is (a sequence waits on a paused child). */
  pause(): void;
  resume(): void;
  /** Stop and drop: no further callbacks, `complete` stays false. */
  kill(): void;
  /** Back to the start (delay included); a finished or killed root tween rejoins its manager. */
  restart(): void;
  /** Run `fn` when the tween completes (at once if it already has). Returns the tween. */
  then(fn: () => void): Tween;
  /** Resolves when the tween completes. A killed tween's promise never settles. */
  promise(): Promise<void>;
}

/** Internal hooks a `Tweens` manager uses on a root tween. */
export interface TweenOwner {
  /** Re-register a root tween that finished or was killed. */
  readd(t: TweenBase): void;
}

export abstract class TweenBase implements Tween {
  progress = 0;
  elapsed = 0;
  duration: number;
  complete = false;
  killed = false;
  paused = false;
  timeScale: number;
  /** @internal The manager this tween registered with (roots only). */
  owner: TweenOwner | null = null;
  /** @internal True while the owner's list holds this tween. */
  listed = false;
  /** @internal True once a group took the tween; it then never talks to the manager. */
  grouped = false;
  /** @internal Direction imposed by the parent (yoyo on a group). */
  parentReversed = false;

  protected readonly ease: Ease | null;
  protected readonly spring: SpringEase | null;
  protected readonly delay: number;
  protected readonly loops: number;
  protected readonly yoyo: boolean;
  protected readonly onStart: ((t: Tween) => void) | undefined;
  protected readonly onUpdate: ((t: Tween) => void) | undefined;
  protected readonly onComplete: ((t: Tween) => void) | undefined;
  protected delayLeft: number;
  protected iteration = 0;
  protected started = false;
  /** Start values were read once; a group's loop replays them instead of reading again. */
  private captured = false;
  private keepStart = false;
  private thenFns: (() => void)[] | null = null;
  /** Spring state `[position, velocity]`, springs only. */
  private readonly springState: Float64Array | null;

  constructor(seconds: number, opts: TweenOptions) {
    const e = opts.ease;
    if (isSpring(e)) {
      this.spring = e;
      this.ease = null;
      this.duration = Number.POSITIVE_INFINITY;
      this.springState = new Float64Array(2);
      this.loops = 0;
      this.yoyo = false;
    } else {
      this.spring = null;
      this.ease = e ?? null;
      this.duration = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      this.springState = null;
      this.loops = opts.loops ?? 0;
      this.yoyo = opts.yoyo ?? false;
    }
    this.delay = Math.max(0, opts.delay ?? 0);
    this.delayLeft = this.delay;
    this.timeScale = opts.timeScale ?? 1;
    this.onStart = opts.onStart;
    this.onUpdate = opts.onUpdate;
    this.onComplete = opts.onComplete;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  kill(): void {
    this.killed = true;
  }

  restart(): void {
    this.reset();
    if (!this.grouped && this.owner && !this.listed) this.owner.readd(this);
  }

  // biome-ignore lint/suspicious/noThenProperty: intentionally thenable, so `await tween` works too.
  then(fn: () => void): Tween {
    if (this.complete) {
      fn();
      return this;
    }
    if (!this.thenFns) this.thenFns = [];
    this.thenFns.push(fn);
    return this;
  }

  promise(): Promise<void> {
    return new Promise((resolve) => {
      this.then(resolve);
    });
  }

  /** @internal True once the tween no longer moves. */
  get done(): boolean {
    return this.complete || this.killed;
  }

  /** @internal Seconds the whole tween lasts: delay plus every iteration; `Infinity` if it never ends. */
  get total(): number {
    return this.loops < 0
      ? Number.POSITIVE_INFINITY
      : this.delay + this.duration * (this.loops + 1);
  }

  /** @internal Seconds consumed so far, delay and finished iterations included. */
  get consumed(): number {
    if (this.done) return this.total;
    return this.delay - this.delayLeft + this.duration * this.iteration + this.elapsed;
  }

  /**
   * @internal Back to the initial state without touching the manager. With `keepStart` (a
   * group looping) the start values read on the first run are kept, so the motion replays.
   */
  reset(keepStart = false): void {
    this.keepStart = keepStart && this.captured;
    this.progress = 0;
    this.elapsed = 0;
    this.complete = false;
    this.killed = false;
    this.delayLeft = this.delay;
    this.iteration = 0;
    this.started = false;
    if (this.springState) {
      this.springState[0] = 0;
      this.springState[1] = 0;
    }
    this.resetChildren();
  }

  /** @internal Groups reset their children here. */
  protected resetChildren(): void {}

  /** @internal The direction of the current iteration: true runs 1 → 0. */
  protected get reversed(): boolean {
    return this.parentReversed !== (this.yoyo && (this.iteration & 1) === 1);
  }

  /**
   * @internal Move forward by `dt` seconds (unscaled). Returns the part of `dt` left unused:
   * 0 while running or paused, the overflow when the tween finishes, all of it when it already
   * had.
   */
  advance(dt: number): number {
    if (this.done) return dt;
    if (this.paused || dt <= 0) return 0;
    const scale = this.timeScale;
    if (scale <= 0) return 0;
    let local = dt * scale;
    if (this.delayLeft > 0) {
      if (local < this.delayLeft) {
        this.delayLeft -= local;
        return 0;
      }
      local -= this.delayLeft;
      this.delayLeft = 0;
    }
    if (!this.started) {
      this.started = true;
      if (!this.keepStart) {
        this.capture();
        this.captured = true;
      }
      this.onStart?.(this);
      if (this.killed) return 0;
    }
    return this.run(local) / scale;
  }

  /** @internal Move by `local` (scaled) seconds past the delay; return the unused part. */
  protected run(local: number): number {
    if (this.spring) return this.runSpring(local);
    return this.runTimed(local);
  }

  private runSpring(local: number): number {
    const s = this.springState!;
    const settled = stepSpring(s, this.spring!, local);
    this.elapsed += local;
    this.progress = s[0]!;
    this.applyAt(this.progress);
    this.onUpdate?.(this);
    if (settled && !this.killed) this.finish();
    return 0;
  }

  private runTimed(local: number): number {
    const duration = this.duration;
    let t = this.elapsed + local;
    // Each loop boundary crossed applies its end value, so callbacks see every extreme.
    while (t >= duration && this.canLoop()) {
      this.applyAt(this.reversed ? 0 : 1);
      this.nextIteration();
      t -= duration;
      if (duration === 0) {
        // A zero-length looping tween would spin forever; one boundary is enough.
        t = 0;
        break;
      }
    }
    let leftover = 0;
    if (t >= duration) {
      leftover = t - duration;
      t = duration;
    }
    this.elapsed = t;
    this.progress = duration > 0 ? t / duration : 1;
    const p = this.reversed ? 1 - this.progress : this.progress;
    // The endpoints bypass the ease: every ease is 0 at 0 and 1 at 1 by contract, but floating
    // point may land at 0.9999999999999999, and the end value must be exactly the target.
    this.applyAt(this.ease && p > 0 && p < 1 ? this.ease(p) : p);
    this.onUpdate?.(this);
    if (this.killed) return 0;
    if (t >= duration) {
      this.finish();
      return leftover;
    }
    return 0;
  }

  /** @internal Whether another iteration follows the current one. */
  protected canLoop(): boolean {
    return this.loops < 0 || this.iteration < this.loops;
  }

  /** @internal Begin the next iteration. */
  protected nextIteration(): void {
    this.iteration++;
    this.elapsed = 0;
    this.progress = 0;
    this.onIteration();
  }

  /** @internal A loop boundary was crossed (groups restart their children). */
  protected onIteration(): void {}

  /** @internal Mark complete and fire the completion callbacks. */
  protected finish(): void {
    this.complete = true;
    this.onComplete?.(this);
    const fns = this.thenFns;
    if (fns) for (let i = 0; i < fns.length; i++) fns[i]!();
  }

  /** @internal Read start values; runs once per `restart`, after the delay. */
  protected abstract capture(): void;
  /** @internal Write the eased position `k` (0..1, may overshoot) to the animated values. */
  protected abstract applyAt(k: number): void;
}

/** Nested number fields by dotted path: `'x'`, `'position.0'`, `'style.opacity'`. */
export type TweenProps = Record<string, number>;

type NumberHolder = Record<string, number>;

/** Animates number fields of an object (nested paths and typed-array indices allowed). */
export class PropertyTween extends TweenBase {
  readonly target: object;
  private readonly holders: NumberHolder[];
  private readonly keys: string[];
  private readonly from: Float64Array;
  private readonly to: Float64Array;

  constructor(target: object, props: TweenProps, seconds: number, opts: TweenOptions) {
    super(seconds, opts);
    this.target = target;
    const paths = Object.keys(props);
    const n = paths.length;
    this.holders = new Array<NumberHolder>(n);
    this.keys = new Array<string>(n);
    this.from = new Float64Array(n);
    this.to = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const path = paths[i]!;
      const parts = path.split('.');
      let holder: unknown = target;
      for (let j = 0; j < parts.length - 1; j++) {
        holder = (holder as Record<string, unknown>)[parts[j]!];
        if (holder === null || typeof holder !== 'object') {
          throw new Error(`tween: '${path}' does not exist on the target`);
        }
      }
      const key = parts[parts.length - 1]!;
      if (typeof (holder as NumberHolder)[key] !== 'number') {
        throw new Error(`tween: '${path}' is not a number on the target`);
      }
      this.holders[i] = holder as NumberHolder;
      this.keys[i] = key;
      this.to[i] = props[path]!;
    }
  }

  protected capture(): void {
    for (let i = 0; i < this.keys.length; i++) this.from[i] = this.holders[i]![this.keys[i]!]!;
  }

  protected applyAt(k: number): void {
    const { holders, keys, from, to } = this;
    for (let i = 0; i < keys.length; i++) {
      const a = from[i]!;
      holders[i]![keys[i]!] = k === 1 ? to[i]! : a + (to[i]! - a) * k;
    }
  }
}

/** Animates one number from `from` to `to`, reporting it through `onUpdate(value, tween)`. */
export class ValueTween extends TweenBase {
  /** The value from the last update. */
  value: number;
  private readonly from: number;
  private readonly to: number;
  private readonly report: (value: number, tween: Tween) => void;

  constructor(
    from: number,
    to: number,
    seconds: number,
    onUpdate: (value: number, tween: Tween) => void,
    opts: TweenOptions,
  ) {
    super(seconds, opts);
    this.from = from;
    this.to = to;
    this.value = from;
    this.report = onUpdate;
  }

  protected capture(): void {}

  protected applyAt(k: number): void {
    this.value = k === 1 ? this.to : this.from + (this.to - this.from) * k;
    this.report(this.value, this);
  }
}

/** Does nothing for `seconds`; a pause inside a sequence. */
export class DelayTween extends TweenBase {
  protected capture(): void {}
  protected applyAt(): void {}
}
