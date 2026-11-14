/**
 * Comfort in a headset (ws/xr-merge, from Forge Wilds' XR1 and XR2): the view moves only as the
 * head and the player's own moves move it. All of it is optional: a game takes what it wants.
 *
 * - `ViewEase`: a correction to the drawn eye (a server's, a physics push-out) is taken out of
 *   the eye and given back over about a tenth of a second, too quick to leave the eye far from
 *   the body and too smooth to read as a jump. A move too far to ease (a teleport, a respawn)
 *   still snaps, and counts in `jumps`.
 * - `Vignette`: while the stick moves the body (a walk, a smooth turn) the view's edges darken;
 *   a snap turn blinks the view and a jump fades it from black. It computes the amounts
 *   (`edge`, `fade`); the game draws them (a veil, a post vignette).
 * - `SpeedLimit`: caps how fast and how sharply a stick-driven move goes (m/s, m/s²), and how
 *   fast a smooth turn turns, the speeds that make a walk without legs sickening.
 *
 * Pure: no WebXR, no DOM, no clock of their own; nothing allocates per frame.
 */

/** How quickly an eased correction is given back (seconds: the offset's time constant). */
export const EASE_TAU_S = 0.08;
/** A move farther than this (metres, on any axis) in a frame isn't eased: a teleport. */
export const EASE_MAX_JUMP = 4;

/** What `ViewEase` reads of the body each frame. */
export interface EaseBody {
  /** Corrections so far (a count that changes when the body's place was corrected this frame). */
  readonly corrections: number;
  /** Times the body was moved outright (a respawn, a teleport): never eased. */
  readonly resets: number;
  /** True: nothing is eased this frame (flying, a vehicle: whatever the game moves freely). */
  readonly free?: boolean;
}

export interface ViewEaseOptions {
  /** Seconds; default `EASE_TAU_S`. */
  tau?: number;
  /** Metres; default `EASE_MAX_JUMP`. */
  maxJump?: number;
}

/** Eases corrections out of the drawn eye. */
export class ViewEase {
  /** The eye as drawn: the true eye plus what is left of the corrections. */
  readonly out: [number, number, number] = [0, 0, 0];
  /** What is left to give back (x, y, z). */
  readonly offset = new Float64Array(3);
  /** Corrections eased so far. */
  eased = 0;
  /** Moves too far to ease (a teleport, a respawn, a reset): `Vignette` fades through each. */
  jumps = 0;
  tau: number;
  maxJump: number;
  private readonly last = new Float64Array(3);
  private seen = false;
  private corrections = 0;
  private resets = 0;
  private lastNow = 0;

  constructor(opts: ViewEaseOptions = {}) {
    this.tau = opts.tau ?? EASE_TAU_S;
    this.maxJump = opts.maxJump ?? EASE_MAX_JUMP;
  }

  /** Forget everything: the next frame is drawn where the eye is. */
  reset(): void {
    this.seen = false;
    this.offset.fill(0);
  }

  /** This frame's eye as drawn (`out`), from the true eye (`eye`) at `now` (ms). */
  frame(eye: ArrayLike<number>, body: EaseBody, now: number): [number, number, number] {
    const o = this.offset;
    const dt = this.seen ? Math.max(0, Math.min(0.25, (now - this.lastNow) / 1000)) : 0;
    const dx = eye[0]! - this.last[0]!;
    const dy = eye[1]! - this.last[1]!;
    const dz = eye[2]! - this.last[2]!;
    const m = this.maxJump;
    const far = Math.abs(dx) > m || Math.abs(dy) > m || Math.abs(dz) > m;
    if (!this.seen || body.free === true || body.resets !== this.resets || far) {
      if (this.seen && (far || body.resets !== this.resets)) this.jumps++;
      o.fill(0);
    } else {
      // What was left decays, and this frame's correction is taken out to be given back.
      const k = Math.exp(-dt / this.tau);
      o[0] = o[0]! * k;
      o[1] = o[1]! * k;
      o[2] = o[2]! * k;
      if (body.corrections !== this.corrections) {
        o[0] = o[0]! - dx;
        o[1] = o[1]! - dy;
        o[2] = o[2]! - dz;
        this.eased++;
      }
    }
    this.seen = true;
    this.lastNow = now;
    this.corrections = body.corrections;
    this.resets = body.resets;
    this.last[0] = eye[0]!;
    this.last[1] = eye[1]!;
    this.last[2] = eye[2]!;
    const out = this.out;
    out[0] = eye[0]! + o[0]!;
    out[1] = eye[1]! + o[1]!;
    out[2] = eye[2]! + o[2]!;
    return out;
  }
}

/** The vignette's default strength. */
export const VIGNETTE_DEFAULT = 0.7;
/** How quickly the edges close as the body moves, and open after (seconds). */
const VIGNETTE_IN_S = 0.1;
const VIGNETTE_OUT_S = 0.25;
/** A snap turn's blink: how dark at most, and how long it takes to clear (ms). */
export const SNAP_BLINK = 0.45;
export const SNAP_BLINK_MS = 110;
/** A jump's fade: from black, cleared over this long (ms). */
export const JUMP_FADE_MS = 300;

/** The comfort vignette and the view's fades: amounts the game draws. */
export class Vignette {
  /** The setting: 0 off (no edge, no blink; a jump still fades), up to 1. */
  strength = VIGNETTE_DEFAULT;
  /** The edges' darkness now (0 to `strength`). */
  edge = 0;
  /** The whole view's fade now (0 to 1). */
  fade = 0;
  /** Pinned amounts (tests, screenshots), or null. */
  held: { edge: number; fade: number } | null = null;
  /** How hard the body is moved this frame (0 still, 1 full), read by `step`. */
  moving = 0;
  private rate = 0;
  private jumps = -1;

  /** Nothing drawn: a session begins or ends. */
  reset(): void {
    this.edge = 0;
    this.fade = 0;
    this.jumps = -1;
  }

  /** A frame of `dt` seconds: `moving` (0 to 1) and `ViewEase.jumps` (a change fades). */
  frame(moving: number, jumps: number, dt: number): void {
    this.moving = moving;
    this.step(jumps, dt);
  }

  /** `frame` with `moving` already set. */
  step(jumps: number, dt: number): void {
    const want = this.strength * Math.min(1, Math.max(0, this.moving));
    const tau = want > this.edge ? VIGNETTE_IN_S : VIGNETTE_OUT_S;
    this.edge += (want - this.edge) * (1 - Math.exp(-Math.max(0, dt) / tau));
    if (want === 0 && this.edge < 0.01) this.edge = 0;
    if (this.jumps !== -1 && jumps !== this.jumps) this.flash(1, JUMP_FADE_MS);
    else this.fade = Math.max(0, this.fade - this.rate * Math.max(0, dt));
    this.jumps = jumps;
    if (this.held) {
      this.edge = this.held.edge;
      this.fade = this.held.fade;
    }
  }

  /** A snap turn: the view blinks (not with the vignette off). */
  snapped(): void {
    if (this.strength > 0) this.flash(SNAP_BLINK, SNAP_BLINK_MS);
  }

  /** The view jumped some other way (a recentre, a carry dropped): it fades from black. */
  jumped(): void {
    this.flash(1, JUMP_FADE_MS);
  }

  private flash(peak: number, ms: number): void {
    if (peak < this.fade) return;
    this.fade = peak;
    this.rate = peak / (ms / 1000);
  }
}

export interface SpeedLimitOptions {
  /** Top speed, m/s (default 3: a brisk walk). */
  maxSpeed?: number;
  /** Top acceleration and braking, m/s² (default 6; Infinity: none). */
  maxAccel?: number;
  /** Top smooth-turn rate, degrees/s (default 150). */
  maxTurnDegS?: number;
}

/**
 * Limits a stick-driven move's speed and change of speed, and a smooth turn's rate. `move` takes
 * the wanted velocity (x, z, m/s) and writes the allowed one to `out`; `turn` clamps an angle.
 */
export class SpeedLimit {
  maxSpeed: number;
  maxAccel: number;
  maxTurnDegS: number;
  /** The velocity allowed last (x, z). */
  readonly out: [number, number] = [0, 0];

  constructor(opts: SpeedLimitOptions = {}) {
    this.maxSpeed = opts.maxSpeed ?? 3;
    this.maxAccel = opts.maxAccel ?? 6;
    this.maxTurnDegS = opts.maxTurnDegS ?? 150;
  }

  /** The velocity (x, z, m/s) wanted this frame of `dt` s, limited, into `out`. */
  move(vx: number, vz: number, dt: number): [number, number] {
    const out = this.out;
    const s = Math.sqrt(vx * vx + vz * vz);
    if (s > this.maxSpeed) {
      vx *= this.maxSpeed / s;
      vz *= this.maxSpeed / s;
    }
    const dx = vx - out[0];
    const dz = vz - out[1];
    const d = Math.sqrt(dx * dx + dz * dz);
    const step = this.maxAccel * Math.max(0, dt);
    if (d > step) {
      out[0] += (dx * step) / d;
      out[1] += (dz * step) / d;
    } else {
      out[0] = vx;
      out[1] = vz;
    }
    return out;
  }

  /** A smooth turn of `angle` radians over `dt` s, clamped to `maxTurnDegS`. */
  turn(angle: number, dt: number): number {
    const max = ((this.maxTurnDegS * Math.PI) / 180) * Math.max(0, dt);
    return angle > max ? max : angle < -max ? -max : angle;
  }

  /** Standing still: the next move starts from rest. */
  reset(): void {
    this.out[0] = 0;
    this.out[1] = 0;
  }
}
