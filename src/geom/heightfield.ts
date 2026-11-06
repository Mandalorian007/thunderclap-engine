/**
 * Heightfields: a grid of heights a game stands on and clicks. `heightAt` and `normalAt` sample
 * the bilinear surface, `raycastHeightfield` walks the grid cells a ray crosses (DDA) and solves
 * the ray against each cell's bilinear patch exactly, and `heightfieldGeometry` builds the same
 * surface as triangles. Nothing here allocates after the field exists.
 *
 * Layout: `heights[z * width + x]`, row-major by z then x, in height units; a sample `(x, z)`
 * sits in the world at `origin + (x * scale[0], heights * scale[1], z * scale[2])`. Outside the
 * field the surface continues flat from the nearest edge sample.
 */
import { type Geometry, type GeometryOptions, GeometryWriter } from './geometry';

/** A 3-vector the heightfield functions read or write in place. */
export type HeightfieldVec3 = [number, number, number] | Float32Array | Float64Array;

/** A ray in world units: `origin` and a direction (`raycastHeightfield` returns distance along it). */
export interface HeightfieldRay {
  readonly origin: ArrayLike<number>;
  readonly dir: ArrayLike<number>;
}

export interface Heightfield {
  /** Samples along x (≥ 2). */
  readonly width: number;
  /** Samples along z (≥ 2). */
  readonly depth: number;
  /** `width × depth` heights, `heights[z * width + x]`, in height units (× `scale[1]`). */
  readonly heights: Float32Array;
  /** World units per sample along x, per height unit, per sample along z. */
  readonly scale: [number, number, number];
  /** World position of sample (0, 0) at height 0. */
  readonly origin: [number, number, number];
}

export interface HeightfieldOptions {
  /** Default `[1, 1, 1]`. */
  scale?: [number, number, number];
  /** Default `[0, 0, 0]`. */
  origin?: [number, number, number];
  /** Initial heights (`width × depth`, copied by reference). Default all zero. */
  heights?: Float32Array;
}

/** A heightfield of `width × depth` samples; fill `heights` in place. */
export function createHeightfield(
  width: number,
  depth: number,
  opts: HeightfieldOptions = {},
): Heightfield {
  if (!(width >= 2) || !(depth >= 2)) {
    throw new Error(`geom: a heightfield needs at least 2×2 samples, got ${width}×${depth}`);
  }
  const heights = opts.heights ?? new Float32Array(width * depth);
  if (heights.length !== width * depth) {
    throw new Error(`geom: heights has ${heights.length} samples, expected ${width * depth}`);
  }
  const s = opts.scale ?? [1, 1, 1];
  const o = opts.origin ?? [0, 0, 0];
  return {
    width,
    depth,
    heights,
    scale: [s[0], s[1], s[2]],
    origin: [o[0], o[1], o[2]],
  };
}

/** Bilinear height in grid space (`gx`, `gz` in samples), clamped to the field. Height units. */
function sampleGrid(hf: Heightfield, gx: number, gz: number): number {
  const { width, depth, heights } = hf;
  const cx = Math.min(Math.max(gx, 0), width - 1);
  const cz = Math.min(Math.max(gz, 0), depth - 1);
  let x0 = Math.floor(cx);
  let z0 = Math.floor(cz);
  if (x0 >= width - 1) x0 = width - 2;
  if (z0 >= depth - 1) z0 = depth - 2;
  const u = cx - x0;
  const v = cz - z0;
  const o = z0 * width + x0;
  const h00 = heights[o]!;
  const h10 = heights[o + 1]!;
  const h01 = heights[o + width]!;
  const h11 = heights[o + width + 1]!;
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
}

/** World height of the surface under world `(x, z)`: bilinear between the four nearest samples. */
export function heightAt(hf: Heightfield, x: number, z: number): number {
  const gx = (x - hf.origin[0]) / hf.scale[0];
  const gz = (z - hf.origin[2]) / hf.scale[2];
  return hf.origin[1] + sampleGrid(hf, gx, gz) * hf.scale[1];
}

/**
 * Unit surface normal at world `(x, z)`, written to `out` (y up). Central differences over half
 * a sample on each side, so it is the bilinear surface's slope smoothed across cell edges.
 */
export function normalAt<T extends HeightfieldVec3>(
  hf: Heightfield,
  x: number,
  z: number,
  out: T,
): T {
  const hx = hf.scale[0] * 0.5;
  const hz = hf.scale[2] * 0.5;
  const dx = heightAt(hf, x - hx, z) - heightAt(hf, x + hx, z);
  const dz = heightAt(hf, x, z - hz) - heightAt(hf, x, z + hz);
  const nx = dx;
  const ny = 2 * hx;
  const nz = dz * (hx / hz);
  const l = Math.hypot(nx, ny, nz);
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}

/** Cells a DDA may visit beyond the grid's own extent before it is forced to stop. */
const DDA_SLACK = 2;
const EPS = 1e-9;

/**
 * Nearest intersection of `ray` with the surface, as the distance along `ray.dir` (world units
 * when `dir` is unit length), or -1 for a miss. The ray is clipped to the field's footprint, the
 * cells it crosses are walked in order (DDA), and in each the ray is solved against that cell's
 * bilinear patch (a quadratic in the distance), so a hit lies exactly on `heightAt`. Hits from
 * below count too. `out`, when given, receives the hit point. No allocation.
 */
export function raycastHeightfield(
  hf: Heightfield,
  ray: HeightfieldRay,
  out?: HeightfieldVec3,
): number {
  const { width, depth, heights, scale, origin } = hf;
  // Grid space: x and z in samples, y in height units.
  const ox = (ray.origin[0]! - origin[0]) / scale[0];
  const oy = (ray.origin[1]! - origin[1]) / scale[1];
  const oz = (ray.origin[2]! - origin[2]) / scale[2];
  const dx = ray.dir[0]! / scale[0];
  const dy = ray.dir[1]! / scale[1];
  const dz = ray.dir[2]! / scale[2];

  // Clip to the footprint 0..width-1 × 0..depth-1.
  let t0 = 0;
  let t1 = Number.POSITIVE_INFINITY;
  if (Math.abs(dx) < EPS) {
    if (ox < 0 || ox > width - 1) return -1;
  } else {
    const ta = -ox / dx;
    const tb = (width - 1 - ox) / dx;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (Math.abs(dz) < EPS) {
    if (oz < 0 || oz > depth - 1) return -1;
  } else {
    const ta = -oz / dz;
    const tb = (depth - 1 - oz) / dz;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t1 < t0) return -1;

  // Starting cell, clamped so a ray entering on the far edge lands in the last cell.
  const sx = ox + dx * t0;
  const sz = oz + dz * t0;
  let cx = Math.floor(sx);
  let cz = Math.floor(sz);
  if (cx < 0) cx = 0;
  if (cx > width - 2) cx = width - 2;
  if (cz < 0) cz = 0;
  if (cz > depth - 2) cz = depth - 2;
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dx) < EPS ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaZ = Math.abs(dz) < EPS ? Number.POSITIVE_INFINITY : Math.abs(1 / dz);
  let tMaxX = Math.abs(dx) < EPS ? Number.POSITIVE_INFINITY : ((dx > 0 ? cx + 1 : cx) - ox) / dx;
  let tMaxZ = Math.abs(dz) < EPS ? Number.POSITIVE_INFINITY : ((dz > 0 ? cz + 1 : cz) - oz) / dz;

  let t = t0;
  const maxSteps = width + depth + DDA_SLACK;
  for (let step = 0; step < maxSteps; step++) {
    const tEnd = Math.min(tMaxX, tMaxZ, t1);
    // The patch of cell (cx, cz): h(u, v) = h00 + a u + b v + c u v, u = x - cx, v = z - cz.
    const o = cz * width + cx;
    const h00 = heights[o]!;
    const a = heights[o + 1]! - h00;
    const b = heights[o + width]! - h00;
    const c = h00 - heights[o + 1]! - heights[o + width]! + heights[o + width + 1]!;
    // f(t) = y(t) - h(u(t), v(t)), with u(t) = u0 + dx t, v(t) = v0 + dz t:
    const u0 = ox - cx;
    const v0 = oz - cz;
    const qa = -c * dx * dz;
    const qb = dy - a * dx - b * dz - c * (u0 * dz + v0 * dx);
    const qc = oy - h00 - a * u0 - b * v0 - c * u0 * v0;
    const hit = smallestRoot(qa, qb, qc, t, tEnd);
    if (hit >= 0) {
      if (out) {
        out[0] = ray.origin[0]! + ray.dir[0]! * hit;
        out[1] = ray.origin[1]! + ray.dir[1]! * hit;
        out[2] = ray.origin[2]! + ray.dir[2]! * hit;
      }
      return hit;
    }
    if (tEnd >= t1) return -1;
    if (tMaxX < tMaxZ) {
      cx += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else {
      cz += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
    }
    if (cx < 0 || cx > width - 2 || cz < 0 || cz > depth - 2) return -1;
  }
  return -1;
}

/** Smallest root of `a t² + b t + c = 0` within `[lo, hi]`, or -1. */
function smallestRoot(a: number, b: number, c: number, lo: number, hi: number): number {
  const tol = 1e-7 * Math.max(1, Math.abs(lo));
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return -1;
    const t = -c / b;
    return t >= lo - tol && t <= hi + tol ? Math.max(lo, t) : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  // Stable pair: q avoids cancellation.
  const q = b >= 0 ? -(b + s) / 2 : -(b - s) / 2;
  const r1 = q / a;
  const r2 = q !== 0 ? c / q : r1;
  const tA = Math.min(r1, r2);
  const tB = Math.max(r1, r2);
  if (tA >= lo - tol && tA <= hi + tol) return Math.max(lo, tA);
  if (tB >= lo - tol && tB <= hi + tol) return Math.max(lo, tB);
  return -1;
}

export interface HeightfieldGeometryOptions extends GeometryOptions {
  /** Flat normals from each cell's two triangles instead of the smooth surface normal. Default false. */
  flat?: boolean;
}

/**
 * The field as triangles in world units: one vertex per sample (u along x, v along z, 0..1
 * across the field), two triangles per cell, smooth normals from `normalAt`. Promotes to 32-bit
 * indices past 65535 samples. With `flat`, each cell's triangles get their own vertices and face
 * normals (six vertices per cell).
 */
export function heightfieldGeometry(
  hf: Heightfield,
  opts: HeightfieldGeometryOptions = {},
): Geometry {
  const { width, depth, scale, origin } = hf;
  const cells = (width - 1) * (depth - 1);
  if (opts.flat) return flatGeometry(hf, opts);
  const w = new GeometryWriter(width * depth, cells * 6, opts);
  const n: [number, number, number] = [0, 1, 0];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const x = origin[0] + i * scale[0];
      const z = origin[2] + j * scale[2];
      const y = origin[1] + hf.heights[j * width + i]! * scale[1];
      normalAt(hf, x, z, n);
      w.vertex(x, y, z, n[0], n[1], n[2], i / (width - 1), j / (depth - 1));
    }
  }
  for (let j = 0; j < depth - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const a = j * width + i;
      // (i, j) → (i, j+1) → (i+1, j+1) → (i+1, j): +z then +x, normal up.
      w.quad(a, a + width, a + width + 1, a + 1);
    }
  }
  return w.finish();
}

function flatGeometry(hf: Heightfield, opts: HeightfieldGeometryOptions): Geometry {
  const { width, depth, scale, origin, heights } = hf;
  const cells = (width - 1) * (depth - 1);
  const w = new GeometryWriter(cells * 6, cells * 6, opts);
  const px = (i: number) => origin[0] + i * scale[0];
  const pz = (j: number) => origin[2] + j * scale[2];
  const py = (i: number, j: number) => origin[1] + heights[j * width + i]! * scale[1];
  const tri = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
    const x0 = px(i0);
    const y0 = py(i0, j0);
    const z0 = pz(j0);
    const x1 = px(i1);
    const y1 = py(i1, j1);
    const z1 = pz(j1);
    const x2 = px(i2);
    const y2 = py(i2, j2);
    const z2 = pz(j2);
    const ax = x1 - x0;
    const ay = y1 - y0;
    const az = z1 - z0;
    const bx = x2 - x0;
    const by = y2 - y0;
    const bz = z2 - z0;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const uw = width - 1;
    const vd = depth - 1;
    const a = w.vertex(x0, y0, z0, nx, ny, nz, i0 / uw, j0 / vd);
    const b = w.vertex(x1, y1, z1, nx, ny, nz, i1 / uw, j1 / vd);
    const c = w.vertex(x2, y2, z2, nx, ny, nz, i2 / uw, j2 / vd);
    w.tri(a, b, c);
  };
  for (let j = 0; j < depth - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      tri(i, j, i, j + 1, i + 1, j + 1);
      tri(i, j, i + 1, j + 1, i + 1, j);
    }
  }
  return w.finish();
}
