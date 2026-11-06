/**
 * Move and slide: the character-controller loop a game would otherwise write. `slide` sweeps the
 * shape along its displacement, stops `skin` short of the first hit, projects what is left of the
 * displacement onto the hit plane and repeats up to `maxIterations` times. A hit whose normal is
 * within `maxSlope` of up is ground: the downward part of the remaining displacement is dropped
 * there (standing on walkable ground is not sliding down it) and the rest follows the surface.
 * Anything steeper is a wall: the remaining displacement slides along it horizontally (a wall
 * cannot be climbed by pushing into it); when a wall blocks horizontal motion from the ground, or
 * catches the shape no higher than `stepHeight` above its bottom, the shape first tries the same
 * move `stepHeight` higher and drops back onto whatever walkable ground it finds (stairs; a
 * rounded bottom landing on a step's lip counts when walkable ground lies under its centre).
 * After the move a short probe downward decides `grounded`; a shape that was grounded and is not
 * any more looks `snapDown` below for ground to stay on (so a step down or a slope's crest does
 * not launch it). The shape itself is not moved: the final position goes into `out`, the game
 * writes it back.
 */
import type { StaticCollider } from './bvh';
import {
  ALL_LAYERS,
  createHit,
  createSweepHit,
  raycast,
  SW,
  type SweepHit,
  sweepMove,
} from './queries';
import {
  isBox2,
  loadShape,
  SH,
  SH_BOX,
  SH_CAPSULE,
  SH_SPHERE,
  type Shape,
  type Shape2,
} from './shapes';

export interface SlideOptions {
  /** Sweep-and-project passes. Default 4. */
  maxIterations?: number;
  /** Gap kept between the shape and what it hit. Default 0.005. */
  skin?: number;
  /** Steepest ground that counts as walkable, in degrees from flat. Default 50. */
  maxSlope?: number;
  /** Highest ledge the shape walks up when a wall blocks it; 0 disables. Default 0.35. */
  stepHeight?: number;
  /** How far below to look for ground after the move when the shape has left it; 0 disables. Default 0.2. */
  snapDown?: number;
  /** Which layers collide. Default all. */
  layerMask?: number;
  /**
   * Whether the shape stood on ground before this move (the previous result's `grounded`): the
   * snap-down and the step-up only run from the ground. Default true.
   */
  wasGrounded?: boolean;
}

export interface SlideResult {
  /** The shape's final centre. */
  x: number;
  y: number;
  z: number;
  /** Whether the shape ended on walkable ground (within `2 × skin` below it). */
  grounded: boolean;
  /** The ground's unit normal when `grounded`, else `[0, 1, 0]`. */
  groundNormal: [number, number, number];
  /** Whether a wall (a hit steeper than `maxSlope`) blocked part of the motion. */
  hitWall: boolean;
  /** Sweep hits during the move (step-ups counted once). */
  hits: number;
  /** Displacement not applied when the iterations ran out (zero otherwise). */
  remaining: [number, number, number];
}

export function createSlideResult(): SlideResult {
  return {
    x: 0,
    y: 0,
    z: 0,
    grounded: false,
    groundNormal: [0, 1, 0],
    hitWall: false,
    hits: 0,
    remaining: [0, 0, 0],
  };
}

/**
 * The controller's registers: box half extents (0..2), position (3..5), remaining displacement
 * (6..8), skin (9), cos of the slope limit (10), step height (11), snap-down (12), a saved
 * position (13..15), the move's dy (16), the shape's half height (17: centre to bottom).
 * Doubles live here and in `SW` / `SH` rather than in locals passed between functions, which
 * V8 would box on every call.
 */
const P = new Float64Array(18);
const P_SKIN = 9;
const P_COS = 10;
const P_STEP = 11;
const P_SNAP = 12;
const P_DY = 16;
const P_HALF = 17;
const hit: SweepHit = createSweepHit();
const lineHit = createHit();
const lineOrigin = new Float64Array(3);
const DOWN = new Float64Array([0, -1, 0]);

/** Loads `shape` into `SH` and its centre into `P[3..5]`. */
function copyShape(shape: Shape): void {
  loadShape(shape);
  if (SH[0] === SH_BOX) {
    P[0] = (SH[4] - SH[1]) / 2;
    P[1] = (SH[5] - SH[2]) / 2;
    P[2] = (SH[6] - SH[3]) / 2;
    P[3] = SH[1] + P[0];
    P[4] = SH[2] + P[1];
    P[5] = SH[3] + P[2];
    P[P_HALF] = P[1];
  } else {
    P[3] = SH[1];
    P[4] = SH[2];
    P[5] = SH[3];
    P[P_HALF] = SH[4] + SH[5];
  }
}

/** Moves the working shape in `SH` to `P[3..5]`. */
function place(): void {
  if (SH[0] === SH_BOX) {
    SH[1] = P[3] - P[0];
    SH[2] = P[4] - P[1];
    SH[3] = P[5] - P[2];
    SH[4] = P[3] + P[0];
    SH[5] = P[4] + P[1];
    SH[6] = P[5] + P[2];
  } else {
    SH[1] = P[3];
    SH[2] = P[4];
    SH[3] = P[5];
  }
}

/** Sweeps the working shape along `P[6..8]`. */
function sweepRemaining(c: StaticCollider, mask: number): boolean {
  SW[0] = P[6];
  SW[1] = P[7];
  SW[2] = P[8];
  return sweepMove(c, hit, mask);
}

/** Sweeps the working shape vertically by `SW[1]` (set by the caller: a double argument would be boxed). */
function sweepY(c: StaticCollider, mask: number): boolean {
  SW[0] = 0;
  SW[2] = 0;
  return sweepMove(c, hit, mask);
}

/**
 * Moves the working shape toward the hit, stopping `skin` short of the surface along its normal,
 * and takes the travelled part off the remaining displacement.
 */
function advanceToHit(): void {
  if (hit.t === 0) return;
  const len = Math.sqrt(P[6] * P[6] + P[7] * P[7] + P[8] * P[8]);
  const dirX = P[6] / len;
  const dirY = P[7] / len;
  const dirZ = P[8] / len;
  const closing = -(dirX * hit.nx + dirY * hit.ny + dirZ * hit.nz);
  const backoff = closing > 1e-6 ? P[P_SKIN] / closing : P[P_SKIN];
  const travel = Math.max(0, hit.t * len - backoff);
  P[3] += dirX * travel;
  P[4] += dirY * travel;
  P[5] += dirZ * travel;
  const left = 1 - travel / len;
  P[6] *= left;
  P[7] *= left;
  P[8] *= left;
  place();
}

/** The plane normal `projectRemaining` works with. */
const N = new Float64Array(3);

/** Removes the component of the remaining displacement that goes into the plane with normal `N`. */
function projectRemaining(): void {
  const nx = N[0];
  const ny = N[1];
  const nz = N[2];
  const into = P[6] * nx + P[7] * ny + P[8] * nz;
  if (into < 0) {
    P[6] -= nx * into;
    P[7] -= ny * into;
    P[8] -= nz * into;
  }
}

/** Ground: drop the downward part of the remaining displacement, follow the surface with the rest. */
function projectOnGround(): void {
  if (P[7] < 0) P[7] = 0;
  N[0] = hit.nx;
  N[1] = hit.ny;
  N[2] = hit.nz;
  projectRemaining();
}

/** Wall: slide along it horizontally (a ceiling, with no horizontal normal, uses its own). */
function projectOnWall(): void {
  const h = Math.sqrt(hit.nx * hit.nx + hit.nz * hit.nz);
  if (h > 1e-6) {
    N[0] = hit.nx / h;
    N[1] = 0;
    N[2] = hit.nz / h;
  } else {
    N[0] = hit.nx;
    N[1] = hit.ny;
    N[2] = hit.nz;
  }
  projectRemaining();
}

/**
 * The step-up: from the current position, go up to `stepHeight`, move the horizontal remainder
 * there, come back down onto walkable ground no lower than where we started. Commits the move
 * and returns true, or leaves everything as it was.
 */
function tryStep(c: StaticCollider, mask: number, out: SlideResult): boolean {
  const hx = P[6];
  const hz = P[8];
  const horiz = Math.sqrt(hx * hx + hz * hz);
  if (horiz < 1e-9) return false;
  const skin = P[P_SKIN];
  P[13] = P[3];
  P[14] = P[4];
  P[15] = P[5];
  // Up.
  let up = P[P_STEP];
  SW[1] = up;
  if (sweepY(c, mask)) {
    up = Math.max(0, hit.t * up - skin / Math.max(1e-6, -hit.ny));
  }
  if (up <= skin) return false;
  // Forward, at the raised height.
  P[4] += up;
  place();
  SW[0] = hx;
  SW[1] = 0;
  SW[2] = hz;
  let frac = 1;
  if (sweepMove(c, hit, mask)) {
    if (hit.t === 0) return restore();
    const closing = -((hx * hit.nx + hz * hit.nz) / horiz);
    const backoff = closing > 1e-6 ? skin / closing : skin;
    frac = Math.max(0, (hit.t * horiz - backoff) / horiz);
    if (frac * horiz < 1e-6) return restore();
  }
  P[3] += hx * frac;
  P[5] += hz * frac;
  place();
  // Down onto the step: ground within `up` of the raised height, walkable.
  const drop = up + skin;
  SW[1] = -drop;
  if (!sweepY(c, mask)) return restore();
  if (hit.t === 0) return restore();
  if (hit.ny < P[P_COS]) {
    // Not ground: a step's lip under the rounded bottom (the next moves carry the shape onto
    // the step) or a slope too steep to stand on. Only the lip, no higher than a step above
    // where we started, with walkable ground under the centre, counts.
    const lip = hit.y <= P[14] - P[P_HALF] + P[P_STEP] + skin;
    if (!lip || !lineGround(c, mask, drop + P[P_STEP])) return restore();
  }
  // Commit.
  P[4] -= Math.max(0, hit.t * drop - skin / hit.ny);
  P[6] = hx * (1 - frac);
  P[7] = 0;
  P[8] = hz * (1 - frac);
  place();
  out.hits++;
  return true;
}

/**
 * Whether a line straight down from the working shape's centre meets walkable ground within
 * `below` of the shape's bottom. A rounded bottom coming down onto a step's lip touches it on
 * the hemisphere, where the contact normal is too steep to be ground although the shape is
 * about to stand on the step: the line under the centre tells a lip (ground below) from a
 * steep slope (the slope itself below).
 */
function lineGround(c: StaticCollider, mask: number, below: number): boolean {
  lineOrigin[0] = P[3];
  lineOrigin[1] = P[4];
  lineOrigin[2] = P[5];
  return raycast(c, lineOrigin, DOWN, P[P_HALF] + below, lineHit, mask) && lineHit.ny >= P[P_COS];
}

/** Puts the working shape back where `tryStep` started; always false. */
function restore(): boolean {
  P[3] = P[13];
  P[4] = P[14];
  P[5] = P[15];
  place();
  return false;
}

/**
 * The loop over the working shape in `SH` from `P[3..5]` along `P[6..8]`. `flat` is the 2D
 * case: every hit a wall, no ground, step or snap.
 */
function run(c: StaticCollider, opts: SlideOptions, out: SlideResult, flat: boolean): SlideResult {
  const maxIterations = opts.maxIterations ?? 4;
  P[P_SKIN] = opts.skin ?? 0.005;
  P[P_COS] = flat ? 2 : Math.cos(((opts.maxSlope ?? 50) * Math.PI) / 180);
  P[P_STEP] = flat ? 0 : (opts.stepHeight ?? 0.35);
  P[P_SNAP] = flat ? 0 : (opts.snapDown ?? 0.2);
  const mask = opts.layerMask ?? ALL_LAYERS;
  const wasGrounded = opts.wasGrounded ?? true;
  P[P_DY] = P[7];

  out.grounded = false;
  out.groundNormal[0] = 0;
  out.groundNormal[1] = 1;
  out.groundNormal[2] = 0;
  out.hitWall = false;
  out.hits = 0;
  let onGround = false;

  for (let i = 0; i < maxIterations; i++) {
    const len = Math.sqrt(P[6] * P[6] + P[7] * P[7] + P[8] * P[8]);
    if (len < 1e-9) {
      P[6] = P[7] = P[8] = 0;
      break;
    }
    if (!sweepRemaining(c, mask)) {
      P[3] += P[6];
      P[4] += P[7];
      P[5] += P[8];
      P[6] = P[7] = P[8] = 0;
      place();
      break;
    }
    out.hits++;
    if (hit.t === 0 && hit.depth > 0) {
      // Started inside something: push out along the normal first.
      const push = hit.depth + P[P_SKIN];
      P[3] += hit.nx * push;
      P[4] += hit.ny * push;
      P[5] += hit.nz * push;
      place();
    } else {
      advanceToHit();
    }
    if (hit.ny >= P[P_COS]) {
      onGround = true;
      projectOnGround();
      continue;
    }
    // A wall. From the ground, or when the obstacle is no higher than a step above the shape's
    // bottom and the shape is not rising (a stair's edge caught under a capsule's lower cap),
    // try to step over it.
    if (
      P[P_STEP] > 0 &&
      (wasGrounded || onGround || (P[P_DY] <= 0 && hit.y <= P[4] - P[P_HALF] + P[P_STEP])) &&
      Math.sqrt(P[6] * P[6] + P[8] * P[8]) > 1e-9
    ) {
      const nx = hit.nx;
      const ny = hit.ny;
      const nz = hit.nz;
      if (tryStep(c, mask, out)) {
        onGround = true;
        continue;
      }
      hit.nx = nx;
      hit.ny = ny;
      hit.nz = nz;
    }
    out.hitWall = true;
    projectOnWall();
  }
  out.remaining[0] = P[6];
  out.remaining[1] = P[7];
  out.remaining[2] = P[8];

  // Ground probe: a hair below for `grounded`; `snapDown` below when the shape has just left the ground.
  if (!flat) {
    const skin = P[P_SKIN];
    const snap = P[P_SNAP] > 0 && wasGrounded && P[P_DY] <= 0;
    const drop = snap ? P[P_SNAP] + skin : 2 * skin;
    SW[1] = -drop;
    if (sweepY(c, mask)) {
      if (hit.ny >= P[P_COS]) {
        if (hit.t > 0) {
          P[4] -= Math.max(0, hit.t * drop - skin / hit.ny);
          place();
        }
        out.grounded = true;
        out.groundNormal[0] = hit.nx;
        out.groundNormal[1] = hit.ny;
        out.groundNormal[2] = hit.nz;
      } else if (lineGround(c, mask, P[P_STEP])) {
        // Held up by a step's lip under the rounded bottom, ground under the centre: standing.
        out.grounded = true;
        out.groundNormal[0] = lineHit.nx;
        out.groundNormal[1] = lineHit.ny;
        out.groundNormal[2] = lineHit.nz;
      }
    }
  }
  out.x = P[3];
  out.y = P[4];
  out.z = P[5];
  return out;
}

/**
 * Moves `shape` by `(dx, dy, dz)` through the collider with the move-and-slide loop described
 * above and writes where it ends up (the shape's centre) and how into `out`. The shape is read,
 * not moved.
 */
export function slide(
  c: StaticCollider,
  shape: Shape,
  dx: number,
  dy: number,
  dz: number,
  opts: SlideOptions = {},
  out: SlideResult = createSlideResult(),
): SlideResult {
  copyShape(shape);
  P[6] = dx;
  P[7] = dy;
  P[8] = dz;
  return run(c, opts, out, false);
}

const EPS_2D = 1e-3;

/**
 * `slide` for a circle or 2D box moving by `(dx, dz)` in the xz plane: every hit is a wall, no
 * step or slope or snap; `out.y` is 0 and `grounded` false. The shape is lifted to the collider's
 * height like the 2D queries.
 */
export function slide2(
  c: StaticCollider,
  shape: Shape2,
  dx: number,
  dz: number,
  opts: SlideOptions = {},
  out: SlideResult = createSlideResult(),
): SlideResult {
  const y0 = c.bounds.min[1] + EPS_2D;
  const y1 = c.bounds.max[1] - EPS_2D;
  P[3] = shape.x;
  P[4] = (y0 + y1) / 2;
  P[5] = shape.z;
  if (isBox2(shape)) {
    SH[0] = SH_BOX;
    P[0] = shape.hw;
    P[1] = Math.max(0, (y1 - y0) / 2);
    P[2] = shape.hh;
    P[P_HALF] = P[1];
  } else {
    const half = (y1 - y0) / 2 - shape.r;
    SH[0] = half <= 0 ? SH_SPHERE : SH_CAPSULE;
    SH[4] = Math.max(0, half);
    SH[5] = shape.r;
    P[P_HALF] = SH[4] + shape.r;
  }
  place();
  P[6] = dx;
  P[7] = 0;
  P[8] = dz;
  run(c, opts, out, true);
  out.y = 0;
  return out;
}
