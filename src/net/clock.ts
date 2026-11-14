/**
 * The client's estimate of the server's game time, in steps, from `Welcome`, `Clock` and `Pong`.
 * Exact while paused; while running it is fractional and never goes backwards between samples. A
 * sample within a step of the estimate eases it a quarter of the way (smoothing network jitter);
 * further off, the server is the truth.
 */
export class NetClock {
  readonly #local: () => number;
  #stepsPerSecond: number;
  #base: number;
  #baseAt: number;
  #paused: boolean;
  #latencyMs = 0;
  #floor: number;

  /**
   * `time` is the server's game time in steps; `stepMs` its step length (default 50: 20 a second).
   * `local` is a millisecond clock (default `performance.now`); tests pass a fake.
   */
  constructor(
    time: number,
    paused: boolean,
    stepMs = 50,
    local: () => number = () => performance.now(),
  ) {
    this.#local = local;
    this.#stepsPerSecond = 1000 / stepMs;
    this.#base = time;
    this.#baseAt = local();
    this.#paused = paused;
    this.#floor = time;
  }

  /** Whether the server's clock is paused. */
  get paused(): boolean {
    return this.#paused;
  }

  /** Estimated one-way latency in milliseconds, from the last `Pong`. */
  get latencyMs(): number {
    return this.#latencyMs;
  }

  /** Milliseconds per step. */
  get stepMs(): number {
    return 1000 / this.#stepsPerSecond;
  }

  /**
   * Estimated current game time in steps. `at` is the local clock's reading when the caller has one
   * (a frame's start), which saves reading it again.
   */
  now(at?: number): number {
    if (this.#paused) return this.#base;
    const t = this.#base + (((at ?? this.#local()) - this.#baseAt) * this.#stepsPerSecond) / 1000;
    if (t < this.#floor) return this.#floor;
    this.#floor = t;
    return t;
  }

  /**
   * Takes a server sample. `latencyMs` is the one-way delay a ping measured; samples without it
   * (pushed `Clock` messages) reuse the last estimate.
   */
  observe(time: number, paused: boolean, latencyMs?: number): void {
    if (latencyMs !== undefined) this.#latencyMs = latencyMs;
    const at = this.#local();
    if (paused) {
      this.#set(time, at, true);
      return;
    }
    const estimate = time + (this.#latencyMs * this.#stepsPerSecond) / 1000;
    if (!this.#paused) {
      const predicted = this.now();
      const error = estimate - predicted;
      if (Math.abs(error) < 1) {
        this.#base = predicted + error / 4;
        this.#baseAt = at;
        return;
      }
    }
    this.#set(estimate, at, false);
  }

  /** Starts over from a `Welcome` (a reconnect): its time, pause and step length. */
  reset(time: number, paused: boolean, stepMs: number): void {
    this.#stepsPerSecond = 1000 / stepMs;
    this.#set(time, this.#local(), paused);
  }

  #set(time: number, at: number, paused: boolean): void {
    this.#base = time;
    this.#baseAt = at;
    this.#paused = paused;
    this.#floor = time;
  }
}
