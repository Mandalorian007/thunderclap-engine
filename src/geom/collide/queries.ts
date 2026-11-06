/**
 * Queries against a `StaticCollider`: `raycast`, `overlap` and `sweep` in 3D, `raycast2`,
 * `overlap2` and `sweep2` in the xz plane. Every query walks the BVH with one shared stack and
 * writes into an `out` the caller owns; nothing allocates after the first call.
 *
 * Sweeps: a sphere or capsule advances conservatively along the displacement (the distance from
 * the inner segment to the triangle over the closing speed, the bound a convex distance function
 * allows, so a face-on approach lands in one step and an edge in a few); a box sweeps by the
 * separating-axis test on the thirteen box–triangle axes, which is exact for a linear motion.
 * The 2D shapes are lifted to the collider's height (a circle to a capsule, a box to a box
 * spanning its y range, shrunk a hair so coplanar floors and ceilings do not register) and run
 * through the 3D code.
 *
 * The per-triangle work passes its doubles through the shared registers of `shapes.ts` (`TRI`,
 * `SEG`, `PT`, `BX`) and the ones below rather than as arguments: V8 boxes a double that crosses
 * a call it did not inline, and these are the calls it does not inline.
 */
import { type Ray, rayTriangle, type Vec3 } from '../../input/rays';
import type { StaticCollider } from './bvh';
import {
  aabbTri,
  BX,
  boxAxis,
  type Contact,
  closestPointTri,
  closestSegTri,
  isBox2,
  loadBox,
  loadShape,
  PT,
  R,
  SEG,
  SH,
  SH_BOX,
  SH_CAPSULE,
  SH_SPHERE,
  type Shape,
  type Shape2,
  shapeBoundsReg,
  shapeTri,
  TRI,
  triNormal,
} from './shapes';

/** All layers. */
export const ALL_LAYERS = 0xffffffff;

/** Where a ray met the collider. `t` is the distance along the ray; `n` the triangle normal facing the ray. */
export interface Hit {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  triangle: number;
  source: number;
  userData: unknown;
}

/**
 * Where a swept shape first touches: `t` in 0..1 along the displacement (0 with `depth > 0` when
 * it started overlapping), the point on the triangle and the unit normal pointing into the shape.
 */
export interface SweepHit extends Hit {
  depth: number;
}

export function createHit(): Hit {
  return {
    t: 0,
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    triangle: -1,
    source: -1,
    userData: undefined,
  };
}

export function createSweepHit(): SweepHit {
  return { ...createHit(), depth: 0 };
}

/** Writes triangle `index`'s nine coordinates into `out` (at `offset`) and returns `out`. */
export function colliderTriangle(
  c: StaticCollider,
  index: number,
  out: Float32Array,
  offset = 0,
): Float32Array {
  const o = index * 9;
  for (let k = 0; k < 9; k++) out[offset + k] = c.tris[o + k]!;
  return out;
}

// ------------------------------------------------------------------ traversal

let stack = new Int32Array(256);

function ensureStack(c: StaticCollider): void {
  // A median-split tree has depth about log2(n / leafSize) + the top level; 2 × node count is a hard bound.
  const need = Math.min(2 * c.nodeLeaf.length + 8, 4096);
  if (stack.length < need) stack = new Int32Array(need);
}

function layerOk(c: StaticCollider, tri: number, mask: number): boolean {
  const s = c.sources[c.triSource[tri]!]!;
  return ((1 << s.layer) & mask) !== 0;
}

/** Loads triangle `o / 9` of `tris` into the `TRI` register. */
function loadTriAt(tris: Float32Array, o: number): void {
  for (let k = 0; k < 9; k++) TRI[k] = tris[o + k]!;
}

const EPS_2D = 1e-3;

// ------------------------------------------------------------------ raycast

const ray: Ray = { origin: [0, 0, 0], dir: [0, 0, 1] };
const triA: Vec3 = [0, 0, 0];
const triB: Vec3 = [0, 0, 0];
const triC: Vec3 = [0, 0, 0];
const normal: Vec3 = [0, 0, 0];

function loadTriangle(tris: Float32Array, o: number): void {
  triA[0] = tris[o]!;
  triA[1] = tris[o + 1]!;
  triA[2] = tris[o + 2]!;
  triB[0] = tris[o + 3]!;
  triB[1] = tris[o + 4]!;
  triB[2] = tris[o + 5]!;
  triC[0] = tris[o + 6]!;
  triC[1] = tris[o + 7]!;
  triC[2] = tris[o + 8]!;
}

/** Ray registers: origin (0..2), inverse direction (3..5), the entry distance of the last `rayNode` (6). */
const RAY = new Float64Array(7);

/** Slab test: `RAY[6]` = the entry distance of the (unit) ray into node `n`, or +∞ for a miss. */
function rayNode(c: StaticCollider, n: number): void {
  const o = n * 3;
  if (c.nodeMin[o]! > c.nodeMax[o]!) {
    RAY[6] = Number.POSITIVE_INFINITY; // removed source
    return;
  }
  let t0 = (c.nodeMin[o]! - RAY[0]) * RAY[3];
  let t1 = (c.nodeMax[o]! - RAY[0]) * RAY[3];
  let tmin = Math.min(t0, t1);
  let tmax = Math.max(t0, t1);
  t0 = (c.nodeMin[o + 1]! - RAY[1]) * RAY[4];
  t1 = (c.nodeMax[o + 1]! - RAY[1]) * RAY[4];
  tmin = Math.max(tmin, Math.min(t0, t1));
  tmax = Math.min(tmax, Math.max(t0, t1));
  t0 = (c.nodeMin[o + 2]! - RAY[2]) * RAY[5];
  t1 = (c.nodeMax[o + 2]! - RAY[2]) * RAY[5];
  tmin = Math.max(tmin, Math.min(t0, t1));
  tmax = Math.min(tmax, Math.max(t0, t1));
  tmin = Math.max(tmin, 0);
  RAY[6] = tmax < tmin ? Number.POSITIVE_INFINITY : tmin;
}

/**
 * The nearest triangle along the ray from `origin` in `dir` (any length; `t` is in world units)
 * within `maxDist`. Writes `out` and returns true, or returns false (out untouched) for a miss.
 * Back faces hit too; the normal is turned to face the ray.
 */
export function raycast(
  c: StaticCollider,
  origin: ArrayLike<number>,
  dir: ArrayLike<number>,
  maxDist: number,
  out: Hit,
  layerMask = ALL_LAYERS,
): boolean {
  const len = Math.sqrt(dir[0]! * dir[0]! + dir[1]! * dir[1]! + dir[2]! * dir[2]!);
  if (!(len > 0)) return false;
  const ox = origin[0]!;
  const oy = origin[1]!;
  const oz = origin[2]!;
  const dx = dir[0]! / len;
  const dy = dir[1]! / len;
  const dz = dir[2]! / len;
  ray.origin[0] = ox;
  ray.origin[1] = oy;
  ray.origin[2] = oz;
  ray.dir[0] = dx;
  ray.dir[1] = dy;
  ray.dir[2] = dz;
  RAY[0] = ox;
  RAY[1] = oy;
  RAY[2] = oz;
  RAY[3] = 1 / dx;
  RAY[4] = 1 / dy;
  RAY[5] = 1 / dz;
  ensureStack(c);
  let best = maxDist;
  let bestTri = -1;
  let sp = 0;
  stack[sp++] = c.root;
  const tris = c.tris;
  while (sp > 0) {
    const n = stack[--sp]!;
    rayNode(c, n);
    if (RAY[6] >= best) continue;
    if (c.nodeLeaf[n]) {
      const t0 = c.nodeA[n]!;
      const t1 = t0 + c.nodeB[n]!;
      for (let t = t0; t < t1; t++) {
        if (layerMask !== ALL_LAYERS && !layerOk(c, t, layerMask)) continue;
        loadTriangle(tris, t * 9);
        const d = rayTriangle(ray, triA, triB, triC, false, null);
        if (d >= 0 && d < best) {
          best = d;
          bestTri = t;
        }
      }
    } else {
      stack[sp++] = c.nodeA[n]!;
      stack[sp++] = c.nodeB[n]!;
    }
  }
  if (bestTri < 0) return false;
  loadTriangle(tris, bestTri * 9);
  rayTriangle(ray, triA, triB, triC, false, normal);
  out.t = best;
  out.x = ox + dx * best;
  out.y = oy + dy * best;
  out.z = oz + dz * best;
  out.nx = normal[0];
  out.ny = normal[1];
  out.nz = normal[2];
  out.triangle = bestTri;
  const src = c.triSource[bestTri]!;
  out.source = src;
  out.userData = c.sources[src]!.userData;
  return true;
}

// ------------------------------------------------------------------ overlap

const qMin = new Float64Array(3);
const qMax = new Float64Array(3);

function nodeOverlapsBox(c: StaticCollider, n: number): boolean {
  const o = n * 3;
  return (
    c.nodeMin[o]! <= qMax[0] &&
    c.nodeMax[o]! >= qMin[0] &&
    c.nodeMin[o + 1]! <= qMax[1] &&
    c.nodeMax[o + 1]! >= qMin[1] &&
    c.nodeMin[o + 2]! <= qMax[2] &&
    c.nodeMax[o + 2]! >= qMin[2]
  );
}

/**
 * Every triangle `shape` penetrates, as contacts into `out` (preallocated with `createContact`),
 * at most `maxContacts` (default `out.length`). Returns the number written. Touching is not a
 * contact; contacts come in BVH order, not by depth.
 */
export function overlap(
  c: StaticCollider,
  shape: Shape,
  out: Contact[],
  maxContacts = out.length,
  layerMask = ALL_LAYERS,
): number {
  loadShape(shape);
  return overlapReg(c, out, maxContacts, layerMask);
}

/** `overlap` of the shape in `SH`. */
function overlapReg(
  c: StaticCollider,
  out: Contact[],
  maxContacts: number,
  layerMask: number,
): number {
  shapeBoundsReg(qMin, qMax);
  ensureStack(c);
  let count = 0;
  let sp = 0;
  stack[sp++] = c.root;
  const tris = c.tris;
  const limit = Math.min(maxContacts, out.length);
  while (sp > 0 && count < limit) {
    const n = stack[--sp]!;
    if (!nodeOverlapsBox(c, n)) continue;
    if (c.nodeLeaf[n]) {
      const t0 = c.nodeA[n]!;
      const t1 = t0 + c.nodeB[n]!;
      for (let t = t0; t < t1 && count < limit; t++) {
        if (layerMask !== ALL_LAYERS && !layerOk(c, t, layerMask)) continue;
        loadTriAt(tris, t * 9);
        const contact = out[count]!;
        if (shapeTri(contact)) {
          contact.triangle = t;
          contact.source = c.triSource[t]!;
          count++;
        }
      }
    } else {
      stack[sp++] = c.nodeA[n]!;
      stack[sp++] = c.nodeB[n]!;
    }
  }
  return count;
}

// ------------------------------------------------------------------ sweep

const SWEEP_TOL = 1e-6;
const SWEEP_ITERATIONS = 48;

/** Sweep registers: the displacement xyz (0..2), the shape radius (3), the time limit (4). */
export const SW = new Float64Array(5);
const SW_R = 3;
const SW_TMAX = 4;

/** The swept segment at t = 0. */
const seg0 = new Float64Array(6);
const sS = new Float64Array(3);
const sT = new Float64Array(3);
const sN = new Float64Array(3);
const sweepContact: Contact = {
  depth: 0,
  nx: 0,
  ny: 0,
  nz: 0,
  px: 0,
  py: 0,
  pz: 0,
  triangle: -1,
  source: -1,
};

/** Results of the per-triangle sweeps: t, point xyz, normal xyz, depth. */
const H = new Float64Array(8);
const H_T = 0;
const H_PX = 1;
const H_PY = 2;
const H_PZ = 3;
const H_NX = 4;
const H_NY = 5;
const H_NZ = 6;
const H_DEPTH = 7;

/** `H` normal and point from the last closest-point pair, normal turned against the motion when degenerate. */
function hitFromClosest(): void {
  let nx = sS[0] - sT[0];
  let ny = sS[1] - sT[1];
  let nz = sS[2] - sT[2];
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nl > 1e-12) {
    nx /= nl;
    ny /= nl;
    nz /= nl;
  } else {
    triNormal(sN);
    nx = sN[0];
    ny = sN[1];
    nz = sN[2];
    if (nx * SW[0] + ny * SW[1] + nz * SW[2] > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
  }
  H[H_NX] = nx;
  H[H_NY] = ny;
  H[H_NZ] = nz;
  H[H_PX] = sT[0];
  H[H_PY] = sT[1];
  H[H_PZ] = sT[2];
}

/**
 * Conservative advancement of the segment `seg0` with radius `SW[3]` along `SW[0..2]` against
 * `TRI`. Returns true with `H` filled when it touches before `SW[4]`.
 */
function sweepSegTri(): boolean {
  const dx = SW[0];
  const dy = SW[1];
  const dz = SW[2];
  const r = SW[SW_R];
  const tMax = SW[SW_TMAX];
  // A contact needs the motion to go into the surface by at least this much of its length:
  // a shape skimming a face it already touches, or crossing a triangle's edge from above, is
  // not a hit (the next move's depenetration catches the hair of overlap this can let through).
  const minClosing = 1e-2 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  let t = 0;
  for (let i = 0; i < SWEEP_ITERATIONS; i++) {
    SEG[0] = seg0[0] + dx * t;
    SEG[1] = seg0[1] + dy * t;
    SEG[2] = seg0[2] + dz * t;
    SEG[3] = seg0[3] + dx * t;
    SEG[4] = seg0[4] + dy * t;
    SEG[5] = seg0[5] + dz * t;
    closestSegTri(sS, sT);
    const dist = Math.sqrt(R[0]) - r;
    hitFromClosest();
    // Closing speed along the separation direction; moving away or sideways never touches.
    const closing = -(dx * H[H_NX] + dy * H[H_NY] + dz * H[H_NZ]);
    if (dist <= SWEEP_TOL) {
      if (i === 0 && dist < -SWEEP_TOL) {
        // Started overlapping: report the penetration, no motion.
        H[H_T] = 0;
        H[H_DEPTH] = -dist;
        return true;
      }
      // Touching: only a contact when the motion goes into the surface.
      if (closing <= minClosing) return false;
      H[H_T] = t;
      H[H_DEPTH] = 0;
      return true;
    }
    if (closing <= minClosing) return false;
    t += dist / closing;
    if (t >= tMax) return false;
  }
  // Out of iterations while still closing: take the conservative time reached.
  H[H_T] = t;
  H[H_DEPTH] = 0;
  return true;
}

/** Separating-axis state for the swept box: entry, exit, normal xyz. */
const SAT = new Float64Array(5);
const SAT_ENTRY = 0;
const SAT_EXIT = 1;

/** One axis (`BX[12..14]`) of the swept separating-axis test; false once the box can never meet the triangle. */
function sweptAxis(): boolean {
  const x = BX[12];
  const y = BX[13];
  const z = BX[14];
  const len2 = x * x + y * y + z * z;
  if (len2 < 1e-18) return true;
  const p0 = BX[3] * x + BX[4] * y + BX[5] * z;
  const p1 = BX[6] * x + BX[7] * y + BX[8] * z;
  const p2 = BX[9] * x + BX[10] * y + BX[11] * z;
  const r = BX[0] * Math.abs(x) + BX[1] * Math.abs(y) + BX[2] * Math.abs(z);
  const lo = Math.min(p0, Math.min(p1, p2));
  const hi = Math.max(p0, Math.max(p1, p2));
  const v = SW[0] * x + SW[1] * y + SW[2] * z;
  if (Math.abs(v) < 1e-18) {
    return lo < r && hi > -r;
  }
  // The box spans [-r, r] + v t; it overlaps (lo, hi) for t between these two.
  let tEnter = (lo - r) / v;
  let tLeave = (hi + r) / v;
  let sign = -1; // the box's leading face is +axis when v > 0: the normal points -axis
  if (tEnter > tLeave) {
    const tmp = tEnter;
    tEnter = tLeave;
    tLeave = tmp;
    sign = 1;
  }
  if (tEnter > SAT[SAT_ENTRY]) {
    SAT[SAT_ENTRY] = tEnter;
    const len = Math.sqrt(len2);
    SAT[2] = (sign * x) / len;
    SAT[3] = (sign * y) / len;
    SAT[4] = (sign * z) / len;
  }
  if (tLeave < SAT[SAT_EXIT]) SAT[SAT_EXIT] = tLeave;
  return SAT[SAT_ENTRY] <= SAT[SAT_EXIT];
}

/** Swept separating-axis test of the box in `SH` along `SW[0..2]` against `TRI`. */
function sweepBoxTri(): boolean {
  loadBox();
  SAT[SAT_ENTRY] = Number.NEGATIVE_INFINITY;
  SAT[SAT_EXIT] = Number.POSITIVE_INFINITY;
  SAT[2] = 0;
  SAT[3] = 0;
  SAT[4] = 0;
  for (let i = 0; i < 13; i++) {
    boxAxis(i);
    if (!sweptAxis()) return false;
  }
  const entry = SAT[SAT_ENTRY];
  if (SAT[SAT_EXIT] < 0 || entry >= SW[SW_TMAX]) return false;
  if (entry <= 0) {
    // Already overlapping (or touching): report the penetration at t = 0.
    if (!aabbTri(sweepContact)) return false;
    H[H_T] = 0;
    H[H_DEPTH] = sweepContact.depth;
    H[H_NX] = sweepContact.nx;
    H[H_NY] = sweepContact.ny;
    H[H_NZ] = sweepContact.nz;
    H[H_PX] = sweepContact.px;
    H[H_PY] = sweepContact.py;
    H[H_PZ] = sweepContact.pz;
    return true;
  }
  H[H_T] = entry;
  H[H_DEPTH] = 0;
  H[H_NX] = SAT[2];
  H[H_NY] = SAT[3];
  H[H_NZ] = SAT[4];
  // `PT` holds the box centre from `loadBox`; move it to the time of impact.
  PT[0] += SW[0] * entry;
  PT[1] += SW[1] * entry;
  PT[2] += SW[2] * entry;
  closestPointTri(sT);
  H[H_PX] = sT[0];
  H[H_PY] = sT[1];
  H[H_PZ] = sT[2];
  return true;
}

/** Sweeps the shape in `SH` along `SW` against triangle `o / 9` of `tris`. */
function sweepTri(tris: Float32Array, o: number): boolean {
  loadTriAt(tris, o);
  if (SH[0] === SH_BOX) return sweepBoxTri();
  const h = SH[4];
  seg0[0] = seg0[3] = SH[1];
  seg0[1] = SH[2] - h;
  seg0[4] = SH[2] + h;
  seg0[2] = seg0[5] = SH[3];
  SW[SW_R] = SH[5];
  return sweepSegTri();
}

const sMin = new Float64Array(3);
const sMax = new Float64Array(3);

/** The box swept by the shape's bounds over `[0, SW[4]]` of the displacement, into `qMin`/`qMax`. */
function sweptBounds(): void {
  const t = SW[SW_TMAX];
  for (let k = 0; k < 3; k++) {
    qMin[k] = Math.min(sMin[k], sMin[k] + SW[k] * t);
    qMax[k] = Math.max(sMax[k], sMax[k] + SW[k] * t);
  }
}

/**
 * `sweep` of the shape in `SH` with the displacement read from `SW[0..2]`: the allocation-free
 * entry `slide` uses.
 */
export function sweepMove(c: StaticCollider, out: SweepHit, layerMask = ALL_LAYERS): boolean {
  shapeBoundsReg(sMin, sMax);
  // Pad by the tolerance so a shape resting a hair off a face still finds it.
  for (let k = 0; k < 3; k++) {
    sMin[k] -= SWEEP_TOL * 4;
    sMax[k] += SWEEP_TOL * 4;
  }
  ensureStack(c);
  SW[SW_TMAX] = 1;
  let bestTri = -1;
  let found = false;
  sweptBounds();
  let sp = 0;
  stack[sp++] = c.root;
  const tris = c.tris;
  while (sp > 0) {
    const n = stack[--sp]!;
    if (!nodeOverlapsBox(c, n)) continue;
    if (c.nodeLeaf[n]) {
      const t0 = c.nodeA[n]!;
      const t1 = t0 + c.nodeB[n]!;
      for (let t = t0; t < t1; t++) {
        if (layerMask !== ALL_LAYERS && !layerOk(c, t, layerMask)) continue;
        if (!sweepTri(tris, t * 9)) continue;
        const ht = H[H_T];
        const best = SW[SW_TMAX];
        // Among initial overlaps the deepest wins; otherwise the earliest.
        if (!found || ht < best || (ht === 0 && best === 0 && H[H_DEPTH] > out.depth)) {
          found = true;
          bestTri = t;
          SW[SW_TMAX] = ht;
          out.t = ht;
          out.depth = H[H_DEPTH];
          out.x = H[H_PX];
          out.y = H[H_PY];
          out.z = H[H_PZ];
          out.nx = H[H_NX];
          out.ny = H[H_NY];
          out.nz = H[H_NZ];
          sweptBounds();
        }
      }
    } else {
      stack[sp++] = c.nodeA[n]!;
      stack[sp++] = c.nodeB[n]!;
    }
  }
  if (!found) return false;
  out.triangle = bestTri;
  const src = c.triSource[bestTri]!;
  out.source = src;
  out.userData = c.sources[src]!.userData;
  return true;
}

/**
 * Moves `shape` by `(dx, dy, dz)` and finds the first triangle it touches: true and `out` filled
 * with the time of impact `t` in 0..1, the triangle point and the normal into the shape; false
 * when the whole displacement is free. A shape already overlapping reports `t` 0 and `depth`.
 */
export function sweep(
  c: StaticCollider,
  shape: Shape,
  dx: number,
  dy: number,
  dz: number,
  out: SweepHit,
  layerMask = ALL_LAYERS,
): boolean {
  loadShape(shape);
  SW[0] = dx;
  SW[1] = dy;
  SW[2] = dz;
  return sweepMove(c, out, layerMask);
}

// ------------------------------------------------------------------ 2D

/**
 * The 2D shape into `SH` as a 3D one spanning the collider's height, a hair inside its y range:
 * a circle becomes a capsule (a sphere when the collider is flatter than its diameter), a 2D box
 * a box.
 */
export function liftShape(c: StaticCollider, s: Shape2): void {
  const y0 = c.bounds.min[1] === Number.POSITIVE_INFINITY ? 0 : c.bounds.min[1] + EPS_2D;
  const y1 = c.bounds.max[1] === Number.NEGATIVE_INFINITY ? 0 : c.bounds.max[1] - EPS_2D;
  if (isBox2(s)) {
    SH[0] = SH_BOX;
    SH[1] = s.x - s.hw;
    SH[2] = Math.min(y0, y1);
    SH[3] = s.z - s.hh;
    SH[4] = s.x + s.hw;
    SH[5] = Math.max(y0, y1);
    SH[6] = s.z + s.hh;
    return;
  }
  const half = (y1 - y0) / 2 - s.r;
  SH[0] = half <= 0 ? SH_SPHERE : SH_CAPSULE;
  SH[1] = s.x;
  SH[2] = (y0 + y1) / 2;
  SH[3] = s.z;
  SH[4] = Math.max(0, half);
  SH[5] = s.r;
}

const origin2 = new Float64Array(3);
const dir2 = new Float64Array(3);

/** `raycast` in the xz plane at the collider's mid height; `t` is the distance in xz. */
export function raycast2(
  c: StaticCollider,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
  out: Hit,
  layerMask = ALL_LAYERS,
): boolean {
  origin2[0] = ox;
  origin2[1] = (c.bounds.min[1] + c.bounds.max[1]) / 2;
  origin2[2] = oz;
  dir2[0] = dx;
  dir2[1] = 0;
  dir2[2] = dz;
  return raycast(c, origin2, dir2, maxDist, out, layerMask);
}

/** `overlap` for a circle or 2D box; contact normals lie in xz. */
export function overlap2(
  c: StaticCollider,
  shape: Shape2,
  out: Contact[],
  maxContacts = out.length,
  layerMask = ALL_LAYERS,
): number {
  liftShape(c, shape);
  return overlapReg(c, out, maxContacts, layerMask);
}

/** `sweep` for a circle or 2D box moving by `(dx, dz)`. */
export function sweep2(
  c: StaticCollider,
  shape: Shape2,
  dx: number,
  dz: number,
  out: SweepHit,
  layerMask = ALL_LAYERS,
): boolean {
  liftShape(c, shape);
  SW[0] = dx;
  SW[1] = 0;
  SW[2] = dz;
  return sweepMove(c, out, layerMask);
}
