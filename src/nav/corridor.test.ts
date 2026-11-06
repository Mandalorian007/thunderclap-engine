import { describe, expect, it } from 'vitest';
import { createCorridor } from './corridor';
import { createCrowd } from './crowd';
import { OBSTACLE_AREA } from './mesh/areas';
import { createNavPath3, findMeshPath } from './mesh/mesh-path';
import { bakeNavMesh, type NavBakeAreaOptions, type NavMesh, type NavPoint3 } from './mesh/navmesh';
import type { NavBakeOptions } from './mesh/voxelize';
import { createObstacleSet } from './obstacles';
import { createPathQueue } from './query-queue';

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

const pt = (): NavPoint3 => ({ x: 0, y: 0, z: 0 });

describe('createCorridor (ws/nav-4)', () => {
  it('string-pulls the remaining polygons, drops passed ones and reports invalidation', () => {
    const mesh = floor(20, [[0, 0, 2, 2]]);
    const path = createNavPath3();
    expect(findMeshPath(mesh, { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, path)).toBe(true);
    expect(path.polyCount).toBeGreaterThan(2);
    const cor = createCorridor(mesh, 32);
    expect(cor.advance(0, 0, pt())).toBe(false);
    cor.set(path);
    expect(cor.count).toBe(path.polyCount);
    expect(cor.current()).toBe(path.polys[0]);
    expect(cor.target).toEqual({
      x: path.points[(path.length - 1) * 3],
      y: path.points[(path.length - 1) * 3 + 1],
      z: path.points[(path.length - 1) * 3 + 2],
    });
    const corner = pt();
    expect(cor.advance(-8, 0, corner)).toBe(true);
    // The first corner bends around the pillar: it lies before the pillar, off the x axis.
    expect(corner.x).toBeLessThan(0);
    expect(Math.abs(corner.z)).toBeGreaterThan(0.5);
    expect(cor.path.length).toBeGreaterThanOrEqual(3);
    expect(cor.valid(mesh)).toBe(true);
    // Walk to the corner, then past it: the head advances and the corridor shrinks.
    const before = cor.count;
    cor.advance(corner.x, corner.z, corner);
    let moved = false;
    for (let i = 0; i < 10 && !moved; i++) {
      cor.advance(corner.x + (i + 1) * 0.3, corner.z, corner);
      moved = cor.count < before;
    }
    expect(moved).toBe(true);
    // Near the target the corner is the target itself.
    cor.advance(7.5, 0, corner);
    expect(corner.x).toBeCloseTo(8, 1);
    expect(cor.path.length).toBe(2);
    // An obstacle on a remaining polygon invalidates the corridor.
    const set = createObstacleSet(mesh, { maxObstacles: 1 });
    set.add({ x: 7.9, z: 0, radius: 0.3 });
    set.apply();
    expect(cor.valid(mesh)).toBe(false);
    // The version moved, so a fresh corridor is needed; an obstacle under the polygon the agent
    // stands in leaves that corridor valid (it is walked out of), one further along does not.
    const again = createNavPath3();
    expect(findMeshPath(mesh, { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 3 }, again)).toBe(true);
    cor.set(again);
    expect(cor.valid(mesh)).toBe(true);
    mesh.area[cor.polys[cor.offset]!] = OBSTACLE_AREA;
    expect(cor.valid(mesh)).toBe(true);
    mesh.area[cor.polys[cor.offset + 1]!] = OBSTACLE_AREA;
    expect(cor.valid(mesh)).toBe(false);
    cor.clear();
    expect(cor.count).toBe(0);
  });
});

describe('Crowd on a mesh (ws/nav-4)', () => {
  it('32 agents cross the floor around a pillar and stay on the mesh', () => {
    const mesh = floor(20, [[0, 0, 2, 2]]);
    const crowd = createCrowd({ maxAgents: 32, neighborDist: 3 });
    crowd.attach(mesh, { maxWaypoints: 32, slowRadius: 1 });
    for (let i = 0; i < 32; i++) {
      const side = i < 16 ? -1 : 1;
      const k = i % 16;
      const z = -7 + k * 0.9;
      const idx = crowd.add({ x: side * 8, z, radius: 0.3, maxSpeed: 2 });
      expect(idx).toBe(i);
      const a = crowd.agents[i]!;
      expect(a.poly).toBeGreaterThanOrEqual(0);
      expect(Math.abs(a.y)).toBeLessThan(0.3);
      crowd.setTarget(i, -side * 8, 0, -z);
      expect(a.corridor?.count).toBeGreaterThan(0);
    }
    expect(crowd.replans).toBe(32);
    const near = pt();
    let minToMesh = 0;
    let steps = 0;
    for (; steps < 60 * 25; steps++) {
      crowd.update(1 / 60);
      let allReached = true;
      for (let i = 0; i < 32; i++) {
        const a = crowd.agents[i]!;
        const p = mesh.findNearestPoly(a.x, a.y, a.z, near, 2);
        expect(p).toBeGreaterThanOrEqual(0);
        const d = Math.hypot(near.x - a.x, near.z - a.z);
        if (d > minToMesh) minToMesh = d;
        expect(d).toBeLessThan(a.radius);
        // Never inside the pillar (its walkable hole is radius ≈ 1.5).
        expect(Math.hypot(a.x, a.z)).toBeGreaterThan(1.2);
        if (!a.targetReached) allReached = false;
      }
      if (allReached) break;
    }
    expect(steps).toBeLessThan(60 * 25);
    for (let i = 0; i < 32; i++) {
      const a = crowd.agents[i]!;
      expect(a.targetReached).toBe(true);
      expect(Math.abs(a.x - (i < 16 ? 8 : -8))).toBeLessThan(1);
    }
    expect(crowd.replans).toBe(32);
  });

  it('plans through a queue, replans once when an obstacle invalidates the corridor, and avoids it', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const queue = createPathQueue(mesh, { maxQueries: 64, iterationsPerUpdate: 64 });
    const set = createObstacleSet(mesh, { maxObstacles: 2 });
    const crowd = createCrowd({ maxAgents: 4 });
    crowd.attach(mesh, { queue, maxWaypoints: 32 });
    crowd.obstacles(set);
    const i = crowd.add({ x: 0, z: -8, radius: 0.3, maxSpeed: 2 });
    crowd.setTarget(i, 0, 0, 8);
    const a = crowd.agents[i]!;
    expect(a.corridor?.count).toBe(0);
    crowd.update(1 / 60);
    // Still waiting for the queue: no movement yet.
    expect(a.z).toBeCloseTo(-8, 5);
    queue.update();
    crowd.update(1 / 60);
    expect(a.corridor?.count).toBeGreaterThan(0);
    expect(a.z).toBeGreaterThan(-8);
    expect(crowd.replans).toBe(1);
    // Block the gap while the agent is on its way: one replan, around a pillar.
    for (let k = 0; k < 60; k++) crowd.update(1 / 60);
    set.add({ x: 0, z: 0, radius: 0.6 });
    set.apply();
    let maxX = 0;
    for (let k = 0; k < 60 * 20 && !a.targetReached; k++) {
      queue.update();
      crowd.update(1 / 60);
      maxX = Math.max(maxX, Math.abs(a.x));
      // The ORCA line keeps the agent clear of the obstacle disc.
      expect(Math.hypot(a.x, a.z)).toBeGreaterThan(0.6 + a.radius - 0.05);
    }
    expect(a.targetReached).toBe(true);
    expect(crowd.replans).toBe(2);
    expect(maxX).toBeGreaterThan(4);
  });
});
