/**
 * A corridor: the polygon list a mesh path crossed, kept beside a moving agent. `advance(x, z)`
 * drops the polygons the agent has left and string-pulls the rest to the target, so each frame
 * costs one funnel over what remains, never a new search. `valid(mesh)` says whether the mesh
 * changed under it (a carve, an obstacle) and a replan is due. Allocated once for
 * `maxWaypoints`.
 */

import { OBSTACLE_AREA } from './mesh/areas';
import { createNavPath3, type NavPath3, pullString, reservePolys3 } from './mesh/mesh-path';
import type { NavMesh, NavPoint3 } from './mesh/navmesh';

export interface Corridor {
  /** The remaining polygons, `offset .. offset + count` into `polys`. */
  readonly polys: Int32Array;
  readonly offset: number;
  readonly count: number;
  /** The target the corridor leads to (the path's last point). */
  readonly target: NavPoint3;
  /** The mesh version the corridor was set from. */
  readonly version: number;
  /** The pulled string from the last `advance`: the agent, every corner, the target. */
  readonly path: NavPath3;
  /** Takes a path (its `polys` corridor and last point); an empty path clears the corridor. */
  set(path: Readonly<NavPath3>): void;
  /** Empties the corridor. */
  clear(): void;
  /** The polygon the agent stands in, or -1 when the corridor is empty. */
  current(): number;
  /**
   * Moves the corridor's head to the polygon holding `(x, z)` (searching forward through the
   * remaining polygons, the first few of them) and writes the next corner to steer to into
   * `out`. Returns false, leaving `out` untouched, when the corridor is empty.
   */
  advance(x: number, z: number, out: NavPoint3): boolean;
  /**
   * True while the mesh is still at the corridor's version (a carve or an obstacle bumps it) and
   * no remaining polygon after the agent's own is an obstacle.
   */
  valid(mesh: NavMesh): boolean;
}

const from: NavPoint3 = { x: 0, y: 0, z: 0 };

/** A corridor over `mesh` with room for `maxWaypoints` polygons. */
export function createCorridor(mesh: NavMesh, maxWaypoints = 64): Corridor {
  const polys = new Int32Array(Math.max(1, maxWaypoints));
  const path = createNavPath3(Math.max(2, maxWaypoints));
  let offset = 0;
  let count = 0;
  let version = -1;
  const target: NavPoint3 = { x: 0, y: 0, z: 0 };
  const corridor: Corridor = {
    polys,
    get offset() {
      return offset;
    },
    get count() {
      return count;
    },
    target,
    get version() {
      return version;
    },
    path,
    set(p) {
      version = p.version;
      offset = 0;
      count = Math.min(p.polyCount, polys.length);
      polys.set(p.polys.subarray(0, count));
      if (p.length > 0) {
        target.x = p.points[(p.length - 1) * 3]!;
        target.y = p.points[(p.length - 1) * 3 + 1]!;
        target.z = p.points[(p.length - 1) * 3 + 2]!;
      } else {
        count = 0;
      }
      reservePolys3(path, count);
      path.length = 0;
      path.polyCount = 0;
    },
    clear() {
      count = 0;
      offset = 0;
      path.length = 0;
    },
    current() {
      return count > 0 ? polys[offset]! : -1;
    },
    advance(x, z, out) {
      if (count === 0) return false;
      // Drop every polygon the agent has passed: look ahead a few, take the furthest that holds it.
      const look = Math.min(count, 4);
      let at = -1;
      for (let i = 0; i < look; i++) {
        if (mesh.containsXZ(polys[offset + i]!, x, z)) at = i;
      }
      if (at > 0) {
        offset += at;
        count -= at;
      }
      from.x = x;
      from.z = z;
      from.y = mesh.polyHeight(polys[offset]!, x, z);
      pullString(mesh, polys, offset, count, from, target, path);
      // The first corner after the agent's own position.
      const k = path.length > 1 ? 1 : 0;
      out.x = path.points[k * 3]!;
      out.y = path.points[k * 3 + 1]!;
      out.z = path.points[k * 3 + 2]!;
      return true;
    },
    valid(m) {
      if (count === 0 || m.version !== version) return false;
      // The polygon the agent stands in is exempt: an obstacle stamped under it must be walked
      // out of, and a replan from inside it would find the same corridor again.
      for (let i = 1; i < count; i++) {
        if (m.area[polys[offset + i]!] === OBSTACLE_AREA) return false;
      }
      return true;
    },
  };
  return corridor;
}
