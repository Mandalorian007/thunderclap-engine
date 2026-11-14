/**
 * Client-side prediction and reconciliation for one thing the player drives.
 *
 * Each input is applied at once with the game's own `step` (the same function the server runs) and
 * sent numbered. The server answers with its state after each input it took. If that state is
 * what was predicted, nothing happens; if not, the predictor starts over from the server's state and
 * replays every input still in flight (rollback), and counts a correction. A server state for an
 * input that was never predicted (connect, a teleport, a knockout) is a reset, not a correction.
 *
 * Pure bookkeeping: it sends nothing. `net.predict()` wires one to a session's `Input` and
 * `PlayerState` messages.
 */

/** A misprediction the server corrected. */
export interface Correction {
  /** The input whose acknowledgement disagreed. */
  readonly seq: number;
  /** How far the prediction jumped (the game's `distance`, 0 without one). */
  readonly distance: number;
  /** When, on the predictor's clock (ms). */
  readonly at: number;
}

/** How a predictor steps and compares the game's state. */
export interface PredictorOptions<State, Input> {
  /** One step of the game's rules: the state after `input`. Must match the server's. */
  readonly step: (state: State, input: Input) => State;
  /** Whether two states are the same (exactly: the server's is the truth). */
  readonly equal: (a: State, b: State) => boolean;
  /** How far apart two states are, for `Correction.distance` (optional). */
  readonly distance?: (a: State, b: State) => number;
  /** The state and last input number to start from (the server's, usually 0). */
  readonly start: { readonly seq: number; readonly state: State };
  /** Milliseconds per step, for `alpha` (default 50). */
  readonly stepMs?: number;
  /** A millisecond clock (default `performance.now`). */
  readonly now?: () => number;
}

interface Pending<State, Input> {
  seq: number;
  input: Input;
  predicted: State;
  sentAt: number;
}

/** How many recent corrections and round trips a predictor remembers. */
const HISTORY = 200;

/** Predicts one thing from its inputs and reconciles with the server's acknowledgements. */
export class Predictor<State, Input> {
  readonly #step: (state: State, input: Input) => State;
  readonly #equal: (a: State, b: State) => boolean;
  readonly #distance: ((a: State, b: State) => number) | undefined;
  readonly #now: () => number;
  readonly #stepMs: number;
  #state: State;
  #previous: State;
  #steppedAt: number;
  #seq: number;
  #pending: Pending<State, Input>[] = [];
  #resetNext = false;
  /** Corrections, newest last (at most 200). */
  readonly corrections: Correction[] = [];
  /** Every correction ever counted. */
  correctionCount = 0;
  /** Server moves that weren't corrections (connect, teleport). */
  resets = 0;
  /** Input round trips (sent to acknowledged), ms, newest last (at most 200). */
  readonly roundTrips: number[] = [];

  constructor(options: PredictorOptions<State, Input>) {
    this.#step = options.step;
    this.#equal = options.equal;
    this.#distance = options.distance;
    this.#now = options.now ?? (() => performance.now());
    this.#stepMs = options.stepMs ?? 50;
    this.#state = options.start.state;
    this.#previous = options.start.state;
    this.#seq = options.start.seq;
    this.#steppedAt = this.#now();
  }

  /** The predicted state after the last input. */
  get state(): State {
    return this.#state;
  }

  /** The predicted state before the last input (to draw between). */
  get previous(): State {
    return this.#previous;
  }

  /** The last input number used. */
  get seq(): number {
    return this.#seq;
  }

  /** Inputs sent and not yet acknowledged. */
  get pending(): number {
    return this.#pending.length;
  }

  /** Applies one input now and returns its number, to send with it. */
  apply(input: Input): number {
    this.#seq = (this.#seq + 1) >>> 0;
    this.#previous = this.#state;
    this.#state = this.#step(this.#state, input);
    this.#steppedAt = this.#now();
    this.#pending.push({ seq: this.#seq, input, predicted: this.#state, sentAt: this.#steppedAt });
    return this.#seq;
  }

  /** The server's state after input `seq`. Returns the correction if the prediction was wrong. */
  acknowledge(seq: number, state: State): Correction | null {
    while (this.#pending.length > 0 && this.#pending[0]!.seq < seq) this.#pending.shift();
    let entry = this.#pending[0]?.seq === seq ? this.#pending.shift() : undefined;
    if (this.#resetNext) {
      this.#resetNext = false;
      entry = undefined;
    }
    const now = this.#now();
    if (entry) {
      this.roundTrips.push(now - entry.sentAt);
      if (this.roundTrips.length > HISTORY) this.roundTrips.shift();
      if (this.#equal(entry.predicted, state)) return null;
    }
    // Wrong, or moved by the server: start over from its state and replay what is in flight.
    const before = this.#state;
    let s = state;
    for (const p of this.#pending) {
      s = this.#step(s, p.input);
      p.predicted = s;
    }
    this.#state = s;
    this.#previous = s;
    this.#seq = Math.max(this.#seq, seq) >>> 0;
    if (!entry) {
      this.resets++;
      return null;
    }
    const correction: Correction = { seq, distance: this.#distance?.(before, s) ?? 0, at: now };
    this.correctionCount++;
    this.corrections.push(correction);
    if (this.corrections.length > HISTORY) this.corrections.shift();
    return correction;
  }

  /**
   * Takes the server's state while another connection drives (this one watches): no prediction to
   * check, drawn like a step of its own so `alpha` blends to it.
   */
  follow(seq: number, state: State): void {
    this.#pending = [];
    this.#previous = this.#state;
    this.#state = state;
    this.#steppedAt = this.#now();
    this.#seq = Math.max(this.#seq, seq) >>> 0;
  }

  /** The next acknowledgement moves it for the server's own reasons: a reset, not a correction. */
  expectReset(): void {
    this.#resetNext = true;
  }

  /** Forgets inputs in flight (the connection dropped). */
  clear(): void {
    this.#pending = [];
  }

  /** Corrections in the last `ms` milliseconds (default a minute). */
  correctionsWithin(ms = 60_000): number {
    const since = this.#now() - ms;
    let n = 0;
    for (const c of this.corrections) if (c.at >= since) n++;
    return n;
  }

  /**
   * How far `now` is through the last step, 0..1: draw `lerp(previous, state, alpha)`. A correction
   * snaps (it is meant to be seen).
   */
  alpha(now: number = this.#now()): number {
    return Math.min(1, Math.max(0, (now - this.#steppedAt) / this.#stepMs));
  }
}
