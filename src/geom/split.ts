/**
 * Cutting geometry apart: `splitGeometry` into connected islands or caller-chosen groups,
 * `sliceGeometry` by a plane into the parts above and below, the cut optionally capped
 * (`triangulate`). Build-time work: allocates freely, deterministic for a given input.
 */
import { VERTEX_LAYOUT_3D, VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { cloneGeometry, computeBounds, createIndices, type Geometry } from './geometry';
import { triangulate } from './triangulate';

function floatsOf(g: Geometry, what: string): number {
  if (g.layout !== VERTEX_LAYOUT_3D && g.layout !== VERTEX_LAYOUT_3D_TANGENT) {
    throw new Error(`geom: ${what} needs a 3D vertex layout, got '${g.layout.name}'`);
  }
  return g.layout.floats;
}

/** A geometry from `g`'s vertices over a list of its triangle indices (only the used vertices). */
function subset(g: Geometry, F: number, tris: readonly number[]): Geometry {
  const map = new Map<number, number>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const i = g.indices[t * 3 + k]!;
      if (!map.has(i)) map.set(i, map.size);
    }
  }
  const vertices = new Float32Array(map.size * F);
  for (const [i, o] of map) vertices.set(g.vertices.subarray(i * F, i * F + F), o * F);
  const indices = createIndices(map.size, tris.length * 3);
  let o = 0;
  for (const t of tris) for (let k = 0; k < 3; k++) indices[o++] = map.get(g.indices[t * 3 + k]!)!;
  return { vertices, indices, bounds: computeBounds(vertices, F), layout: g.layout };
}

/** Position key: exact xyz with -0 folded into 0, so seam duplicates of a vertex share one. */
function posKey(v: Float32Array, o: number): string {
  return `${v[o]! + 0},${v[o + 1]! + 0},${v[o + 2]! + 0}`;
}

/**
 * Split `g` into parts. `'island'`: connected components, triangles joined where they share a
 * vertex position (so a UV or normal seam does not split a mesh), in order of each island's
 * first triangle. A function: `by(triangle)` (the triangle's index, `indices[3t..3t+2]`) names
 * each triangle's group, a negative number drops it, and the groups come back in ascending
 * order of their number. Each part holds only the vertices it uses, in `g`'s layout.
 */
export function splitGeometry(
  g: Geometry,
  by: 'island' | ((triangle: number) => number),
): Geometry[] {
  const F = floatsOf(g, 'splitGeometry');
  const T = Math.floor(g.indices.length / 3);
  const group = new Float64Array(T);
  if (by === 'island') {
    // Union-find over positions, then each triangle takes its first corner's root.
    const ids = new Map<string, number>();
    const pos = new Int32Array(g.vertices.length / F);
    for (let i = 0; i < pos.length; i++) {
      const k = posKey(g.vertices, i * F);
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
      }
      pos[i] = id;
    }
    const parent = Int32Array.from({ length: ids.size }, (_, i) => i);
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]!]!;
        a = parent[a]!;
      }
      return a;
    };
    const join = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    for (let t = 0; t < T; t++) {
      const a = pos[g.indices[t * 3]!]!;
      join(a, pos[g.indices[t * 3 + 1]!]!);
      join(a, pos[g.indices[t * 3 + 2]!]!);
    }
    // Number islands by first appearance.
    const order = new Map<number, number>();
    for (let t = 0; t < T; t++) {
      const r = find(pos[g.indices[t * 3]!]!);
      let n = order.get(r);
      if (n === undefined) {
        n = order.size;
        order.set(r, n);
      }
      group[t] = n;
    }
  } else {
    for (let t = 0; t < T; t++) group[t] = by(t);
  }
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const k = group[t]!;
    if (!(k >= 0)) continue;
    const list = buckets.get(k);
    if (list) list.push(t);
    else buckets.set(k, [t]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => subset(g, F, buckets.get(k)!));
}

/** A plane: the points `p` with `n · p = d`; "above" is the side `n` points to. */
export interface SlicePlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

export interface SliceOptions {
  /**
   * Close each half where it was cut: every loop of the cut outline is triangulated as its own
   * polygon (a loop inside another is not treated as a hole), facing out of its half, uv the
   * cut's planar coordinates. Default false. Only a closed input leaves closed loops.
   */
  cap?: boolean;
}

export interface SliceResult {
  above: Geometry;
  below: Geometry;
}

/** Growable float and index buffers for one half. */
class Part {
  verts: number[] = [];
  idx: number[] = [];
  constructor(readonly F: number) {}
  add(src: ArrayLike<number>, o: number): number {
    const at = this.verts.length / this.F;
    for (let k = 0; k < this.F; k++) this.verts.push(src[o + k]!);
    return at;
  }
  build(layout: Geometry['layout']): Geometry {
    const vertices = new Float32Array(this.verts);
    const n = vertices.length / this.F;
    const indices = createIndices(n, this.idx.length);
    indices.set(this.idx);
    return { vertices, indices, bounds: computeBounds(vertices, this.F), layout };
  }
}

/**
 * Cut `g` by `plane` into the triangles above it and below it, each triangle the plane crosses
 * split along the cut (every lane interpolated linearly; normals and tangents renormalised), so
 * the two halves meet without cracks. A triangle lying in the plane goes below when it faces the
 * normal's way and above otherwise, so slicing a box at its top face leaves it whole below.
 * A plane that misses `g` leaves everything on one side and an empty geometry on the other.
 * Both halves are in `g`'s layout.
 */
export function sliceGeometry(
  g: Geometry,
  plane: SlicePlane,
  opts: SliceOptions = {},
): SliceResult {
  const F = floatsOf(g, 'sliceGeometry');
  const tangent = g.layout === VERTEX_LAYOUT_3D_TANGENT;
  const nl = Math.hypot(plane.nx, plane.ny, plane.nz);
  if (!(nl > 0)) throw new Error('geom: sliceGeometry needs a plane with a non-zero normal');
  const nx = plane.nx / nl;
  const ny = plane.ny / nl;
  const nz = plane.nz / nl;
  const d = plane.d / nl;
  const v = g.vertices;
  const vCount = v.length / F;
  const eps = 1e-6 * Math.max(1, g.bounds.radius);
  const side = new Float64Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const s = nx * v[i * F]! + ny * v[i * F + 1]! + nz * v[i * F + 2]! - d;
    side[i] = Math.abs(s) <= eps ? 0 : s;
  }
  // Wholly on one side: that side is a copy of `g` (vertex order kept), the other empty.
  let minSide = Number.POSITIVE_INFINITY;
  let maxSide = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < vCount; i++) {
    if (side[i]! < minSide) minSide = side[i]!;
    if (side[i]! > maxSide) maxSide = side[i]!;
  }
  if (maxSide < 0 || minSide > 0) {
    const empty = new Part(F).build(g.layout);
    return maxSide < 0
      ? { above: empty, below: cloneGeometry(g) }
      : { above: cloneGeometry(g), below: empty };
  }
  const above = new Part(F);
  const below = new Part(F);
  /** Source vertex → its index in each half. */
  const inAbove = new Int32Array(vCount).fill(-1);
  const inBelow = new Int32Array(vCount).fill(-1);
  const vertexIn = (part: Part, map: Int32Array, i: number): number => {
    if (map[i]! < 0) map[i] = part.add(v, i * F);
    return map[i]!;
  };
  /** Cut points by source edge (`min · n + max`), one vertex shared by both halves' copies. */
  const cutAbove = new Map<number, number>();
  const cutBelow = new Map<number, number>();
  const tmp = new Float64Array(F);
  const cutPoint = (i: number, j: number): void => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const t = side[a]! / (side[a]! - side[b]!);
    for (let k = 0; k < F; k++) tmp[k] = v[a * F + k]! + (v[b * F + k]! - v[a * F + k]!) * t;
    // Project onto the plane exactly, then renormalise the direction lanes.
    const s = nx * tmp[0]! + ny * tmp[1]! + nz * tmp[2]! - d;
    tmp[0] = tmp[0]! - nx * s;
    tmp[1] = tmp[1]! - ny * s;
    tmp[2] = tmp[2]! - nz * s;
    const l = Math.hypot(tmp[3]!, tmp[4]!, tmp[5]!);
    if (l > 0) for (let k = 3; k < 6; k++) tmp[k] = tmp[k]! / l;
    if (tangent) {
      const m = Math.hypot(tmp[12]!, tmp[13]!, tmp[14]!);
      if (m > 0) for (let k = 12; k < 15; k++) tmp[k] = tmp[k]! / m;
      tmp[15] = v[a * F + 15]!;
    }
  };
  const cutIn = (part: Part, map: Map<number, number>, i: number, j: number): number => {
    const key = Math.min(i, j) * vCount + Math.max(i, j);
    let at = map.get(key);
    if (at === undefined) {
      cutPoint(i, j);
      at = part.add(tmp, 0);
      map.set(key, at);
    }
    return at;
  };
  /**
   * The below half's cut outline, as directed segments (xyz pairs, six floats each) wound
   * counter-clockwise about `+n`: every below edge lying in the plane, reversed. A face lying in
   * the plane contributes too, so its edges cancel the walls' (`capCut` drops opposite pairs).
   */
  const segments: number[] = [];
  // A corner of a half's polygon: `k` a source vertex, `[i, j]` the cut point on edge ij.
  type Corner = number | readonly [number, number];
  const inPlane = (c: Corner) => typeof c !== 'number' || side[c] === 0;
  const emit = (
    part: Part,
    vmap: Int32Array,
    cmap: Map<number, number>,
    poly: readonly Corner[],
  ): void => {
    const at = poly.map((c) =>
      typeof c === 'number' ? vertexIn(part, vmap, c) : cutIn(part, cmap, c[0], c[1]),
    );
    for (let k = 1; k + 1 < at.length; k++) part.idx.push(at[0]!, at[k]!, at[k + 1]!);
    if (part !== below) return;
    const p = part.verts;
    for (let k = 0; k < poly.length; k++) {
      const n = (k + 1) % poly.length;
      if (!inPlane(poly[k]!) || !inPlane(poly[n]!)) continue;
      const a = at[n]! * F;
      const b = at[k]! * F;
      segments.push(p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!);
    }
  };

  const idx = g.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const tri = [idx[t]!, idx[t + 1]!, idx[t + 2]!] as const;
    const s0 = side[tri[0]]!;
    const s1 = side[tri[1]]!;
    const s2 = side[tri[2]]!;
    const pos = (s0 > 0 ? 1 : 0) + (s1 > 0 ? 1 : 0) + (s2 > 0 ? 1 : 0);
    const neg = (s0 < 0 ? 1 : 0) + (s1 < 0 ? 1 : 0) + (s2 < 0 ? 1 : 0);
    if (neg === 0 && pos === 0) {
      // In the plane: below when it faces along the normal.
      const [a, b, c] = tri;
      const ux = v[b * F]! - v[a * F]!;
      const uy = v[b * F + 1]! - v[a * F + 1]!;
      const uz = v[b * F + 2]! - v[a * F + 2]!;
      const wx = v[c * F]! - v[a * F]!;
      const wy = v[c * F + 1]! - v[a * F + 1]!;
      const wz = v[c * F + 2]! - v[a * F + 2]!;
      const dot = nx * (uy * wz - uz * wy) + ny * (uz * wx - ux * wz) + nz * (ux * wy - uy * wx);
      if (dot > 0) emit(below, inBelow, cutBelow, tri);
      else emit(above, inAbove, cutAbove, tri);
    } else if (neg === 0) {
      emit(above, inAbove, cutAbove, tri);
    } else if (pos === 0) {
      emit(below, inBelow, cutBelow, tri);
    } else {
      // Crossing: walk the corners, dropping a cut point on every sign change.
      const up: Corner[] = [];
      const down: Corner[] = [];
      for (let k = 0; k < 3; k++) {
        const i = tri[k]!;
        const j = tri[(k + 1) % 3]!;
        const si = side[i]!;
        const sj = side[j]!;
        if (si >= 0) up.push(i);
        if (si <= 0) down.push(i);
        if ((si > 0 && sj < 0) || (si < 0 && sj > 0)) {
          const c = [i, j] as const;
          up.push(c);
          down.push(c);
        }
      }
      emit(above, inAbove, cutAbove, up);
      emit(below, inBelow, cutBelow, down);
    }
  }

  if (opts.cap) capCut(segments, nx, ny, nz, F, tangent, above, below, eps);
  return { above: above.build(g.layout), below: below.build(g.layout) };
}

/**
 * Chain the cut segments into loops and triangulate each into both halves: facing `+n` on the
 * below half, `-n` on the above half.
 */
function capCut(
  segments: readonly number[],
  nx: number,
  ny: number,
  nz: number,
  F: number,
  tangent: boolean,
  above: Part,
  below: Part,
  eps: number,
): void {
  // The plane basis: u, w with u × w = n.
  const ax = Math.abs(nx) < 0.9 ? 1 : 0;
  const ay = ax ? 0 : 1;
  let ux = ay * nz;
  let uy = -ax * nz;
  let uz = ax * ny - ay * nx;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = ny * uz - nz * uy;
  const wy = nz * ux - nx * uz;
  const wz = nx * uy - ny * ux;
  // Points welded by quantised position; each segment a directed link start → end.
  const q = 1 / (eps * 10);
  const key = (o: number) =>
    `${Math.round(segments[o]! * q)},${Math.round(segments[o + 1]! * q)},${Math.round(segments[o + 2]! * q)}`;
  const ids = new Map<string, number>();
  const pts: number[] = [];
  const idOf = (o: number) => {
    const k = key(o);
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
      pts.push(segments[o]!, segments[o + 1]!, segments[o + 2]!);
    }
    return id;
  };
  // Opposite segments cancel (an edge between a wall and a face lying in the plane).
  const links = new Map<string, number>();
  for (let s = 0; s < segments.length; s += 6) {
    const a = idOf(s);
    const b = idOf(s + 3);
    if (a === b) continue;
    const back = `${b}>${a}`;
    const n = links.get(back) ?? 0;
    if (n > 0) links.set(back, n - 1);
    else links.set(`${a}>${b}`, (links.get(`${a}>${b}`) ?? 0) + 1);
  }
  const nextOf = new Map<number, number>();
  for (const [k, n] of links) {
    if (n <= 0) continue;
    const [a, b] = k.split('>').map(Number) as [number, number];
    nextOf.set(a, b);
  }
  const used = new Set<number>();
  const vert = new Float32Array(F);
  for (const start of [...nextOf.keys()].sort((a, b) => a - b)) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let p: number | undefined = start;
    while (p !== undefined && !used.has(p)) {
      used.add(p);
      loop.push(p);
      p = nextOf.get(p);
    }
    if (p !== start || loop.length < 3) continue; // open chain: nothing to close
    const profile: number[] = [];
    for (const id of loop) {
      const x = pts[id * 3]!;
      const y = pts[id * 3 + 1]!;
      const z = pts[id * 3 + 2]!;
      profile.push(x * ux + y * uy + z * uz, x * wx + y * wy + z * wz);
    }
    const tris = triangulate(profile);
    for (const [part, sign] of [
      [below, 1],
      [above, -1],
    ] as const) {
      const base = part.verts.length / F;
      for (let k = 0; k < loop.length; k++) {
        const id = loop[k]!;
        vert.fill(0);
        vert[0] = pts[id * 3]!;
        vert[1] = pts[id * 3 + 1]!;
        vert[2] = pts[id * 3 + 2]!;
        vert[3] = nx * sign;
        vert[4] = ny * sign;
        vert[5] = nz * sign;
        vert[6] = profile[k * 2]!;
        vert[7] = profile[k * 2 + 1]!;
        vert[8] = vert[9] = vert[10] = vert[11] = 1;
        if (tangent) {
          vert[12] = ux * sign;
          vert[13] = uy * sign;
          vert[14] = uz * sign;
          vert[15] = 1;
        }
        part.add(vert, 0);
      }
      // `triangulate` winds counter-clockwise in (u, w), which faces +n.
      for (let t = 0; t < tris.length; t += 3) {
        const a = base + tris[t]!;
        const b = base + tris[t + 1]!;
        const c = base + tris[t + 2]!;
        if (sign > 0) part.idx.push(a, b, c);
        else part.idx.push(a, c, b);
      }
    }
  }
}
