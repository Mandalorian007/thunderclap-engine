/**
 * Rays and hit testing for the pointer router (`pointer-router.ts`). Plain math, no DOM, no
 * game nouns: a `HitTester` turns a world-space `Ray` into the nearest `RayHit` it knows, and the
 * game decides what `target` means.
 */
import type { Camera } from '../render/camera';
import type { MeshBounds } from '../render/mesh';
import type { Transform } from '../render/transform';

/** A 3-vector, mutable and reused (`[x, y, z]`). */
export type Vec3 = [number, number, number];

/** A world-space ray. `dir` is unit length. Reuse one per pointer; nothing here allocates. */
export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

/**
 * The nearest thing a ray met. `distance` is along `ray.dir` from `ray.origin` (world units).
 * `normal` faces the ray (unit), or `null` when the tester has none (the ray started inside).
 * Hits the router hands out are reused: read them in the listener or copy them.
 */
export interface RayHit<T = unknown> {
  readonly point: Vec3;
  normal: Vec3 | null;
  distance: number;
  /** What was hit, as the game named it (a box's `target`, a plane's `target`). */
  target: T;
}

/**
 * @deprecated (ws/api-core, E-036) Use `RayHit`: `geom` exports a different `Hit`. Removed next
 * minor.
 */
export type Hit<T = unknown> = RayHit<T>;

/**
 * Returns the nearest hit of `ray` against what this tester knows, or `null`. It may return the
 * same object on every call (the router copies it before calling again).
 */
export type HitTester<T = unknown> = (ray: Ray) => RayHit<T> | null;

/** The camera slice the router needs: `screen` and the inverse projection (`render`'s `Camera`). */
export type RayCamera = Pick<Camera, 'screen' | 'screenToWorld'>;

export function createRay(): Ray {
  return { origin: [0, 0, 0], dir: [0, 0, 1] };
}

export function createHit<T = unknown>(target: T): RayHit<T> {
  return { point: [0, 0, 0], normal: null, distance: 0, target };
}

/** `out = ray.origin + t * ray.dir`. */
export function rayAt(ray: Ray, t: number, out: Vec3): Vec3 {
  out[0] = ray.origin[0] + ray.dir[0] * t;
  out[1] = ray.origin[1] + ray.dir[1] * t;
  out[2] = ray.origin[2] + ray.dir[2] * t;
  return out;
}

const near = { x: 0, y: 0, z: 0 };
const far = { x: 0, y: 0, z: 0 };

/**
 * The ray through screen point (`sx`, `sy`) (the camera's screen units): from the near plane
 * (`screenToWorld(…, 0)`) towards the far one (`…, 1`; depth 0.5 when the far plane is at
 * infinity). For `Camera.ortho2d` the origin is the world point on the near plane
 * (z = -ORTHO2D_HALF_DEPTH) and `dir` is +z, into the screen.
 * Returns false (and leaves `out` alone) when the camera gives no usable ray.
 */
export function screenRay(camera: RayCamera, sx: number, sy: number, out: Ray): boolean {
  camera.screenToWorld(sx, sy, 0, near);
  camera.screenToWorld(sx, sy, 1, far);
  if (!Number.isFinite(far.x) || !Number.isFinite(far.y) || !Number.isFinite(far.z)) {
    camera.screenToWorld(sx, sy, 0.5, far);
  }
  const dx = far.x - near.x;
  const dy = far.y - near.y;
  const dz = far.z - near.z;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0) || !Number.isFinite(len) || !Number.isFinite(near.x + near.y + near.z)) {
    return false;
  }
  const o = out.origin;
  const d = out.dir;
  o[0] = near.x;
  o[1] = near.y;
  o[2] = near.z;
  d[0] = dx / len;
  d[1] = dy / len;
  d[2] = dz / len;
  return true;
}

const EPS = 1e-9;

/**
 * Any plane for `planeTester` (ws/api-core): the points `p` with `dot(normal, p) = offset`.
 * `normal` need not be unit length; it must not be zero. Read on every call, so the game may
 * move the plane in place. `{ normal: [0, 0, 1], offset: z }` is the plane z = `z`.
 */
export interface RayPlane {
  normal: readonly [number, number, number];
  /** Default 0 (the plane through the origin). */
  offset?: number;
}

/**
 * Hits a plane: the plane z = `plane` when it is a number (a 2D game's world, default 0), or
 * any `RayPlane` (a floor at y = 0 is `{ normal: [0, 1, 0] }`). The hit point is where the ray
 * crosses it, so through `Camera.ortho2d` the z-plane hit is the world point under the pointer.
 * Rays parallel to the plane or pointing away from it miss. The hit's normal is the plane's,
 * unit length, turned to face the ray. `target` is what every hit carries (default `null`).
 */
export function planeTester<T = null>(
  plane: number | RayPlane = 0,
  target: T = null as T,
): HitTester<T> {
  const hit = createHit(target);
  const normal: Vec3 = [0, 0, 0];
  if (typeof plane === 'number') {
    const z = plane;
    return (ray) => {
      const dz = ray.dir[2];
      if (Math.abs(dz) < EPS) return null;
      const t = (z - ray.origin[2]) / dz;
      if (t < 0) return null;
      rayAt(ray, t, hit.point);
      hit.point[2] = z;
      normal[2] = dz > 0 ? -1 : 1;
      hit.normal = normal;
      hit.distance = t;
      hit.target = target;
      return hit;
    };
  }
  return (ray) => {
    const n = plane.normal;
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) return null;
    const nx = n[0] / len;
    const ny = n[1] / len;
    const nz = n[2] / len;
    const d = (plane.offset ?? 0) / len;
    const dn = ray.dir[0] * nx + ray.dir[1] * ny + ray.dir[2] * nz;
    if (Math.abs(dn) < EPS) return null;
    const t = (d - (ray.origin[0] * nx + ray.origin[1] * ny + ray.origin[2] * nz)) / dn;
    if (t < 0) return null;
    rayAt(ray, t, hit.point);
    const s = dn > 0 ? -1 : 1;
    normal[0] = nx * s;
    normal[1] = ny * s;
    normal[2] = nz * s;
    hit.normal = normal;
    hit.distance = t;
    hit.target = target;
    return hit;
  };
}

/** An axis-aligned box for `aabbTester`. `min` ≤ `max` per axis; a flat box (2D quad) is fine. */
export interface RayBox<T = unknown> {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  target: T;
}

/**
 * @deprecated (ws/api-core, E-036) Use `RayBox`: `geom` exports a different `Aabb`. Removed next
 * minor.
 */
export type Aabb<T = unknown> = RayBox<T>;

/**
 * Hits the nearest of `boxes` (read on every call, so the game may edit the array and its
 * boxes). A ray that starts inside a box hits it at distance 0 with no normal. Equal distances
 * go to the earlier box. Flat boxes (`min[i] === max[i]`) work, so 2D quads at z = 0 can be
 * picked through `Camera.ortho2d`.
 */
export function aabbTester<T = unknown>(boxes: readonly RayBox<T>[]): HitTester<T> {
  const hit = createHit<T>(undefined as T);
  const normal: Vec3 = [0, 0, 0];
  return (ray) => {
    let best = Infinity;
    let bestBox: RayBox<T> | null = null;
    let bestAxis = -1;
    let bestSign = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b]!;
      let tmin = -Infinity;
      let tmax = Infinity;
      let axis = -1;
      let sign = 0;
      let miss = false;
      for (let i = 0; i < 3; i++) {
        const o = ray.origin[i]!;
        const d = ray.dir[i]!;
        const lo = box.min[i]!;
        const hi = box.max[i]!;
        if (Math.abs(d) < EPS) {
          if (o < lo || o > hi) {
            miss = true;
            break;
          }
          continue;
        }
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        // Entering through the `lo` face means travelling +axis: the face normal is -axis.
        let s = -1;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = i;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) {
          miss = true;
          break;
        }
      }
      if (miss || tmax < 0) continue;
      const inside = tmin < 0;
      const t = inside ? 0 : tmin;
      if (t < best) {
        best = t;
        bestBox = box;
        bestAxis = inside ? -1 : axis;
        bestSign = sign;
      }
    }
    if (!bestBox) return null;
    rayAt(ray, best, hit.point);
    hit.distance = best;
    hit.target = bestBox.target;
    if (bestAxis < 0) {
      hit.normal = null;
    } else {
      normal[0] = 0;
      normal[1] = 0;
      normal[2] = 0;
      normal[bestAxis] = bestSign;
      hit.normal = normal;
    }
    return hit;
  };
}

// ---------------------------------------------------------------- transformed testers (ws/pick)

/**
 * The slice of `render`'s `Transform` a transformed tester reads: the 3×4 row-major world
 * matrix (12 floats, `[r0 | tx, r1 | ty, r2 | tz]`). Read on every call, so a moving object
 * picks correctly without re-registering its tester.
 */
export type RayTransform = Pick<Transform, 'world'>;

/** A bounding sphere in object space (`render`'s `MeshBounds`): `center` and `radius`. */
export type RayBounds = MeshBounds;

/** Floats per vertex and the position's float offset in `VERTEX_LAYOUT_3D` (x, y, z first). */
const DEFAULT_STRIDE = 12;
const DEFAULT_OFFSET = 0;

/**
 * Inverts the 3×3 part of a 3×4 world matrix into `out` (9 floats, row-major). Returns false
 * (leaving `out` alone) when the matrix is singular (a zero scale).
 */
function invert3x3(m: ArrayLike<number>, out: Float32Array): boolean {
  const a = m[0]!;
  const b = m[1]!;
  const c = m[2]!;
  const d = m[4]!;
  const e = m[5]!;
  const f = m[6]!;
  const g = m[8]!;
  const h = m[9]!;
  const i = m[10]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-20) || !Number.isFinite(det)) return false;
  const inv = 1 / det;
  out[0] = A * inv;
  out[1] = -(b * i - c * h) * inv;
  out[2] = (b * f - c * e) * inv;
  out[3] = B * inv;
  out[4] = (a * i - c * g) * inv;
  out[5] = -(a * f - c * d) * inv;
  out[6] = C * inv;
  out[7] = -(a * h - b * g) * inv;
  out[8] = (a * e - b * d) * inv;
  return true;
}

/**
 * `out` = `ray` in the object space of a 3×4 world matrix whose 3×3 inverse is `inv`, with
 * `out.dir` normalised. Returns the world units per object-space unit along the ray (an
 * object-space distance times it is the world distance), or 0 when the direction collapses.
 */
function localRay(ray: Ray, m: ArrayLike<number>, inv: Float32Array, out: Ray): number {
  const ox = ray.origin[0] - m[3]!;
  const oy = ray.origin[1] - m[7]!;
  const oz = ray.origin[2] - m[11]!;
  const o = out.origin;
  o[0] = inv[0]! * ox + inv[1]! * oy + inv[2]! * oz;
  o[1] = inv[3]! * ox + inv[4]! * oy + inv[5]! * oz;
  o[2] = inv[6]! * ox + inv[7]! * oy + inv[8]! * oz;
  const dx = ray.dir[0];
  const dy = ray.dir[1];
  const dz = ray.dir[2];
  const lx = inv[0]! * dx + inv[1]! * dy + inv[2]! * dz;
  const ly = inv[3]! * dx + inv[4]! * dy + inv[5]! * dz;
  const lz = inv[6]! * dx + inv[7]! * dy + inv[8]! * dz;
  const len = Math.hypot(lx, ly, lz);
  if (!(len > 0) || !Number.isFinite(len)) return 0;
  const d = out.dir;
  d[0] = lx / len;
  d[1] = ly / len;
  d[2] = lz / len;
  return 1 / len;
}

/**
 * Object-space normal `n` to a unit world normal through the inverse transpose of the 3×3 part
 * (`inv` is the inverse): correct under non-uniform scale. Writes `out`.
 */
function worldNormal(n: Vec3, inv: Float32Array, out: Vec3): Vec3 {
  const x = inv[0]! * n[0] + inv[3]! * n[1] + inv[6]! * n[2];
  const y = inv[1]! * n[0] + inv[4]! * n[1] + inv[7]! * n[2];
  const z = inv[2]! * n[0] + inv[5]! * n[1] + inv[8]! * n[2];
  const len = Math.hypot(x, y, z);
  if (len > 0) {
    out[0] = x / len;
    out[1] = y / len;
    out[2] = z / len;
  } else {
    out[0] = n[0];
    out[1] = n[1];
    out[2] = n[2];
  }
  return out;
}

const transformInv = new Float32Array(9);

/**
 * `outRay` = `ray` in the object space of `worldMatrix3x4` (12 floats, row-major, as
 * `Transform.world`): the 3×3 is inverted (non-uniform scale is fine), the translation
 * removed, and `outRay.dir` normalised. Returns the world units per object-space unit along
 * the ray, so a distance found in object space times the result is the world distance. Returns
 * 0 (and leaves `outRay` alone) when the matrix is singular. No allocation.
 */
export function transformRayInto(ray: Ray, worldMatrix3x4: ArrayLike<number>, outRay: Ray): number {
  if (!invert3x3(worldMatrix3x4, transformInv)) return 0;
  return localRay(ray, worldMatrix3x4, transformInv, outRay);
}

/**
 * Möller–Trumbore: the distance along `ray` to triangle `a, b, c` (counter-clockwise seen from
 * the front), or -1 for a miss. With `cullBack` a triangle whose back faces the ray misses.
 * `out`, when given, receives the unit triangle normal turned to face the ray. No allocation.
 */
export function rayTriangle(
  ray: Ray,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
  cullBack: boolean,
  out: Vec3 | null,
): number {
  const e1x = b[0]! - a[0]!;
  const e1y = b[1]! - a[1]!;
  const e1z = b[2]! - a[2]!;
  const e2x = c[0]! - a[0]!;
  const e2y = c[1]! - a[1]!;
  const e2z = c[2]! - a[2]!;
  const dx = ray.dir[0];
  const dy = ray.dir[1];
  const dz = ray.dir[2];
  // p = dir × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (cullBack ? det < EPS : Math.abs(det) < EPS) return -1;
  const invDet = 1 / det;
  const tx = ray.origin[0] - a[0]!;
  const ty = ray.origin[1] - a[1]!;
  const tz = ray.origin[2] - a[2]!;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;
  // q = t × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < 0) return -1;
  if (out) {
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    if (nx * dx + ny * dy + nz * dz > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz);
    out[0] = nx / len;
    out[1] = ny / len;
    out[2] = nz / len;
  }
  return t;
}

/**
 * The entry distance of `ray` (unit `dir`) into a sphere, or -1 for a miss. A ray starting
 * inside returns 0.
 */
function raySphere(ray: Ray, cx: number, cy: number, cz: number, r: number): number {
  const ox = ray.origin[0] - cx;
  const oy = ray.origin[1] - cy;
  const oz = ray.origin[2] - cz;
  const b = ox * ray.dir[0] + oy * ray.dir[1] + oz * ray.dir[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  return -b + s >= 0 ? 0 : -1;
}

/**
 * Hits `bounds` (an object-space sphere, read each call) placed by `transform` (read each call).
 * The hit carries `point` and `normal` in world space and `distance` in world units, under any
 * rotation and non-uniform scale (an ellipsoid). A ray that starts inside hits at distance 0
 * with `normal: null`. Zero allocations per call.
 */
export function sphereTester<T = null>(
  transform: RayTransform,
  bounds: RayBounds,
  target: T = null as T,
): HitTester<T> {
  const hit = createHit(target);
  const normal: Vec3 = [0, 0, 0];
  const local: Vec3 = [0, 0, 0];
  const inv = new Float32Array(9);
  const lray = createRay();
  return (ray) => {
    const m = transform.world;
    if (!invert3x3(m, inv)) return null;
    const scale = localRay(ray, m, inv, lray);
    if (scale === 0) return null;
    const c = bounds.center;
    const t = raySphere(lray, c[0], c[1], c[2], bounds.radius);
    if (t < 0) return null;
    const dist = t * scale;
    rayAt(ray, dist, hit.point);
    hit.distance = dist;
    hit.target = target;
    if (t === 0) {
      hit.normal = null;
    } else {
      rayAt(lray, t, local);
      local[0] -= c[0];
      local[1] -= c[1];
      local[2] -= c[2];
      hit.normal = worldNormal(local, inv, normal);
    }
    return hit;
  };
}

/**
 * Entry distance of `ray` (unit `dir`) into the object-space box `[-h, h]` per axis, or -1.
 * `faceOut` receives the entering face as `[axis, sign]`; axis -1 when the ray started inside,
 * in which case the distance is 0.
 */
function rayBox(ray: Ray, h: ArrayLike<number>, faceOut: [number, number]): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const o = ray.origin[i]!;
    const d = ray.dir[i]!;
    const e = h[i]!;
    if (Math.abs(d) < EPS) {
      if (o < -e || o > e) return -1;
      continue;
    }
    let t1 = (-e - o) / d;
    let t2 = (e - o) / d;
    let s = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  if (tmin < 0) {
    faceOut[0] = -1;
    faceOut[1] = 0;
    return 0;
  }
  faceOut[0] = axis;
  faceOut[1] = sign;
  return tmin;
}

/**
 * Hits an oriented box: the object-space box `[-halfExtents, +halfExtents]` placed by
 * `transform` (both read each call). The hit's `normal` is the entering face's, in world space;
 * `distance` is in world units. A ray that starts inside hits at distance 0 with `normal: null`.
 * Zero allocations per call.
 */
export function obbTester<T = null>(
  transform: RayTransform,
  halfExtents: readonly [number, number, number],
  target: T = null as T,
): HitTester<T> {
  const hit = createHit(target);
  const normal: Vec3 = [0, 0, 0];
  const local: Vec3 = [0, 0, 0];
  const face: [number, number] = [-1, 0];
  const inv = new Float32Array(9);
  const lray = createRay();
  return (ray) => {
    const m = transform.world;
    if (!invert3x3(m, inv)) return null;
    const scale = localRay(ray, m, inv, lray);
    if (scale === 0) return null;
    const t = rayBox(lray, halfExtents, face);
    if (t < 0) return null;
    const dist = t * scale;
    rayAt(ray, dist, hit.point);
    hit.distance = dist;
    hit.target = target;
    if (face[0] < 0) {
      hit.normal = null;
    } else {
      local[0] = 0;
      local[1] = 0;
      local[2] = 0;
      local[face[0]] = face[1];
      hit.normal = worldNormal(local, inv, normal);
    }
    return hit;
  };
}

export interface MeshTesterOptions {
  /**
   * Object-space bounding sphere the ray must enter before any triangle is tested (read each
   * call, so a mesh rebuilt in place can update it). Default: computed once from `positions`.
   * `radius` Infinity skips the test.
   */
  bounds?: RayBounds;
  /** Skip triangles whose back faces the ray (counter-clockwise front). Default false. */
  cullBack?: boolean;
  /** Floats per vertex in `positions` (`VertexLayout.floats`). Default 12 (`VERTEX_LAYOUT_3D`). */
  stride?: number;
  /** Float offset of x, y, z within a vertex. Default 0 (every shipped layout). */
  offset?: number;
}

/** Vertices with a full x, y, z in an interleaved buffer. */
function vertexCount(positions: Float32Array, stride: number, offset: number): number {
  const room = positions.length - offset - 3;
  return room < 0 ? 0 : Math.floor(room / stride) + 1;
}

/** The bounding sphere of the positions in an interleaved buffer (centre of the AABB). */
function boundsOf(positions: Float32Array, stride: number, offset: number): MeshBounds {
  const bounds: MeshBounds = { center: [0, 0, 0], radius: 0 };
  const n = vertexCount(positions, stride, offset);
  if (n <= 0) return bounds;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = offset + i * stride;
    const x = positions[p]!;
    const y = positions[p + 1]!;
    const z = positions[p + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const c = bounds.center;
  c[0] = (minX + maxX) / 2;
  c[1] = (minY + maxY) / 2;
  c[2] = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const p = offset + i * stride;
    const dx = positions[p]! - c[0];
    const dy = positions[p + 1]! - c[1];
    const dz = positions[p + 2]! - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  bounds.radius = Math.sqrt(r2);
  return bounds;
}

/**
 * Hits the triangles of a mesh whose positions the game keeps on the CPU: `positions` is the
 * interleaved vertex buffer it uploaded (`MeshDesc.vertices`; `stride`/`offset` in floats say
 * where x, y, z sit, default `VERTEX_LAYOUT_3D`), `indices` its index buffer or `null` for a
 * plain triangle list. Both are read each call, so a mesh rebuilt in place is picked as drawn,
 * and `transform` is read each call too. The ray is moved into object space, rejected on the
 * bounds sphere first, then tested against every triangle (Möller–Trumbore); the nearest wins.
 * The hit carries the world-space `point`, the triangle's unit `normal` facing the ray and
 * `distance` in world units. Zero allocations per call; O(triangles) after the sphere.
 */
export function meshTester<T = null>(
  transform: RayTransform,
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | null,
  target: T = null as T,
  opts: MeshTesterOptions = {},
): HitTester<T> {
  const stride = opts.stride ?? DEFAULT_STRIDE;
  const offset = opts.offset ?? DEFAULT_OFFSET;
  const bounds = opts.bounds ?? boundsOf(positions, stride, offset);
  const cullBack = opts.cullBack ?? false;
  const hit = createHit(target);
  const normal: Vec3 = [0, 0, 0];
  const local: Vec3 = [0, 0, 0];
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  const inv = new Float32Array(9);
  const lray = createRay();
  const corners = (tri: number): void => {
    let i0 = tri;
    let i1 = tri + 1;
    let i2 = tri + 2;
    if (indices) {
      i0 = indices[i0]!;
      i1 = indices[i1]!;
      i2 = indices[i2]!;
    }
    let p = offset + i0 * stride;
    a[0] = positions[p]!;
    a[1] = positions[p + 1]!;
    a[2] = positions[p + 2]!;
    p = offset + i1 * stride;
    b[0] = positions[p]!;
    b[1] = positions[p + 1]!;
    b[2] = positions[p + 2]!;
    p = offset + i2 * stride;
    c[0] = positions[p]!;
    c[1] = positions[p + 1]!;
    c[2] = positions[p + 2]!;
  };
  return (ray) => {
    const m = transform.world;
    if (!invert3x3(m, inv)) return null;
    const scale = localRay(ray, m, inv, lray);
    if (scale === 0) return null;
    const bc = bounds.center;
    if (bounds.radius !== Infinity && raySphere(lray, bc[0], bc[1], bc[2], bounds.radius) < 0) {
      return null;
    }
    const count = indices ? indices.length : vertexCount(positions, stride, offset);
    let best = Infinity;
    let bestTri = -1;
    for (let i = 0; i + 2 < count; i += 3) {
      corners(i);
      const t = rayTriangle(lray, a, b, c, cullBack, null);
      if (t >= 0 && t < best) {
        best = t;
        bestTri = i;
      }
    }
    if (bestTri < 0) return null;
    corners(bestTri);
    rayTriangle(lray, a, b, c, cullBack, local);
    const dist = best * scale;
    rayAt(ray, dist, hit.point);
    hit.distance = dist;
    hit.target = target;
    hit.normal = worldNormal(local, inv, normal);
    return hit;
  };
}
