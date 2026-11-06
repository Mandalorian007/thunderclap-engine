/**
 * Convex hulls (`convexHull`, 3D quickhull) and cheap collision stand-ins for render meshes
 * (`collisionProxy`). Build-time work: allocates freely, deterministic for a given input.
 */
import { VERTEX_LAYOUT_3D } from '../render/mesh';
import { computeBounds, createIndices, type Geometry } from './geometry';
import { simplifyGeometry } from './simplify';

const F3 = VERTEX_LAYOUT_3D.floats;

interface Face {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
  /** Indices of the points still outside this face. */
  outside: number[];
  alive: boolean;
}

function emptyGeometry(): Geometry {
  return {
    vertices: new Float32Array(0),
    indices: new Uint16Array(0),
    bounds: { center: [0, 0, 0], radius: 0 },
    layout: VERTEX_LAYOUT_3D,
  };
}

/** xyz triples from a positions array or a geometry's position lane (float 0 of each vertex). */
function pointsOf(src: Float32Array | Geometry): Float64Array {
  if (src instanceof Float32Array) {
    if (src.length % 3 !== 0)
      throw new Error(`geom: convexHull positions need xyz triples, got ${src.length} floats`);
    return Float64Array.from(src);
  }
  const F = src.layout.floats;
  const n = src.vertices.length / F;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = src.vertices[i * F]!;
    out[i * 3 + 1] = src.vertices[i * F + 1]!;
    out[i * 3 + 2] = src.vertices[i * F + 2]!;
  }
  return out;
}

/**
 * The convex hull of a point set (xyz triples, or a geometry's positions) as a flat-shaded
 * `VERTEX_LAYOUT_3D` geometry: three vertices per triangle, wound counter-clockwise seen from
 * outside, each carrying its face normal, uv 0 and white. Quickhull: start from a tetrahedron of
 * extreme points, then repeatedly lift the farthest outside point of a face, replacing the faces
 * it sees with a fan from their horizon. Points within a small tolerance of a face (scaled to the
 * cloud's extent) count as on it, so a cube's corners give 12 triangles however noisy its inside.
 * Fewer than four points, or a flat or collinear cloud, has no volume: the result is empty.
 */
export function convexHull(src: Float32Array | Geometry): Geometry {
  const p = pointsOf(src);
  const n = p.length / 3;
  if (n < 4) return emptyGeometry();
  const x = (i: number) => p[i * 3]!;
  const y = (i: number) => p[i * 3 + 1]!;
  const z = (i: number) => p[i * 3 + 2]!;

  // Extreme points on each axis; the widest pair seeds the hull.
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      if (p[i * 3 + k]! < p[lo[k]! * 3 + k]!) lo[k] = i;
      if (p[i * 3 + k]! > p[hi[k]! * 3 + k]!) hi[k] = i;
    }
  }
  let axis = 0;
  let span = -1;
  for (let k = 0; k < 3; k++) {
    const s = p[hi[k]! * 3 + k]! - p[lo[k]! * 3 + k]!;
    if (s > span) {
      span = s;
      axis = k;
    }
  }
  const eps = 1e-9 + 1e-6 * span;
  if (!(span > eps)) return emptyGeometry();
  const i0 = lo[axis]!;
  const i1 = hi[axis]!;
  // Farthest from the line i0 i1.
  const ex = x(i1) - x(i0);
  const ey = y(i1) - y(i0);
  const ez = z(i1) - z(i0);
  let i2 = -1;
  let best = eps * eps;
  for (let i = 0; i < n; i++) {
    const vx = x(i) - x(i0);
    const vy = y(i) - y(i0);
    const vz = z(i) - z(i0);
    const cx = vy * ez - vz * ey;
    const cy = vz * ex - vx * ez;
    const cz = vx * ey - vy * ex;
    const d = cx * cx + cy * cy + cz * cz;
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0) return emptyGeometry();
  // Farthest from the plane i0 i1 i2.
  const fx = x(i2) - x(i0);
  const fy = y(i2) - y(i0);
  const fz = z(i2) - z(i0);
  let pnx = ey * fz - ez * fy;
  let pny = ez * fx - ex * fz;
  let pnz = ex * fy - ey * fx;
  const pl = Math.hypot(pnx, pny, pnz);
  pnx /= pl;
  pny /= pl;
  pnz /= pl;
  let i3 = -1;
  let bestD = eps;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((x(i) - x(i0)) * pnx + (y(i) - y(i0)) * pny + (z(i) - z(i0)) * pnz);
    if (d > bestD) {
      bestD = d;
      i3 = i;
    }
  }
  if (i3 < 0) return emptyGeometry();

  const faces: Face[] = [];
  const makeFace = (a: number, b: number, c: number): Face => {
    const ux = x(b) - x(a);
    const uy = y(b) - y(a);
    const uz = z(b) - z(a);
    const vx = x(c) - x(a);
    const vy = y(c) - y(a);
    const vz = z(c) - z(a);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const f: Face = {
      a,
      b,
      c,
      nx,
      ny,
      nz,
      d: nx * x(a) + ny * y(a) + nz * z(a),
      outside: [],
      alive: true,
    };
    faces.push(f);
    edgeOwner.set(a * n + b, f);
    edgeOwner.set(b * n + c, f);
    edgeOwner.set(c * n + a, f);
    return f;
  };
  /** Directed edge `a → b` (key `a · n + b`) to the live face it bounds counter-clockwise. */
  const edgeOwner = new Map<number, Face>();
  const dist = (f: Face, i: number) => f.nx * x(i) + f.ny * y(i) + f.nz * z(i) - f.d;

  // The tetrahedron, wound outward (away from i3 for the base).
  const above = (x(i3) - x(i0)) * pnx + (y(i3) - y(i0)) * pny + (z(i3) - z(i0)) * pnz > 0;
  const seed = above
    ? [makeFace(i0, i2, i1), makeFace(i0, i1, i3), makeFace(i1, i2, i3), makeFace(i2, i0, i3)]
    : [makeFace(i0, i1, i2), makeFace(i0, i3, i1), makeFace(i1, i3, i2), makeFace(i2, i3, i0)];
  const assign = (candidates: readonly Face[], i: number) => {
    let bestFace: Face | undefined;
    let bd = eps;
    for (const f of candidates) {
      const d = dist(f, i);
      if (d > bd) {
        bd = d;
        bestFace = f;
      }
    }
    bestFace?.outside.push(i);
  };
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1 || i === i2 || i === i3) continue;
    assign(seed, i);
  }

  // Faces still to process, in creation order: deterministic.
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi]!;
    if (!face.alive || face.outside.length === 0) continue;
    // The farthest outside point (lowest index on ties).
    let eye = -1;
    let ed = -1;
    for (const i of face.outside) {
      const d = dist(face, i);
      if (d > ed) {
        ed = d;
        eye = i;
      }
    }
    // Every face the eye sees: a flood across shared edges from this face (the visible region of
    // a convex hull is connected). Its horizon is the edges whose far face does not see the eye.
    face.alive = false;
    const visible: Face[] = [face];
    const horizon: number[] = [];
    for (let k = 0; k < visible.length; k++) {
      const f = visible[k]!;
      for (const [a, b] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as const) {
        const g = edgeOwner.get(b * n + a);
        if (!g?.alive) continue;
        if (dist(g, eye) > eps) {
          g.alive = false;
          visible.push(g);
        } else horizon.push(a, b);
      }
    }
    for (const f of visible) {
      edgeOwner.delete(f.a * n + f.b);
      edgeOwner.delete(f.b * n + f.c);
      edgeOwner.delete(f.c * n + f.a);
    }
    const created: Face[] = [];
    for (let k = 0; k < horizon.length; k += 2)
      created.push(makeFace(horizon[k]!, horizon[k + 1]!, eye));
    for (const f of visible) {
      for (const i of f.outside) if (i !== eye) assign(created, i);
      f.outside = [];
    }
  }

  const live = faces.filter((f) => f.alive);
  const vertices = new Float32Array(live.length * 3 * F3);
  let o = 0;
  for (const f of live) {
    for (const i of [f.a, f.b, f.c]) {
      vertices[o] = x(i);
      vertices[o + 1] = y(i);
      vertices[o + 2] = z(i);
      vertices[o + 3] = f.nx;
      vertices[o + 4] = f.ny;
      vertices[o + 5] = f.nz;
      vertices[o + 8] = 1;
      vertices[o + 9] = 1;
      vertices[o + 10] = 1;
      vertices[o + 11] = 1;
      o += F3;
    }
  }
  const count = live.length * 3;
  const indices = createIndices(count, count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return { vertices, indices, bounds: computeBounds(vertices, F3), layout: VERTEX_LAYOUT_3D };
}

export interface CollisionProxyOptions {
  /** Most triangles the proxy may have. */
  maxTriangles: number;
  /**
   * `'hull'` (default): the convex hull, simplified further when it is over budget; solid and
   * cheapest to query, but it fills concavities. `'simplified'`: the mesh itself simplified to
   * the budget; keeps its shape, concavities included.
   */
  kind?: 'hull' | 'simplified';
}

/**
 * A low-triangle stand-in for `g` to hand `createStaticCollider` (as `{ geometry }`) in place of
 * the render mesh: at most `maxTriangles` triangles, in `VERTEX_LAYOUT_3D` for `'hull'` and in
 * `g`'s layout for `'simplified'`.
 */
export function collisionProxy(g: Geometry, opts: CollisionProxyOptions): Geometry {
  const max = Math.max(0, Math.floor(opts.maxTriangles));
  const toBudget = (s: Geometry): Geometry => {
    let out = s;
    // Simplification can stall short of the target where a collapse would fold the surface; a
    // tighter target then gets there.
    for (let k = 0; out.indices.length / 3 > max && k < 8; k++) {
      const over = out.indices.length / 3 - max;
      out = simplifyGeometry(out, { targetTriangles: Math.max(0, max - over) }).geometry;
    }
    return out;
  };
  if ((opts.kind ?? 'hull') === 'simplified') {
    if (g.indices.length / 3 <= max) return g;
    return toBudget(simplifyGeometry(g, { targetTriangles: max }).geometry);
  }
  const hull = convexHull(g);
  if (hull.indices.length / 3 <= max) return hull;
  return toBudget(simplifyGeometry(hull, { targetTriangles: max }).geometry);
}
