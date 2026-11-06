import { describe, expect, it } from 'vitest';
import { findPath } from './astar';
import { createNavGrid } from './grid';
import { createNavPath3, findMeshPath } from './mesh/mesh-path';
import { bakeNavMesh, type NavBakeAreaOptions, type NavMesh } from './mesh/navmesh';
import type { NavBakeOptions } from './mesh/voxelize';
import { createNavPath, type NavPath } from './path';
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

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('createPathQueue on a grid (ws/nav-4)', () => {
  it('200 requests on a 200 × 200 grid give the same paths as findPath, within the pop budget', () => {
    const r = rng(7);
    const grid = createNavGrid({
      width: 200,
      height: 200,
      cellSize: 1,
      walkable: (x, y) => (x * 7 + y * 13) % 11 !== 0 || x === 0 || y === 0,
    });
    const queue = createPathQueue(grid, { maxQueries: 256, iterationsPerUpdate: 2000 });
    const outs: NavPath[] = [];
    const tickets: number[] = [];
    const ends: { fx: number; fy: number; tx: number; ty: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const e = {
        fx: Math.floor(r() * 200),
        fy: Math.floor(r() * 200),
        tx: Math.floor(r() * 200),
        ty: Math.floor(r() * 200),
      };
      ends.push(e);
      const out = createNavPath();
      outs.push(out);
      tickets.push(queue.request({ x: e.fx, y: e.fy }, { x: e.tx, y: e.ty }, out));
      expect(tickets[i]).toBeGreaterThan(0);
    }
    expect(queue.pending).toBe(200);
    expect(queue.status(tickets[0]!)).toBe('pending');
    let updates = 0;
    let done = 0;
    queue.onDone = () => done++;
    while (queue.pending > 0) {
      expect(queue.update()).toBeLessThanOrEqual(2000);
      updates++;
      expect(updates).toBeLessThan(100000);
    }
    expect(done).toBe(200);
    expect(queue.finished).toBe(200);
    expect(updates).toBeGreaterThan(5);
    const ref = createNavPath();
    for (let i = 0; i < 200; i++) {
      const e = ends[i]!;
      const ok = findPath(grid, { x: e.fx, y: e.fy }, { x: e.tx, y: e.ty }, ref);
      expect(queue.status(tickets[i]!)).toBe(ok ? 'done' : 'failed');
      expect(outs[i]!.length).toBe(ok ? ref.length : 0);
      if (ok)
        expect(outs[i]!.points.subarray(0, ref.length * 2)).toEqual(
          ref.points.subarray(0, ref.length * 2),
        );
    }
  });

  it('respects the pop budget per update, cancels without writing, smooths on request and restarts on a grid edit', () => {
    const grid = createNavGrid({ width: 50, height: 50, cellSize: 1 });
    const queue = createPathQueue(grid, { maxQueries: 4, iterationsPerUpdate: 10 });
    const a = createNavPath();
    const b = createNavPath();
    const ta = queue.request({ x: 0, y: 0 }, { x: 49, y: 49 }, a, { smooth: true });
    const tb = queue.request({ x: 0, y: 0 }, { x: 49, y: 0 }, b);
    expect(queue.update()).toBe(10);
    expect(queue.status(ta)).toBe('pending');
    expect(a.length).toBe(0);
    expect(queue.cancel(tb)).toBe(true);
    expect(queue.status(tb)).toBe('none');
    expect(queue.pending).toBe(1);
    // An edit under the in-flight search restarts it: the first update after it still pops 10.
    grid.setWalkable(25, 25, false);
    let n = 0;
    while (queue.status(ta) === 'pending') {
      expect(queue.update()).toBeLessThanOrEqual(10);
      n++;
    }
    expect(n).toBeGreaterThan(5);
    expect(queue.status(ta)).toBe('done');
    expect(a.version).toBe(grid.version);
    // Smoothed: a diagonal line is two points.
    expect(a.length).toBeLessThan(10);
    expect(b.length).toBe(0);
    expect(queue.cancel(ta)).toBe(false);
    expect(queue.cancel(999)).toBe(false);
    // Full queue reports -1; an unknown ticket is 'none'.
    for (let i = 0; i < 4; i++) queue.request({ x: 0, y: 0 }, { x: 1, y: 0 }, createNavPath());
    expect(queue.request({ x: 0, y: 0 }, { x: 1, y: 0 }, createNavPath())).toBe(-1);
    expect(queue.status(12345)).toBe('none');
  });
});

describe('createPathQueue on a mesh (ws/nav-4)', () => {
  it('slices mesh searches and returns findMeshPath results', () => {
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    const queue = createPathQueue(mesh, { maxQueries: 8, iterationsPerUpdate: 2 });
    const outs = [createNavPath3(), createNavPath3(), createNavPath3()];
    const ends = [
      [
        { x: -8, y: 0, z: -8 },
        { x: 8, y: 0, z: 8 },
      ],
      [
        { x: 0, y: 0, z: -8 },
        { x: 0, y: 0, z: 8 },
      ],
      [
        { x: 8, y: 0, z: -8 },
        { x: -8, y: 0, z: 8 },
      ],
    ] as const;
    const tickets = ends.map((e, i) => queue.request(e[0], e[1], outs[i]!));
    let n = 0;
    while (queue.pending > 0 && n < 1000) {
      queue.update();
      n++;
    }
    expect(n).toBeGreaterThan(3);
    const ref = createNavPath3();
    for (let i = 0; i < 3; i++) {
      expect(queue.status(tickets[i]!)).toBe('done');
      expect(findMeshPath(mesh, ends[i]![0], ends[i]![1], ref)).toBe(true);
      expect(outs[i]!.length).toBe(ref.length);
      expect(outs[i]!.polyCount).toBe(ref.polyCount);
      expect(outs[i]!.points.subarray(0, ref.length * 3)).toEqual(
        ref.points.subarray(0, ref.length * 3),
      );
    }
    // Off-mesh ends fail.
    const bad = createNavPath3();
    const t = queue.request({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, bad, { snapRadius: 1 });
    queue.update();
    expect(queue.status(t)).toBe('failed');
  });
});
