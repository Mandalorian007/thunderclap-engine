/**
 * Budget-bounded reachability on a `NavMesh` (ws/nav-5): "where can this unit get to with N
 * metres of movement", cheap enough to ask every frame. A Dijkstra over the polygon graph that
 * prices legs exactly as `findMeshPath` does (portal midpoints as nodes, each leg × the area cost
 * of the polygon it crosses, off-mesh links at their cost) and stops at the budget, then
 * `reachableOutline` traces the reached set's boundary into loops for drawing a movement range.
 * Scratch is sized to the mesh once (per mesh, in a `WeakMap`) and reused: no allocation per
 * query after the first.
 */
import { CellHeap } from '../heap';
import { OBSTACLE_AREA } from './areas';
import { areaAllowed, type NavPath3, pullString, reservePolys3 } from './mesh-path';
import type { NavMesh, NavPoint3 } from './navmesh';

export interface MeshReachOptions {
  /** Path cost a polygon may cost to reach, inclusive (world units × area cost). */
  budget: number;
  /** A cost multiplier per area byte (256 entries, `createAreaCosts`); `Infinity` excludes an area. */
  areaCost?: Float32Array;
  /** Per area byte (256 entries, `createAreaMask`): 0 excludes the area. */
  areaMask?: Uint8Array;
  /** Stop once this many polygons are in (the start counts). Default: no cap. */
  maxPolys?: number;
  /** How far `from` may be from the mesh to snap onto it. Default: any distance. */
  snapRadius?: number;
}

export interface MeshReach {
  readonly mesh: NavMesh;
  /** Polygons reached (the start included); 0 when `from` is off the mesh. */
  readonly count: number;
  /** The reached polygons in the order they came within budget, the start first; `count` valid. */
  readonly polys: Int32Array;
  /**
   * Cost to reach each polygon's centre (`polyCenter`), the value `findMeshPath(mesh, from,
   * centre).cost` gives; 0 at the start polygon, `Infinity` off the reach. One per polygon.
   */
  readonly costs: Float32Array;
  /** The polygon each reached polygon is entered from on its cheapest route; -1 at the start or off the reach. */
  readonly parents: Int32Array;
  /** The polygon `from` snapped to, or -1. */
  readonly startPoly: number;
  /** Where `from` snapped to on the mesh. */
  readonly start: Readonly<NavPoint3>;
  /** The budget of the last query. */
  readonly budget: number;
  /** `mesh.version` at the last query, or -1 before the first. */
  readonly version: number;
  /** True when the mesh changed (a link, an area, an obstacle) since the last query. */
  readonly stale: boolean;
  /** True when polygon `p` was reached within the budget. */
  has(p: number): boolean;
  /**
   * The route from the start to polygon `p`'s centre into `out`: the corridor in `out.polys`,
   * the pulled string in `out.points`, `out.cost` the reach's cost. False, with `out` empty,
   * when `p` is not reached.
   */
  pathTo(p: number, out: NavPath3): boolean;
  /** Calls `fn` for every reached polygon, in `polys` order. */
  forEach(fn: (poly: number, cost: number) => void): void;
}

/** Per-mesh Dijkstra scratch, shared by every `MeshReach` of the mesh. */
class ReachScratch {
  readonly g: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Polygon centres, `x, y, z` per polygon (computed once). */
  readonly centres: Float64Array;
  /** Edge midpoints, `x, y, z` per polygon edge slot (`p * nvp + e`; computed once). */
  readonly mids: Float64Array;
  /** The node parent (entry) chain, for `pathTo`. */
  readonly nodeParent: Int32Array;
  readonly seen: Uint32Array;
  readonly closed: Uint32Array;
  readonly heap: CellHeap;
  readonly corridor: Int32Array;
  stamp = 0;

  constructor(mesh: NavMesh) {
    const n = Math.max(1, mesh.polyCount);
    this.g = new Float64Array(n);
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.centres = new Float64Array(n * 3);
    const c: NavPoint3 = { x: 0, y: 0, z: 0 };
    for (let p = 0; p < mesh.polyCount; p++) {
      mesh.polyCenter(p, c);
      this.centres[p * 3] = c.x;
      this.centres[p * 3 + 1] = c.y;
      this.centres[p * 3 + 2] = c.z;
    }
    const nvp = mesh.maxVertsPerPoly;
    this.mids = new Float64Array(n * nvp * 3);
    for (let p = 0; p < mesh.polyCount; p++) {
      const k = mesh.polyVertexCount(p);
      for (let e = 0; e < k; e++) {
        const a = mesh.polys[p * nvp + e]! * 3;
        const b = mesh.polys[p * nvp + (e + 1 === k ? 0 : e + 1)]! * 3;
        const m = (p * nvp + e) * 3;
        this.mids[m] = (mesh.verts[a]! + mesh.verts[b]!) * 0.5;
        this.mids[m + 1] = (mesh.verts[a + 1]! + mesh.verts[b + 1]!) * 0.5;
        this.mids[m + 2] = (mesh.verts[a + 2]! + mesh.verts[b + 2]!) * 0.5;
      }
    }
    this.nodeParent = new Int32Array(n).fill(-1);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new CellHeap(n, this.g);
    this.corridor = new Int32Array(n + 1);
  }

  next(): number {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.stamp = 1;
    }
    this.heap.clear();
    return this.stamp;
  }
}

const scratchFor = new WeakMap<NavMesh, ReachScratch>();

function scratchOf(mesh: NavMesh): ReachScratch {
  let s = scratchFor.get(mesh);
  if (!s) {
    s = new ReachScratch(mesh);
    scratchFor.set(mesh, s);
  }
  return s;
}

const pathCentre: NavPoint3 = { x: 0, y: 0, z: 0 };

class MeshReachImpl implements MeshReach {
  readonly mesh: NavMesh;
  readonly polys: Int32Array;
  readonly costs: Float32Array;
  readonly parents: Int32Array;
  readonly start: NavPoint3 = { x: 0, y: 0, z: 0 };
  count = 0;
  startPoly = -1;
  budget = 0;
  version = -1;

  constructor(mesh: NavMesh) {
    this.mesh = mesh;
    const n = Math.max(1, mesh.polyCount);
    this.polys = new Int32Array(n);
    this.costs = new Float32Array(n).fill(Infinity);
    this.parents = new Int32Array(n).fill(-1);
  }

  get stale(): boolean {
    return this.version !== this.mesh.version;
  }

  has(p: number): boolean {
    return p >= 0 && p < this.mesh.polyCount && this.costs[p]! < Infinity;
  }

  pathTo(p: number, out: NavPath3): boolean {
    const mesh = this.mesh;
    if (!this.has(p)) {
      out.length = 0;
      out.cursor = 0;
      out.linkCount = 0;
      out.polyCount = 0;
      out.cost = 0;
      out.version = this.version;
      return false;
    }
    const s = scratchOf(mesh);
    const corridor = s.corridor;
    // The centre's parent, then the node chain back to the start.
    let len = 0;
    corridor[len++] = p;
    for (let q = this.parents[p]!; q >= 0; q = s.nodeParent[q]!) corridor[len++] = q;
    for (let i = 0, j = len - 1; i < j; i++, j--) {
      const t = corridor[i]!;
      corridor[i] = corridor[j]!;
      corridor[j] = t;
    }
    pathCentre.x = s.centres[p * 3]!;
    pathCentre.y = s.centres[p * 3 + 1]!;
    pathCentre.z = s.centres[p * 3 + 2]!;
    pullString(mesh, corridor, 0, len, this.start, pathCentre, out);
    reservePolys3(out, len);
    out.polys.set(corridor.subarray(0, len));
    out.polyCount = len;
    out.cost = this.costs[p]!;
    out.version = this.version;
    return true;
  }

  forEach(fn: (poly: number, cost: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const p = this.polys[i]!;
      fn(p, this.costs[p]!);
    }
  }

  reset(): void {
    for (let i = 0; i < this.count; i++) {
      const p = this.polys[i]!;
      this.costs[p] = Infinity;
      this.parents[p] = -1;
    }
    this.count = 0;
    this.startPoly = -1;
  }

  add(p: number, cost: number, parent: number): void {
    if (this.costs[p] === Infinity) this.polys[this.count++] = p;
    this.costs[p] = cost;
    this.parents[p] = parent;
  }
}

/** A reusable mesh reachability result sized to `mesh`; pass it to `reachable` as `out`. */
export function createMeshReach(mesh: NavMesh): MeshReach {
  return new MeshReachImpl(mesh);
}

const reachFor = new WeakMap<NavMesh, MeshReachImpl>();

/**
 * `findNearestPoly`, but an unbounded snap first looks near the point: the nearest polygon within
 * a radius is the nearest overall, and the whole-mesh scan costs more than the search itself on a
 * large mesh.
 */
function snap(mesh: NavMesh, from: Readonly<NavPoint3>, out: NavPoint3, radius: number): number {
  if (radius === Number.POSITIVE_INFINITY) {
    const near = mesh.findNearestPoly(from.x, from.y, from.z, out, mesh.cellSize * 8);
    if (near >= 0) return near;
  }
  return mesh.findNearestPoly(from.x, from.y, from.z, out, radius);
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The polygons whose centre is within path cost `opts.budget` of `from`, with their cost to
 * reach. Legs are priced as `findMeshPath` prices them; the search expands only polygons it can
 * enter within the budget and stops there (or at `maxPolys`). Writes into `out`, or a `MeshReach`
 * kept per mesh; nothing allocates after the first query on a mesh.
 */
export function reachableMesh(
  mesh: NavMesh,
  from: Readonly<NavPoint3>,
  opts: MeshReachOptions,
  out?: MeshReach,
): MeshReach {
  let r: MeshReachImpl;
  if (out) {
    if (out.mesh !== mesh) throw new Error('nav: reach belongs to another mesh');
    r = out as MeshReachImpl;
  } else {
    const cached = reachFor.get(mesh);
    if (cached) {
      r = cached;
    } else {
      r = new MeshReachImpl(mesh);
      reachFor.set(mesh, r);
    }
  }
  r.reset();
  const budget = opts.budget;
  r.budget = budget;
  r.version = mesh.version;
  if (mesh.polyCount === 0 || !(budget >= 0)) return r;
  const startPoly = snap(mesh, from, r.start, opts.snapRadius ?? Number.POSITIVE_INFINITY);
  if (startPoly < 0) return r;
  const areaCost = opts.areaCost;
  const areaMask = opts.areaMask;
  const maxPolys = opts.maxPolys ?? Number.POSITIVE_INFINITY;
  const s = scratchOf(mesh);
  const stamp = s.next();
  const { g, px, py, pz, centres, nodeParent, seen, closed, heap } = s;
  const costs = r.costs;
  const nvp = mesh.maxVertsPerPoly;
  const adjacency = mesh.adjacency;
  const area = mesh.area;
  const mids = s.mids;
  const plain = areaCost === undefined && areaMask === undefined;

  r.startPoly = startPoly;
  r.add(startPoly, 0, -1);
  g[startPoly] = 0;
  px[startPoly] = r.start.x;
  py[startPoly] = r.start.y;
  pz[startPoly] = r.start.z;
  nodeParent[startPoly] = -1;
  seen[startPoly] = stamp;
  heap.pushOrDecrease(startPoly);

  while (heap.size > 0 && r.count < maxPolys) {
    const cur = heap.pop();
    closed[cur] = stamp;
    const cx = px[cur]!;
    const cy = py[cur]!;
    const cz = pz[cur]!;
    const gc = g[cur]!;
    // As in `findMeshPath`: the polygon a leg crosses prices it.
    const mul = areaCost === undefined ? 1 : areaCost[area[cur]!]!;
    const n = mesh.polyVertexCount(cur);
    for (let e = 0; e < n; e++) {
      const next = adjacency[cur * nvp + e]!;
      if (next < 0) continue;
      if (plain ? area[next] === OBSTACLE_AREA : !areaAllowed(area[next]!, areaCost, areaMask))
        continue;
      // The centre: what a search with the centre as its goal would charge. A closed polygon
      // still takes a cheaper centre (a goal polygon is never expanded through).
      const nc =
        gc +
        dist3(cx, cy, cz, centres[next * 3]!, centres[next * 3 + 1]!, centres[next * 3 + 2]!) * mul;
      if (nc <= budget && nc < costs[next]! && r.count < maxPolys) r.add(next, nc, cur);
      if (closed[next] === stamp) continue;
      const m = (cur * nvp + e) * 3;
      const nx = mids[m]!;
      const ny = mids[m + 1]!;
      const nz = mids[m + 2]!;
      const ng = gc + dist3(cx, cy, cz, nx, ny, nz) * mul;
      if (ng > budget) continue;
      if (seen[next] === stamp && ng >= g[next]!) continue;
      seen[next] = stamp;
      g[next] = ng;
      px[next] = nx;
      py[next] = ny;
      pz[next] = nz;
      nodeParent[next] = cur;
      heap.pushOrDecrease(next);
    }
    const lend = mesh.linkStart[cur + 1]!;
    for (let li = mesh.linkStart[cur]!; li < lend; li++) {
      const rec = mesh.linkItems[li]!;
      const link = mesh.links[rec >> 1];
      if (!link) continue;
      const end = rec & 1;
      const src = end === 0 ? link.from : link.to;
      const dst = end === 0 ? link.to : link.from;
      const next = end === 0 ? link.toPoly : link.fromPoly;
      if (next < 0) continue;
      const na = area[next]!;
      if (!areaAllowed(na, areaCost, areaMask)) continue;
      const linkCost = link.cost ?? dist3(src.x, src.y, src.z, dst.x, dst.y, dst.z);
      const ng = gc + dist3(cx, cy, cz, src.x, src.y, src.z) * mul + linkCost;
      if (ng > budget) continue;
      // From the landing to the centre, priced by the polygon landed in.
      const nmul = areaCost === undefined ? 1 : areaCost[na]!;
      const nc =
        ng +
        dist3(
          dst.x,
          dst.y,
          dst.z,
          centres[next * 3]!,
          centres[next * 3 + 1]!,
          centres[next * 3 + 2]!,
        ) *
          nmul;
      if (nc <= budget && nc < costs[next]! && r.count < maxPolys) r.add(next, nc, cur);
      if (closed[next] === stamp) continue;
      if (seen[next] === stamp && ng >= g[next]!) continue;
      seen[next] = stamp;
      g[next] = ng;
      px[next] = dst.x;
      py[next] = dst.y;
      pz[next] = dst.z;
      nodeParent[next] = cur;
      heap.pushOrDecrease(next);
    }
  }
  return r;
}

// --------------------------------------------------------------- outline

export interface ReachOutline {
  /** Loop vertices as world `x, y, z` triples; `pointCount` are valid. Grows in place. */
  points: Float32Array;
  pointCount: number;
  /**
   * Loop `k` is points `loopStart[k]` to `loopStart[k + 1] - 1` (closed: the last joins the
   * first); `loopCount + 1` entries are valid. Outer loops run counter-clockwise seen from above,
   * holes clockwise.
   */
  loopStart: Int32Array;
  loopCount: number;
}

/** An empty outline (buffers grow on demand); pass it to `reachableOutline` as `out`. */
export function createReachOutline(capacity = 64): ReachOutline {
  return {
    points: new Float32Array(Math.max(1, capacity) * 3),
    pointCount: 0,
    loopStart: new Int32Array(8),
    loopCount: 0,
  };
}

/** Per-mesh outline scratch: boundary edges and a per-vertex list of the edges leaving it. */
class OutlineScratch {
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  readonly edgeNext: Int32Array;
  readonly used: Uint8Array;
  readonly head: Int32Array;
  readonly headStamp: Uint32Array;
  stamp = 0;

  constructor(mesh: NavMesh) {
    const edges = Math.max(1, mesh.polyCount * mesh.maxVertsPerPoly);
    this.edgeA = new Int32Array(edges);
    this.edgeB = new Int32Array(edges);
    this.edgeNext = new Int32Array(edges);
    this.used = new Uint8Array(edges);
    this.head = new Int32Array(Math.max(1, mesh.vertCount));
    this.headStamp = new Uint32Array(Math.max(1, mesh.vertCount));
  }
}

const outlineScratchFor = new WeakMap<NavMesh, OutlineScratch>();
const outlineFor = new WeakMap<MeshReach, ReachOutline>();

function pushOutlinePoint(out: ReachOutline, verts: Float32Array, v: number): void {
  const need = (out.pointCount + 1) * 3;
  if (out.points.length < need) {
    const next = new Float32Array(Math.max(need, Math.ceil(out.points.length * 1.5)));
    next.set(out.points);
    out.points = next;
  }
  const i = out.pointCount++ * 3;
  out.points[i] = verts[v * 3]!;
  out.points[i + 1] = verts[v * 3 + 1]!;
  out.points[i + 2] = verts[v * 3 + 2]!;
}

function pushLoopStart(out: ReachOutline, at: number): void {
  if (out.loopStart.length < out.loopCount + 2) {
    const next = new Int32Array(Math.max(out.loopCount + 2, out.loopStart.length * 2));
    next.set(out.loopStart);
    out.loopStart = next;
  }
  out.loopStart[out.loopCount] = at;
}

/**
 * The boundary of a reach as closed loops of mesh vertices: every edge of a reached polygon whose
 * other side is off the mesh or not reached, chained end to end. Writes into `out`, or one
 * outline kept per reach; nothing allocates once the buffers have grown to the largest outline.
 * The boundary follows polygon edges, so its resolution is the mesh's.
 */
export function reachableOutline(reach: MeshReach, out?: ReachOutline): ReachOutline {
  let o = out;
  if (!o) {
    o = outlineFor.get(reach);
    if (!o) {
      o = createReachOutline();
      outlineFor.set(reach, o);
    }
  }
  o.pointCount = 0;
  o.loopCount = 0;
  o.loopStart[0] = 0;
  const mesh = reach.mesh;
  if (reach.count === 0) return o;
  let s = outlineScratchFor.get(mesh);
  if (!s) {
    s = new OutlineScratch(mesh);
    outlineScratchFor.set(mesh, s);
  }
  s.stamp = (s.stamp + 1) >>> 0;
  if (s.stamp === 0) {
    s.headStamp.fill(0);
    s.stamp = 1;
  }
  const stamp = s.stamp;
  const { edgeA, edgeB, edgeNext, used, head, headStamp } = s;
  const nvp = mesh.maxVertsPerPoly;
  const polys = mesh.polys;
  const adjacency = mesh.adjacency;
  const costs = reach.costs;
  let edges = 0;
  for (let i = 0; i < reach.count; i++) {
    const p = reach.polys[i]!;
    const n = mesh.polyVertexCount(p);
    for (let e = 0; e < n; e++) {
      const other = adjacency[p * nvp + e]!;
      if (other >= 0 && costs[other]! < Infinity) continue;
      const a = polys[p * nvp + e]!;
      edgeA[edges] = a;
      edgeB[edges] = polys[p * nvp + (e + 1 === n ? 0 : e + 1)]!;
      used[edges] = 0;
      edgeNext[edges] = headStamp[a] === stamp ? head[a]! : -1;
      head[a] = edges;
      headStamp[a] = stamp;
      edges++;
    }
  }
  const verts = mesh.verts;
  for (let first = 0; first < edges; first++) {
    if (used[first]) continue;
    used[first] = 1;
    pushLoopStart(o, o.pointCount);
    const origin = edgeA[first]!;
    pushOutlinePoint(o, verts, origin);
    let v = edgeB[first]!;
    while (v !== origin) {
      let e = headStamp[v] === stamp ? head[v]! : -1;
      while (e >= 0 && used[e]) e = edgeNext[e]!;
      if (e < 0) break; // an open chain (a mesh with unmatched shared edges); keep what we have
      used[e] = 1;
      pushOutlinePoint(o, verts, v);
      v = edgeB[e]!;
    }
    o.loopCount++;
  }
  pushLoopStart(o, o.pointCount);
  return o;
}
