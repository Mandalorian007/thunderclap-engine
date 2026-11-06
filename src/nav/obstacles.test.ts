import { describe, expect, it } from 'vitest';
import { findPath } from './astar';
import { createNavGrid } from './grid';
import { OBSTACLE_AREA } from './mesh/areas';
import { createNavPath3, findMeshPath, pathDistance3 } from './mesh/mesh-path';
import { bakeNavMesh, type NavBakeAreaOptions, type NavMesh } from './mesh/navmesh';
import type { NavBakeOptions } from './mesh/voxelize';
import { createObstacleSet } from './obstacles';
import { createNavPath } from './path';

/** Appends an axis-aligned box (12 triangles) centred at `cx, cy, cz`. */
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
      cx + c[i * 3]! * sx * 0.5,
      cy + c[i * 3 + 1]! * sy * 0.5,
      cz + c[i * 3 + 2]! * sz * 0.5,
    );
  const f = [
    4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7,
    4, 3, 4, 0,
  ];
  for (const i of f) idx.push(b + i);
}

const OPTS: NavBakeOptions = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2,
  agentRadius: 0.5,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
};

/** A `size` × `size` floor (top at y = 0) with the given pillars (`x, z, w, d` each), 3 high. */
function floor(size: number, pillars: number[][] = [], extra: NavBakeAreaOptions = {}): NavMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  box(0, -0.5, 0, size, 1, size, pos, idx);
  for (const [x, z, w, d] of pillars) box(x!, 1.5, z!, w!, 3, d!, pos, idx);
  return bakeNavMesh({ positions: pos, indices: idx }, { ...OPTS, ...extra });
}

describe('createObstacleSet on a mesh (ws/nav-4)', () => {
  it('blocks the doorway after add, reopens after remove, and bumps versions only on change', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const gap = mesh.findPolyAt(0, 0, 0);
    const set = createObstacleSet(mesh, { maxObstacles: 4 });
    expect(set.layer.length).toBe(0);
    const from = { x: 0, y: 0, z: -8 };
    const to = { x: 0, y: 0, z: 8 };
    const path = createNavPath3();
    expect(findMeshPath(mesh, from, to, path)).toBe(true);
    const straight = pathDistance3(path);
    const v = mesh.version;
    expect(set.apply()).toBe(0);
    expect(set.version).toBe(0);
    expect(mesh.version).toBe(v);
    const id = set.add({ x: 0, z: 0, radius: 0.5 });
    expect(id).toBeGreaterThan(0);
    expect(set.count).toBe(1);
    // Nothing happens until apply.
    expect(mesh.area[gap]).toBe(0);
    expect(set.apply()).toBe(1);
    expect(mesh.area[gap]).toBe(OBSTACLE_AREA);
    expect(mesh.version).toBe(v + 1);
    expect(set.version).toBe(1);
    expect(findMeshPath(mesh, from, to, path)).toBe(true);
    expect(pathDistance3(path)).toBeGreaterThan(straight + 3);
    expect(path.polys.subarray(0, path.polyCount)).not.toContain(gap);
    // Apply with no moves leaves every version alone.
    expect(set.apply()).toBe(0);
    expect(mesh.version).toBe(v + 1);
    // A second obstacle on the same polygon: the area stays 255 after either is removed.
    const id2 = set.add({ x: 1, z: 1, w: 1, d: 1, yaw: 0.3 });
    expect(set.apply()).toBe(0);
    expect(set.remove(id)).toBe(true);
    expect(set.apply()).toBe(0);
    expect(mesh.area[gap]).toBe(OBSTACLE_AREA);
    expect(set.remove(id2)).toBe(true);
    expect(set.remove(id2)).toBe(false);
    expect(set.apply()).toBe(1);
    expect(mesh.area[gap]).toBe(0);
    expect(findMeshPath(mesh, from, to, path)).toBe(true);
    expect(pathDistance3(path)).toBeCloseTo(straight, 3);
  });

  it('touches only the polygons under the footprint, and move restamps', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const set = createObstacleSet(mesh, { maxObstacles: 2 });
    const id = set.add({ x: -7, z: -7, radius: 0.3 });
    const flipped = set.apply();
    expect(flipped).toBeGreaterThanOrEqual(1);
    expect(flipped).toBeLessThanOrEqual(3);
    let blocked = 0;
    for (let p = 0; p < mesh.polyCount; p++) if (mesh.area[p] === OBSTACLE_AREA) blocked++;
    expect(blocked).toBe(flipped);
    set.move(id, 7, 7);
    expect(set.get(id)?.x).toBe(7);
    set.apply();
    expect(mesh.area[mesh.findPolyAt(7, 0, 7)]).toBe(OBSTACLE_AREA);
    blocked = 0;
    for (let p = 0; p < mesh.polyCount; p++) if (mesh.area[p] === OBSTACLE_AREA) blocked++;
    expect(blocked).toBeLessThanOrEqual(3);
    expect(set.add({ x: 0, z: 0, radius: 1 })).toBeGreaterThan(0);
    expect(set.add({ x: 0, z: 0, radius: 1 })).toBe(-1);
  });
});

describe('createObstacleSet on a grid (ws/nav-4)', () => {
  it('writes a cost layer the edge hook reads, reroutes, and restores on remove', () => {
    const layer = new Float32Array(20 * 20);
    const grid = createNavGrid({
      width: 20,
      height: 20,
      cellSize: 1,
      neighbours: 8,
      walkable: (x, y) => !(y === 10 && x !== 9),
      edgeCost: (_from, to) => layer[to]!,
    });
    const set = createObstacleSet(grid, { maxObstacles: 2, layer });
    expect(set.layer).toBe(layer);
    const path = createNavPath();
    expect(findPath(grid, { x: 9, y: 0 }, { x: 9, y: 19 }, path)).toBe(true);
    expect(path.length).toBe(20);
    const v = grid.version;
    const id = set.add({ x: 9.5, z: 10.5, radius: 0.4 });
    expect(set.apply()).toBe(1);
    expect(layer[10 * 20 + 9]).toBe(Infinity);
    expect(grid.version).toBe(v + 1);
    expect(findPath(grid, { x: 9, y: 0 }, { x: 9, y: 19 }, path)).toBe(false);
    expect(set.apply()).toBe(0);
    expect(grid.version).toBe(v + 1);
    set.remove(id);
    expect(set.apply()).toBe(1);
    expect(layer[10 * 20 + 9]).toBe(0);
    expect(findPath(grid, { x: 9, y: 0 }, { x: 9, y: 19 }, path)).toBe(true);
    // A yawed box covers the cells it holds.
    set.add({ x: 5, z: 5, w: 3, d: 1, yaw: Math.PI / 2 });
    const cells = set.apply();
    expect(cells).toBeGreaterThanOrEqual(3);
    expect(cells).toBeLessThanOrEqual(8);
    expect(layer[5 * 20 + 4]).toBe(Infinity);
    expect(layer[4 * 20 + 4]).toBe(Infinity);
    expect(layer[6 * 20 + 4]).toBe(Infinity);
  });
});
