/**
 * Mesh emission surfaces (ws/fx-3): a triangle list with a cumulative-area table, so particles
 * can be born uniformly over a mesh's surface (`EmitShape` `{ kind: 'mesh' }`). Pure arithmetic;
 * the GPU kernel samples the same table (`SURFACE_TRI_FLOATS` per triangle).
 */
import type { Geometry } from '../geom/geometry';
import { SURFACE_TRI_FLOATS } from './particles-wgsl';

/** A triangle mesh by its arrays: `positions` xyz per vertex, optional `normals`, `indices`. */
export interface MeshShapeSource {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  indices?: ArrayLike<number>;
}

/**
 * A mesh emit shape with its sampling table built: usable as `EmitParams.shape` directly.
 * `table` holds `SURFACE_TRI_FLOATS` per triangle: p0 (xyz + cumulative area 0..1), p1, p2,
 * n0, n1, n2 (unit normals, each xyz + 0).
 */
export interface EmitSurface extends MeshShapeSource {
  readonly kind: 'mesh';
  /** Launch along the surface normal (instead of `angle`/`spread`). Default false. */
  alongNormal?: boolean;
  readonly table: Float32Array;
  readonly triangles: number;
  /** Total surface area (square units). */
  readonly area: number;
}

function isGeometry(src: Geometry | MeshShapeSource): src is Geometry {
  return 'vertices' in src && 'layout' in src;
}

/**
 * Build the sampling table of a `Geometry` (xyz at 0, normal at 3 of each `layout.floats`
 * vertex) or of raw `positions`/`normals`/`indices`. Without indices every three positions
 * are a triangle; without normals the face normal is used. Allocates; build once per mesh.
 */
export function buildEmitSurface(
  src: Geometry | MeshShapeSource,
  opts: { alongNormal?: boolean } = {},
): EmitSurface {
  let positions: ArrayLike<number>;
  let normals: ArrayLike<number> | undefined;
  let indices: ArrayLike<number> | undefined;
  let stride = 3;
  let nOffset = 3;
  if (isGeometry(src)) {
    positions = src.vertices;
    normals = src.vertices;
    indices = src.indices;
    stride = src.layout.floats;
  } else {
    positions = src.positions;
    normals = src.normals;
    indices = src.indices;
    nOffset = 0;
  }
  const vertexCount = Math.floor(positions.length / stride);
  const triangles = indices ? Math.floor(indices.length / 3) : Math.floor(vertexCount / 3);
  const table = new Float32Array(triangles * SURFACE_TRI_FLOATS);
  let area = 0;
  const n = new Float32Array(3);
  for (let t = 0; t < triangles; t++) {
    const o = t * SURFACE_TRI_FLOATS;
    for (let k = 0; k < 3; k++) {
      const vi = indices ? indices[t * 3 + k]! : t * 3 + k;
      const base = vi * stride;
      table[o + k * 4] = positions[base]!;
      table[o + k * 4 + 1] = positions[base + 1]!;
      table[o + k * 4 + 2] = positions[base + 2]!;
    }
    // Face normal and area from the edge cross product.
    const ax = table[o + 4]! - table[o]!;
    const ay = table[o + 5]! - table[o + 1]!;
    const az = table[o + 6]! - table[o + 2]!;
    const bx = table[o + 8]! - table[o]!;
    const by = table[o + 9]! - table[o + 1]!;
    const bz = table[o + 10]! - table[o + 2]!;
    n[0] = ay * bz - az * by;
    n[1] = az * bx - ax * bz;
    n[2] = ax * by - ay * bx;
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    area += len * 0.5;
    if (len > 0) {
      n[0]! /= len;
      n[1]! /= len;
      n[2]! /= len;
    }
    for (let k = 0; k < 3; k++) {
      const vi = indices ? indices[t * 3 + k]! : t * 3 + k;
      const no = o + 12 + k * 4;
      if (normals && normals.length >= (vi + 1) * stride) {
        const base = vi * stride + nOffset;
        const nx = normals[base]!;
        const ny = normals[base + 1]!;
        const nz = normals[base + 2]!;
        const nl = Math.hypot(nx, ny, nz) || 1;
        table[no] = nx / nl;
        table[no + 1] = ny / nl;
        table[no + 2] = nz / nl;
      } else {
        table[no] = n[0]!;
        table[no + 1] = n[1]!;
        table[no + 2] = n[2]!;
      }
    }
    table[o + 3] = area;
  }
  // Normalise the cumulative areas to 0..1 (the last is exactly 1).
  if (area > 0) {
    for (let t = 0; t < triangles; t++) table[t * SURFACE_TRI_FLOATS + 3]! /= area;
  }
  if (triangles > 0) table[(triangles - 1) * SURFACE_TRI_FLOATS + 3] = 1;
  return {
    kind: 'mesh',
    positions,
    normals,
    indices,
    alongNormal: opts.alongNormal,
    table,
    triangles,
    area,
  };
}

/**
 * The CPU mirror of the kernel's sampling: triangle by `u` (binary search of the cumulative
 * areas), point by `v`, `w` (square-root barycentrics, uniform over the triangle). Writes
 * position xyz then normal xyz into `out` (6 floats). Returns the triangle index.
 */
export function sampleEmitSurface(
  surface: EmitSurface,
  u: number,
  v: number,
  w: number,
  out: Float32Array,
): number {
  const tb = surface.table;
  let lo = 0;
  let hi = surface.triangles - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tb[mid * SURFACE_TRI_FLOATS + 3]! < u) lo = mid + 1;
    else hi = mid;
  }
  const o = lo * SURFACE_TRI_FLOATS;
  const r1 = Math.sqrt(v);
  const w0 = 1 - r1;
  const w1 = r1 * (1 - w);
  const w2 = r1 * w;
  for (let k = 0; k < 3; k++) {
    out[k] = tb[o + k]! * w0 + tb[o + 4 + k]! * w1 + tb[o + 8 + k]! * w2;
    out[3 + k] = tb[o + 12 + k]! * w0 + tb[o + 16 + k]! * w1 + tb[o + 20 + k]! * w2;
  }
  return lo;
}
