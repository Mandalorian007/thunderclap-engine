/**
 * Paths over a `NavMesh`: A* across polygons (and off-mesh links) priced by area, then the
 * funnel algorithm pulls the polygon corridor into the shortest string of waypoints. `NavPath3`
 * is `NavPath` with a y and the corridor. The search is a resumable `MeshSearch` so a queue can
 * slice it; scratch is allocated once per search (the first query is the warm-up) and reused.
 */
import { CellHeap } from '../heap';
import type { FollowResult } from '../path';
import { OBSTACLE_AREA } from './areas';
import type { NavMesh, NavPoint3 } from './navmesh';
import { area2 } from './navmesh';

export interface NavPathLink {
  /** The waypoint the link starts at; waypoint `index + 1` is where it lands. */
  index: number;
  /** The off-mesh link's id. */
  id: number;
}

export interface NavPath3 {
  /** Waypoints as world `x, y, z` triples; `length * 3` floats are valid. Grows in place as needed. */
  points: Float32Array;
  /** Waypoints in the path (0 when no path). */
  length: number;
  /** Index of the waypoint `followPath3` is heading for. */
  cursor: number;
  /** `mesh.version` when the path was found. */
  version: number;
  /** Off-mesh links the path takes, in order; `linkCount` entries are valid (records are reused). */
  links: NavPathLink[];
  linkCount: number;
  /** The polygon corridor the path crosses, start to goal; `polyCount` entries are valid. */
  polys: Int32Array;
  polyCount: number;
}

export interface FindMeshPathOptions extends AreaQueryOptions {
  /** Give up (return false) after expanding this many polygons. Default: the whole mesh. */
  maxExpand?: number;
  /** How far `from` and `to` may be from the mesh to snap onto it. Default: any distance. */
  snapRadius?: number;
  /** False keeps the portal midpoints instead of pulling the string taut (for debugging). Default true. */
  stringPull?: boolean;
}

/** A path with room for `capacity` waypoints (grows on demand). */
export function createNavPath3(capacity = 64): NavPath3 {
  return {
    points: new Float32Array(Math.max(1, capacity) * 3),
    length: 0,
    cursor: 0,
    version: -1,
    links: [],
    linkCount: 0,
    polys: new Int32Array(Math.max(1, capacity)),
    polyCount: 0,
  };
}

/** Makes room for `count` corridor polygons (1.5× growth), keeping the data already there. */
export function reservePolys3(path: NavPath3, count: number): void {
  if (path.polys.length >= count) return;
  const next = new Int32Array(Math.max(count, Math.ceil(path.polys.length * 1.5)));
  next.set(path.polys);
  path.polys = next;
}

/** Makes room for `count` waypoints (1.5× growth), keeping the floats already there. */
export function reservePath3(path: NavPath3, count: number): void {
  const need = count * 3;
  if (path.points.length >= need) return;
  const next = new Float32Array(Math.max(need, Math.ceil(path.points.length * 1.5)));
  next.set(path.points);
  path.points = next;
}

/** Empties the path (`length` 0, `cursor` 0, no links, no corridor); the buffers stay. */
export function clearPath3(path: NavPath3): void {
  path.length = 0;
  path.cursor = 0;
  path.linkCount = 0;
  path.polyCount = 0;
}

/** Writes waypoint `i` into `out`. */
export function pathPoint3(path: NavPath3, i: number, out: NavPoint3): NavPoint3 {
  out.x = path.points[i * 3]!;
  out.y = path.points[i * 3 + 1]!;
  out.z = path.points[i * 3 + 2]!;
  return out;
}

/** The sum of the segment lengths, world units. */
export function pathDistance3(path: NavPath3): number {
  const p = path.points;
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = p[i * 3]! - p[i * 3 - 3]!;
    const dy = p[i * 3 + 1]! - p[i * 3 - 2]!;
    const dz = p[i * 3 + 2]! - p[i * 3 - 1]!;
    d += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return d;
}

function pushPoint(path: NavPath3, x: number, y: number, z: number): void {
  // Portals fanning around one corner would repeat it; a path never holds the same point twice in a row.
  if (path.length > 0) {
    const l = (path.length - 1) * 3;
    // `points` is f32 and the portals pass through f32 too: compare at that precision.
    if (
      path.points[l] === Math.fround(x) &&
      path.points[l + 1] === Math.fround(y) &&
      path.points[l + 2] === Math.fround(z)
    )
      return;
  }
  reservePath3(path, path.length + 1);
  const i = path.length++ * 3;
  path.points[i] = x;
  path.points[i + 1] = y;
  path.points[i + 2] = z;
}

function pushLink(path: NavPath3, index: number, id: number): void {
  const i = path.linkCount++;
  const rec = path.links[i];
  if (rec) {
    rec.index = index;
    rec.id = id;
  } else {
    path.links[i] = { index, id };
  }
}

/** How a step into a polygon is priced and whether it is allowed: the area options every mesh query shares. */
export interface AreaQueryOptions {
  /**
   * A cost multiplier per area byte (256 entries, see `createAreaCosts`): a leg across a
   * polygon costs its length × `areaCost[area]`; `Infinity` excludes the area. Default: 1
   * everywhere. Area 255 (obstacles) is always excluded.
   */
  areaCost?: Float32Array;
  /** Per area byte (256 entries, see `createAreaMask`): 0 excludes the area. Default: all allowed. */
  areaMask?: Uint8Array;
}

/** Whether a polygon of area `a` may be entered under the options. */
export function areaAllowed(a: number, cost?: Float32Array, mask?: Uint8Array): boolean {
  if (a === OBSTACLE_AREA) return false;
  if (mask !== undefined && mask[a] === 0) return false;
  return cost === undefined || cost[a]! !== Infinity;
}

export type MeshSearchState = 'idle' | 'running' | 'found' | 'failed';

/**
 * A resumable polygon A*: `begin` snaps the ends and seeds the open heap, `step(maxPops)`
 * expands at most that many polygons and `finish` backtracks the corridor and string-pulls it
 * into a path. `findMeshPath` runs one to the end; a path queue slices one across frames. Every
 * array is allocated once per search (sized to the mesh) and reused.
 */
export class MeshSearch {
  readonly mesh: NavMesh;
  state: MeshSearchState = 'idle';
  /** The mesh version `begin` saw; a differing `mesh.version` means the search is stale. */
  version = -1;
  private readonly g: Float64Array;
  private readonly f: Float64Array;
  private readonly parent: Int32Array;
  /** How the polygon was entered: the parent's edge index, or `-(link * 2 + end) - 1` for a link. */
  private readonly via: Int32Array;
  /** Where the search stands inside each polygon (portal midpoints, link landings). */
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private readonly heap: CellHeap;
  private stamp = 0;
  /** The corridor, start to end, after backtracking. */
  private readonly corridor: Int32Array;
  private readonly corridorVia: Int32Array;
  /** Funnel portals, `lx, ly, lz, rx, ry, rz` per step. */
  private readonly portals: Float64Array;
  private readonly start: NavPoint3 = { x: 0, y: 0, z: 0 };
  private readonly end: NavPoint3 = { x: 0, y: 0, z: 0 };
  /** The polygons the ends snapped to (-1 before `begin`). */
  startPoly = -1;
  endPoly = -1;
  private expanded = 0;
  private maxExpand = Number.POSITIVE_INFINITY;
  private pull = true;
  private areaCost: Float32Array | undefined;
  private areaMask: Uint8Array | undefined;

  constructor(mesh: NavMesh) {
    this.mesh = mesh;
    const n = Math.max(1, mesh.polyCount);
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.via = new Int32Array(n);
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new CellHeap(n, this.f);
    this.corridor = new Int32Array(n);
    this.corridorVia = new Int32Array(n);
    this.portals = new Float64Array((n + 2) * 6);
  }

  /**
   * Snaps `from` and `to` onto the mesh and seeds the search. False (state `'failed'`) when
   * either end is off the mesh (beyond `snapRadius`) or the goal polygon's area is excluded.
   */
  begin(from: Readonly<NavPoint3>, to: Readonly<NavPoint3>, opts?: FindMeshPathOptions): boolean {
    const mesh = this.mesh;
    this.version = mesh.version;
    this.state = 'failed';
    this.expanded = 0;
    if (mesh.polyCount === 0) return false;
    const snap = opts?.snapRadius ?? Number.POSITIVE_INFINITY;
    const startPoly = mesh.findNearestPoly(from.x, from.y, from.z, this.start, snap);
    if (startPoly < 0) return false;
    const endPoly = mesh.findNearestPoly(to.x, to.y, to.z, this.end, snap);
    if (endPoly < 0) return false;
    this.areaCost = opts?.areaCost;
    this.areaMask = opts?.areaMask;
    if (!areaAllowed(mesh.area[endPoly]!, this.areaCost, this.areaMask)) return false;
    this.maxExpand = opts?.maxExpand ?? Number.POSITIVE_INFINITY;
    this.pull = opts?.stringPull ?? true;
    this.startPoly = startPoly;
    this.endPoly = endPoly;
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.stamp = 1;
    }
    this.heap.clear();
    const s = this.start;
    const e = this.end;
    this.g[startPoly] = 0;
    this.f[startPoly] = dist3(s.x, s.y, s.z, e.x, e.y, e.z);
    this.parent[startPoly] = -1;
    this.via[startPoly] = 0;
    this.px[startPoly] = s.x;
    this.py[startPoly] = s.y;
    this.pz[startPoly] = s.z;
    this.seen[startPoly] = this.stamp;
    this.heap.pushOrDecrease(startPoly);
    this.state = startPoly === endPoly ? 'found' : 'running';
    return true;
  }

  /** The funnel portal buffer (room for every polygon plus two), for `pullString`. */
  portalsScratch(): Float64Array {
    return this.portals;
  }

  /** Pops up to `maxPops` polygons off the open heap; returns how many it popped. */
  step(maxPops: number): number {
    if (this.state !== 'running') return 0;
    const mesh = this.mesh;
    const { g, f, parent, via, px, py, pz, seen, closed, heap, stamp, endPoly } = this;
    const nvp = mesh.maxVertsPerPoly;
    const verts = mesh.verts;
    const polys = mesh.polys;
    const adjacency = mesh.adjacency;
    const area = mesh.area;
    const areaCost = this.areaCost;
    const areaMask = this.areaMask;
    const ex = this.end.x;
    const ey = this.end.y;
    const ez = this.end.z;
    let pops = 0;
    while (pops < maxPops) {
      if (heap.size === 0) {
        this.state = 'failed';
        break;
      }
      const cur = heap.pop();
      pops++;
      if (cur === endPoly) {
        this.state = 'found';
        break;
      }
      closed[cur] = stamp;
      if (++this.expanded > this.maxExpand) {
        this.state = 'failed';
        break;
      }
      const cx = px[cur]!;
      const cy = py[cur]!;
      const cz = pz[cur]!;
      const gc = g[cur]!;
      // A leg runs from where the search stands in `cur` to the portal out of it, so `cur`'s
      // area prices it; the destination's area only says whether the step is allowed.
      const curMul = areaCost === undefined ? 1 : areaCost[area[cur]!]!;
      const n = mesh.polyVertexCount(cur);
      for (let e = 0; e < n; e++) {
        const next = adjacency[cur * nvp + e]!;
        if (next < 0 || closed[next] === stamp) continue;
        const na = area[next]!;
        if (!areaAllowed(na, areaCost, areaMask)) continue;
        const a = polys[cur * nvp + e]! * 3;
        const b = polys[cur * nvp + (e + 1 === n ? 0 : e + 1)]! * 3;
        // Stand at the portal's midpoint, except in the goal polygon where the goal itself is the node.
        let nx: number;
        let ny: number;
        let nz: number;
        if (next === endPoly) {
          nx = ex;
          ny = ey;
          nz = ez;
        } else {
          nx = (verts[a]! + verts[b]!) * 0.5;
          ny = (verts[a + 1]! + verts[b + 1]!) * 0.5;
          nz = (verts[a + 2]! + verts[b + 2]!) * 0.5;
        }
        const ng = gc + dist3(cx, cy, cz, nx, ny, nz) * curMul;
        if (seen[next] === stamp && ng >= g[next]!) continue;
        seen[next] = stamp;
        g[next] = ng;
        f[next] = ng + dist3(nx, ny, nz, ex, ey, ez);
        parent[next] = cur;
        via[next] = e;
        px[next] = nx;
        py[next] = ny;
        pz[next] = nz;
        heap.pushOrDecrease(next);
      }
      // Off-mesh links leaving this polygon.
      const lend = mesh.linkStart[cur + 1]!;
      for (let li = mesh.linkStart[cur]!; li < lend; li++) {
        const rec = mesh.linkItems[li]!;
        const link = mesh.links[rec >> 1];
        if (!link) continue;
        const end = rec & 1;
        const src = end === 0 ? link.from : link.to;
        const dst = end === 0 ? link.to : link.from;
        const next = end === 0 ? link.toPoly : link.fromPoly;
        if (next < 0 || closed[next] === stamp) continue;
        if (!areaAllowed(area[next]!, areaCost, areaMask)) continue;
        const linkCost = link.cost ?? dist3(src.x, src.y, src.z, dst.x, dst.y, dst.z);
        const ng = gc + dist3(cx, cy, cz, src.x, src.y, src.z) * curMul + linkCost;
        if (seen[next] === stamp && ng >= g[next]!) continue;
        seen[next] = stamp;
        g[next] = ng;
        f[next] = ng + dist3(dst.x, dst.y, dst.z, ex, ey, ez);
        parent[next] = cur;
        via[next] = -rec - 1;
        px[next] = dst.x;
        py[next] = dst.y;
        pz[next] = dst.z;
        heap.pushOrDecrease(next);
      }
    }
    return pops;
  }

  /**
   * After `'found'`: backtracks the corridor into `out.polys` and string-pulls it (each stretch
   * between links through its portals) into `out.points`. False, with `out` empty, unless the
   * search found the goal.
   */
  finish(out: NavPath3): boolean {
    clearPath3(out);
    out.version = this.version;
    if (this.state !== 'found') return false;
    const mesh = this.mesh;
    const { parent, via, corridor, corridorVia, portals, endPoly } = this;
    const nvp = mesh.maxVertsPerPoly;
    const verts = mesh.verts;
    const polys = mesh.polys;
    // Backtrack into the corridor, start first.
    let len = 0;
    for (let p = endPoly; p >= 0; p = parent[p]!) {
      corridor[len] = p;
      corridorVia[len] = via[p]!;
      len++;
    }
    for (let i = 0, j = len - 1; i < j; i++, j--) {
      let t = corridor[i]!;
      corridor[i] = corridor[j]!;
      corridor[j] = t;
      t = corridorVia[i]!;
      corridorVia[i] = corridorVia[j]!;
      corridorVia[j] = t;
    }
    reservePolys3(out, len);
    out.polys.set(corridor.subarray(0, len));
    out.polyCount = len;

    // String-pull each stretch between links through the portals.
    let apexX = this.start.x;
    let apexY = this.start.y;
    let apexZ = this.start.z;
    pushPoint(out, apexX, apexY, apexZ);
    let i = 1;
    while (i <= len) {
      // Collect portals of the stretch starting at the apex until a link or the end.
      let np = 0;
      let linkRec = -1;
      while (i < len) {
        const v = corridorVia[i]!;
        if (v < 0) {
          linkRec = -v - 1;
          break;
        }
        const prevPoly = corridor[i - 1]!;
        const n = mesh.polyVertexCount(prevPoly);
        const a = polys[prevPoly * nvp + v]! * 3;
        const b = polys[prevPoly * nvp + (v + 1 === n ? 0 : v + 1)]! * 3;
        // Edge `v` runs a → b; exiting across it, b is on the left and a on the right.
        portals[np * 6] = verts[b]!;
        portals[np * 6 + 1] = verts[b + 1]!;
        portals[np * 6 + 2] = verts[b + 2]!;
        portals[np * 6 + 3] = verts[a]!;
        portals[np * 6 + 4] = verts[a + 1]!;
        portals[np * 6 + 5] = verts[a + 2]!;
        np++;
        i++;
      }
      // The stretch ends at the link's start point or at the goal.
      let tx: number;
      let ty: number;
      let tz: number;
      if (linkRec >= 0) {
        const link = mesh.links[linkRec >> 1]!;
        const src = (linkRec & 1) === 0 ? link.from : link.to;
        tx = src.x;
        ty = src.y;
        tz = src.z;
      } else {
        tx = this.end.x;
        ty = this.end.y;
        tz = this.end.z;
      }
      portals[np * 6] = tx;
      portals[np * 6 + 1] = ty;
      portals[np * 6 + 2] = tz;
      portals[np * 6 + 3] = tx;
      portals[np * 6 + 4] = ty;
      portals[np * 6 + 5] = tz;
      np++;
      if (this.pull) {
        funnel(out, portals, np, apexX, apexY, apexZ);
      } else {
        for (let k = 0; k + 1 < np; k++) {
          pushPoint(
            out,
            (portals[k * 6]! + portals[k * 6 + 3]!) * 0.5,
            (portals[k * 6 + 1]! + portals[k * 6 + 4]!) * 0.5,
            (portals[k * 6 + 2]! + portals[k * 6 + 5]!) * 0.5,
          );
        }
      }
      pushPoint(out, tx, ty, tz);
      if (linkRec >= 0) {
        const link = mesh.links[linkRec >> 1]!;
        const dst = (linkRec & 1) === 0 ? link.to : link.from;
        pushLink(out, out.length - 1, link.id);
        pushPoint(out, dst.x, dst.y, dst.z);
        apexX = dst.x;
        apexY = dst.y;
        apexZ = dst.z;
        i++;
      } else {
        break;
      }
    }
    this.state = 'idle';
    return true;
  }
}

const searchFor = new WeakMap<NavMesh, MeshSearch>();

/** The mesh's shared synchronous search (allocated on the first query). */
function searchOf(mesh: NavMesh): MeshSearch {
  let s = searchFor.get(mesh);
  if (!s) {
    s = new MeshSearch(mesh);
    searchFor.set(mesh, s);
  }
  return s;
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Finds the shortest route over the mesh from `from` to `to` (both snapped to the nearest
 * polygon) and writes its waypoints into `out`, the first being the snapped start and the last
 * the snapped goal, and its polygon corridor into `out.polys`. Off-mesh links are taken when
 * they are cheaper and listed in `out.links`. Steps are priced by `areaCost` and filtered by
 * `areaMask`; area 255 (an obstacle) is never entered. Returns false, with `out` empty, when
 * either end is off the mesh (beyond `snapRadius`), the goal is unreachable or excluded, or
 * `maxExpand` ran out.
 */
export function findMeshPath(
  mesh: NavMesh,
  from: Readonly<NavPoint3>,
  to: Readonly<NavPoint3>,
  out: NavPath3,
  opts?: FindMeshPathOptions,
): boolean {
  const s = searchOf(mesh);
  if (!s.begin(from, to, opts)) {
    clearPath3(out);
    out.version = mesh.version;
    return false;
  }
  s.step(Number.POSITIVE_INFINITY);
  return s.finish(out);
}

/**
 * String-pulls a corridor of `count` polygons (`polys[offset ..]`, each adjacent to the next)
 * from `from` (inside the first) to `to` (inside the last) into `out`: the start, every
 * corner, the target. A pair without a shared edge (an off-mesh link) is bridged through the
 * next polygon's centre. Allocation-free after the mesh's first query; used by corridors.
 */
export function pullString(
  mesh: NavMesh,
  polys: Int32Array,
  offset: number,
  count: number,
  from: Readonly<NavPoint3>,
  to: Readonly<NavPoint3>,
  out: NavPath3,
): void {
  clearPath3(out);
  out.version = mesh.version;
  const s = searchOf(mesh);
  const portals = s.portalsScratch();
  const nvp = mesh.maxVertsPerPoly;
  const verts = mesh.verts;
  const mp = mesh.polys;
  const adjacency = mesh.adjacency;
  let np = 0;
  for (let i = 1; i < count; i++) {
    const prev = polys[offset + i - 1]!;
    const next = polys[offset + i]!;
    const n = mesh.polyVertexCount(prev);
    let e = 0;
    while (e < n && adjacency[prev * nvp + e] !== next) e++;
    if (e === n) {
      mesh.polyCenter(next, centreScratch);
      portals[np * 6] = centreScratch.x;
      portals[np * 6 + 1] = centreScratch.y;
      portals[np * 6 + 2] = centreScratch.z;
      portals[np * 6 + 3] = centreScratch.x;
      portals[np * 6 + 4] = centreScratch.y;
      portals[np * 6 + 5] = centreScratch.z;
    } else {
      const a = mp[prev * nvp + e]! * 3;
      const b = mp[prev * nvp + (e + 1 === n ? 0 : e + 1)]! * 3;
      portals[np * 6] = verts[b]!;
      portals[np * 6 + 1] = verts[b + 1]!;
      portals[np * 6 + 2] = verts[b + 2]!;
      portals[np * 6 + 3] = verts[a]!;
      portals[np * 6 + 4] = verts[a + 1]!;
      portals[np * 6 + 5] = verts[a + 2]!;
    }
    np++;
  }
  portals[np * 6] = to.x;
  portals[np * 6 + 1] = to.y;
  portals[np * 6 + 2] = to.z;
  portals[np * 6 + 3] = to.x;
  portals[np * 6 + 4] = to.y;
  portals[np * 6 + 5] = to.z;
  np++;
  pushPoint(out, from.x, from.y, from.z);
  funnel(out, portals, np, from.x, from.y, from.z);
  pushPoint(out, to.x, to.y, to.z);
}

const centreScratch: NavPoint3 = { x: 0, y: 0, z: 0 };

/**
 * Simple Stupid Funnel Algorithm over `np` portals (the last one degenerate at the target),
 * appending the corners it turns at to `out`. The apex itself and the target are not appended.
 */
function funnel(
  out: NavPath3,
  portals: Float64Array,
  np: number,
  apexX0: number,
  apexY0: number,
  apexZ0: number,
): void {
  let apexX = apexX0;
  let apexY = apexY0;
  let apexZ = apexZ0;
  let leftX = apexX;
  let leftY = apexY;
  let leftZ = apexZ;
  let rightX = apexX;
  let rightY = apexY;
  let rightZ = apexZ;
  let apexIndex = -1;
  let leftIndex = -1;
  let rightIndex = -1;
  for (let i = 0; i < np; i++) {
    const lx = portals[i * 6]!;
    const ly = portals[i * 6 + 1]!;
    const lz = portals[i * 6 + 2]!;
    const rx = portals[i * 6 + 3]!;
    const ry = portals[i * 6 + 4]!;
    const rz = portals[i * 6 + 5]!;
    // Right side: tighten when the new right is inside the funnel.
    if (area2(apexX, apexZ, rightX, rightZ, rx, rz) >= 0) {
      if ((apexX === rightX && apexZ === rightZ) || area2(apexX, apexZ, leftX, leftZ, rx, rz) < 0) {
        rightX = rx;
        rightY = ry;
        rightZ = rz;
        rightIndex = i;
      } else {
        // The right crossed the left: the left vertex is a corner of the path.
        pushPoint(out, leftX, leftY, leftZ);
        apexX = leftX;
        apexY = leftY;
        apexZ = leftZ;
        apexIndex = leftIndex;
        leftX = apexX;
        leftY = apexY;
        leftZ = apexZ;
        rightX = apexX;
        rightY = apexY;
        rightZ = apexZ;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
    // Left side.
    if (area2(apexX, apexZ, leftX, leftZ, lx, lz) <= 0) {
      if ((apexX === leftX && apexZ === leftZ) || area2(apexX, apexZ, rightX, rightZ, lx, lz) > 0) {
        leftX = lx;
        leftY = ly;
        leftZ = lz;
        leftIndex = i;
      } else {
        pushPoint(out, rightX, rightY, rightZ);
        apexX = rightX;
        apexY = rightY;
        apexZ = rightZ;
        apexIndex = rightIndex;
        leftX = apexX;
        leftY = apexY;
        leftZ = apexZ;
        rightX = apexX;
        rightY = apexY;
        rightZ = apexZ;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
      }
    }
  }
}

/**
 * Heads for `path.points[path.cursor]` at `speed`: the cursor advances when `position` is within
 * `arriveRadius` (measured in XZ) of its waypoint, and the last waypoint reached is `'arrived'`
 * with a zero velocity. `outVelocity` is the desired velocity in 3D (world units per second);
 * a walker usually keeps its own y and snaps it to `mesh.height(x, z)`.
 */
export function followPath3(
  path: NavPath3,
  position: Readonly<NavPoint3>,
  speed: number,
  arriveRadius: number,
  outVelocity: NavPoint3,
): FollowResult {
  const n = path.length;
  if (n === 0) {
    outVelocity.x = 0;
    outVelocity.y = 0;
    outVelocity.z = 0;
    return 'arrived';
  }
  if (path.cursor >= n) path.cursor = n - 1;
  const r2 = arriveRadius * arriveRadius;
  const p = path.points;
  let dx = p[path.cursor * 3]! - position.x;
  let dy = p[path.cursor * 3 + 1]! - position.y;
  let dz = p[path.cursor * 3 + 2]! - position.z;
  while (dx * dx + dz * dz <= r2) {
    if (path.cursor >= n - 1) {
      outVelocity.x = 0;
      outVelocity.y = 0;
      outVelocity.z = 0;
      return 'arrived';
    }
    path.cursor++;
    dx = p[path.cursor * 3]! - position.x;
    dy = p[path.cursor * 3 + 1]! - position.y;
    dz = p[path.cursor * 3 + 2]! - position.z;
  }
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  outVelocity.x = (dx / d) * speed;
  outVelocity.y = (dy / d) * speed;
  outVelocity.z = (dz / d) * speed;
  return 'moving';
}
