/**
 * Collision shapes and the shape-vs-triangle tests the queries are built on. Every function is
 * pure arithmetic over plain numbers: a triangle is its nine coordinates (so the collider's flat
 * triangle array is read in place), the result goes into an `out` the caller owns, nothing here
 * allocates.
 */

/** A sphere: centre and radius. */
export interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/**
 * A capsule along the y axis: centre, half the length of the inner segment (the distance from
 * the centre to each hemisphere's centre) and the radius. Its total height is `2 × (halfHeight + r)`.
 */
export interface Capsule {
  x: number;
  y: number;
  z: number;
  halfHeight: number;
  r: number;
}

/** An axis-aligned box: `min` and `max` corners (`[x, y, z]`). */
export interface GeomAabb {
  min: [number, number, number];
  max: [number, number, number];
}

/** @deprecated (ws/api-rest, E-036) Use `GeomAabb`. Removed next minor. */
export type Aabb = GeomAabb;

/** A circle in the xz plane (the 2D case). */
export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** An axis-aligned rectangle in the xz plane: centre and half extents. */
export interface Box2 {
  x: number;
  z: number;
  hw: number;
  hh: number;
}

/** Any 3D shape the queries take. */
export type Shape = Sphere | Capsule | GeomAabb;
/** Any 2D shape the `*2` queries take. */
export type Shape2 = Circle | Box2;

/** A 3-vector written in place. */
export type Vec3Out = [number, number, number] | Float32Array | Float64Array;

/**
 * A touching or penetrating shape and triangle: `depth` is how far along the unit normal
 * (`nx, ny, nz`, pointing from the triangle into the shape) the shape must move to separate;
 * `px, py, pz` is the point on the triangle. `triangle` and `source` index the collider that
 * produced it (-1 from the bare shape tests).
 */
export interface Contact {
  depth: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
  triangle: number;
  source: number;
}

/** A zeroed `Contact`, for the caller's preallocated arrays. */
export function createContact(): Contact {
  return { depth: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, triangle: -1, source: -1 };
}

// `in`, not a field read: loading the double just to test it boxes it at a polymorphic site.
export function isCapsule(s: Shape): s is Capsule {
  return 'halfHeight' in s;
}

export function isAabb(s: Shape): s is GeomAabb {
  return 'min' in s;
}

export function isBox2(s: Shape2): s is Box2 {
  return 'hw' in s;
}

// ------------------------------------------------------------------ registers
//
// V8 boxes every non-integer number that crosses a call it did not inline (arguments and return
// values become heap numbers), so the hot internal paths pass doubles through these shared typed
// arrays instead and return booleans. The public functions load them from plain-number
// parameters; the queries write them directly.

/** The current triangle: a, b, c as nine coordinates. */
export const TRI = new Float64Array(9);
/** A point (0..2) or segment (0..2, 3..5). */
export const SEG = new Float64Array(6);
/** A second segment. */
const SEG2 = new Float64Array(6);
/** Scalars: `R[0]` the squared distance of the last closest-point query; the rest internal. */
export const R = new Float64Array(4);
/** The query point of `closestPointTri`; also the box centre of the box tests. */
export const PT = new Float64Array(3);
/** Box state: half extents (0..2), triangle vertices relative to the box centre (3..11), axis (12..14). */
export const BX = new Float64Array(15);
/**
 * The query shape: kind (0), then for a sphere or capsule its centre (1..3), half height (4, 0
 * for a sphere) and radius (5); for a box its min (1..3) and max (4..6). Queries read the shape
 * from here, never from the caller's object: field loads from objects of varying layout box
 * their doubles.
 */
export const SH = new Float64Array(7);
export const SH_SPHERE = 0;
export const SH_CAPSULE = 1;
export const SH_BOX = 2;

function loadSphere(s: Sphere): void {
  SH[0] = SH_SPHERE;
  SH[1] = s.x;
  SH[2] = s.y;
  SH[3] = s.z;
  SH[4] = 0;
  SH[5] = s.r;
}

function loadCapsule(s: Capsule): void {
  SH[0] = SH_CAPSULE;
  SH[1] = s.x;
  SH[2] = s.y;
  SH[3] = s.z;
  SH[4] = s.halfHeight;
  SH[5] = s.r;
}

function loadAabb(s: GeomAabb): void {
  SH[0] = SH_BOX;
  SH[1] = s.min[0];
  SH[2] = s.min[1];
  SH[3] = s.min[2];
  SH[4] = s.max[0];
  SH[5] = s.max[1];
  SH[6] = s.max[2];
}

/** Loads `s` into `SH`. */
export function loadShape(s: Shape): void {
  if (isAabb(s)) loadAabb(s);
  else if (isCapsule(s)) loadCapsule(s);
  else loadSphere(s);
}

/** Loads `TRI`. */
export function loadTri(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  TRI[0] = ax;
  TRI[1] = ay;
  TRI[2] = az;
  TRI[3] = bx;
  TRI[4] = by;
  TRI[5] = bz;
  TRI[6] = cx;
  TRI[7] = cy;
  TRI[8] = cz;
}

// ------------------------------------------------------------------ point / triangle

/**
 * The point of triangle `TRI` closest to `PT` (Ericson, Real-Time Collision Detection 5.1.5): the
 * Voronoi region of the point decides between a vertex, an edge and the face. Writes `out`.
 */
export function closestPointTri(out: Vec3Out): void {
  const px = PT[0];
  const py = PT[1];
  const pz = PT[2];
  const ax = TRI[0];
  const ay = TRI[1];
  const az = TRI[2];
  const bx = TRI[3];
  const by = TRI[4];
  const bz = TRI[5];
  const cx = TRI[6];
  const cy = TRI[7];
  const cz = TRI[8];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return;
  }
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + v * abx;
    out[1] = ay + v * aby;
    out[2] = az + v * abz;
    return;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + w * acx;
    out[1] = ay + w * acy;
    out[2] = az + w * acz;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + w * (cx - bx);
    out[1] = by + w * (cy - by);
    out[2] = bz + w * (cz - bz);
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

/** The point of triangle `a, b, c` closest to `p`, into `out`; returns `out`. */
export function closestPointTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Vec3Out,
): Vec3Out {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  PT[0] = px;
  PT[1] = py;
  PT[2] = pz;
  closestPointTri(out);
  return out;
}

/** The unit normal of `TRI` (counter-clockwise front) into `out`; zero if degenerate. */
export function triNormal(out: Vec3Out): void {
  const ax = TRI[0];
  const ay = TRI[1];
  const az = TRI[2];
  const abx = TRI[3] - ax;
  const aby = TRI[4] - ay;
  const abz = TRI[5] - az;
  const acx = TRI[6] - ax;
  const acy = TRI[7] - ay;
  const acz = TRI[8] - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-20) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
}

/** The unit normal of triangle `a, b, c` (counter-clockwise front) into `out`; zero if degenerate. */
export function triangleNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Vec3Out,
): Vec3Out {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  triNormal(out);
  return out;
}

// ------------------------------------------------------------------ segments

/**
 * The closest points between segments `SEG` and `SEG2` (Ericson 5.1.9): the point on the first
 * into `outP`, on the second into `outQ`, the squared distance into `R[0]`.
 */
function closestSegSeg(outP: Vec3Out, outQ: Vec3Out): void {
  const p0x = SEG[0];
  const p0y = SEG[1];
  const p0z = SEG[2];
  const q0x = SEG2[0];
  const q0y = SEG2[1];
  const q0z = SEG2[2];
  const d1x = SEG[3] - p0x;
  const d1y = SEG[4] - p0y;
  const d1z = SEG[5] - p0z;
  const d2x = SEG2[3] - q0x;
  const d2y = SEG2[4] - q0y;
  const d2z = SEG2[5] - q0z;
  const rx = p0x - q0x;
  const ry = p0y - q0y;
  const rz = p0z - q0z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number;
  let t: number;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const px = p0x + d1x * s;
  const py = p0y + d1y * s;
  const pz = p0z + d1z * s;
  const qx = q0x + d2x * t;
  const qy = q0y + d2y * t;
  const qz = q0z + d2z * t;
  outP[0] = px;
  outP[1] = py;
  outP[2] = pz;
  outQ[0] = qx;
  outQ[1] = qy;
  outQ[2] = qz;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  R[0] = dx * dx + dy * dy + dz * dz;
}

/**
 * The closest points between segment `p0 p1` and segment `q0 q1`: writes the point on the first
 * into `outP` and on the second into `outQ`, returns the squared distance.
 */
export function closestSegmentSegment(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  q0x: number,
  q0y: number,
  q0z: number,
  q1x: number,
  q1y: number,
  q1z: number,
  outP: Vec3Out,
  outQ: Vec3Out,
): number {
  SEG[0] = p0x;
  SEG[1] = p0y;
  SEG[2] = p0z;
  SEG[3] = p1x;
  SEG[4] = p1y;
  SEG[5] = p1z;
  SEG2[0] = q0x;
  SEG2[1] = q0y;
  SEG2[2] = q0z;
  SEG2[3] = q1x;
  SEG2[4] = q1y;
  SEG2[5] = q1z;
  closestSegSeg(outP, outQ);
  return R[0];
}

const scratchP = new Float64Array(3);
const scratchQ = new Float64Array(3);
const scratchN = new Float64Array(3);
const segP = new Float64Array(3);
const segQ = new Float64Array(3);
const capS = new Float64Array(3);

/** Loads triangle edge `i` (0: ab, 1: bc, 2: ca) of `TRI` into `SEG2`. */
function edgeToSeg2(i: number): void {
  const o0 = i * 3;
  const o1 = ((i + 1) % 3) * 3;
  SEG2[0] = TRI[o0];
  SEG2[1] = TRI[o0 + 1];
  SEG2[2] = TRI[o0 + 2];
  SEG2[3] = TRI[o1];
  SEG2[4] = TRI[o1 + 1];
  SEG2[5] = TRI[o1 + 2];
}

/** Takes the candidate pair `s`, `t` when its squared distance `R[0]` beats the best so far, `R[1]`. */
function takeBest(s: Float64Array, t: Float64Array, outS: Vec3Out, outT: Vec3Out): void {
  if (R[0] < R[1]) {
    R[1] = R[0];
    outS[0] = s[0];
    outS[1] = s[1];
    outS[2] = s[2];
    outT[0] = t[0];
    outT[1] = t[1];
    outT[2] = t[2];
  }
}

/** `R[0]` = the squared distance from `PT` to `scratchQ`. */
function pointDist2(): void {
  const dx = PT[0] - scratchQ[0];
  const dy = PT[1] - scratchQ[1];
  const dz = PT[2] - scratchQ[2];
  R[0] = dx * dx + dy * dy + dz * dz;
}

/**
 * The closest points between segment `SEG` and triangle `TRI`: the point on the segment into
 * `outS`, the point on the triangle into `outT`, the squared distance into `R[0]` (0 when the
 * segment crosses the face). Candidates: each endpoint against the face, the segment against
 * each edge, and the face crossing. Clobbers `SEG2`, `PT` and `R[1]`.
 */
export function closestSegTri(outS: Vec3Out, outT: Vec3Out): void {
  const p0x = SEG[0];
  const p0y = SEG[1];
  const p0z = SEG[2];
  const p1x = SEG[3];
  const p1y = SEG[4];
  const p1z = SEG[5];
  const ax = TRI[0];
  const ay = TRI[1];
  const az = TRI[2];
  // Does the segment cross the face? Then the distance is zero at the crossing.
  triNormal(scratchN);
  const nx = scratchN[0];
  const ny = scratchN[1];
  const nz = scratchN[2];
  const s0 = (p0x - ax) * nx + (p0y - ay) * ny + (p0z - az) * nz;
  const s1 = (p1x - ax) * nx + (p1y - ay) * ny + (p1z - az) * nz;
  if ((nx !== 0 || ny !== 0 || nz !== 0) && s0 * s1 <= 0 && s0 !== s1) {
    const u = s0 / (s0 - s1);
    PT[0] = p0x + (p1x - p0x) * u;
    PT[1] = p0y + (p1y - p0y) * u;
    PT[2] = p0z + (p1z - p0z) * u;
    closestPointTri(scratchQ);
    pointDist2();
    if (R[0] < 1e-18) {
      outS[0] = outT[0] = PT[0];
      outS[1] = outT[1] = PT[1];
      outS[2] = outT[2] = PT[2];
      R[0] = 0;
      return;
    }
  }
  R[1] = Number.POSITIVE_INFINITY;
  // Endpoints against the face.
  PT[0] = p0x;
  PT[1] = p0y;
  PT[2] = p0z;
  closestPointTri(scratchQ);
  pointDist2();
  takeBest(PT, scratchQ, outS, outT);
  PT[0] = p1x;
  PT[1] = p1y;
  PT[2] = p1z;
  closestPointTri(scratchQ);
  pointDist2();
  takeBest(PT, scratchQ, outS, outT);
  // The segment against each edge.
  for (let e = 0; e < 3; e++) {
    edgeToSeg2(e);
    closestSegSeg(segP, segQ);
    takeBest(segP, segQ, outS, outT);
  }
  R[0] = R[1];
}

/**
 * The closest points between segment `p0 p1` and triangle `a b c`: the point on the segment
 * into `outS`, the point on the triangle into `outT`; returns the squared distance (0 when the
 * segment crosses the face).
 */
export function closestSegmentTriangle(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  outS: Vec3Out,
  outT: Vec3Out,
): number {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  SEG[0] = p0x;
  SEG[1] = p0y;
  SEG[2] = p0z;
  SEG[3] = p1x;
  SEG[4] = p1y;
  SEG[5] = p1z;
  closestSegTri(outS, outT);
  return R[0];
}

// ------------------------------------------------------------------ shape / triangle

/**
 * Fills `out` for a sphere centred at `PT` with radius `R[2]` whose closest triangle point is
 * `scratchP`. When the centre lies on the triangle the normal is the face normal. Returns true
 * for a contact (touching is none).
 */
function contactFromClosest(out: Contact): boolean {
  const r = R[2];
  const dx = PT[0] - scratchP[0];
  const dy = PT[1] - scratchP[1];
  const dz = PT[2] - scratchP[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-9) {
    out.nx = dx / d;
    out.ny = dy / d;
    out.nz = dz / d;
  } else {
    triNormal(scratchN);
    out.nx = scratchN[0];
    out.ny = scratchN[1];
    out.nz = scratchN[2];
  }
  out.depth = r - d;
  out.px = scratchP[0];
  out.py = scratchP[1];
  out.pz = scratchP[2];
  out.triangle = -1;
  out.source = -1;
  return true;
}

/** The sphere in `SH` against `TRI`. */
export function sphereTri(out: Contact): boolean {
  PT[0] = SH[1];
  PT[1] = SH[2];
  PT[2] = SH[3];
  R[2] = SH[5];
  closestPointTri(scratchP);
  return contactFromClosest(out);
}

/** Sphere against a triangle: true and `out` filled when they overlap (touching is no contact). */
export function sphereTriangle(
  s: Sphere,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Contact,
): boolean {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  loadSphere(s);
  return sphereTri(out);
}

/** The capsule (y axis) in `SH` against `TRI`. */
export function capsuleTri(out: Contact): boolean {
  const h = SH[4];
  const r = SH[5];
  SEG[0] = SH[1];
  SEG[1] = SH[2] - h;
  SEG[2] = SH[3];
  SEG[3] = SH[1];
  SEG[4] = SH[2] + h;
  SEG[5] = SH[3];
  // Not straight into `PT`: `closestSegTri` uses `PT` as scratch while it runs.
  closestSegTri(capS, scratchP);
  if (R[0] >= r * r) return false;
  PT[0] = capS[0];
  PT[1] = capS[1];
  PT[2] = capS[2];
  R[2] = r;
  return contactFromClosest(out);
}

/**
 * Capsule (y axis) against a triangle: the closest points between the inner segment and the
 * triangle, then the sphere test there. True and `out` filled when they overlap.
 */
export function capsuleTriangle(
  cap: Capsule,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Contact,
): boolean {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  loadCapsule(cap);
  return capsuleTri(out);
}

/** Separating-axis state: depth, normal x y z. */
const sat = new Float64Array(4);

/**
 * Loads the box in `SH` for the separating-axis tests: half extents into `BX[0..2]`, the
 * vertices of `TRI` relative to the box centre into `BX[3..11]`, the centre into `PT`.
 */
export function loadBox(): void {
  const ccx = (SH[1] + SH[4]) * 0.5;
  const ccy = (SH[2] + SH[5]) * 0.5;
  const ccz = (SH[3] + SH[6]) * 0.5;
  PT[0] = ccx;
  PT[1] = ccy;
  PT[2] = ccz;
  BX[0] = (SH[4] - SH[1]) * 0.5;
  BX[1] = (SH[5] - SH[2]) * 0.5;
  BX[2] = (SH[6] - SH[3]) * 0.5;
  for (let v = 0; v < 9; v += 3) {
    BX[3 + v] = TRI[v] - ccx;
    BX[4 + v] = TRI[v + 1] - ccy;
    BX[5 + v] = TRI[v + 2] - ccz;
  }
}

/**
 * Sets `BX[12..14]` to axis `i` of the thirteen box–triangle separating axes: the box axes
 * (0..2), the face normal (3), each edge crossed with each box axis (4..12).
 */
export function boxAxis(i: number): void {
  if (i < 3) {
    BX[12] = i === 0 ? 1 : 0;
    BX[13] = i === 1 ? 1 : 0;
    BX[14] = i === 2 ? 1 : 0;
    return;
  }
  if (i === 3) {
    const e0x = BX[6] - BX[3];
    const e0y = BX[7] - BX[4];
    const e0z = BX[8] - BX[5];
    const e1x = BX[9] - BX[6];
    const e1y = BX[10] - BX[7];
    const e1z = BX[11] - BX[8];
    BX[12] = e0y * e1z - e0z * e1y;
    BX[13] = e0z * e1x - e0x * e1z;
    BX[14] = e0x * e1y - e0y * e1x;
    return;
  }
  // Edge `e` (0: ab, 1: bc, 2: ca) crossed with box axis `k`.
  const k = ((i - 4) / 3) | 0;
  const e = (i - 4) % 3;
  const o0 = 3 + e * 3;
  const o1 = 3 + ((e + 1) % 3) * 3;
  const ex = BX[o1] - BX[o0];
  const ey = BX[o1 + 1] - BX[o0 + 1];
  const ez = BX[o1 + 2] - BX[o0 + 2];
  if (k === 0) {
    BX[12] = 0;
    BX[13] = -ez;
    BX[14] = ey;
  } else if (k === 1) {
    BX[12] = ez;
    BX[13] = 0;
    BX[14] = -ex;
  } else {
    BX[12] = -ey;
    BX[13] = ex;
    BX[14] = 0;
  }
}

/**
 * Tests the axis `BX[12..14]` for the loaded box against the loaded triangle. Returns false when
 * the axis separates; otherwise records the axis with the smallest overlap, oriented from the
 * triangle toward the box, in `sat`.
 */
function satAxis(): boolean {
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
  if (lo >= r || hi <= -r) return false;
  // Overlap along this axis: the box spans [-r, r], the triangle [lo, hi].
  const len = Math.sqrt(len2);
  const pushPos = (hi + r) / len; // move the box toward +axis by this to separate
  const pushNeg = (r - lo) / len; // move the box toward -axis by this to separate
  if (pushPos < pushNeg) {
    if (pushPos < sat[0]) {
      sat[0] = pushPos;
      sat[1] = x / len;
      sat[2] = y / len;
      sat[3] = z / len;
    }
  } else if (pushNeg < sat[0]) {
    sat[0] = pushNeg;
    sat[1] = -x / len;
    sat[2] = -y / len;
    sat[3] = -z / len;
  }
  return true;
}

/** The box in `SH` against `TRI` by the separating-axis test; see `aabbTriangle`. */
export function aabbTri(out: Contact): boolean {
  loadBox();
  sat[0] = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 13; i++) {
    boxAxis(i);
    if (!satAxis()) return false;
  }
  if (!Number.isFinite(sat[0])) return false;
  out.depth = sat[0];
  out.nx = sat[1];
  out.ny = sat[2];
  out.nz = sat[3];
  closestPointTri(scratchP);
  out.px = scratchP[0];
  out.py = scratchP[1];
  out.pz = scratchP[2];
  out.triangle = -1;
  out.source = -1;
  return true;
}

/**
 * Axis-aligned box against a triangle by the separating-axis test (Akenine-Möller: the three
 * box axes, the face normal, the nine edge cross products). True and `out` filled when they
 * overlap: the normal is the axis of least penetration pointing from the triangle into the box,
 * `depth` the overlap along it, the point the triangle point closest to the box centre.
 */
export function aabbTriangle(
  box: GeomAabb,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Contact,
): boolean {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  loadAabb(box);
  return aabbTri(out);
}

/** The world AABB of the shape in `SH` into `min` and `max`. */
export function shapeBoundsReg(min: Vec3Out, max: Vec3Out): void {
  if (SH[0] === SH_BOX) {
    min[0] = SH[1];
    min[1] = SH[2];
    min[2] = SH[3];
    max[0] = SH[4];
    max[1] = SH[5];
    max[2] = SH[6];
  } else {
    const h = SH[4];
    const r = SH[5];
    min[0] = SH[1] - r;
    min[1] = SH[2] - h - r;
    min[2] = SH[3] - r;
    max[0] = SH[1] + r;
    max[1] = SH[2] + h + r;
    max[2] = SH[3] + r;
  }
}

/** The world AABB of a shape into `min` and `max`. */
export function shapeBounds(s: Shape, min: Vec3Out, max: Vec3Out): void {
  loadShape(s);
  shapeBoundsReg(min, max);
}

/** The shape in `SH` against `TRI`, dispatching on its kind. */
export function shapeTri(out: Contact): boolean {
  const kind = SH[0];
  if (kind === SH_BOX) return aabbTri(out);
  if (kind === SH_CAPSULE) return capsuleTri(out);
  return sphereTri(out);
}

/** Shape against one triangle, dispatching on the shape kind. */
export function shapeTriangle(
  s: Shape,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Contact,
): boolean {
  loadTri(ax, ay, az, bx, by, bz, cx, cy, cz);
  loadShape(s);
  return shapeTri(out);
}
