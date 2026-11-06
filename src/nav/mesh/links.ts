/**
 * Off-mesh links: a jump, ladder or teleport between two points of the navmesh that the
 * pathfinder may take as one edge. Links live on the mesh; adding or removing one rebuilds the
 * per-polygon link index (edit-time, allocates) and bumps `mesh.version`.
 */
import type { NavMesh, NavPoint3 } from './navmesh';

export interface OffMeshLinkOptions {
  from: NavPoint3;
  to: NavPoint3;
  /** How far from `from` (and `to`, when bidirectional) an agent may be to take the link. */
  radius: number;
  bidirectional?: boolean;
  /** Traversal cost in world units; default the straight distance from `from` to `to`. */
  cost?: number;
  /** Anything the game wants back from `path.links`; not serialised. */
  userData?: unknown;
}

export interface OffMeshLink {
  readonly id: number;
  readonly from: NavPoint3;
  readonly to: NavPoint3;
  readonly radius: number;
  readonly bidirectional: boolean;
  /** The cost given, or `undefined` for the straight distance. */
  readonly cost: number | undefined;
  readonly userData: unknown;
  /** The polygons the ends landed on (-1 when an end is off the mesh; such a link is never taken). */
  readonly fromPoly: number;
  readonly toPoly: number;
}

/** Adds a link and returns its id (0 is never an id). An end farther than `radius` from the mesh never connects. */
export function addOffMeshLink(mesh: NavMesh, opts: OffMeshLinkOptions): number {
  const id = mesh.nextLinkId++;
  const tmp: NavPoint3 = { x: 0, y: 0, z: 0 };
  const fromPoly = mesh.findNearestPoly(opts.from.x, opts.from.y, opts.from.z, tmp, opts.radius);
  const toPoly = mesh.findNearestPoly(opts.to.x, opts.to.y, opts.to.z, tmp, opts.radius);
  const link: OffMeshLink = {
    id,
    from: { x: opts.from.x, y: opts.from.y, z: opts.from.z },
    to: { x: opts.to.x, y: opts.to.y, z: opts.to.z },
    radius: opts.radius,
    bidirectional: opts.bidirectional ?? false,
    cost: opts.cost,
    userData: opts.userData,
    fromPoly,
    toPoly,
  };
  mesh.links.push(link);
  rebuildLinkIndex(mesh);
  return id;
}

/** Removes the link with `id`; false when there is none. */
export function removeOffMeshLink(mesh: NavMesh, id: number): boolean {
  const i = mesh.links.findIndex((l) => l !== null && l.id === id);
  if (i < 0) return false;
  mesh.links[i] = null;
  // Trim trailing holes so the array does not grow without bound.
  while (mesh.links.length > 0 && mesh.links[mesh.links.length - 1] === null) mesh.links.pop();
  rebuildLinkIndex(mesh);
  return true;
}

/** The link with `id`, or `undefined`. */
export function getOffMeshLink(mesh: NavMesh, id: number): OffMeshLink | undefined {
  for (const l of mesh.links) if (l !== null && l.id === id) return l;
  return undefined;
}

/** Rebuilds `mesh.linkStart` / `mesh.linkItems`: per polygon the `link * 2 + end` records that start there. */
export function rebuildLinkIndex(mesh: NavMesh): void {
  const start = new Int32Array(mesh.polyCount + 1);
  let total = 0;
  for (const l of mesh.links) {
    if (l === null) continue;
    if (l.fromPoly >= 0 && l.toPoly >= 0) {
      start[l.fromPoly + 1]!++;
      total++;
      if (l.bidirectional) {
        start[l.toPoly + 1]!++;
        total++;
      }
    }
  }
  for (let p = 0; p < mesh.polyCount; p++) start[p + 1]! += start[p]!;
  const items = new Int32Array(Math.max(1, total));
  const fill = new Int32Array(mesh.polyCount);
  for (let i = 0; i < mesh.links.length; i++) {
    const l = mesh.links[i]!;
    if (l === null || l.fromPoly < 0 || l.toPoly < 0) continue;
    items[start[l.fromPoly]! + fill[l.fromPoly]!++] = i * 2;
    if (l.bidirectional) items[start[l.toPoly]! + fill[l.toPoly]!++] = i * 2 + 1;
  }
  mesh.linkStart = start;
  mesh.linkItems = items;
  mesh.version++;
}
