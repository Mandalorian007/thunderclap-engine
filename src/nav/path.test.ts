import { describe, expect, it } from 'vitest';
import { findPath } from './astar';
import { createNavGrid, type NavPoint } from './grid';
import {
  clearPath,
  createNavPath,
  followPath,
  hasLineOfWalkable,
  pathDistance,
  pathPoint,
  reservePath,
  smoothPath,
} from './path';

function pathOf(...pts: [number, number][]) {
  const p = createNavPath(pts.length);
  for (const [i, [x, z]] of pts.entries()) {
    p.points[i * 2] = x;
    p.points[i * 2 + 1] = z;
  }
  p.length = pts.length;
  return p;
}

const v: NavPoint = { x: 0, z: 0 };

describe('NavPath', () => {
  it('creates, reserves (keeping data), reads points and clears', () => {
    const p = createNavPath(2);
    expect(p.points.length).toBe(4);
    expect(p.length).toBe(0);
    expect(p.version).toBe(-1);
    p.points[0] = 7;
    p.points[1] = 8;
    reservePath(p, 2);
    expect(p.points.length).toBe(4);
    reservePath(p, 10);
    expect(p.points.length).toBeGreaterThanOrEqual(20);
    expect(p.points[0]).toBe(7);
    p.length = 1;
    expect(pathPoint(p, 0, v)).toEqual({ x: 7, z: 8 });
    p.cursor = 1;
    clearPath(p);
    expect(p.length).toBe(0);
    expect(p.cursor).toBe(0);
    expect(createNavPath(0).points.length).toBe(2);
  });

  it('measures its length', () => {
    expect(pathDistance(pathOf([0, 0], [3, 0], [3, 4]))).toBe(7);
    expect(pathDistance(pathOf([1, 1]))).toBe(0);
    expect(pathDistance(createNavPath())).toBe(0);
  });
});

describe('followPath', () => {
  it('heads for the current waypoint at full speed', () => {
    const p = pathOf([0, 0], [10, 0], [10, 10]);
    expect(followPath(p, { x: 0, z: 0 }, 5, 0.5, v)).toBe('moving');
    // Standing on the first waypoint advances past it to the second.
    expect(p.cursor).toBe(1);
    expect(v).toEqual({ x: 5, z: 0 });
    expect(followPath(p, { x: 7, z: 4 }, 5, 0.5, v)).toBe('moving');
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(5, 6);
    expect(v.x).toBeCloseTo(3, 6);
    expect(v.z).toBeCloseTo(-4, 6);
  });

  it('advances the cursor inside arriveRadius and arrives at the last point', () => {
    const p = pathOf([0, 0], [10, 0], [10, 10]);
    p.cursor = 1;
    expect(followPath(p, { x: 9.8, z: 0.1 }, 5, 0.5, v)).toBe('moving');
    expect(p.cursor).toBe(2);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(5, 6);
    expect(v.x).toBeCloseTo(0.1, 1);
    expect(v.z).toBeCloseTo(5, 1);
    expect(followPath(p, { x: 10, z: 9.7 }, 5, 0.5, v)).toBe('arrived');
    expect(v).toEqual({ x: 0, z: 0 });
    expect(p.cursor).toBe(2);
    // Walking away again keeps heading for the last point.
    expect(followPath(p, { x: 10, z: 5 }, 2, 0.5, v)).toBe('moving');
    expect(v).toEqual({ x: 0, z: 2 });
  });

  it('skips several waypoints already within reach', () => {
    const p = pathOf([0, 0], [1, 0], [2, 0], [20, 0]);
    expect(followPath(p, { x: 1, z: 0 }, 1, 1.5, v)).toBe('moving');
    expect(p.cursor).toBe(3);
    expect(v).toEqual({ x: 1, z: 0 });
  });

  it('treats an empty path as arrived and clamps a stale cursor', () => {
    const empty = createNavPath();
    expect(followPath(empty, { x: 1, z: 1 }, 3, 1, v)).toBe('arrived');
    expect(v).toEqual({ x: 0, z: 0 });
    const p = pathOf([0, 0], [10, 0]);
    p.cursor = 9;
    expect(followPath(p, { x: 0, z: 0 }, 1, 0.1, v)).toBe('moving');
    expect(p.cursor).toBe(1);
    expect(v).toEqual({ x: 1, z: 0 });
  });
});

describe('hasLineOfWalkable and smoothPath with an edge-cost hook (ws/nav-4)', () => {
  it('keeps the bend at a one-way ledge the grid hook forbids', () => {
    // A 5 × 3 grid: rows 0 and 2 are plateaus, row 1 a ramp cell at x = 4 only; the hook
    // forbids every row-0 → row-1 step except through the ramp column.
    const g = createNavGrid({
      width: 5,
      height: 3,
      cellSize: 1,
      neighbours: 8,
      edgeCost: (from, to) => {
        const fy = Math.floor(from / 5);
        const ty = Math.floor(to / 5);
        if (fy === ty) return 0;
        return to % 5 === 4 && from % 5 === 4 ? 0 : Infinity;
      },
    });
    const path = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 0, y: 2 }, path)).toBe(true);
    expect(path.length).toBeGreaterThan(3);
    // The hook-aware line test refuses the straight cut, so smoothing keeps the detour.
    expect(hasLineOfWalkable(g, 0, 0, 0, 2)).toBe(false);
    expect(hasLineOfWalkable(g, 0, 0, 0, 2, { edgeCost: null })).toBe(true);
    smoothPath(g, path);
    expect(path.length).toBeGreaterThanOrEqual(3);
    const p = { x: 0, z: 0 };
    pathPoint(path, 1, p);
    expect(p.x).toBeGreaterThan(3);
    // Without the hook the smoothing collapses the path to a straight line.
    expect(findPath(g, { x: 0, y: 0 }, { x: 0, y: 2 }, path)).toBe(true);
    smoothPath(g, path, { edgeCost: null });
    expect(path.length).toBe(2);
  });
});
