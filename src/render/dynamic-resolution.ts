/**
 * Dynamic resolution: a small controller that turns GPU frame-time samples into a render
 * scale. Pure (no GPU, no clock): feed it `sample(gpuMs, nowMs)` and apply the returned scale
 * with `Renderer.setResolution({ scale })` when it changes.
 *
 * Design goals: steady image, no pumping.
 * - Drops only after a sustained over-budget window (`dropAfterMs`), one step at a time.
 * - Raises only after a longer window of clear headroom (`raiseAfterMs`), and only when the
 *   predicted cost at the higher scale (time ∝ pixels ∝ scale²) stays under
 *   `budgetMs × raiseMargin`. That gap between drop and raise thresholds is the hysteresis.
 * - A cooldown after every change lets the new size settle before the next decision.
 * - A raise that is followed quickly by a drop "burns" that level: the controller will not try
 *   to raise past it again for `burnMs`, so a scene that sits right at the edge settles
 *   instead of oscillating.
 */

export interface DynamicResolutionOptions {
  /** GPU time budget per frame (ms). Default 14 (headroom under a 16.7 ms vsync). */
  budgetMs?: number;
  /** Lowest scale. Default 0.5. */
  minScale?: number;
  /** Highest scale. Default 1. */
  maxScale?: number;
  /** Step per change. Default 0.1. */
  step?: number;
  /** Sustained over-budget time before dropping (ms). Default 1000. */
  dropAfterMs?: number;
  /** Sustained headroom before raising (ms). Default 3000. */
  raiseAfterMs?: number;
  /** Predicted time at the higher scale must be below budget × this. Default 0.85. */
  raiseMargin?: number;
  /** Quiet time after any change (ms). Default 1500. */
  cooldownMs?: number;
  /** How long a level that dropped right after a raise stays off limits (ms). Default 20000. */
  burnMs?: number;
  /** Smoothing for the time estimate, 0..1 (weight of each new sample). Default 0.2. */
  smoothing?: number;
}

export class DynamicResolution {
  readonly budgetMs: number;
  readonly minScale: number;
  readonly maxScale: number;
  private readonly step: number;
  private readonly dropAfterMs: number;
  private readonly raiseAfterMs: number;
  private readonly raiseMargin: number;
  private readonly cooldownMs: number;
  private readonly burnMs: number;
  private readonly smoothing: number;

  private _scale: number;
  private ema = -1;
  private overSince = -1;
  private underSince = -1;
  private lastChange = Number.NEGATIVE_INFINITY;
  private lastRaise = Number.NEGATIVE_INFINITY;
  /** Scale above which we will not raise until `ceilingUntil`. */
  private ceiling = Number.POSITIVE_INFINITY;
  private ceilingUntil = Number.NEGATIVE_INFINITY;

  constructor(opts: DynamicResolutionOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 14;
    this.minScale = opts.minScale ?? 0.5;
    this.maxScale = opts.maxScale ?? 1;
    this.step = opts.step ?? 0.1;
    this.dropAfterMs = opts.dropAfterMs ?? 1000;
    this.raiseAfterMs = opts.raiseAfterMs ?? 3000;
    this.raiseMargin = opts.raiseMargin ?? 0.85;
    this.cooldownMs = opts.cooldownMs ?? 1500;
    this.burnMs = opts.burnMs ?? 20000;
    this.smoothing = opts.smoothing ?? 0.2;
    this._scale = this.maxScale;
  }

  /** Current scale. */
  get scale(): number {
    return this._scale;
  }

  /** Smoothed GPU time (ms), or -1 before the first sample. */
  get estimateMs(): number {
    return this.ema;
  }

  /** True when the scale is at its floor and frames are still over budget. */
  get saturated(): boolean {
    return this._scale <= this.minScale + 1e-6 && this.overSince >= 0;
  }

  /** Forget history and return to `scale` (default max), e.g. on a scene change. */
  reset(scale = this.maxScale, nowMs = Number.NEGATIVE_INFINITY): void {
    this._scale = clamp(scale, this.minScale, this.maxScale);
    this.ema = -1;
    this.overSince = -1;
    this.underSince = -1;
    this.lastChange = nowMs;
  }

  /** Feed a GPU time sample. Returns the (possibly new) scale. */
  sample(gpuMs: number, nowMs: number): number {
    if (!(gpuMs >= 0) || !Number.isFinite(gpuMs)) return this._scale;
    // Samples right after a change describe the old size; let them flush.
    if (nowMs - this.lastChange < this.cooldownMs) {
      this.ema = gpuMs;
      this.overSince = -1;
      this.underSince = -1;
      return this._scale;
    }
    this.ema = this.ema < 0 ? gpuMs : this.ema + (gpuMs - this.ema) * this.smoothing;

    if (this.ema > this.budgetMs) {
      this.underSince = -1;
      if (this.overSince < 0) this.overSince = nowMs;
      if (nowMs - this.overSince >= this.dropAfterMs && this._scale > this.minScale + 1e-6) {
        // A drop soon after a raise means that level is too expensive: remember it.
        if (nowMs - this.lastRaise < this.raiseAfterMs + this.cooldownMs) {
          this.ceiling = this._scale - 1e-6;
          this.ceilingUntil = nowMs + this.burnMs;
        }
        // Drop by enough to get under budget, at least one step, at most three.
        const want = this._scale * Math.sqrt((this.budgetMs * this.raiseMargin) / this.ema);
        const steps = clamp(Math.ceil((this._scale - want) / this.step), 1, 3);
        this.change(this._scale - steps * this.step, nowMs);
        this.overSince = nowMs;
      }
      return this._scale;
    }

    this.overSince = -1;
    const next = Math.min(this.maxScale, this._scale + this.step);
    const predicted = this.ema * (next / this._scale) ** 2;
    const blocked = nowMs < this.ceilingUntil && next > this.ceiling;
    if (next > this._scale + 1e-6 && !blocked && predicted < this.budgetMs * this.raiseMargin) {
      if (this.underSince < 0) this.underSince = nowMs;
      if (nowMs - this.underSince >= this.raiseAfterMs) {
        this.change(next, nowMs);
        this.lastRaise = nowMs;
      }
    } else {
      this.underSince = -1;
    }
    return this._scale;
  }

  private change(scale: number, nowMs: number): void {
    // Snap to the step grid so repeated changes don't accumulate float drift.
    const snapped = Math.round(scale / this.step) * this.step;
    this._scale = clamp(Number(snapped.toFixed(4)), this.minScale, this.maxScale);
    this.lastChange = nowMs;
    this.underSince = -1;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
