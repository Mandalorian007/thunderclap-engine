/**
 * The player controller: run, jump (coyote time, jump buffering, variable height), dash. Pure; the
 * scene feeds it an `Intent` per fixed step and reads the `Body` and the `state` for animation.
 *
 * The three constants an agent tunes are at the top: `GRAVITY`, `JUMP_SPEED`, `RUN_SPEED`.
 */
import type { Level } from '../levels/format';
import { type Body, createBody, type MoverBox, moveBody } from './body';

// ---------------------------------------------------------------- tuning

/** Downward acceleration, px/s². Higher = snappier arcs. */
export const GRAVITY = 2600;
/** Jump launch speed, px/s. With GRAVITY it sets the apex: v²/(2g) ≈ 3.1 tiles. */
export const JUMP_SPEED = 1020;
/** Top running speed, px/s. */
export const RUN_SPEED = 520;

/** Ground acceleration and deceleration, px/s². */
export const RUN_ACCEL = 4200;
export const RUN_DECEL = 5200;
/** Air control is softer. */
export const AIR_ACCEL = 2600;
/** Terminal fall speed, px/s. */
export const MAX_FALL = 1500;
/** Gravity multiplier once the jump button is released on the way up (variable height). */
export const SHORT_HOP_GRAVITY = 2.6;
/** Seconds after leaving an edge during which a jump still counts. */
export const COYOTE_TIME = 0.1;
/** Seconds a jump press is remembered before landing. */
export const JUMP_BUFFER = 0.12;
/** Dash: speed, duration, cooldown. */
export const DASH_SPEED = 1150;
export const DASH_TIME = 0.14;
export const DASH_COOLDOWN = 0.9;

export const PLAYER_W = 40;
export const PLAYER_H = 56;

// ---------------------------------------------------------------- types

export type PlayerState = 'idle' | 'run' | 'jump' | 'fall' | 'land' | 'dash';

/** What the player wants this step: the scene maps keyboard, pad and touch onto it. */
export interface Intent {
  /** -1 .. 1 */
  move: number;
  /** Jump was pressed this step. */
  jumpPressed: boolean;
  /** Jump is held. */
  jumpHeld: boolean;
  /** Dash was pressed this step. */
  dashPressed: boolean;
}

export interface Player {
  readonly body: Body;
  /** +1 right, -1 left. */
  facing: 1 | -1;
  state: PlayerState;
  /** Seconds in the current state. */
  stateTime: number;
  coyote: number;
  jumpBuffer: number;
  dashLeft: number;
  dashCooldown: number;
  /** Events the scene turns into sound and particles; cleared each step before input. */
  jumped: boolean;
  landed: boolean;
  dashed: boolean;
}

export function createPlayer(x: number, y: number): Player {
  return {
    body: createBody(x, y, PLAYER_W, PLAYER_H),
    facing: 1,
    state: 'idle',
    stateTime: 0,
    coyote: 0,
    jumpBuffer: 0,
    dashLeft: 0,
    dashCooldown: 0,
    jumped: false,
    landed: false,
    dashed: false,
  };
}

/** Puts the player at `(x, y)` (top-left) with no motion, as after a respawn. */
export function placePlayer(p: Player, x: number, y: number): void {
  p.body.x = x;
  p.body.y = y;
  p.body.vx = 0;
  p.body.vy = 0;
  p.body.riding = -1;
  p.body.grounded = false;
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.dashLeft = 0;
  setState(p, 'fall');
}

/** One fixed step. */
export function stepPlayer(
  p: Player,
  intent: Intent,
  level: Level,
  movers: readonly MoverBox[],
  dt: number,
): void {
  const b = p.body;
  p.jumped = false;
  p.landed = false;
  p.dashed = false;
  const wasGrounded = b.grounded;

  // Timers.
  p.coyote = wasGrounded ? COYOTE_TIME : Math.max(0, p.coyote - dt);
  p.jumpBuffer = intent.jumpPressed ? JUMP_BUFFER : Math.max(0, p.jumpBuffer - dt);
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);

  if (intent.move > 0.01) p.facing = 1;
  else if (intent.move < -0.01) p.facing = -1;

  // Dash.
  if (intent.dashPressed && p.dashCooldown === 0 && p.dashLeft === 0) {
    p.dashLeft = DASH_TIME;
    p.dashCooldown = DASH_COOLDOWN;
    p.dashed = true;
    setState(p, 'dash');
  }
  if (p.dashLeft > 0) {
    p.dashLeft = Math.max(0, p.dashLeft - dt);
    b.vx = DASH_SPEED * p.facing;
    b.vy = 0;
    moveBody(b, level, movers, dt);
    if (p.dashLeft === 0) {
      b.vx = RUN_SPEED * p.facing;
      setState(p, b.grounded ? 'run' : 'fall');
    }
    p.stateTime += dt;
    return;
  }

  // Horizontal.
  const target = intent.move * RUN_SPEED;
  const accel = wasGrounded
    ? Math.abs(target) > Math.abs(b.vx)
      ? RUN_ACCEL
      : RUN_DECEL
    : AIR_ACCEL;
  b.vx = approach(b.vx, target, accel * dt);

  // Jump: a press within the buffer while grounded or within coyote time.
  if (p.jumpBuffer > 0 && p.coyote > 0) {
    b.vy = -JUMP_SPEED;
    p.coyote = 0;
    p.jumpBuffer = 0;
    b.grounded = false;
    b.riding = -1;
    p.jumped = true;
    setState(p, 'jump');
  }

  // Gravity, stronger when the button is let go on the way up.
  const g = b.vy < 0 && !intent.jumpHeld ? GRAVITY * SHORT_HOP_GRAVITY : GRAVITY;
  b.vy = Math.min(MAX_FALL, b.vy + g * dt);

  moveBody(b, level, movers, dt);

  // State.
  if (b.grounded) {
    if (!wasGrounded) {
      p.landed = true;
      setState(p, 'land');
    } else if (p.state === 'land' && p.stateTime < 0.08) {
      // hold the land pose a moment
    } else {
      setState(p, Math.abs(b.vx) > 20 ? 'run' : 'idle');
    }
  } else if (b.vy < 0) {
    if (p.state !== 'jump') setState(p, 'jump');
  } else if (p.state !== 'fall') {
    setState(p, 'fall');
  }
  p.stateTime += dt;
}

function setState(p: Player, s: PlayerState): void {
  if (p.state !== s) {
    p.state = s;
    p.stateTime = 0;
  }
}

function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}
