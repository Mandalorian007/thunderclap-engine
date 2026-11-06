import { describe, expect, it } from 'vitest';
import { reachable } from '../reach';
import { createAreaCosts, createAreaMask } from './areas';
import { addOffMeshLink } from './links';
import { createNavPath3, type FindMeshPathOptions, findMeshPath } from './mesh-path';
import {
  createMeshReach,
  createReachOutline,
  type MeshReach,
  reachableOutline,
} from './mesh-reach';
import { bakeNavMesh, NavMesh, type NavPoint3 } from './navmesh';
import { exportNavMesh, importNavMesh, loadNavMesh } from './serialize';

/** A `w × h` grid of unit quads on y = 0 from (0, 0), one polygon per cell; `skip` leaves cells out. */
function quadMesh(w: number, h: number, skip: (x: number, z: number) => boolean = () => false) {
  const verts = new Float32Array((w + 1) * (h + 1) * 3);
  for (let z = 0; z <= h; z++) {
    for (let x = 0; x <= w; x++) {
      const i = (z * (w + 1) + x) * 3;
      verts[i] = x;
      verts[i + 2] = z;
    }
  }
  const polys: number[] = [];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (skip(x, z)) continue;
      const v = z * (w + 1) + x;
      polys.push(v, v + w + 1, v + w + 2, v + 1);
    }
  }
  const count = polys.length / 4;
  return new NavMesh(verts, (w + 1) * (h + 1), Int32Array.from(polys), count, 4, 1, 0.2);
}

function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  pos: number[],
  idx: number[],
): void {
  const b = pos.length / 3;
  const c = [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1];
  for (let i = 0; i < 8; i++)
    pos.push(
      cx + (c[i * 3]! * sx) / 2,
      cy + (c[i * 3 + 1]! * sy) / 2,
      cz + (c[i * 3 + 2]! * sz) / 2,
    );
  const f = [
    4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7,
    4, 3, 4, 0,
  ];
  for (const i of f) idx.push(b + i);
}

/** A 20 × 20 floor with three pillars, baked. */
function bakedLevel(): NavMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  box(0, -0.5, 0, 20, 1, 20, pos, idx);
  box(-4, 1.5, 0, 2, 3, 2, pos, idx);
  box(4, 1.5, 2, 2, 3, 4, pos, idx);
  box(0, 1.5, -5, 6, 3, 1, pos, idx);
  return bakeNavMesh(
    { positions: pos, indices: idx },
    {
      cellSize: 0.3,
      cellHeight: 0.2,
      agentHeight: 2,
      agentRadius: 0.5,
      agentMaxClimb: 0.4,
      agentMaxSlope: 45,
      maxEdgeLength: 2,
    },
  );
}

const centre = (mesh: NavMesh, p: number): NavPoint3 => mesh.polyCenter(p, { x: 0, y: 0, z: 0 });

/** Every polygon's `findMeshPath` cost to its centre (Infinity when no path ends in it). */
/**
 * `heuristicWeight: 0` makes the search a Dijkstra, the order `reachable` settles polygons in;
 * the default A* may settle a polygon through a costlier portal, so its cost is an upper bound.
 */
function searchCosts(mesh: NavMesh, from: NavPoint3, opts: FindMeshPathOptions = {}): Float64Array {
  const out = new Float64Array(mesh.polyCount).fill(Infinity);
  const path = createNavPath3();
  for (let p = 0; p < mesh.polyCount; p++) {
    if (!findMeshPath(mesh, from, centre(mesh, p), path, opts)) continue;
    if (path.polys[path.polyCount - 1] !== p) continue;
    out[p] = path.cost;
  }
  return out;
}

function expectAgrees(reach: MeshReach, costs: Float64Array, budget: number): void {
  expect(reach.count).toBeGreaterThan(1);
  for (let p = 0; p < reach.mesh.polyCount; p++) {
    if (reach.has(p)) {
      expect(Math.abs(reach.costs[p]! - costs[p]!)).toBeLessThan(1e-3);
      expect(reach.costs[p]!).toBeLessThanOrEqual(budget);
    } else {
      // Complete: nothing the search reaches within the budget is missing.
      expect(costs[p]!).toBeGreaterThan(budget - 1e-3);
    }
  }
}

describe('reachable on a mesh', () => {
  const from: NavPoint3 = { x: -7, y: 0, z: -7 };

  it('agrees with findMeshPath cost for every polygon and respects the budget', () => {
    const mesh = bakedLevel();
    expect(mesh.polyCount).toBeGreaterThan(20);
    const costs = searchCosts(mesh, from, { heuristicWeight: 0 });
    const astar = searchCosts(mesh, from);
    for (const budget of [3, 8, 14]) {
      const reach = reachable(mesh, from, { budget });
      expect(reach.budget).toBe(budget);
      expect(reach.costs[reach.startPoly]).toBe(0);
      expect(reach.polys[0]).toBe(reach.startPoly);
      expectAgrees(reach, costs, budget);
      // The default A* never beats the reach.
      reach.forEach((p, cost) => {
        expect(astar[p]!).toBeGreaterThan(cost - 1e-3);
      });
    }
    const small = reachable(mesh, from, { budget: 3 }, createMeshReach(mesh)).count;
    const large = reachable(mesh, from, { budget: 14 }, createMeshReach(mesh)).count;
    expect(large).toBeGreaterThan(small);
  });

  it('prices areas like findMeshPath and excludes masked ones', () => {
    // Mud across the middle columns of a 12 × 12 quad floor.
    const mesh = quadMesh(12, 12);
    for (let p = 0; p < mesh.polyCount; p++) {
      const c = centre(mesh, p);
      if (c.x > 4 && c.x < 8) mesh.area[p] = 1;
    }
    const start = { x: 1.5, y: 0, z: 6.5 };
    const areaCost = createAreaCosts();
    areaCost[1] = 3;
    const budget = 9;
    const priced = reachable(mesh, start, { budget, areaCost }, createMeshReach(mesh));
    expectAgrees(priced, searchCosts(mesh, start, { areaCost, heuristicWeight: 0 }), budget);
    const plain = reachable(mesh, start, { budget }, createMeshReach(mesh));
    expect(priced.count).toBeLessThan(plain.count);
    // A polygon beyond the mud is in reach only without the price.
    const across = mesh.findPolyAt(9.5, 0, 6.5);
    expect(plain.has(across)).toBe(true);
    expect(priced.has(across)).toBe(false);
    const areaMask = createAreaMask();
    areaMask[1] = 0;
    const masked = reachable(mesh, start, { budget: 100, areaMask }, createMeshReach(mesh));
    for (let p = 0; p < mesh.polyCount; p++) {
      expect(masked.has(p)).toBe(centre(mesh, p).x < 4);
    }
  });

  it('takes off-mesh links at their cost', () => {
    // Two 4 × 4 floors 4 apart, joined by a link.
    const mesh = quadMesh(12, 4, (x) => x >= 4 && x < 8);
    const start = { x: 0.5, y: 0, z: 1.5 };
    expect(reachable(mesh, start, { budget: 100 }).count).toBe(16);
    addOffMeshLink(mesh, {
      from: { x: 3.5, y: 0, z: 1.5 },
      to: { x: 8.5, y: 0, z: 1.5 },
      radius: 0.5,
      cost: 1,
    });
    const r = reachable(mesh, start, { budget: 100 });
    expect(r.count).toBe(32);
    const landing = mesh.findPolyAt(8.5, 0, 1.5);
    // 3 to the link's start, 1 for the link, 0 to the landing polygon's centre.
    expect(r.costs[landing]).toBeCloseTo(4, 3);
    expect(r.stale).toBe(false);
  });

  it('stops at maxPolys and off the mesh', () => {
    const mesh = quadMesh(10, 10);
    const r = reachable(mesh, { x: 5.5, y: 0, z: 5.5 }, { budget: 100, maxPolys: 7 });
    expect(r.count).toBe(7);
    let n = 0;
    r.forEach((p, cost) => {
      expect(cost).toBe(r.costs[p]);
      n++;
    });
    expect(n).toBe(7);
    const off = reachable(mesh, { x: 50, y: 0, z: 50 }, { budget: 100, snapRadius: 1 });
    expect(off.count).toBe(0);
    expect(off.startPoly).toBe(-1);
    expect(reachable(mesh, { x: 5.5, y: 0, z: 5.5 }, { budget: 0 }).count).toBe(1);
  });

  it('reuses its result and scratch: same object, same buffers', () => {
    const mesh = quadMesh(16, 16);
    const a = reachable(mesh, { x: 2.5, y: 0, z: 2.5 }, { budget: 6 });
    const costs = a.costs;
    const b = reachable(mesh, { x: 12.5, y: 0, z: 12.5 }, { budget: 3 });
    expect(b).toBe(a);
    expect(b.costs).toBe(costs);
    expect(b.has(mesh.findPolyAt(2.5, 0, 2.5))).toBe(false);
    const o1 = reachableOutline(b);
    const pts = o1.points;
    const o2 = reachableOutline(reachable(mesh, { x: 8.5, y: 0, z: 8.5 }, { budget: 2 }));
    expect(o2).toBe(o1);
    expect(o2.points).toBe(pts);
    expect(() => reachable(quadMesh(2, 2), { x: 0, y: 0, z: 0 }, { budget: 1 }, a)).toThrow();
  });

  it('pathTo walks to the polygon centre at the reach cost', () => {
    const mesh = bakedLevel();
    const r = reachable(mesh, from, { budget: 14 });
    const path = createNavPath3();
    const p = r.polys[r.count - 1]!;
    expect(r.pathTo(p, path)).toBe(true);
    expect(path.polys[0]).toBe(r.startPoly);
    expect(path.polys[path.polyCount - 1]).toBe(p);
    const c = centre(mesh, p);
    expect(path.points[(path.length - 1) * 3]).toBeCloseTo(c.x, 4);
    expect(path.points[(path.length - 1) * 3 + 2]).toBeCloseTo(c.z, 4);
    expect(path.cost).toBe(r.costs[p]);
    expect(r.pathTo(-1, path)).toBe(false);
    expect(path.length).toBe(0);
  });
});

describe('reachableOutline', () => {
  it('traces the whole floor as one counter-clockwise loop', () => {
    const mesh = quadMesh(10, 10);
    const o = reachableOutline(reachable(mesh, { x: 5.5, y: 0, z: 5.5 }, { budget: 100 }));
    expect(o.loopCount).toBe(1);
    expect(o.pointCount).toBe(40);
    expect(o.loopStart[0]).toBe(0);
    expect(o.loopStart[1]).toBe(40);
    // Signed XZ area (x right, z "up" as in the mesh's convention) of the loop: the floor's.
    let area = 0;
    for (let i = 0; i < o.pointCount; i++) {
      const j = (i + 1) % o.pointCount;
      area += o.points[i * 3]! * o.points[j * 3 + 2]! - o.points[j * 3]! * o.points[i * 3 + 2]!;
    }
    expect(Math.abs(area / 2)).toBeCloseTo(100, 5);
  });

  it('gives a hole its own loop and a partial reach its boundary', () => {
    const mesh = quadMesh(10, 10, (x, z) => x >= 4 && x < 6 && z >= 4 && z < 6);
    const all = reachableOutline(
      reachable(mesh, { x: 0.5, y: 0, z: 0.5 }, { budget: 100 }),
      createReachOutline(2),
    );
    expect(all.loopCount).toBe(2);
    const sizes = [
      all.loopStart[1]! - all.loopStart[0]!,
      all.loopStart[2]! - all.loopStart[1]!,
    ].sort((a, b) => a - b);
    expect(sizes).toEqual([8, 40]);
    // One polygon: its four edges.
    const one = reachableOutline(reachable(mesh, { x: 0.5, y: 0, z: 0.5 }, { budget: 0 }));
    expect(one.loopCount).toBe(1);
    expect(one.pointCount).toBe(4);
    // Every outline vertex lies on a reached polygon's edge whose far side is not reached.
    const r = reachable(mesh, { x: 0.5, y: 0, z: 0.5 }, { budget: 3 });
    const o = reachableOutline(r);
    expect(o.loopCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < o.pointCount; i++) {
      const x = o.points[i * 3]!;
      const z = o.points[i * 3 + 2]!;
      // A boundary vertex touches a reached and an unreached (or missing) cell.
      let inside = 0;
      let outside = 0;
      for (const [dx, dz] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ]) {
        const p = mesh.findPolyAt(x + dx!, 0, z + dz!);
        if (p >= 0 && r.has(p)) inside++;
        else outside++;
      }
      expect(inside).toBeGreaterThan(0);
      expect(outside).toBeGreaterThan(0);
    }
    expect(
      reachableOutline(reachable(mesh, { x: 50, y: 0, z: 50 }, { budget: 1, snapRadius: 1 }))
        .loopCount,
    ).toBe(0);
  });
});

describe('loadNavMesh', () => {
  it('round-trips an in-memory bake', () => {
    const mesh = bakedLevel();
    mesh.area[0] = 3;
    addOffMeshLink(mesh, {
      from: { x: -7, y: 0, z: -7 },
      to: { x: 7, y: 0, z: 7 },
      radius: 1,
      cost: 2,
    });
    const bytes = new Uint8Array(exportNavMesh(mesh));
    const loaded = loadNavMesh(bytes);
    expect(loaded.polyCount).toBe(mesh.polyCount);
    expect(loaded.vertCount).toBe(mesh.vertCount);
    expect(loaded.verts.subarray(0, mesh.vertCount * 3)).toEqual(
      mesh.verts.subarray(0, mesh.vertCount * 3),
    );
    expect(loaded.polys).toEqual(mesh.polys);
    expect(loaded.adjacency).toEqual(mesh.adjacency);
    expect(loaded.area[0]).toBe(3);
    expect(new Uint8Array(exportNavMesh(loaded))).toEqual(bytes);
    const a = createNavPath3();
    const b = createNavPath3();
    const to = { x: 7, y: 0, z: 6 };
    expect(findMeshPath(mesh, { x: -7, y: 0, z: 6 }, to, a)).toBe(true);
    expect(findMeshPath(loaded, { x: -7, y: 0, z: 6 }, to, b)).toBe(true);
    expect(b.points.subarray(0, b.length * 3)).toEqual(a.points.subarray(0, a.length * 3));
    expect(b.cost).toBeCloseTo(a.cost, 6);
    // A view into a larger buffer loads too.
    const padded = new Uint8Array(bytes.byteLength + 8);
    padded.set(bytes, 4);
    expect(loadNavMesh(padded.subarray(4, 4 + bytes.byteLength)).polyCount).toBe(mesh.polyCount);
  });

  it('refuses bytes that are not a sound navmesh', () => {
    const mesh = quadMesh(3, 3);
    const bytes = new Uint8Array(exportNavMesh(mesh));
    expect(() => loadNavMesh(new Uint8Array(16))).toThrow(/loadNavMesh/);
    expect(() => loadNavMesh(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/loadNavMesh/);
    // importNavMesh trusts the indices; loadNavMesh checks them.
    const bad = bytes.slice();
    const view = new DataView(bad.buffer);
    const polysAt = 7 * 4 + 8 * 4 + mesh.vertCount * 12;
    view.setInt32(polysAt, 999, true);
    expect(() => importNavMesh(bad)).not.toThrow();
    expect(() => loadNavMesh(bad)).toThrow(/vertex 999/);
    const badAdj = bytes.slice();
    new DataView(badAdj.buffer).setInt32(polysAt + mesh.polyCount * 4 * 4, 77, true);
    expect(() => loadNavMesh(badAdj)).toThrow(/neighbour 77/);
  });
});
