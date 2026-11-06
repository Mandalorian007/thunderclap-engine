/**
 * `Geometry`: vertices and indices in the engine's 3D vertex layout, with a bounding sphere.
 * A `Geometry` is a `MeshDesc`, so `renderer.createMesh(geometry)` takes it as-is.
 *
 * Pure arithmetic over flat typed arrays; the only `render/` dependency is types and the layout
 * constant. Builders size their arrays up front, so nothing grows while writing; indices are
 * `Uint16Array` while every vertex index fits (vertex count ≤ 65535) and `Uint32Array` past that.
 */
import { type MeshBounds, VERTEX_LAYOUT_3D, type VertexLayout } from '../render/mesh';

/** `[r, g, b, a]`, 0..1. */
export type Rgba = [number, number, number, number];

/**
 * Indexed triangles in `layout` (`VERTEX_LAYOUT_3D` from every builder: xyz, normal xyz, uv,
 * rgba = 12 floats), with a bounding sphere. Structurally a `MeshDesc`.
 */
export interface Geometry {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Bounding sphere: the centre of the positions' box, the radius the farthest vertex from it. */
  bounds: MeshBounds;
  layout: VertexLayout;
}

/** Options every builder shares. */
export interface GeometryOptions {
  /** Vertex colour of every vertex. Default white `[1, 1, 1, 1]`. */
  color?: Rgba;
  /** Multiplies every uv: one number for both axes or `[u, v]`. Default 1. */
  uvScale?: number | [number, number];
}

/** Vertices above which a geometry's indices are `Uint32Array` (`0xffff` is the last uint16). */
export const UINT16_MAX_VERTICES = 0xffff;

/** Floats per vertex in every builder's output (`VERTEX_LAYOUT_3D.floats`). */
export const GEOMETRY_FLOATS = VERTEX_LAYOUT_3D.floats;

/** The index array type for `vertexCount` vertices. */
export function createIndices(vertexCount: number, indexCount: number): Uint16Array | Uint32Array {
  return vertexCount > UINT16_MAX_VERTICES
    ? new Uint32Array(indexCount)
    : new Uint16Array(indexCount);
}

/**
 * Sequential writer the builders share: `vertices` and `indices` are sized at construction and
 * filled by `vertex(...)` and `tri(...)`/`quad(...)`; `finish()` checks the counts and computes the
 * bounds. Colour and uv scale come from the options.
 */
export class GeometryWriter {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  /** Vertices written so far (the index the next `vertex` gets). */
  count = 0;
  private i = 0;
  private readonly r: number;
  private readonly g: number;
  private readonly b: number;
  private readonly a: number;
  private readonly us: number;
  private readonly vs: number;

  constructor(vertexCount: number, indexCount: number, opts: GeometryOptions = {}) {
    this.vertices = new Float32Array(vertexCount * GEOMETRY_FLOATS);
    this.indices = createIndices(vertexCount, indexCount);
    const c = opts.color ?? WHITE;
    this.r = c[0];
    this.g = c[1];
    this.b = c[2];
    this.a = c[3];
    const s = opts.uvScale ?? 1;
    this.us = typeof s === 'number' ? s : s[0];
    this.vs = typeof s === 'number' ? s : s[1];
  }

  /** Append one vertex; returns its index. The normal is stored as given (normalise first). */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    const o = this.count * GEOMETRY_FLOATS;
    const out = this.vertices;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = nx;
    out[o + 4] = ny;
    out[o + 5] = nz;
    out[o + 6] = u * this.us;
    out[o + 7] = v * this.vs;
    out[o + 8] = this.r;
    out[o + 9] = this.g;
    out[o + 10] = this.b;
    out[o + 11] = this.a;
    return this.count++;
  }

  /** Append one triangle (counter-clockwise seen from the front). */
  tri(a: number, b: number, c: number): void {
    const out = this.indices;
    out[this.i++] = a;
    out[this.i++] = b;
    out[this.i++] = c;
  }

  /** Append a quad `a b c d` (counter-clockwise) as two triangles. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** The finished geometry; throws if a count does not match what was reserved. */
  finish(): Geometry {
    if (this.count * GEOMETRY_FLOATS !== this.vertices.length) {
      throw new Error(
        `geom: wrote ${this.count} of ${this.vertices.length / GEOMETRY_FLOATS} vertices`,
      );
    }
    if (this.i !== this.indices.length) {
      throw new Error(`geom: wrote ${this.i} of ${this.indices.length} indices`);
    }
    return {
      vertices: this.vertices,
      indices: this.indices,
      bounds: computeBounds(this.vertices),
      layout: VERTEX_LAYOUT_3D,
    };
  }
}

const WHITE: Rgba = [1, 1, 1, 1];

/**
 * Bounding sphere of the positions in `vertices` (xyz first, `floats` per vertex; the 3D layout's
 * 12 by default): the centre of their axis-aligned box and the distance to the farthest one, the
 * same rule `Mesh` uses for `autoBounds`. Writes `out` when given.
 */
export function computeBounds(
  vertices: Float32Array,
  floats = GEOMETRY_FLOATS,
  out: MeshBounds = { center: [0, 0, 0], radius: 0 },
): MeshBounds {
  const n = vertices.length;
  if (n === 0) {
    out.center[0] = out.center[1] = out.center[2] = 0;
    out.radius = 0;
    return out;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let o = 0; o < n; o += floats) {
    const x = vertices[o]!;
    const y = vertices[o + 1]!;
    const z = vertices[o + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let o = 0; o < n; o += floats) {
    const dx = vertices[o]! - cx;
    const dy = vertices[o + 1]! - cy;
    const dz = vertices[o + 2]! - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  out.center[0] = cx;
  out.center[1] = cy;
  out.center[2] = cz;
  out.radius = Math.sqrt(r2);
  return out;
}

/**
 * One geometry from several: vertices concatenated, indices offset by the vertices before them,
 * promoted to `Uint32Array` when the total passes 65535 vertices, bounds recomputed. Every input
 * must share one layout (the first's); the inputs are left untouched. No inputs give an empty
 * geometry in `VERTEX_LAYOUT_3D`.
 */
export function mergeGeometry(...parts: Geometry[]): Geometry {
  const layout = parts[0]?.layout ?? VERTEX_LAYOUT_3D;
  const floats = layout.floats;
  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    if (p.layout !== layout) {
      throw new Error(`geom: mergeGeometry mixes layouts '${layout.name}' and '${p.layout.name}'`);
    }
    vTotal += p.vertices.length / floats;
    iTotal += p.indices.length;
  }
  const vertices = new Float32Array(vTotal * floats);
  const indices = createIndices(vTotal, iTotal);
  let vo = 0;
  let io = 0;
  let base = 0;
  for (const p of parts) {
    vertices.set(p.vertices, vo);
    vo += p.vertices.length;
    const src = p.indices;
    for (let k = 0; k < src.length; k++) indices[io + k] = src[k]! + base;
    io += src.length;
    base += p.vertices.length / floats;
  }
  // Only the 3D layout has xyz positions to bound; any other is left unbounded (never culled).
  const bounds: MeshBounds =
    layout === VERTEX_LAYOUT_3D
      ? computeBounds(vertices)
      : { center: [0, 0, 0], radius: Number.POSITIVE_INFINITY };
  return { vertices, indices, bounds, layout };
}

/**
 * Transform `g` in place by a 3×4 row-major world matrix (`Transform.world`,
 * `MATRIX3X4_FLOATS`): positions by the full matrix, normals by the inverse transpose of its
 * 3×3 part (so non-uniform scale keeps them perpendicular), renormalised. The bounds are
 * recomputed. Returns `g`. A singular 3×3 (a zero scale) leaves the normals as they were. The
 * geometry must be in `VERTEX_LAYOUT_3D`.
 */
export function transformGeometry(g: Geometry, world: ArrayLike<number>): Geometry {
  if (g.layout !== VERTEX_LAYOUT_3D) {
    throw new Error(`geom: transformGeometry needs VERTEX_LAYOUT_3D, got '${g.layout.name}'`);
  }
  const m00 = world[0]!;
  const m01 = world[1]!;
  const m02 = world[2]!;
  const tx = world[3]!;
  const m10 = world[4]!;
  const m11 = world[5]!;
  const m12 = world[6]!;
  const ty = world[7]!;
  const m20 = world[8]!;
  const m21 = world[9]!;
  const m22 = world[10]!;
  const tz = world[11]!;
  // Inverse transpose of the 3×3: cofactors / det, laid out transposed.
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  const c10 = m02 * m21 - m01 * m22;
  const c11 = m00 * m22 - m02 * m20;
  const c12 = m01 * m20 - m00 * m21;
  const c20 = m01 * m12 - m02 * m11;
  const c21 = m02 * m10 - m00 * m12;
  const c22 = m00 * m11 - m01 * m10;
  const det = m00 * c00 + m01 * c01 + m02 * c02;
  const singular = Math.abs(det) < 1e-20;
  const v = g.vertices;
  for (let o = 0; o < v.length; o += GEOMETRY_FLOATS) {
    const x = v[o]!;
    const y = v[o + 1]!;
    const z = v[o + 2]!;
    v[o] = m00 * x + m01 * y + m02 * z + tx;
    v[o + 1] = m10 * x + m11 * y + m12 * z + ty;
    v[o + 2] = m20 * x + m21 * y + m22 * z + tz;
    if (singular) continue;
    const nx = v[o + 3]!;
    const ny = v[o + 4]!;
    const nz = v[o + 5]!;
    // n' = (M^-1)^T n = cofactor matrix · n (the 1/det cancels in the normalisation, up to sign).
    let rx = c00 * nx + c01 * ny + c02 * nz;
    let ry = c10 * nx + c11 * ny + c12 * nz;
    let rz = c20 * nx + c21 * ny + c22 * nz;
    if (det < 0) {
      rx = -rx;
      ry = -ry;
      rz = -rz;
    }
    const len = Math.hypot(rx, ry, rz);
    if (len > 0) {
      v[o + 3] = rx / len;
      v[o + 4] = ry / len;
      v[o + 5] = rz / len;
    }
  }
  computeBounds(v, GEOMETRY_FLOATS, g.bounds);
  return g;
}
