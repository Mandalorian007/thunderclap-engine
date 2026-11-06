/**
 * Mesh simplification for LODs and collision proxies (ws/geom-3): quadric-error edge collapse
 * (Garland–Heckbert) over the welded position set.
 *
 * Every vertex is first mapped to a *position* (vertices within `WELD_EPSILON` on each axis are one
 * position, so a uv seam or a hard edge does not split the surface). Each position accumulates
 * the plane quadrics of its triangles (and, on an open border, of a plane through the border
 * edge perpendicular to its triangle). An edge collapse moves one position onto the other
 * (half-edge collapse: the kept position is an original vertex, so the result never leaves the
 * input's vertex set, and its uv, normal, colour and tangent lanes are the kept vertex's). The
 * candidates sit in a binary heap ordered by cost, then by the two position indices, so two runs
 * over the same input make the same collapses in the same order and the output is byte-identical.
 * A collapse is refused when it would flip or flatten a triangle, or pinch the surface (the link
 * condition: the two positions share exactly the neighbours of the triangles on their edge).
 *
 * CPU, build-time: arrays are sized from the input; nothing here runs per frame.
 */
import { VERTEX_LAYOUT_3D, VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { computeBounds, createIndices, type Geometry } from './geometry';
import { weld } from './ops';

export interface SimplifyOptions {
  /** Keep this fraction of the triangles (0..1). Default 0.5. Ignored under `targetTriangles`. */
  targetRatio?: number;
  /** Keep at most this many triangles. */
  targetTriangles?: number;
  /** Never move a vertex on an open border (an edge with one triangle). Default false. */
  preserveBorders?: boolean;
  /**
   * Never move a position whose vertices disagree (a uv seam or a hard normal edge), so islands
   * and creases keep their outline. Default false.
   */
  preserveUvSeams?: boolean;
  /**
   * Stop before any collapse whose error (the square root of its quadric cost, world units:
   * at least the farthest the moved position lies from one of its original planes) exceeds this.
   * Default unlimited: the target alone decides.
   */
  errorLimit?: number;
}

export interface SimplifyResult {
  geometry: Geometry;
  /** The largest collapse error made (world units, see `errorLimit`); 0 when nothing collapsed. */
  error: number;
}

/** Positions closer than this on every axis are one (a UV sphere's seam is off by ~1e-16). */
const WELD_EPSILON = 1e-6;

function floatsOf(g: Geometry): number {
  if (g.layout !== VERTEX_LAYOUT_3D && g.layout !== VERTEX_LAYOUT_3D_TANGENT) {
    throw new Error(`geom: simplifyGeometry needs a 3D vertex layout, got '${g.layout.name}'`);
  }
  return g.layout.floats;
}

/** Adds the plane `n · p + d = 0` (unit n), times `w`, into the quadric at `q[o..o+10)`. */
function addPlane(
  q: Float64Array,
  o: number,
  a: number,
  b: number,
  c: number,
  d: number,
  w: number,
): void {
  q[o] = q[o]! + w * a * a;
  q[o + 1] = q[o + 1]! + w * a * b;
  q[o + 2] = q[o + 2]! + w * a * c;
  q[o + 3] = q[o + 3]! + w * a * d;
  q[o + 4] = q[o + 4]! + w * b * b;
  q[o + 5] = q[o + 5]! + w * b * c;
  q[o + 6] = q[o + 6]! + w * b * d;
  q[o + 7] = q[o + 7]! + w * c * c;
  q[o + 8] = q[o + 8]! + w * c * d;
  q[o + 9] = q[o + 9]! + w * d * d;
}

/** `p^T (Qa + Qb) p` for p = (x, y, z, 1). */
function quadricCost(q: Float64Array, a: number, b: number, x: number, y: number, z: number) {
  const A = a * 10;
  const B = b * 10;
  const s = (k: number) => q[A + k]! + q[B + k]!;
  const e =
    s(0) * x * x +
    2 * s(1) * x * y +
    2 * s(2) * x * z +
    2 * s(3) * x +
    s(4) * y * y +
    2 * s(5) * y * z +
    2 * s(6) * y +
    s(7) * z * z +
    2 * s(8) * z +
    s(9);
  // Rounding can leave a tiny negative (or NaN on a degenerate quadric): clamp to 0.
  if (e > 0) return e;
  return 0;
}

/**
 * A min-heap of collapse candidates in parallel arrays: cost, the removed and kept positions,
 * and the versions of both when the entry was made (a later collapse that changes either makes
 * the entry stale). Ordered by cost, then removed index, then kept index: deterministic.
 */
class CandidateHeap {
  cost: number[] = [];
  rem: number[] = [];
  keep: number[] = [];
  vr: number[] = [];
  vk: number[] = [];
  private readonly lanes = [this.cost, this.rem, this.keep, this.vr, this.vk];

  get size(): number {
    return this.cost.length;
  }

  private less(i: number, j: number): boolean {
    const ci = this.cost[i]!;
    const cj = this.cost[j]!;
    if (ci !== cj) return ci < cj;
    if (this.rem[i] !== this.rem[j]) return this.rem[i]! < this.rem[j]!;
    return this.keep[i]! < this.keep[j]!;
  }

  private swap(i: number, j: number): void {
    for (const a of this.lanes) {
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
  }

  push(cost: number, rem: number, keep: number, vr: number, vk: number): void {
    let i = this.cost.length;
    this.cost.push(cost);
    this.rem.push(rem);
    this.keep.push(keep);
    this.vr.push(vr);
    this.vk.push(vk);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Moves the top entry to the end of the arrays and pops it there; read it with `last*`. */
  pop(): void {
    const n = this.cost.length - 1;
    this.swap(0, n);
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  /** Drops the entry `pop` moved to the end. */
  drop(): void {
    this.cost.pop();
    this.rem.pop();
    this.keep.pop();
    this.vr.pop();
    this.vk.pop();
  }
}

/**
 * Simplify `g` by quadric-error edge collapse to `targetTriangles` (or `targetRatio` of its
 * triangles), stopping early at `errorLimit`. Returns a new geometry in `g`'s layout (welded, its
 * indices 16-bit when they fit) and the largest error made. `g` is untouched. Takes
 * `VERTEX_LAYOUT_3D` or `VERTEX_LAYOUT_3D_TANGENT`.
 */
export function simplifyGeometry(g: Geometry, opts: SimplifyOptions = {}): SimplifyResult {
  const F = floatsOf(g);
  const src = g.vertices;
  const vCount = src.length / F;
  const idx = g.indices;
  const triIn = Math.floor(idx.length / 3);
  const target = Math.max(
    0,
    Math.floor(opts.targetTriangles ?? Math.floor((opts.targetRatio ?? 0.5) * triIn)),
  );
  const limit = opts.errorLimit ?? Number.POSITIVE_INFINITY;
  const limit2 = limit * limit;

  // ---------------------------------------------------------------- the position set
  // Vertices within WELD_EPSILON on every axis are one position (a spatial hash over cells of
  // that size hashed to an int, the 27 neighbouring cells searched, every candidate compared),
  // the first vertex's coordinates kept.
  const posOf = new Int32Array(vCount);
  const cells = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number, cz: number) =>
    Math.imul(cx | 0, 73856093) ^ Math.imul(cy | 0, 19349663) ^ Math.imul(cz | 0, 83492791);
  const px: number[] = [];
  /** First vertex of each position, and whether its vertices disagree (a seam). */
  const firstVert: number[] = [];
  const seam: number[] = [];
  const inv = 1 / WELD_EPSILON;
  for (let i = 0; i < vCount; i++) {
    const o = i * F;
    const x = src[o]!;
    const y = src[o + 1]!;
    const z = src[o + 2]!;
    const cx = Math.round(x * inv);
    const cy = Math.round(y * inv);
    const cz = Math.round(z * inv);
    let p: number | undefined;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const q of bucket) {
            if (
              Math.abs(px[q * 3]! - x) <= WELD_EPSILON &&
              Math.abs(px[q * 3 + 1]! - y) <= WELD_EPSILON &&
              Math.abs(px[q * 3 + 2]! - z) <= WELD_EPSILON
            ) {
              p = q;
              break search;
            }
          }
        }
      }
    }
    if (p === undefined) {
      p = px.length / 3;
      const key = cellKey(cx, cy, cz);
      const bucket = cells.get(key);
      if (bucket) bucket.push(p);
      else cells.set(key, [p]);
      px.push(x, y, z);
      firstVert.push(i);
      seam.push(0);
    } else if (!seam[p]) {
      const f = firstVert[p]! * F;
      for (let k = 3; k < 8; k++) {
        if (Math.abs(src[f + k]! - src[o + k]!) > 1e-6) {
          seam[p] = 1;
          break;
        }
      }
    }
    posOf[i] = p;
  }
  const P = px.length / 3;

  // ---------------------------------------------------------------- faces and adjacency
  /** Corner vertex indices, three per face; `alive[f]` 0 once collapsed or degenerate. */
  const corner = new Int32Array(triIn * 3);
  const alive = new Uint8Array(triIn);
  const facesOf: number[][] = Array.from({ length: P }, () => []);
  let live = 0;
  for (let f = 0; f < triIn; f++) {
    const a = idx[f * 3]!;
    const b = idx[f * 3 + 1]!;
    const c = idx[f * 3 + 2]!;
    corner[f * 3] = a;
    corner[f * 3 + 1] = b;
    corner[f * 3 + 2] = c;
    const pa = posOf[a]!;
    const pb = posOf[b]!;
    const pc = posOf[c]!;
    if (pa === pb || pb === pc || pa === pc) continue;
    alive[f] = 1;
    live++;
    facesOf[pa]!.push(f);
    facesOf[pb]!.push(f);
    facesOf[pc]!.push(f);
  }

  // ---------------------------------------------------------------- quadrics and borders
  const Q = new Float64Array(P * 10);
  const edgeUse = new Map<number, number>();
  const edgeFace = new Map<number, number>();
  const ekey = (a: number, b: number) => (a < b ? a * P + b : b * P + a);
  const n3 = new Float64Array(4);
  const faceNormal = (f: number, out: Float64Array): number => {
    const a = posOf[corner[f * 3]!]! * 3;
    const b = posOf[corner[f * 3 + 1]!]! * 3;
    const c = posOf[corner[f * 3 + 2]!]! * 3;
    const ux = px[b]! - px[a]!;
    const uy = px[b + 1]! - px[a + 1]!;
    const uz = px[b + 2]! - px[a + 2]!;
    const vx = px[c]! - px[a]!;
    const vy = px[c + 1]! - px[a + 1]!;
    const vz = px[c + 2]! - px[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    out[0] = len > 0 ? nx / len : 0;
    out[1] = len > 0 ? ny / len : 0;
    out[2] = len > 0 ? nz / len : 0;
    out[3] = -(out[0]! * px[a]! + out[1]! * px[a + 1]! + out[2]! * px[a + 2]!);
    return len;
  };
  for (let f = 0; f < triIn; f++) {
    if (!alive[f]) continue;
    if (faceNormal(f, n3) === 0) continue;
    for (let k = 0; k < 3; k++) {
      const p = posOf[corner[f * 3 + k]!]!;
      addPlane(Q, p * 10, n3[0]!, n3[1]!, n3[2]!, n3[3]!, 1);
      const q = posOf[corner[f * 3 + ((k + 1) % 3)]!]!;
      const e = ekey(p, q);
      edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
      edgeFace.set(e, f);
    }
  }
  const border = new Uint8Array(P);
  for (const [e, uses] of edgeUse) {
    if (uses !== 1) continue;
    const a = Math.floor(e / P);
    const b = e - a * P;
    border[a] = border[b] = 1;
    // A plane through the border edge, perpendicular to its triangle: keeps the rim in place.
    faceNormal(edgeFace.get(e)!, n3);
    const ex = px[b * 3]! - px[a * 3]!;
    const ey = px[b * 3 + 1]! - px[a * 3 + 1]!;
    const ez = px[b * 3 + 2]! - px[a * 3 + 2]!;
    let mx = ey * n3[2]! - ez * n3[1]!;
    let my = ez * n3[0]! - ex * n3[2]!;
    let mz = ex * n3[1]! - ey * n3[0]!;
    const ml = Math.hypot(mx, my, mz);
    if (ml === 0) continue;
    mx /= ml;
    my /= ml;
    mz /= ml;
    const d = -(mx * px[a * 3]! + my * px[a * 3 + 1]! + mz * px[a * 3 + 2]!);
    addPlane(Q, a * 10, mx, my, mz, d, 1);
    addPlane(Q, b * 10, mx, my, mz, d, 1);
  }
  const locked = new Uint8Array(P);
  for (let p = 0; p < P; p++) {
    if ((opts.preserveBorders && border[p]) || (opts.preserveUvSeams && seam[p])) locked[p] = 1;
  }

  // ---------------------------------------------------------------- candidates
  const version = new Int32Array(P);
  const dead = new Uint8Array(P);
  const heap = new CandidateHeap();
  const mark = new Int32Array(P);
  let stamp = 0;
  const neighbours: number[] = [];
  /** Live neighbour positions of `p` into `neighbours` (each once), stamped in `mark`. */
  const gather = (p: number): void => {
    stamp++;
    neighbours.length = 0;
    for (const f of facesOf[p]!) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) {
        const q = posOf[corner[f * 3 + k]!]!;
        if (q !== p && mark[q] !== stamp) {
          mark[q] = stamp;
          neighbours.push(q);
        }
      }
    }
  };
  const offer = (rem: number, keep: number): void => {
    if (locked[rem]) return;
    if (border[rem] && !border[keep]) return;
    const cost = quadricCost(Q, rem, keep, px[keep * 3]!, px[keep * 3 + 1]!, px[keep * 3 + 2]!);
    heap.push(cost, rem, keep, version[rem]!, version[keep]!);
  };
  for (let p = 0; p < P; p++) {
    gather(p);
    for (const q of neighbours) offer(p, q);
  }

  // ---------------------------------------------------------------- collapsing
  const nA = new Float64Array(4);
  const nB = new Float64Array(4);
  const remap = new Map<number, number>();
  let maxCost = 0;
  while (live > target && heap.size > 0) {
    heap.pop();
    const last = heap.size - 1;
    const cost = heap.cost[last]!;
    const u = heap.rem[last]!;
    const v = heap.keep[last]!;
    const stale =
      dead[u] || dead[v] || heap.vr[last] !== version[u] || heap.vk[last] !== version[v];
    heap.drop();
    if (stale) continue;
    if (cost > limit2) break;
    // Link condition: the common neighbours of u and v are exactly the far corners of the
    // triangles on edge uv (one on a border, two inside), or the collapse pinches the surface.
    gather(u);
    const uStamp = stamp;
    let shared = 0;
    for (const f of facesOf[u]!) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) if (posOf[corner[f * 3 + k]!] === v) shared++;
    }
    if (shared === 0) continue;
    if (border[u] && shared !== 1) continue;
    let common = 0;
    for (const f of facesOf[v]!) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) {
        const q = posOf[corner[f * 3 + k]!]!;
        if (q !== v && q !== u && mark[q] === uStamp) {
          mark[q] = -1;
          common++;
        }
      }
    }
    if (common !== shared) continue;
    // No surviving triangle around u may flip or collapse to a sliver when u moves to v.
    let ok = true;
    for (const f of facesOf[u]!) {
      if (!alive[f]) continue;
      let hasV = false;
      for (let k = 0; k < 3; k++) if (posOf[corner[f * 3 + k]!] === v) hasV = true;
      if (hasV) continue;
      const before = faceNormal(f, nA);
      // Evaluate the moved triangle by swapping u's position for v's in place.
      const ux = px[u * 3]!;
      const uy = px[u * 3 + 1]!;
      const uz = px[u * 3 + 2]!;
      px[u * 3] = px[v * 3]!;
      px[u * 3 + 1] = px[v * 3 + 1]!;
      px[u * 3 + 2] = px[v * 3 + 2]!;
      const after = faceNormal(f, nB);
      px[u * 3] = ux;
      px[u * 3 + 1] = uy;
      px[u * 3 + 2] = uz;
      if (after <= before * 1e-3 || nA[0]! * nB[0]! + nA[1]! * nB[1]! + nA[2]! * nB[2]! < 0.2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Collapse u into v. The dying triangles map u's corner vertex to v's, so a surviving
    // triangle on the same side of a seam takes the matching vertex of v.
    remap.clear();
    let fallback = -1;
    for (const f of facesOf[u]!) {
      if (!alive[f]) continue;
      let cu = -1;
      let cv = -1;
      for (let k = 0; k < 3; k++) {
        const c = corner[f * 3 + k]!;
        if (posOf[c] === u) cu = c;
        else if (posOf[c] === v) cv = c;
      }
      if (cv < 0) continue;
      if (!remap.has(cu)) remap.set(cu, cv);
      if (fallback < 0) fallback = cv;
      alive[f] = 0;
      live--;
    }
    for (const f of facesOf[u]!) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) {
        const c = corner[f * 3 + k]!;
        if (posOf[c] === u) corner[f * 3 + k] = remap.get(c) ?? fallback;
      }
      facesOf[v]!.push(f);
    }
    dead[u] = 1;
    facesOf[u]!.length = 0;
    for (let k = 0; k < 10; k++) Q[v * 10 + k] = Q[v * 10 + k]! + Q[u * 10 + k]!;
    if (cost > maxCost) maxCost = cost;
    version[v]++;
    // Compact v's face list and offer its edges again with the merged quadric.
    const fl = facesOf[v]!;
    let w = 0;
    for (const f of fl) if (alive[f]) fl[w++] = f;
    fl.length = w;
    gather(v);
    for (const q of neighbours) {
      offer(v, q);
      offer(q, v);
    }
  }

  // ---------------------------------------------------------------- output
  const used = new Int32Array(vCount).fill(-1);
  let outV = 0;
  for (let f = 0; f < triIn; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const c = corner[f * 3 + k]!;
      if (used[c] === -1) used[c] = outV++;
    }
  }
  const vertices = new Float32Array(outV * F);
  for (let i = 0; i < vCount; i++) {
    const o = used[i]!;
    if (o >= 0) vertices.set(src.subarray(i * F, i * F + F), o * F);
  }
  const indices = createIndices(outV, live * 3);
  let io = 0;
  for (let f = 0; f < triIn; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) indices[io++] = used[corner[f * 3 + k]!]!;
  }
  const compact: Geometry = {
    vertices,
    indices,
    bounds: computeBounds(vertices, F),
    layout: g.layout,
  };
  return { geometry: weld(compact, 1e-6), error: Math.sqrt(maxCost) };
}

/**
 * A level-of-detail chain: level 0 is `g` itself, level `i` is `simplifyGeometry(g, { ...opts,
 * targetRatio: ratios[i - 1] })` (each from the full mesh, so errors do not compound). Ratios are
 * fractions of `g`'s triangles, typically decreasing (`[0.5, 0.25, 0.1]`).
 */
export function createLodChain(
  g: Geometry,
  ratios: readonly number[],
  opts: Omit<SimplifyOptions, 'targetRatio' | 'targetTriangles'> = {},
): Geometry[] {
  const out: Geometry[] = [g];
  for (const r of ratios) out.push(simplifyGeometry(g, { ...opts, targetRatio: r }).geometry);
  return out;
}
