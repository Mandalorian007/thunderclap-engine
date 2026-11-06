import { describe, expect, it } from 'vitest';
import { createObstacleSet } from '../obstacles';
import { createAreaCosts } from './areas';
import { createFlowField3 } from './flow3';
import { createNavPath3, findMeshPath, pathDistance3 } from './mesh-path';
import { bakeNavMesh, type NavBakeAreaOptions, type NavMesh, type NavPoint3 } from './navmesh';
import type { NavBakeOptions } from './voxelize';

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

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('createFlowField3 (ws/nav-4)', () => {
  it('every direction leads to a smaller distance and ends at the goal', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
      [0, 5, 6, 1],
    ]);
    const goal = { x: 0, y: 0, z: 8 };
    const field = createFlowField3(mesh, [goal]);
    expect(field.version).toBe(mesh.version);
    expect(field.stale).toBe(false);
    expect(field.reached).toBe(mesh.polyCount);
    const r = rng(3);
    const dir: NavPoint3 = { x: 0, y: 0, z: 0 };
    const p: NavPoint3 = { x: 0, y: 0, z: 0 };
    let walks = 0;
    for (let trial = 0; trial < 40; trial++) {
      if (mesh.findRandomPoint(p, r) < 0) continue;
      let d = field.distanceAt(p.x, p.y, p.z);
      expect(d).toBeLessThan(Infinity);
      let steps = 0;
      while (Math.hypot(p.x - goal.x, p.z - goal.z) > 0.5 && steps < 400) {
        const poly = field.direction3(p.x, p.y, p.z, dir);
        expect(poly).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 6);
        const step = 0.1;
        p.x += dir.x * step;
        p.z += dir.z * step;
        p.y = mesh.height(p.x, p.z);
        expect(Number.isNaN(p.y)).toBe(false);
        const nd = field.distanceAt(p.x, p.y, p.z);
        expect(nd).toBeLessThan(d);
        d = nd;
        steps++;
      }
      expect(steps).toBeLessThan(400);
      walks++;
    }
    expect(walks).toBeGreaterThan(30);
    // At the goal (on the surface) the direction is zero.
    field.direction3(goal.x, mesh.height(goal.x, goal.z), goal.z, dir);
    expect(dir).toEqual({ x: 0, y: 0, z: 0 });
    expect(field.direction3(100, 0, 0, dir)).toBe(-1);
  });

  it('matches findMeshPath length within 10 % on a corridor mesh, and prices mud', () => {
    const mesh = floor(
      20,
      [
        [-4, 0, 2, 2],
        [4, 0, 2, 2],
      ],
      {
        areas: [{ shape: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, area: 1 }],
      },
    );
    const goal = { x: 0, y: 0, z: 8 };
    const field = createFlowField3(mesh, [goal]);
    const path = createNavPath3();
    const start = { x: 0, y: 0, z: -8 };
    expect(findMeshPath(mesh, start, goal, path)).toBe(true);
    const len = pathDistance3(path);
    const d = field.distanceAt(start.x, start.y, start.z);
    expect(Math.abs(d - len) / len).toBeLessThan(0.1);
    // Mud at 2×: the field's distance through the gap grows by the gap polygon's share.
    const costs = createAreaCosts();
    costs[1] = 2;
    const mud = createFlowField3(mesh, [goal], { areaCost: costs });
    const dm = mud.distanceAt(start.x, start.y, start.z);
    expect(dm).toBeGreaterThan(d + 2);
    expect(dm).toBeLessThan(d + 8);
    // Excluded mud flows around through the lanes.
    costs[1] = Infinity;
    const around = createFlowField3(mesh, [goal], { areaCost: costs });
    expect(around.distances[mesh.findPolyAt(0, 0, 0)]).toBe(Infinity);
    expect(around.distanceAt(start.x, start.y, start.z)).toBeGreaterThan(d + 2);
  });

  it('walks 48 starters from a row to the goal, through portals, without one sticking', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const goal: NavPoint3 = { x: 0, y: mesh.height(0, 8), z: 8 };
    const field = createFlowField3(mesh, [goal]);
    const n = 48;
    const w = new Float64Array(n * 3);
    const done = new Uint8Array(n);
    const dir: NavPoint3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const x = -7.5 + (i % 12) * (15 / 11);
      const z = -8.5 + Math.floor(i / 12);
      w[i * 3] = x;
      w[i * 3 + 1] = mesh.height(x, z);
      w[i * 3 + 2] = z;
    }
    // A point on a portal midpoint answers for the polygon downstream, never back to the portal.
    let portals = 0;
    const a: NavPoint3 = { x: 0, y: 0, z: 0 };
    const b: NavPoint3 = { x: 0, y: 0, z: 0 };
    for (let p = 0; p < mesh.polyCount; p++) {
      const e = field.portal[p]!;
      if (e < 0) continue;
      const c = mesh.polyVertexCount(p);
      mesh.polyVertex(p, e, a);
      mesh.polyVertex(p, (e + 1) % c, b);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      field.direction3(mx, mesh.height(mx, mz), mz, dir);
      const dBefore = field.distanceAt(mx, mesh.height(mx, mz), mz);
      const sx = mx + dir.x * 0.05;
      const sz = mz + dir.z * 0.05;
      expect(field.distanceAt(sx, mesh.height(sx, sz), sz)).toBeLessThan(dBefore);
      portals++;
    }
    expect(portals).toBeGreaterThan(10);
    const step = 2 / 60;
    let arrived = 0;
    for (let t = 0; t < 60 * 30 && arrived < n; t++) {
      arrived = 0;
      for (let i = 0; i < n; i++) {
        if (done[i] === 1) {
          arrived++;
          continue;
        }
        const x = w[i * 3]!;
        const z = w[i * 3 + 2]!;
        const dx = goal.x - x;
        const dz = goal.z - z;
        if (dx * dx + dz * dz <= 0.25) {
          done[i] = 1;
          arrived++;
          continue;
        }
        const p = field.direction3(x, w[i * 3 + 1]!, z, dir);
        expect(p).toBeGreaterThanOrEqual(0);
        const s = Math.min(step, Math.sqrt(dx * dx + dz * dz));
        w[i * 3] = x + dir.x * s;
        w[i * 3 + 2] = z + dir.z * s;
        w[i * 3 + 1] = mesh.height(w[i * 3]!, w[i * 3 + 2]!, p);
      }
    }
    expect(arrived).toBe(n);
  });

  it('is stale after an obstacle and update() rebuilds around it', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const field = createFlowField3(mesh, [{ x: 0, y: 0, z: 8 }]);
    const before = field.distanceAt(0, 0, -8);
    const set = createObstacleSet(mesh, { maxObstacles: 1 });
    set.add({ x: 0, z: 0, radius: 0.5 });
    set.apply();
    expect(field.stale).toBe(true);
    expect(field.update()).toBe(true);
    expect(field.update()).toBe(false);
    expect(field.stale).toBe(false);
    expect(field.distanceAt(0, 0, -8)).toBeGreaterThan(before + 2);
    expect(field.reached).toBe(mesh.polyCount - 1);
    const dir: NavPoint3 = { x: 0, y: 0, z: 0 };
    field.direction3(0, 0, 0, dir);
    expect(dir).toEqual({ x: 0, y: 0, z: 0 });
  });
});
