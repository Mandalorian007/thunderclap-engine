/**
 * The one rule the client runs itself: `step`, the twin of `step` in `server/src/game.rs`, so the
 * client can move its own player before the server answers (prediction). Both read their numbers
 * from `shared/rules.json` and are tested against its cases.
 */
import rules from '../shared/rules.json';
import type { Pos } from './types';

export const {
  width: WIDTH,
  height: HEIGHT,
  radius: RADIUS,
  speed: SPEED,
  stepMs: STEP_MS,
} = rules;

/** Input keys, one bit each. */
export const LEFT = 1;
export const RIGHT = 2;
export const UP = 4;
export const DOWN = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const axis = (keys: number, minus: number, plus: number) =>
  (keys & plus ? 1 : 0) - (keys & minus ? 1 : 0);

/** Where `keys` held for a step take a player from `p`. */
export function step(p: Pos, keys: number): Pos {
  return {
    x: clamp(p.x + axis(keys, LEFT, RIGHT) * SPEED, RADIUS, WIDTH - RADIUS),
    y: clamp(p.y + axis(keys, UP, DOWN) * SPEED, RADIUS, HEIGHT - RADIUS),
  };
}
