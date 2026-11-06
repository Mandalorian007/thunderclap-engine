/**
 * A flow field over a `NavMesh`: one Dijkstra from the goal polygons outward (centre to portal
 * midpoint to centre, from the goal point itself in a goal polygon, priced by area) gives every
 * polygon a distance and the neighbour it flows to, so any number of agents read a direction in
 * O(1) with no search of their own.
 * `direction3` points from the query to the portal midpoint into the next polygon (or to the
 * nearest goal inside a goal polygon). `update()` rebuilds on a mesh version change.
 * Allocated once per field; `update` allocates nothing.
 */
import { CellHeap } from '../heap';
import { type AreaQueryOptions, areaAllowed } from './mesh-path';
import type { NavMesh, NavPoint3 } from './navmesh';

export interface FlowField3Options extends AreaQueryOptions {
  /** Snap each goal to the nearest polygon within this radius. Default: unbounded. */
  snapRadius?: number;
}

export interface FlowField3 {
  readonly mesh: NavMesh;
  /** Per polygon: cost-weighted distance to the nearest goal (`Infinity` unreachable). */
  readonly distances: Float64Array;
  /** Per polygon: the polygon it flows to (-1 at a goal or unreachable). */
  readonly next: Int32Array;
  /** Per polygon: the portal edge index into `next` (-1 at a goal or unreachable). */
  readonly portal: Int32Array;
  /** The mesh version the field was built from. */
  readonly version: number;
  /** True when the mesh changed since the build. */
  readonly stale: boolean;
  /** Rebuilds the field when stale (or always, with `force`); returns whether it rebuilt. */
  update(force?: boolean): boolean;
  /** The polygon count reached from a goal in the last build. */
  readonly reached: number;
  /**
   * The unit direction to walk from `(x, y, z)` into `out` (zero at a goal, off the mesh or
   * where no goal is reachable). Returns the polygon under the point, or -1.
   */
  direction3(x: number, y: number, z: number, out: NavPoint3): number;
  /**
   * The cost-weighted distance to the nearest goal from `(x, y, z)` along the field (through
   * the polygon's exit portal); `Infinity` off the mesh or where no goal is reachable.
   */
  distanceAt(x: number, y: number, z: number): number;
}

const snapped: NavPoint3 = { x: 0, y: 0, z: 0 };

/** Builds a flow field toward `goals` (points on the mesh) and keeps it current. */
export function createFlowField3(
  mesh: NavMesh,
  goals: readonly Readonly<NavPoint3>[],
  opts: FlowField3Options = {},
): FlowField3 {
  const n = Math.max(1, mesh.polyCount);
  const distances = new Float64Array(n);
  const next = new Int32Array(n);
  const portal = new Int32Array(n);
  const heap = new CellHeap(n, distances);
  const closed = new Uint8Array(n);
  const goalPoly = new Int32Array(goals.length);
  const goalX = new Float64Array(goals.length);
  const goalY = new Float64Array(goals.length);
  const goalZ = new Float64Array(goals.length);
  const centreX = new Float64Array(n);
  const centreY = new Float64Array(n);
  const centreZ = new Float64Array(n);
  /** The exit portal's midpoint per polygon (its centre at a goal). */
  const exitX = new Float64Array(n);
  const exitY = new Float64Array(n);
  const exitZ = new Float64Array(n);
  const areaCost = opts.areaCost;
  const areaMask = opts.areaMask;
  const snap = opts.snapRadius ?? Number.POSITIVE_INFINITY;
  let version = -1;
  let reached = 0;
  const nvp = mesh.maxVertsPerPoly;

  const build = (): void => {
    version = mesh.version;
    distances.fill(Number.POSITIVE_INFINITY);
    next.fill(-1);
    portal.fill(-1);
    closed.fill(0);
    heap.clear();
    reached = 0;
    for (let p = 0; p < mesh.polyCount; p++) {
      mesh.polyCenter(p, snapped);
      centreX[p] = snapped.x;
      centreY[p] = snapped.y;
      centreZ[p] = snapped.z;
    }
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i]!;
      const p = mesh.findNearestPoly(g.x, g.y, g.z, snapped, snap);
      goalPoly[i] = p;
      goalX[i] = snapped.x;
      goalY[i] = snapped.y;
      goalZ[i] = snapped.z;
      if (p < 0 || !areaAllowed(mesh.area[p]!, areaCost, areaMask)) continue;
      if (distances[p] !== 0) {
        // A goal polygon's legs are measured from the goal itself, not its centre.
        centreX[p] = snapped.x;
        centreY[p] = snapped.y;
        centreZ[p] = snapped.z;
      }
      distances[p] = 0;
      heap.pushOrDecrease(p);
    }
    const verts = mesh.verts;
    const polys = mesh.polys;
    const adjacency = mesh.adjacency;
    while (heap.size > 0) {
      const cur = heap.pop();
      closed[cur] = 1;
      reached++;
      const dc = distances[cur]!;
      const cx = centreX[cur]!;
      const cy = centreY[cur]!;
      const cz = centreZ[cur]!;
      const count = mesh.polyVertexCount(cur);
      for (let e = 0; e < count; e++) {
        const nb = adjacency[cur * nvp + e]!;
        if (nb < 0 || closed[nb] === 1) continue;
        const na = mesh.area[nb]!;
        if (!areaAllowed(na, areaCost, areaMask)) continue;
        const a = polys[cur * nvp + e]! * 3;
        const b = polys[cur * nvp + (e + 1 === count ? 0 : e + 1)]! * 3;
        const mx = (verts[a]! + verts[b]!) * 0.5;
        const my = (verts[a + 1]! + verts[b + 1]!) * 0.5;
        const mz = (verts[a + 2]! + verts[b + 2]!) * 0.5;
        const mul = areaCost === undefined ? 1 : areaCost[na]!;
        // Into `cur` from `nb`: the leg from nb's centre to the portal is priced by nb's area, the
        // leg from the portal to cur's centre by cur's.
        const curMul = areaCost === undefined ? 1 : areaCost[mesh.area[cur]!]!;
        const d =
          dc +
          dist3(cx, cy, cz, mx, my, mz) * curMul +
          dist3(mx, my, mz, centreX[nb]!, centreY[nb]!, centreZ[nb]!) * mul;
        if (d >= distances[nb]!) continue;
        distances[nb] = d;
        next[nb] = cur;
        exitX[nb] = mx;
        exitY[nb] = my;
        exitZ[nb] = mz;
        // The edge of `nb` shared with `cur`.
        const nc = mesh.polyVertexCount(nb);
        let pe = 0;
        while (pe < nc && adjacency[nb * nvp + pe] !== cur) pe++;
        portal[nb] = pe < nc ? pe : -1;
        heap.pushOrDecrease(nb);
      }
    }
  };
  build();

  /**
   * A point on the portal out of `p` lies in `next[p]` too; the field answers for the polygon
   * furthest downstream that holds it, so a walker standing on a portal is never sent back to it.
   */
  const downstream = (p: number, x: number, z: number): number => {
    let cur = p;
    for (let nb = next[cur]!; nb >= 0 && mesh.containsXZ(nb, x, z); nb = next[cur]!) cur = nb;
    return cur;
  };

  return {
    mesh,
    distances,
    next,
    portal,
    get version() {
      return version;
    },
    get stale() {
      return version !== mesh.version;
    },
    get reached() {
      return reached;
    },
    update(force = false) {
      if (!force && version === mesh.version) return false;
      build();
      return true;
    },
    direction3(x, y, z, out) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      let p = mesh.findPolyAt(x, y, z);
      if (p < 0 || distances[p] === Number.POSITIVE_INFINITY) return p;
      p = downstream(p, x, z);
      let tx: number;
      let ty: number;
      let tz: number;
      const nb = next[p]!;
      if (nb < 0) {
        // A goal polygon: head for the nearest goal inside it.
        let best = -1;
        let bestD = Number.POSITIVE_INFINITY;
        for (let i = 0; i < goalPoly.length; i++) {
          if (goalPoly[i] !== p) continue;
          const d = dist3(x, y, z, goalX[i]!, goalY[i]!, goalZ[i]!);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best < 0) return p;
        tx = goalX[best]!;
        ty = goalY[best]!;
        tz = goalZ[best]!;
      } else {
        tx = exitX[p]!;
        ty = exitY[p]!;
        tz = exitZ[p]!;
      }
      const dx = tx - x;
      const dy = ty - y;
      const dz = tz - z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len === 0) return p;
      out.x = dx / len;
      out.y = dy / len;
      out.z = dz / len;
      return p;
    },
    distanceAt(x, y, z) {
      let p = mesh.findPolyAt(x, y, z);
      if (p < 0 || distances[p] === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
      p = downstream(p, x, z);
      const mul = areaCost === undefined ? 1 : areaCost[mesh.area[p]!]!;
      if (next[p]! < 0) {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < goalPoly.length; i++) {
          if (goalPoly[i] !== p) continue;
          const d = dist3(x, y, z, goalX[i]!, goalY[i]!, goalZ[i]!);
          if (d < best) best = d;
        }
        return best * mul;
      }
      // The polygon's distance is measured from its centre through its exit portal: swap the
      // centre leg for the query's own.
      const ex = exitX[p]!;
      const ey = exitY[p]!;
      const ez = exitZ[p]!;
      return (
        distances[p]! -
        dist3(centreX[p]!, centreY[p]!, centreZ[p]!, ex, ey, ez) * mul +
        dist3(x, y, z, ex, ey, ez) * mul
      );
    },
  };
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
