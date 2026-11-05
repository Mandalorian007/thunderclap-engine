/**
 * Rays and hit testing for the pointer router (`pointer-router.ts`). Plain math, no DOM, no
 * game nouns: a `HitTester` turns a world-space `Ray` into the nearest `Hit` it knows, and the
 * game decides what `target` means.
 */
import type { Camera } from '../render/camera';

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
export interface Hit<T = unknown> {
  readonly point: Vec3;
  normal: Vec3 | null;
  distance: number;
  /** What was hit, as the game named it (a box's `target`, a plane's `target`). */
  target: T;
}

/**
 * Returns the nearest hit of `ray` against what this tester knows, or `null`. It may return the
 * same object on every call (the router copies it before calling again).
 */
export type HitTester<T = unknown> = (ray: Ray) => Hit<T> | null;

/** The camera slice the router needs: `screen` and the inverse projection (`render`'s `Camera`). */
export type RayCamera = Pick<Camera, 'screen' | 'screenToWorld'>;

export function createRay(): Ray {
  return { origin: [0, 0, 0], dir: [0, 0, 1] };
}

export function createHit<T = unknown>(target: T): Hit<T> {
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
 * infinity). For `Camera.ortho2d` the origin is the world point at z = 0 and `dir` is +z.
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
 * Hits the plane z = `z` (a 2D game's world): the hit point is where the ray crosses it, so
 * through `Camera.ortho2d` it is the world point under the pointer. Rays parallel to the plane
 * or pointing away from it miss. `target` is what every hit carries (default `null`).
 */
export function planeTester<T = null>(z = 0, target: T = null as T): HitTester<T> {
  const hit = createHit(target);
  const normal: Vec3 = [0, 0, 0];
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

/** An axis-aligned box for `aabbTester`. `min` ≤ `max` per axis; a flat box (2D quad) is fine. */
export interface Aabb<T = unknown> {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  target: T;
}

/**
 * Hits the nearest of `boxes` (read on every call, so the game may edit the array and its
 * boxes). A ray that starts inside a box hits it at distance 0 with no normal. Equal distances
 * go to the earlier box. Flat boxes (`min[i] === max[i]`) work, so 2D quads at z = 0 can be
 * picked through `Camera.ortho2d`.
 */
export function aabbTester<T = unknown>(boxes: readonly Aabb<T>[]): HitTester<T> {
  const hit = createHit<T>(undefined as T);
  const normal: Vec3 = [0, 0, 0];
  return (ray) => {
    let best = Infinity;
    let bestBox: Aabb<T> | null = null;
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
