/**
 * Fixed-step simulation + variable-rate render.
 *
 * `FixedStepper` is the pure accumulator (unit-tested); `GameLoop` drives it from the host's
 * frames (`Host.requestFrame`: the browser's requestAnimationFrame, a test's manual stepping).
 * With `fixed: false` the loop has no fixed step: update runs once per rendered frame with the
 * real (clamped) delta, for a client that applies another's state.
 */
import { defaultHost } from '../host/default';
import type { FrameSource } from '../host/types';

export interface FixedStepperOptions {
  /** Simulation step in seconds. Default 1/60. */
  step?: number;
  /** Real frame delta is clamped to this before accumulating (tab switches, breakpoints). */
  maxFrameDt?: number;
  /** Hard cap on steps per frame (spiral-of-death guard). Extra time is dropped. */
  maxSteps?: number;
}

export class FixedStepper {
  readonly step: number;
  readonly maxFrameDt: number;
  readonly maxSteps: number;
  accumulator = 0;

  constructor(opts: FixedStepperOptions = {}) {
    this.step = opts.step ?? 1 / 60;
    this.maxFrameDt = opts.maxFrameDt ?? 0.25;
    this.maxSteps = opts.maxSteps ?? 8;
  }

  /** Feed a real frame delta (seconds). Returns how many fixed steps to run now. */
  advance(frameDt: number): number {
    const dt = Math.min(Math.max(frameDt, 0), this.maxFrameDt);
    this.accumulator += dt;
    let steps = Math.floor(this.accumulator / this.step + 1e-9);
    if (steps > this.maxSteps) {
      steps = this.maxSteps;
      this.accumulator = 0;
      return steps;
    }
    this.accumulator -= steps * this.step;
    if (this.accumulator < 0) this.accumulator = 0;
    return steps;
  }

  /** Interpolation factor in [0,1) between the last and next simulation state. */
  get alpha(): number {
    return this.accumulator / this.step;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

/** Read-only time info shared with systems. Mutated in place by the loop. */
export interface Time {
  /** Fixed step (seconds). */
  readonly step: number;
  /** Total simulated time (seconds); advances only while running and not paused. */
  simTime: number;
  /** Total real time since start (seconds), excluding hidden/paused gaps. */
  realTime: number;
  /** Last real frame delta (clamped, seconds). */
  frameDt: number;
  /** Rendered frame counter. */
  frame: number;
  /** Simulation step counter. */
  tick: number;
}

export interface LoopCallbacks {
  /**
   * Fixed-step update: `dt` is always `time.step`. With `fixed: false`, once per rendered frame
   * before render, `dt` the real frame delta (`time.frameDt`).
   */
  update(dt: number, time: Time): void;
  /**
   * Variable-rate render. `alpha` is the interpolation factor between sim states (always 1 with
   * `fixed: false`, 0 while paused).
   */
  render(alpha: number, time: Time): void;
}

export interface GameLoopOptions extends FixedStepperOptions {
  /**
   * Default true: update runs in fixed steps of `step`. False: once per rendered frame with the
   * real frame delta (render-rate only, no accumulator); `time.tick` then counts those updates.
   */
  fixed?: boolean;
  /** Clock for frame deltas (ms). Default `performance.now`. */
  now?: () => number;
  /**
   * Where frames come from: the game's `Host` (`createGame` passes its own), or a stub a test
   * steps by hand. Default: `defaultHost()`, read when the loop first starts.
   */
  frames?: FrameSource;
}

/** Early-frame tolerance for `GameLoop.maxFps`, ms. */
const FRAME_CAP_SLACK_MS = 3;

/** An XR session's frames (`createXrHost`'s `kind: 'xr'`): `maxFps` never applies to them. */
function isXrSource(src: FrameSource | null): boolean {
  return (src as { readonly kind?: unknown } | null)?.kind === 'xr';
}

export class GameLoop {
  readonly time: Time;
  private readonly stepper: FixedStepper;
  private readonly cb: LoopCallbacks;
  private readonly fixed: boolean;
  private readonly now: () => number;
  private source: FrameSource | null;
  private frameId = 0;
  private last = 0;
  private running = false;
  private _paused = false;
  private _halted = false;
  private minFrameMs = 0;
  /** True while `frame` runs its callbacks (so `setFrames` leaves rescheduling to it). */
  private inFrame = false;

  constructor(cb: LoopCallbacks, opts: GameLoopOptions = {}) {
    this.cb = cb;
    this.stepper = new FixedStepper(opts);
    this.fixed = opts.fixed !== false;
    this.now = opts.now ?? (() => performance.now());
    this.source = opts.frames ?? null;
    this.time = { step: this.stepper.step, simTime: 0, realTime: 0, frameDt: 0, frame: 0, tick: 0 };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** While paused, update is skipped but render keeps running (so menus/overlays still draw). */
  get paused(): boolean {
    return this._paused;
  }

  set paused(v: boolean) {
    this._paused = v;
    if (v) this.stepper.reset();
  }

  /**
   * Cap the render rate (null = every display frame). With 30 on a 60 Hz display the loop runs
   * on every other vsync: a steady 30 fps instead of a GPU-bound jitter between 30 and 60.
   * Frames are skipped whole (no update, no render), so the fixed step still keeps time.
   * Ignored while frames come from an XR session (a `kind: 'xr'` source): the headset sets
   * the rate.
   */
  get maxFps(): number | null {
    return this.minFrameMs > 0 ? 1000 / this.minFrameMs : null;
  }

  set maxFps(fps: number | null) {
    this.minFrameMs = fps && fps > 0 ? 1000 / fps : 0;
  }

  /** True after `halt()`: the loop is stopped for good. */
  get halted(): boolean {
    return this._halted;
  }

  start(): void {
    if (this.running || this._halted) return;
    this.running = true;
    this.last = this.now();
    this.stepper.reset();
    this.frameId = this.frames.requestFrame(this.frame);
  }

  /** Stop scheduling frames entirely (e.g. tab hidden, device lost). */
  stop(): void {
    this.running = false;
    this.source?.cancelFrame(this.frameId);
  }

  /**
   * Swap the frame source while the loop runs (or before): a pending frame on the old source
   * is cancelled and the next is requested from `src`. Called from inside a frame callback
   * (an action handler), the current frame finishes and reschedules through `src`. Entering and
   * leaving an XR session swaps between the XR host and the page's host this way (ws/xr).
   */
  setFrames(src: FrameSource): void {
    if (src === this.source) return;
    const prev = this.source;
    this.source = src;
    if (!this.running || this.inFrame) return;
    prev?.cancelFrame(this.frameId);
    this.frameId = src.requestFrame(this.frame);
  }

  /** The frame source, resolved on first use so a loop that is only ticked by hand needs none. */
  private get frames(): FrameSource {
    this.source ??= defaultHost();
    return this.source;
  }

  /**
   * Stop for good (e.g. the GPU device is lost): later `start()` calls, such as a
   * tab-visible handler, are ignored, and `tickOnce` does nothing.
   */
  halt(): void {
    this._halted = true;
    this.stop();
  }

  /** Run one frame manually with an explicit delta (tests, frame stepping). */
  tickOnce(frameDt: number): void {
    if (this._halted) return;
    this.runFrame(frameDt);
  }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.inFrame = true;
    try {
      // The clock is read inside the try too: a throwing `now()` must not stop the loop (#7).
      const t = this.now();
      // A few ms of slack: vsync timestamps jitter, and a 33.3 ms target must not miss 33.2.
      // Never in XR: the headset paces the session, and a skipped XR frame is a dropped frame.
      // A skipped frame returns here; the finally below requests the next one.
      if (
        this.minFrameMs > 0 &&
        !isXrSource(this.source) &&
        t - this.last < this.minFrameMs - FRAME_CAP_SLACK_MS
      ) {
        return;
      }
      const dt = (t - this.last) / 1000;
      this.last = t;
      this.runFrame(dt);
    } finally {
      // A frame that throws still schedules the next one (a headset otherwise freezes for good);
      // the error then propagates to the frame source, which reports it.
      this.inFrame = false;
      if (this.running) this.frameId = this.frames.requestFrame(this.frame);
    }
  };

  private runFrame(rawDt: number): void {
    const time = this.time;
    const dt = Math.min(Math.max(rawDt, 0), this.stepper.maxFrameDt);
    time.frameDt = dt;
    time.realTime += dt;
    if (!this._paused && !this.fixed) {
      time.simTime += dt;
      time.tick++;
      this.cb.update(dt, time);
    } else if (!this._paused) {
      const steps = this.stepper.advance(dt);
      for (let i = 0; i < steps; i++) {
        time.simTime += this.stepper.step;
        time.tick++;
        this.cb.update(this.stepper.step, time);
      }
    }
    time.frame++;
    this.cb.render(this._paused ? 0 : this.fixed ? this.stepper.alpha : 1, time);
  }
}
