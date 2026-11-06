/**
 * Per-geometry operations a level builder reaches for: `flatShade`, `weld`, `flipWinding`,
 * `projectUv`, `fitBounds`, `recenter`. They read the 3D prefix every supported layout shares
 * (position at float 0, normal at 3, uv at 6) and step by `layout.floats`, so they take
 * `VERTEX_LAYOUT_3D` and `VERTEX_LAYOUT_3D_TANGENT` geometry alike. `flipWinding`, `projectUv`,
 * `fitBounds` and `recenter` mutate and return their input; `flatShade` and `weld` return a new
 * geometry (their vertex counts change).
 */
import { VERTEX_LAYOUT_3D, VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { computeBounds, createIndices, type Geometry } from './geometry';

const TAU = Math.PI * 2;

function floatsOf(g: Geometry, what: string): number {
  if (g.layout !== VERTEX_LAYOUT_3D && g.layout !== VERTEX_LAYOUT_3D_TANGENT) {
    throw new Error(`geom: ${what} needs a 3D vertex layout, got '${g.layout.name}'`);
  }
  return g.layout.floats;
}

/** Axis-aligned box of the positions: `[minX, minY, minZ, maxX, maxY, maxZ]` (zeros when empty). */
function aabb(v: Float32Array, F: number, out: Float64Array): Float64Array {
  if (v.length === 0) {
    out.fill(0);
    return out;
  }
  out[0] = out[1] = out[2] = Number.POSITIVE_INFINITY;
  out[3] = out[4] = out[5] = Number.NEGATIVE_INFINITY;
  for (let o = 0; o < v.length; o += F) {
    for (let k = 0; k < 3; k++) {
      const c = v[o + k]!;
      if (c < out[k]!) out[k] = c;
      if (c > out[3 + k]!) out[3 + k] = c;
    }
  }
  return out;
}

// ------------------------------------------------------------------ flatShade

/**
 * Unshare every vertex: one vertex per triangle corner (`indices.length` of them, indices
 * `0..n-1`), each carrying its triangle's geometric normal; the other attributes are copied from
 * the source corner. A degenerate triangle keeps its source normals. New geometry, same layout.
 */
export function flatShade(g: Geometry): Geometry {
  const F = floatsOf(g, 'flatShade');
  const src = g.vertices;
  const idx = g.indices;
  const count = idx.length;
  const out = new Float32Array(count * F);
  const indices = createIndices(count, count);
  for (let t = 0; t < count; t += 3) {
    const a = idx[t]! * F;
    const b = idx[t + 1]! * F;
    const c = idx[t + 2]! * F;
    const abx = src[b]! - src[a]!;
    const aby = src[b + 1]! - src[a + 1]!;
    const abz = src[b + 2]! - src[a + 2]!;
    const acx = src[c]! - src[a]!;
    const acy = src[c + 1]! - src[a + 1]!;
    const acz = src[c + 2]! - src[a + 2]!;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    const flat = len > 1e-20;
    if (flat) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (let k = 0; k < 3; k++) {
      const s = idx[t + k]! * F;
      const o = (t + k) * F;
      out.set(src.subarray(s, s + F), o);
      if (flat) {
        out[o + 3] = nx;
        out[o + 4] = ny;
        out[o + 5] = nz;
      }
      indices[t + k] = t + k;
    }
  }
  return { vertices: out, indices, bounds: computeBounds(out, F), layout: g.layout };
}

// ------------------------------------------------------------------ weld

/**
 * Merge vertices whose position, normal and uv each lie within `epsilon` (per component) of an
 * earlier vertex's: a spatial hash over positions finds candidates, the first occurrence is kept,
 * indices are remapped and shrink to 16-bit when the result fits. Vertex order is otherwise
 * preserved; colour and tangent are taken from the kept vertex. New geometry, same layout.
 */
export function weld(g: Geometry, epsilon = 1e-5): Geometry {
  const F = floatsOf(g, 'weld');
  const src = g.vertices;
  const n = src.length / F;
  const inv = 1 / epsilon;
  const cells = new Map<number, number[]>();
  const remap = new Uint32Array(n);
  const keep = new Uint32Array(n);
  let kept = 0;
  const key = (cx: number, cy: number, cz: number) =>
    // Three 21-bit cell coordinates folded into one double (exact below 2^53).
    ((cx & 0x1fffff) * 2097152 + (cy & 0x1fffff)) * 2097152 + (cz & 0x1fffff);
  const same = (a: number, b: number) => {
    for (let k = 0; k < 8; k++) if (Math.abs(src[a + k]! - src[b + k]!) > epsilon) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    const o = i * F;
    const cx = Math.round(src[o]! * inv);
    const cy = Math.round(src[o + 1]! * inv);
    const cz = Math.round(src[o + 2]! * inv);
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (same(o, j * F)) {
              found = j;
              break search;
            }
          }
        }
      }
    }
    if (found >= 0) {
      remap[i] = remap[found]!;
      continue;
    }
    remap[i] = kept;
    keep[kept++] = i;
    const k = key(cx, cy, cz);
    const bucket = cells.get(k);
    if (bucket) bucket.push(i);
    else cells.set(k, [i]);
  }
  const vertices = new Float32Array(kept * F);
  for (let i = 0; i < kept; i++) {
    const s = keep[i]! * F;
    vertices.set(src.subarray(s, s + F), i * F);
  }
  const indices = createIndices(kept, g.indices.length);
  for (let t = 0; t < g.indices.length; t++) indices[t] = remap[g.indices[t]!]!;
  return { vertices, indices, bounds: computeBounds(vertices, F), layout: g.layout };
}

// ------------------------------------------------------------------ flipWinding

/**
 * Turn the geometry inside out: every triangle's winding is reversed and every normal negated
 * (and, in the tangent layout, the handedness, so the bitangent keeps its direction). Bounds are
 * unchanged. Mutates and returns `g`.
 */
export function flipWinding(g: Geometry): Geometry {
  const F = floatsOf(g, 'flipWinding');
  const idx = g.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const b = idx[t + 1]!;
    idx[t + 1] = idx[t + 2]!;
    idx[t + 2] = b;
  }
  const v = g.vertices;
  const tangent = F >= 16;
  for (let o = 0; o < v.length; o += F) {
    v[o + 3] = -v[o + 3]!;
    v[o + 4] = -v[o + 4]!;
    v[o + 5] = -v[o + 5]!;
    if (tangent) v[o + 15] = -v[o + 15]!;
  }
  return g;
}

// ------------------------------------------------------------------ projectUv

/** How `projectUv` maps positions to uvs. */
export type UvProjection = 'box' | 'planar' | 'cylindrical' | 'spherical';

export interface ProjectUvOptions {
  /** Multiplies the projected uvs (one number or `[u, v]`). Default 1: 0..1 across the box. */
  scale?: number | [number, number];
  /** `'planar'` only: the axis the plane faces. Default `'y'` (u along x, v along z). */
  axis?: 'x' | 'y' | 'z';
}

/**
 * Overwrite the uvs from the positions, relative to the geometry's axis-aligned box so each
 * coordinate spans 0..1 before `scale`:
 * - `'box'`: each vertex takes the plane facing its normal's dominant axis (x: u = z, v = y;
 *   y: u = x, v = z; z: u = x, v = y), so a box or a building block tiles on every face;
 * - `'planar'`: one plane for all vertices, facing `axis`;
 * - `'cylindrical'`: u is the angle around +y (0 at +z, as `cylinder`), v the height;
 * - `'spherical'`: u the angle around +y, v the latitude from the box centre (0 at the top).
 * Mutates and returns `g`.
 */
export function projectUv(g: Geometry, mode: UvProjection, opts: ProjectUvOptions = {}): Geometry {
  const F = floatsOf(g, 'projectUv');
  const v = g.vertices;
  const box = aabb(v, F, AABB);
  const sx = box[3]! - box[0]! || 1;
  const sy = box[4]! - box[1]! || 1;
  const sz = box[5]! - box[2]! || 1;
  const cx = (box[0]! + box[3]!) / 2;
  const cy = (box[1]! + box[4]!) / 2;
  const cz = (box[2]! + box[5]!) / 2;
  const s = opts.scale ?? 1;
  const su = typeof s === 'number' ? s : s[0];
  const sv = typeof s === 'number' ? s : s[1];
  const planarAxis = opts.axis ?? 'y';
  for (let o = 0; o < v.length; o += F) {
    const x = (v[o]! - box[0]!) / sx;
    const y = (v[o + 1]! - box[1]!) / sy;
    const z = (v[o + 2]! - box[2]!) / sz;
    let u: number;
    let w: number;
    if (mode === 'box' || mode === 'planar') {
      let axis = planarAxis;
      if (mode === 'box') {
        const ax = Math.abs(v[o + 3]!);
        const ay = Math.abs(v[o + 4]!);
        const az = Math.abs(v[o + 5]!);
        axis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
      }
      if (axis === 'x') {
        u = z;
        w = y;
      } else if (axis === 'y') {
        u = x;
        w = z;
      } else {
        u = x;
        w = y;
      }
    } else {
      const dx = v[o]! - cx;
      const dz = v[o + 2]! - cz;
      u = 0.5 + Math.atan2(dx, dz) / TAU;
      if (mode === 'cylindrical') {
        w = 1 - y;
      } else {
        const dy = v[o + 1]! - cy;
        const len = Math.hypot(dx, dy, dz);
        w = len > 0 ? Math.acos(Math.max(-1, Math.min(1, dy / len))) / Math.PI : 0;
      }
    }
    v[o + 6] = u * su;
    v[o + 7] = w * sv;
  }
  return g;
}

const AABB = new Float64Array(6);

// ------------------------------------------------------------------ fitBounds / recenter

/**
 * Scale uniformly about the origin so the longest side of the axis-aligned box equals `size`.
 * Normals are unchanged (a uniform scale keeps them); bounds are recomputed. An empty or
 * zero-extent geometry is left as it is. Mutates and returns `g`.
 */
export function fitBounds(g: Geometry, size: number): Geometry {
  const F = floatsOf(g, 'fitBounds');
  const v = g.vertices;
  const box = aabb(v, F, AABB);
  const longest = Math.max(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!);
  if (!(longest > 0)) return g;
  const k = size / longest;
  for (let o = 0; o < v.length; o += F) {
    v[o] = v[o]! * k;
    v[o + 1] = v[o + 1]! * k;
    v[o + 2] = v[o + 2]! * k;
  }
  computeBounds(v, F, g.bounds);
  return g;
}

/** Translate so the centre of the axis-aligned box is the origin. Mutates and returns `g`. */
export function recenter(g: Geometry): Geometry {
  const F = floatsOf(g, 'recenter');
  const v = g.vertices;
  const box = aabb(v, F, AABB);
  const cx = (box[0]! + box[3]!) / 2;
  const cy = (box[1]! + box[4]!) / 2;
  const cz = (box[2]! + box[5]!) / 2;
  for (let o = 0; o < v.length; o += F) {
    v[o] = v[o]! - cx;
    v[o + 1] = v[o + 1]! - cy;
    v[o + 2] = v[o + 2]! - cz;
  }
  computeBounds(v, F, g.bounds);
  return g;
}
