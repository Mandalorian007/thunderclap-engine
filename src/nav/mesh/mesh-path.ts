/**
 * Paths over a `NavMesh`: A* across polygons (and off-mesh links), then the funnel algorithm
 * pulls the polygon corridor into the shortest string of waypoints. `NavPath3` is `NavPath`
 * with a y. Scratch is allocated once per mesh (the first query is the warm-up) and reused.
 */
import { CellHeap } from '../heap';
import type { FollowResult } from '../path';
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
}

export interface FindMeshPathOptions {
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
  };
}

/** Makes room for `count` waypoints (1.5× growth), keeping the floats already there. */
export function reservePath3(path: NavPath3, count: number): void {
  const need = count * 3;
  if (path.points.length >= need) return;
  const next = new Float32Array(Math.max(need, Math.ceil(path.points.length * 1.5)));
  next.set(path.points);
  path.points = next;
}

/** Empties the path (`length` 0, `cursor` 0, no links); the buffers stay. */
export function clearPath3(path: NavPath3): void {
  path.length = 0;
  path.cursor = 0;
  path.linkCount = 0;
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

interface Scratch {
  g: Float64Array;
  f: Float64Array;
  parent: Int32Array;
  /** How the polygon was entered: the parent's edge index, or `-(link * 2 + end) - 1` for a link. */
  via: Int32Array;
  /** Where the search stands inside each polygon (portal midpoints, link landings). */
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  seen: Uint32Array;
  closed: Uint32Array;
  heap: CellHeap;
  stamp: number;
  /** The corridor, start to end, after backtracking. */
  corridor: Int32Array;
  corridorVia: Int32Array;
  /** Funnel portals, `lx, ly, lz, rx, ry, rz` per step. */
  portals: Float64Array;
}

const scratchFor = new WeakMap<NavMesh, Scratch>();

function scratch(mesh: NavMesh): Scratch {
  let s = scratchFor.get(mesh);
  if (!s) {
    const n = Math.max(1, mesh.polyCount);
    const f = new Float64Array(n);
    s = {
      g: new Float64Array(n),
      f,
      parent: new Int32Array(n),
      via: new Int32Array(n),
      px: new Float64Array(n),
      py: new Float64Array(n),
      pz: new Float64Array(n),
      seen: new Uint32Array(n),
      closed: new Uint32Array(n),
      heap: new CellHeap(n, f),
      stamp: 0,
      corridor: new Int32Array(n),
      corridorVia: new Int32Array(n),
      portals: new Float64Array((n + 2) * 6),
    };
    scratchFor.set(mesh, s);
  }
  return s;
}

const startPt: NavPoint3 = { x: 0, y: 0, z: 0 };
const endPt: NavPoint3 = { x: 0, y: 0, z: 0 };

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Finds the shortest route over the mesh from `from` to `to` (both snapped to the nearest
 * polygon) and writes its waypoints into `out`, the first being the snapped start and the last
 * the snapped goal. Off-mesh links are taken when they are cheaper and listed in `out.links`.
 * Returns false, with `out` empty, when either end is off the mesh (beyond `snapRadius`), the
 * goal is unreachable or `maxExpand` ran out.
 */
export function findMeshPath(
  mesh: NavMesh,
  from: Readonly<NavPoint3>,
  to: Readonly<NavPoint3>,
  out: NavPath3,
  opts?: FindMeshPathOptions,
): boolean {
  clearPath3(out);
  out.version = mesh.version;
  if (mesh.polyCount === 0) return false;
  const snap = opts?.snapRadius ?? Number.POSITIVE_INFINITY;
  const startPoly = mesh.findNearestPoly(from.x, from.y, from.z, startPt, snap);
  if (startPoly < 0) return false;
  const endPoly = mesh.findNearestPoly(to.x, to.y, to.z, endPt, snap);
  if (endPoly < 0) return false;
  const maxExpand = opts?.maxExpand ?? Number.POSITIVE_INFINITY;
  const pull = opts?.stringPull ?? true;

  const s = scratch(mesh);
  const { g, f, parent, via, px, py, pz, seen, closed, heap } = s;
  s.stamp = (s.stamp + 1) >>> 0;
  if (s.stamp === 0) {
    seen.fill(0);
    closed.fill(0);
    s.stamp = 1;
  }
  const stamp = s.stamp;
  heap.clear();

  const nvp = mesh.maxVertsPerPoly;
  const verts = mesh.verts;
  const polys = mesh.polys;
  const adjacency = mesh.adjacency;
  const ex = endPt.x;
  const ey = endPt.y;
  const ez = endPt.z;

  g[startPoly] = 0;
  f[startPoly] = dist3(startPt.x, startPt.y, startPt.z, ex, ey, ez);
  parent[startPoly] = -1;
  via[startPoly] = 0;
  px[startPoly] = startPt.x;
  py[startPoly] = startPt.y;
  pz[startPoly] = startPt.z;
  seen[startPoly] = stamp;
  heap.pushOrDecrease(startPoly);

  let expanded = 0;
  let found = startPoly === endPoly;
  while (!found && heap.size > 0) {
    const cur = heap.pop();
    if (cur === endPoly) {
      found = true;
      break;
    }
    closed[cur] = stamp;
    if (++expanded > maxExpand) break;
    const cx = px[cur]!;
    const cy = py[cur]!;
    const cz = pz[cur]!;
    const gc = g[cur]!;
    const n = mesh.polyVertexCount(cur);
    for (let e = 0; e < n; e++) {
      const next = adjacency[cur * nvp + e]!;
      if (next < 0 || closed[next] === stamp) continue;
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
      const ng = gc + dist3(cx, cy, cz, nx, ny, nz);
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
      const linkCost = link.cost ?? dist3(src.x, src.y, src.z, dst.x, dst.y, dst.z);
      const ng = gc + dist3(cx, cy, cz, src.x, src.y, src.z) + linkCost;
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
  if (!found) return false;

  // Backtrack into the corridor, start first.
  const corridor = s.corridor;
  const corridorVia = s.corridorVia;
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

  // String-pull each stretch between links through the portals.
  const portals = s.portals;
  let apexX = startPt.x;
  let apexY = startPt.y;
  let apexZ = startPt.z;
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
      tx = endPt.x;
      ty = endPt.y;
      tz = endPt.z;
    }
    portals[np * 6] = tx;
    portals[np * 6 + 1] = ty;
    portals[np * 6 + 2] = tz;
    portals[np * 6 + 3] = tx;
    portals[np * 6 + 4] = ty;
    portals[np * 6 + 5] = tz;
    np++;
    if (pull) {
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
  return true;
}

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
