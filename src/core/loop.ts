/**
 * Fixed-step simulation + variable-rate render.
 *
 * `FixedStepper` is the pure accumulator (unit-tested); `GameLoop` drives it from
 * requestAnimationFrame.
 */

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
  /** Fixed-step update. `dt` is always `time.step`. */
  update(dt: number, time: Time): void;
  /** Variable-rate render. `alpha` is the interpolation factor between sim states. */
  render(alpha: number, time: Time): void;
}

export interface GameLoopOptions extends FixedStepperOptions {
  /** Injected for tests. Defaults to `performance.now` / `requestAnimationFrame`. */
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}

/** Early-frame tolerance for `GameLoop.maxFps`, ms. */
const FRAME_CAP_SLACK_MS = 3;

export class GameLoop {
  readonly time: Time;
  private readonly stepper: FixedStepper;
  private readonly cb: LoopCallbacks;
  private readonly now: () => number;
  private readonly raf: (cb: (t: number) => void) => number;
  private readonly caf: (id: number) => void;
  private rafId = 0;
  private last = 0;
  private running = false;
  private _paused = false;
  private _halted = false;
  private minFrameMs = 0;

  constructor(cb: LoopCallbacks, opts: GameLoopOptions = {}) {
    this.cb = cb;
    this.stepper = new FixedStepper(opts);
    this.now = opts.now ?? (() => performance.now());
    this.raf = opts.raf ?? ((f) => requestAnimationFrame(f));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
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
    this.rafId = this.raf(this.frame);
  }

  /** Stop scheduling frames entirely (e.g. tab hidden, device lost). */
  stop(): void {
    this.running = false;
    this.caf(this.rafId);
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
    const t = this.now();
    // A few ms of slack: vsync timestamps jitter, and a 33.3 ms target must not miss 33.2.
    if (this.minFrameMs > 0 && t - this.last < this.minFrameMs - FRAME_CAP_SLACK_MS) {
      this.rafId = this.raf(this.frame);
      return;
    }
    const dt = (t - this.last) / 1000;
    this.last = t;
    this.runFrame(dt);
    if (this.running) this.rafId = this.raf(this.frame);
  };

  private runFrame(rawDt: number): void {
    const time = this.time;
    const dt = Math.min(Math.max(rawDt, 0), this.stepper.maxFrameDt);
    time.frameDt = dt;
    time.realTime += dt;
    if (!this._paused) {
      const steps = this.stepper.advance(dt);
      for (let i = 0; i < steps; i++) {
        time.simTime += this.stepper.step;
        time.tick++;
        this.cb.update(this.stepper.step, time);
      }
    }
    time.frame++;
    this.cb.render(this._paused ? 0 : this.stepper.alpha, time);
  }
}
