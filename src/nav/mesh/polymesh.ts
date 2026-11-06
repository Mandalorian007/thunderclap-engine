/**
 * Navmesh bake, stage four: contours to convex polygons. Each contour is ear-clipped into
 * triangles, triangles are merged pairwise while the result stays convex and under
 * `maxVertsPerPoly`, vertices are shared between contours, and every polygon learns its
 * neighbour across each edge. Recast `rcBuildPolyMesh`, in cells.
 */
import type { Contour } from './contour';

export interface PolyMesh {
  /** `x, y, z` per vertex (cells). */
  verts: Int32Array;
  vertCount: number;
  /** `maxVertsPerPoly` indices per polygon, -1 padded. */
  polys: Int32Array;
  /** `maxVertsPerPoly` neighbour polygons per polygon (per edge `i` from vertex `i` to `i + 1`), -1 none. */
  adjacency: Int32Array;
  regs: Uint16Array;
  areas: Uint8Array;
  polyCount: number;
  maxVertsPerPoly: number;
}

const REMOVABLE = 0x80000000;
const INDEX_MASK = 0x0fffffff;

function next(i: number, n: number): number {
  return i + 1 < n ? i + 1 : 0;
}
function prev(i: number, n: number): number {
  return i - 1 >= 0 ? i - 1 : n - 1;
}

/** Twice the signed area in XZ of contour vertices `a, b, c` (each an index × 4 into `v`). */
function area2(v: number[], a: number, b: number, c: number): number {
  return (v[b]! - v[a]!) * (v[c + 2]! - v[a + 2]!) - (v[c]! - v[a]!) * (v[b + 2]! - v[a + 2]!);
}
function left(v: number[], a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) < 0;
}
function leftOn(v: number[], a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) <= 0;
}
function collinear(v: number[], a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) === 0;
}
function intersectProp(v: number[], a: number, b: number, c: number, d: number): boolean {
  if (
    collinear(v, a, b, c) ||
    collinear(v, a, b, d) ||
    collinear(v, c, d, a) ||
    collinear(v, c, d, b)
  ) {
    return false;
  }
  return left(v, a, b, c) !== left(v, a, b, d) && left(v, c, d, a) !== left(v, c, d, b);
}
function between(v: number[], a: number, b: number, c: number): boolean {
  if (!collinear(v, a, b, c)) return false;
  if (v[a] !== v[b]) {
    return (v[a]! <= v[c]! && v[c]! <= v[b]!) || (v[a]! >= v[c]! && v[c]! >= v[b]!);
  }
  return (
    (v[a + 2]! <= v[c + 2]! && v[c + 2]! <= v[b + 2]!) ||
    (v[a + 2]! >= v[c + 2]! && v[c + 2]! >= v[b + 2]!)
  );
}
function intersect(v: number[], a: number, b: number, c: number, d: number): boolean {
  if (intersectProp(v, a, b, c, d)) return true;
  return between(v, a, b, c) || between(v, a, b, d) || between(v, c, d, a) || between(v, c, d, b);
}
function vequal(v: number[], a: number, b: number): boolean {
  return v[a] === v[b] && v[a + 2] === v[b + 2];
}

function vi(indices: Int32Array, i: number): number {
  return (indices[i]! & INDEX_MASK) * 4;
}

function diagonalie(
  i: number,
  j: number,
  n: number,
  v: number[],
  indices: Int32Array,
  loose: boolean,
): boolean {
  const d0 = vi(indices, i);
  const d1 = vi(indices, j);
  for (let k = 0; k < n; k++) {
    const k1 = next(k, n);
    if (!(k === i || k1 === i || k === j || k1 === j)) {
      const p0 = vi(indices, k);
      const p1 = vi(indices, k1);
      if (vequal(v, d0, p0) || vequal(v, d1, p0) || vequal(v, d0, p1) || vequal(v, d1, p1))
        continue;
      if (loose ? intersectProp(v, d0, d1, p0, p1) : intersect(v, d0, d1, p0, p1)) return false;
    }
  }
  return true;
}

function inCone(
  i: number,
  j: number,
  n: number,
  v: number[],
  indices: Int32Array,
  loose: boolean,
): boolean {
  const pi = vi(indices, i);
  const pj = vi(indices, j);
  const pi1 = vi(indices, next(i, n));
  const pin1 = vi(indices, prev(i, n));
  if (leftOn(v, pin1, pi, pi1)) {
    return loose
      ? leftOn(v, pi, pj, pin1) && leftOn(v, pj, pi, pi1)
      : left(v, pi, pj, pin1) && left(v, pj, pi, pi1);
  }
  return !(leftOn(v, pi, pj, pi1) && leftOn(v, pj, pi, pin1));
}

function diagonal(
  i: number,
  j: number,
  n: number,
  v: number[],
  indices: Int32Array,
  loose = false,
): boolean {
  return inCone(i, j, n, v, indices, loose) && diagonalie(i, j, n, v, indices, loose);
}

/** Ear-clips a contour into triangles of contour-vertex indices; negative when it had to give up. */
function triangulate(n0: number, v: number[], indices: Int32Array, tris: Int32Array): number {
  let n = n0;
  let ntris = 0;
  let dst = 0;
  for (let i = 0; i < n; i++) {
    const i1 = next(i, n);
    const i2 = next(i1, n);
    if (diagonal(i, i2, n, v, indices)) indices[i1] = indices[i1]! | REMOVABLE;
  }
  while (n > 3) {
    let minLen = -1;
    let mini = -1;
    for (let i = 0; i < n; i++) {
      const i1 = next(i, n);
      if (indices[i1]! & REMOVABLE) {
        const p0 = vi(indices, i);
        const p2 = vi(indices, next(i1, n));
        const dx = v[p2]! - v[p0]!;
        const dz = v[p2 + 2]! - v[p0 + 2]!;
        const len = dx * dx + dz * dz;
        if (minLen < 0 || len < minLen) {
          minLen = len;
          mini = i;
        }
      }
    }
    if (mini === -1) {
      minLen = -1;
      for (let i = 0; i < n; i++) {
        const i1 = next(i, n);
        const i2 = next(i1, n);
        if (diagonal(i, i2, n, v, indices, true)) {
          const p0 = vi(indices, i);
          const p2 = vi(indices, i2);
          const dx = v[p2]! - v[p0]!;
          const dz = v[p2 + 2]! - v[p0 + 2]!;
          const len = dx * dx + dz * dz;
          if (minLen < 0 || len < minLen) {
            minLen = len;
            mini = i;
          }
        }
      }
      if (mini === -1) return -ntris;
    }
    let i = mini;
    let i1 = next(i, n);
    const i2 = next(i1, n);
    tris[dst++] = indices[i]! & INDEX_MASK;
    tris[dst++] = indices[i1]! & INDEX_MASK;
    tris[dst++] = indices[i2]! & INDEX_MASK;
    ntris++;
    n--;
    for (let k = i1; k < n; k++) indices[k] = indices[k + 1]!;
    if (i1 >= n) i1 = 0;
    i = prev(i1, n);
    if (diagonal(prev(i, n), i1, n, v, indices)) indices[i] = indices[i]! | REMOVABLE;
    else indices[i] = indices[i]! & INDEX_MASK;
    if (diagonal(i, next(i1, n), n, v, indices)) indices[i1] = indices[i1]! | REMOVABLE;
    else indices[i1] = indices[i1]! & INDEX_MASK;
  }
  tris[dst++] = indices[0]! & INDEX_MASK;
  tris[dst++] = indices[1]! & INDEX_MASK;
  tris[dst++] = indices[2]! & INDEX_MASK;
  ntris++;
  return ntris;
}

function countPolyVerts(polys: Int32Array, p: number, nvp: number): number {
  for (let i = 0; i < nvp; i++) if (polys[p + i] === -1) return i;
  return nvp;
}

function uleft(verts: Int32Array, a: number, b: number, c: number): boolean {
  return (
    (verts[b * 3]! - verts[a * 3]!) * (verts[c * 3 + 2]! - verts[a * 3 + 2]!) -
      (verts[c * 3]! - verts[a * 3]!) * (verts[b * 3 + 2]! - verts[a * 3 + 2]!) <
    0
  );
}

const mergeEdge = [0, 0];

/** The squared length of the shared edge when `pa` and `pb` can merge into a convex polygon, else -1. */
function polyMergeValue(
  polys: Int32Array,
  pa: number,
  pb: number,
  verts: Int32Array,
  nvp: number,
): number {
  const na = countPolyVerts(polys, pa, nvp);
  const nb = countPolyVerts(polys, pb, nvp);
  if (na + nb - 2 > nvp) return -1;
  let ea = -1;
  let eb = -1;
  for (let i = 0; i < na && ea === -1; i++) {
    let va0 = polys[pa + i]!;
    let va1 = polys[pa + ((i + 1) % na)]!;
    if (va0 > va1) {
      const t = va0;
      va0 = va1;
      va1 = t;
    }
    for (let j = 0; j < nb; j++) {
      let vb0 = polys[pb + j]!;
      let vb1 = polys[pb + ((j + 1) % nb)]!;
      if (vb0 > vb1) {
        const t = vb0;
        vb0 = vb1;
        vb1 = t;
      }
      if (va0 === vb0 && va1 === vb1) {
        ea = i;
        eb = j;
        break;
      }
    }
  }
  if (ea === -1 || eb === -1) return -1;
  let va = polys[pa + ((ea + na - 1) % na)]!;
  let vb = polys[pa + ea]!;
  let vc = polys[pb + ((eb + 2) % nb)]!;
  if (!uleft(verts, va, vb, vc)) return -1;
  va = polys[pb + ((eb + nb - 1) % nb)]!;
  vb = polys[pb + eb]!;
  vc = polys[pa + ((ea + 2) % na)]!;
  if (!uleft(verts, va, vb, vc)) return -1;
  va = polys[pa + ea]!;
  vb = polys[pa + ((ea + 1) % na)]!;
  const dx = verts[va * 3]! - verts[vb * 3]!;
  const dz = verts[va * 3 + 2]! - verts[vb * 3 + 2]!;
  mergeEdge[0] = ea;
  mergeEdge[1] = eb;
  return dx * dx + dz * dz;
}

function mergePolyVerts(
  polys: Int32Array,
  pa: number,
  pb: number,
  ea: number,
  eb: number,
  tmp: Int32Array,
  nvp: number,
): void {
  const na = countPolyVerts(polys, pa, nvp);
  const nb = countPolyVerts(polys, pb, nvp);
  tmp.fill(-1);
  let n = 0;
  for (let i = 0; i < na - 1; i++) tmp[n++] = polys[pa + ((ea + 1 + i) % na)]!;
  for (let i = 0; i < nb - 1; i++) tmp[n++] = polys[pb + ((eb + 1 + i) % nb)]!;
  for (let i = 0; i < nvp; i++) polys[pa + i] = tmp[i]!;
}

function buildAdjacency(mesh: PolyMesh): void {
  const nvp = mesh.maxVertsPerPoly;
  const edgeOf = new Map<number, number>();
  const nv = mesh.vertCount;
  mesh.adjacency.fill(-1);
  for (let p = 0; p < mesh.polyCount; p++) {
    const n = countPolyVerts(mesh.polys, p * nvp, nvp);
    for (let e = 0; e < n; e++) {
      const v0 = mesh.polys[p * nvp + e]!;
      const v1 = mesh.polys[p * nvp + ((e + 1) % n)]!;
      const key = v0 < v1 ? v0 * nv + v1 : v1 * nv + v0;
      const other = edgeOf.get(key);
      if (other === undefined) {
        edgeOf.set(key, p * nvp + e);
      } else {
        const op = Math.floor(other / nvp);
        if (op !== p) {
          mesh.adjacency[p * nvp + e] = op;
          mesh.adjacency[other] = p;
        }
      }
    }
  }
}

/** Builds the polygon mesh from the contours. `maxVertsPerPoly` is 3..6. */
export function buildPolyMesh(contours: readonly Contour[], maxVertsPerPoly: number): PolyMesh {
  const nvp = maxVertsPerPoly;
  let maxVertices = 0;
  let maxTris = 0;
  let maxVertsPerCont = 0;
  for (const c of contours) {
    const n = c.verts.length / 4;
    if (n < 3) continue;
    maxVertices += n;
    maxTris += n - 2;
    maxVertsPerCont = Math.max(maxVertsPerCont, n);
  }
  const mesh: PolyMesh = {
    verts: new Int32Array(Math.max(1, maxVertices) * 3),
    vertCount: 0,
    polys: new Int32Array(Math.max(1, maxTris) * nvp).fill(-1),
    adjacency: new Int32Array(Math.max(1, maxTris) * nvp).fill(-1),
    regs: new Uint16Array(Math.max(1, maxTris)),
    areas: new Uint8Array(Math.max(1, maxTris)),
    polyCount: 0,
    maxVertsPerPoly: nvp,
  };
  if (maxVertsPerCont === 0) return mesh;

  const vertexOf = new Map<number, number>();
  const addVertex = (x: number, y: number, z: number): number => {
    // Vertices stack: the same (x, z) within two cells of height is one vertex.
    const key = x * 0x100000 + z;
    let base = vertexOf.get(key);
    while (base !== undefined) {
      if (Math.abs(mesh.verts[base * 3 + 1]! - y) <= 2) return base;
      // Another level at the same column: chain through a second key.
      const chained = vertexOf.get(-(base + 1));
      if (chained === undefined) {
        const i = mesh.vertCount++;
        mesh.verts[i * 3] = x;
        mesh.verts[i * 3 + 1] = y;
        mesh.verts[i * 3 + 2] = z;
        vertexOf.set(-(base + 1), i);
        return i;
      }
      base = chained;
    }
    const i = mesh.vertCount++;
    mesh.verts[i * 3] = x;
    mesh.verts[i * 3 + 1] = y;
    mesh.verts[i * 3 + 2] = z;
    vertexOf.set(key, i);
    return i;
  };

  const indices = new Int32Array(maxVertsPerCont);
  const tris = new Int32Array(maxVertsPerCont * 3);
  const polys = new Int32Array((maxVertsPerCont + 1) * nvp);
  const tmpPoly = new Int32Array(nvp);

  for (const cont of contours) {
    const n = cont.verts.length / 4;
    if (n < 3) continue;
    for (let j = 0; j < n; j++) indices[j] = j;
    let ntris = triangulate(n, cont.verts, indices, tris);
    if (ntris <= 0) ntris = -ntris;
    for (let j = 0; j < n; j++) {
      indices[j] = addVertex(cont.verts[j * 4]!, cont.verts[j * 4 + 1]!, cont.verts[j * 4 + 2]!);
    }
    let npolys = 0;
    polys.fill(-1);
    for (let j = 0; j < ntris; j++) {
      const a = tris[j * 3]!;
      const b = tris[j * 3 + 1]!;
      const c = tris[j * 3 + 2]!;
      if (a !== b && a !== c && b !== c) {
        polys[npolys * nvp] = indices[a]!;
        polys[npolys * nvp + 1] = indices[b]!;
        polys[npolys * nvp + 2] = indices[c]!;
        npolys++;
      }
    }
    if (npolys === 0) continue;
    if (nvp > 3) {
      for (;;) {
        let bestMergeVal = 0;
        let bestPa = 0;
        let bestPb = 0;
        let bestEa = 0;
        let bestEb = 0;
        for (let j = 0; j < npolys - 1; j++) {
          for (let k = j + 1; k < npolys; k++) {
            const v = polyMergeValue(polys, j * nvp, k * nvp, mesh.verts, nvp);
            if (v > bestMergeVal) {
              bestMergeVal = v;
              bestPa = j;
              bestPb = k;
              bestEa = mergeEdge[0]!;
              bestEb = mergeEdge[1]!;
            }
          }
        }
        if (bestMergeVal <= 0) break;
        mergePolyVerts(polys, bestPa * nvp, bestPb * nvp, bestEa, bestEb, tmpPoly, nvp);
        const last = (npolys - 1) * nvp;
        if (bestPb * nvp !== last) {
          for (let i = 0; i < nvp; i++) polys[bestPb * nvp + i] = polys[last + i]!;
        }
        npolys--;
      }
    }
    for (let j = 0; j < npolys; j++) {
      const p = mesh.polyCount * nvp;
      for (let k = 0; k < nvp; k++) mesh.polys[p + k] = polys[j * nvp + k]!;
      mesh.regs[mesh.polyCount] = cont.reg;
      mesh.areas[mesh.polyCount] = cont.area;
      mesh.polyCount++;
    }
  }
  buildAdjacency(mesh);
  return mesh;
}

export { countPolyVerts };
