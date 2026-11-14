/**
 * Seated or standing (ws/xr-merge, from Forge Wilds' height calibration): the head's height in
 * the headset mapped to the game's eye height, whatever the player's.
 *
 * On `local-floor` the space's origin is the floor under the head. A game draws its eye at its
 * character's eye height plus the head's height less `offset`. In `'avatar'` mode (the default)
 * the head's height at the first sane pose after `ask` is the offset, so a seated player (1.0 m)
 * and a tall one (1.8 m) both see from the character's eye, and moving from there stays real (a
 * crouch lowers the view). In `'real'` mode the offset is the eye height: the head's own height
 * is the eye's. A head under `HEAD_MIN` or over `HEAD_MAX` isn't one being worn (a headset on a
 * desk): calibration waits for a sane one up to `WAIT_MS`, then keeps what it had.
 *
 * Pure: no WebXR, no clock of its own.
 */

/** The lowest and highest head (metres over the floor) taken as worn. */
export const HEAD_MIN = 0.5;
export const HEAD_MAX = 2.3;
/** How long a calibration waits for a sane head before it gives up (ms). */
export const WAIT_MS = 2000;

/** `'avatar'`: calibrate to the game's eye height; `'real'`: the head's own height. */
export type HeightMode = 'avatar' | 'real';

/** Why a calibration was asked: the session's start, a recentre, the player, the mode changed. */
export type CalibrateWhy = 'start' | 'reset' | 'asked' | 'mode';

export interface HeightReport {
  mode: HeightMode;
  /** The head's height last measured (m), or null. */
  measured: number | null;
  /** What comes off a pose's height now. */
  offset: number;
  calibrations: number;
  recalibrations: number;
  timeouts: number;
  pending: boolean;
  last: CalibrateWhy;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export class HeightCalibration {
  /** The game's eye height over the feet: the offset in `'real'`, and before any measure. */
  readonly eyeHeight: number;
  mode: HeightMode;
  /** What comes off every pose's height now. */
  offset: number;
  measured: number | null = null;
  calibrations = 0;
  recalibrations = 0;
  timeouts = 0;
  /** Waiting for a sane head. */
  pending = false;
  last: CalibrateWhy = 'start';
  private since = Number.NaN;
  private asked = 0;

  constructor(eyeHeight: number, mode: HeightMode = 'avatar') {
    this.eyeHeight = eyeHeight;
    this.mode = mode;
    this.offset = eyeHeight;
  }

  /** Ask for a calibration (the first is the session's start); measured at the next sane head. */
  ask(why: CalibrateWhy): void {
    this.last = why;
    if (this.asked++ > 0) this.recalibrations++;
    if (this.mode !== 'avatar') return;
    this.pending = true;
    this.since = Number.NaN;
  }

  /** The mode changed: `'real'` is the eye height now; `'avatar'` measures again. */
  setMode(mode: HeightMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'real') {
      this.pending = false;
      this.offset = this.eyeHeight;
    } else this.ask('mode');
  }

  /**
   * A frame at `now` (ms) with the head `headY` over the floor (NaN: no pose). True when the
   * offset changed.
   */
  frame(headY: number, now: number): boolean {
    if (!this.pending) return false;
    if (Number.isNaN(this.since)) this.since = now;
    if (headY >= HEAD_MIN && headY <= HEAD_MAX) {
      this.pending = false;
      this.measured = headY;
      this.calibrations++;
      const was = this.offset;
      this.offset = headY;
      return was !== headY;
    }
    if (now - this.since >= WAIT_MS) {
      this.pending = false;
      this.timeouts++;
    }
    return false;
  }

  /** The drawn eye's height over the feet for a head `headY` over the floor. */
  eyeOverFeet(headY: number): number {
    return this.eyeHeight + headY - this.offset;
  }

  report(): HeightReport {
    return {
      mode: this.mode,
      measured: this.measured === null ? null : r3(this.measured),
      offset: r3(this.offset),
      calibrations: this.calibrations,
      recalibrations: this.recalibrations,
      timeouts: this.timeouts,
      pending: this.pending,
      last: this.last,
    };
  }
}
