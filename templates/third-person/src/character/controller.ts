/**
 * The character controller: camera-relative movement over the ground, turned towards where it
 * goes, kept out of the blocks. Pure arithmetic over `Ground`; the scene feeds it `Look.move`
 * and the camera yaw and reads back position, yaw and speed for the animation graph.
 *
 * Yaw convention (the engine's `Follow`): 0 faces -Z, positive turns right, so the facing is
 * `(sin yaw, 0, -cos yaw)`.
 */
import { type Ground, groundHeight, resolveXZ } from '../world/ground';

export const WALK_SPEED = 2.2;
export const RUN_SPEED = 5;
/** Horizontal radius the controller keeps clear of blocks and the rim. */
export const BODY_RADIUS = 0.3;
const ACCEL = 18;
const TURN_RATE = 12;

export interface Controller {
  /** Feet position, world units. */
  readonly position: Float32Array;
  /** Facing, radians. */
  yaw: number;
  /** Horizontal velocity. */
  readonly velocity: Float32Array;
  /** Horizontal speed, units per second (what the locomotion blend reads). */
  speed: number;
}

export interface MoveInput {
  /** Strafe, -1..1, positive right of the camera. */
  x: number;
  /** Forward, -1..1, positive away from the camera. */
  y: number;
  /** The camera's yaw, radians (`Follow.yaw`). */
  cameraYaw: number;
  sprint: boolean;
}

export function createController(x: number, z: number, g: Ground): Controller {
  const position = new Float32Array([x, groundHeight(g, x, z), z]);
  return { position, yaw: 0, velocity: new Float32Array(2), speed: 0 };
}

const xz = new Float32Array(2);

/** Wrap an angle difference into -π..π. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Advance `dt` seconds. With `locked` the character neither accelerates nor turns (an attack or
 * a hit in progress) but still slows down and stays on the ground.
 */
export function stepController(
  c: Controller,
  input: MoveInput,
  dt: number,
  g: Ground,
  locked = false,
): void {
  const sy = Math.sin(input.cameraYaw);
  const cy = Math.cos(input.cameraYaw);
  // Camera forward (sy, -cy) and right (cy, sy) in the xz plane.
  let wx = locked ? 0 : cy * input.x + sy * input.y;
  let wz = locked ? 0 : sy * input.x - cy * input.y;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }
  const max = input.sprint ? RUN_SPEED : WALK_SPEED;
  const v = c.velocity;
  const k = Math.min(1, ACCEL * dt);
  v[0] += (wx * max - v[0]!) * k;
  v[1] += (wz * max - v[1]!) * k;
  c.speed = Math.hypot(v[0]!, v[1]!);
  if (c.speed < 0.02) {
    v[0] = v[1] = 0;
    c.speed = 0;
  }
  if (!locked && len > 0.05) {
    const want = Math.atan2(wx, -wz);
    const d = angleDelta(c.yaw, want);
    c.yaw += d * Math.min(1, TURN_RATE * dt);
  }
  moveController(c, v[0]! * dt, v[1]! * dt, g);
}

/** Move by a world delta, sliding around blocks and following the ground. */
export function moveController(c: Controller, dx: number, dz: number, g: Ground): void {
  const p = c.position;
  resolveXZ(g, p[0]! + dx, p[2]! + dz, BODY_RADIUS, xz);
  p[0] = xz[0]!;
  p[2] = xz[1]!;
  p[1] = groundHeight(g, p[0]!, p[2]!);
}

/** Facing as a unit xz vector, written to `out[0]`, `out[1]`. */
export function facing(yaw: number, out: Float32Array): Float32Array {
  out[0] = Math.sin(yaw);
  out[1] = -Math.cos(yaw);
  return out;
}
