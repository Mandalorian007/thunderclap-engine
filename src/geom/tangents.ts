/**
 * Tangent frames for normal-mapped materials: `computeTangents` turns a `VERTEX_LAYOUT_3D`
 * geometry into one in `VERTEX_LAYOUT_3D_TANGENT` (16 floats: the 12 of the 3D layout, then the
 * unit tangent xyz and its handedness in w).
 */
import { VERTEX_LAYOUT_3D, VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { GEOMETRY_FLOATS, type Geometry } from './geometry';

/** A `Geometry` whose `layout` is `VERTEX_LAYOUT_3D_TANGENT` (16 floats per vertex). */
export type GeometryTangent = Geometry;

/** Floats per vertex in `VERTEX_LAYOUT_3D_TANGENT`. */
export const TANGENT_FLOATS = VERTEX_LAYOUT_3D_TANGENT.floats;

/**
 * Per-vertex tangents in the MikkTSpace manner: each triangle's tangent and bitangent (the
 * directions in which u and v grow across it, scaled by its area over its uv area) are
 * accumulated on its three vertices; each sum is then Gram-Schmidt orthogonalised against the
 * vertex normal and normalised, and w = +1 when `cross(normal, tangent)` points along the accumulated
 * bitangent, -1 when the uv mapping is mirrored. A vertex with no uv area (or none at all) gets
 * an arbitrary unit tangent perpendicular to its normal and w = 1. Returns a new geometry in
 * `VERTEX_LAYOUT_3D_TANGENT` with the same indices object and bounds; the input is untouched.
 * Allocates the output and one scratch array.
 */
export function computeTangents(g: Geometry): GeometryTangent {
  if (g.layout !== VERTEX_LAYOUT_3D) {
    throw new Error(`geom: computeTangents needs VERTEX_LAYOUT_3D, got '${g.layout.name}'`);
  }
  const F = GEOMETRY_FLOATS;
  const T = TANGENT_FLOATS;
  const src = g.vertices;
  const n = src.length / F;
  const out = new Float32Array(n * T);
  // Tangent sums live in the output's tangent slots; bitangent sums in the scratch array.
  const bit = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(src.subarray(i * F, i * F + F), i * T);

  const idx = g.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * F;
    const b = idx[t + 1]! * F;
    const c = idx[t + 2]! * F;
    const e1x = src[b]! - src[a]!;
    const e1y = src[b + 1]! - src[a + 1]!;
    const e1z = src[b + 2]! - src[a + 2]!;
    const e2x = src[c]! - src[a]!;
    const e2y = src[c + 1]! - src[a + 1]!;
    const e2z = src[c + 2]! - src[a + 2]!;
    const du1 = src[b + 6]! - src[a + 6]!;
    const dv1 = src[b + 7]! - src[a + 7]!;
    const du2 = src[c + 6]! - src[a + 6]!;
    const dv2 = src[c + 7]! - src[a + 7]!;
    const det = du1 * dv2 - du2 * dv1;
    if (det === 0) continue;
    const r = 1 / det;
    // Tangent = direction of +u, bitangent = direction of +v (Lengyel); a mirrored mapping
    // flips the sign of `det`, so both still point along +u and +v but B lands on the far side of
    // cross(n, t), which is what w records.
    const tx = (e1x * dv2 - e2x * dv1) * r;
    const ty = (e1y * dv2 - e2y * dv1) * r;
    const tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r;
    const by = (e2y * du1 - e1y * du2) * r;
    const bz = (e2z * du1 - e1z * du2) * r;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k]!;
      const o = v * T + 12;
      out[o] = out[o]! + tx;
      out[o + 1] = out[o + 1]! + ty;
      out[o + 2] = out[o + 2]! + tz;
      const p = v * 3;
      bit[p] = bit[p]! + bx;
      bit[p + 1] = bit[p + 1]! + by;
      bit[p + 2] = bit[p + 2]! + bz;
    }
  }

  for (let i = 0; i < n; i++) {
    const o = i * T;
    const nx = out[o + 3]!;
    const ny = out[o + 4]!;
    const nz = out[o + 5]!;
    let tx = out[o + 12]!;
    let ty = out[o + 13]!;
    let tz = out[o + 14]!;
    // Gram-Schmidt: remove the normal component.
    const d = tx * nx + ty * ny + tz * nz;
    tx -= d * nx;
    ty -= d * ny;
    tz -= d * nz;
    let len = Math.hypot(tx, ty, tz);
    if (len < 1e-12) {
      // No usable uv gradient: any unit vector perpendicular to the normal.
      if (Math.abs(nx) < 0.9) {
        tx = 0;
        ty = nz;
        tz = -ny;
      } else {
        tx = -nz;
        ty = 0;
        tz = nx;
      }
      len = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= len;
    ty /= len;
    tz /= len;
    // Handedness: does cross(n, t) agree with the accumulated bitangent?
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const p = i * 3;
    const h = cx * bit[p]! + cy * bit[p + 1]! + cz * bit[p + 2]!;
    out[o + 12] = tx;
    out[o + 13] = ty;
    out[o + 14] = tz;
    out[o + 15] = h < 0 ? -1 : 1;
  }
  return {
    vertices: out,
    indices: g.indices,
    bounds: {
      center: [g.bounds.center[0], g.bounds.center[1], g.bounds.center[2]],
      radius: g.bounds.radius,
    },
    layout: VERTEX_LAYOUT_3D_TANGENT,
  };
}
