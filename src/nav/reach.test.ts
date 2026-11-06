import { describe, expect, it } from 'vitest';
import { findPath } from './astar';
import { type Cell, createNavGrid, type NavGrid } from './grid';
import { createNavPath, type NavPath } from './path';
import { createReach, reachable } from './reach';

function cells(grid: NavGrid, path: NavPath): [number, number][] {
  const c: Cell = { x: 0, y: 0 };
  const out: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    grid.toCell(path.points[i * 2]!, path.points[i * 2 + 1]!, c);
    out.push([c.x, c.y]);
  }
  return out;
}

describe('reachable', () => {
  it('reaches every cell within the budget, the boundary included, nearest first', () => {
    const g = createNavGrid({ width: 7, height: 7, cellSize: 1, neighbours: 4 });
    const r = reachable(g, g.index(3, 3), 2);
    // A Manhattan diamond of radius 2: 1 + 4 + 8 = 13 cells.
    expect(r.count).toBe(13);
    expect(r.budget).toBe(2);
    expect(r.version).toBe(0);
    expect(r.stale).toBe(false);
    expect(r.has(g.index(3, 3))).toBe(true);
    expect(r.has(g.index(5, 3))).toBe(true);
    expect(r.has(g.index(6, 3))).toBe(false);
    expect(r.has(g.index(4, 4))).toBe(true);
    expect(r.has(g.index(5, 4))).toBe(false);
    expect(r.has(-1)).toBe(false);
    expect(r.distances[g.index(3, 3)]).toBe(0);
    expect(r.distances[g.index(5, 3)]).toBe(2);
    expect(r.distances[g.index(6, 3)]).toBe(Infinity);
    expect(r.parents[g.index(3, 3)]).toBe(-1);
    expect(r.parents[g.index(5, 3)]).toBe(g.index(4, 3));
    const seen: number[] = [];
    r.forEach((i, d) => {
      seen.push(d);
      expect(r.has(i)).toBe(true);
    });
    expect(seen).toHaveLength(13);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    // A budget below the cheapest step reaches the start alone.
    expect(reachable(g, g.index(3, 3), 0.5).count).toBe(1);
  });

  it('honours cell costs, edge costs and the 8-neighbourhood', () => {
    const g = createNavGrid({
      width: 5,
      height: 5,
      cellSize: 1,
      cost: (x) => (x === 3 ? 3 : 1),
      edgeCost: (from, to) => (from === 12 && to === 7 ? Infinity : 0),
    });
    const r = reachable(g, 12, 1.5);
    // From (2,2): the four orthogonal at 1 and the four diagonals at √2, except (2,1): blocked
    // by the hook, and (3,2): cost 3. The diagonals into column 3 cost 3√2 > 1.5.
    expect(r.has(g.index(1, 2))).toBe(true);
    expect(r.has(g.index(2, 3))).toBe(true);
    expect(r.has(g.index(2, 1))).toBe(false);
    expect(r.has(g.index(3, 2))).toBe(false);
    expect(r.has(g.index(1, 1))).toBe(true);
    expect(r.has(g.index(3, 1))).toBe(false);
    expect(r.distances[g.index(1, 3)]).toBeCloseTo(Math.SQRT2, 5);
    expect(r.count).toBe(1 + 2 + 2);
  });

  it('floods from several starts at once', () => {
    const g = createNavGrid({ width: 9, height: 1, cellSize: 1, neighbours: 4 });
    const r = reachable(g, [0, 8], 2);
    expect(r.count).toBe(6);
    expect(r.has(2)).toBe(true);
    expect(r.has(3)).toBe(false);
    expect(r.has(6)).toBe(true);
    expect(r.parents[6]).toBe(7);
    expect(r.parents[0]).toBe(-1);
    expect(r.parents[8]).toBe(-1);
    // Skipped starts: out of the grid or unwalkable.
    g.setWalkable(8, 0, false);
    const q = reachable(g, [0, 8, 99, -1], 1);
    expect(q.count).toBe(2);
  });

  it('reconstructs the path findPath returns for the same costs, from either end', () => {
    // A snaking corridor so the cheapest route is unique.
    const g = createNavGrid({
      width: 6,
      height: 5,
      cellSize: 2,
      origin: { x: 10, z: 10 },
      walkable: (x, y) => (y % 2 === 0 ? true : y === 1 ? x === 5 : x === 0),
    });
    const r = reachable(g, g.index(0, 0), 100);
    const viaReach = createNavPath(4);
    const viaAstar = createNavPath(4);
    const goal = g.index(5, 4);
    expect(r.pathTo(goal, viaReach)).toBe(true);
    expect(findPath(g, { x: 0, y: 0 }, { x: 5, y: 4 }, viaAstar)).toBe(true);
    expect(viaReach.length).toBe(viaAstar.length);
    expect(cells(g, viaReach)).toEqual(cells(g, viaAstar));
    expect(viaReach.version).toBe(g.version);
    expect(viaReach.cursor).toBe(0);
    expect(r.distances[goal]).toBe(19);
    // The start is a one-point path; an unreached cell empties the path.
    expect(r.pathTo(g.index(0, 0), viaReach)).toBe(true);
    expect(viaReach.length).toBe(1);
    expect(reachable(g, g.index(0, 0), 3).pathTo(goal, viaReach)).toBe(false);
    expect(viaReach.length).toBe(0);
    expect(r.pathTo(g.index(3, 1), viaReach)).toBe(false);
  });

  it('reuses one Reach per grid, or the one given, and allocates nothing on the second call', () => {
    const g = createNavGrid({ width: 16, height: 16, cellSize: 1 });
    const a = reachable(g, 0, 4);
    const b = reachable(g, 255, 6);
    expect(b).toBe(a);
    expect(a.count).toBeGreaterThan(1);
    expect(a.has(0)).toBe(false);
    expect(a.has(255)).toBe(true);
    const own = createReach(g);
    expect(own.count).toBe(0);
    expect(own.version).toBe(-1);
    expect(reachable(g, 0, 4, own)).toBe(own);
    expect(own).not.toBe(a);
    const cellsBuf = own.cells;
    const distBuf = own.distances;
    const parentBuf = own.parents;
    reachable(g, [3, 7], 9, own);
    expect(own.cells).toBe(cellsBuf);
    expect(own.distances).toBe(distBuf);
    expect(own.parents).toBe(parentBuf);
    // A Reach from another grid is refused.
    const h = createNavGrid({ width: 2, height: 2, cellSize: 1 });
    expect(() => reachable(h, 0, 1, own)).toThrow();
    // The slate is clean between queries: a cell reached before and not now is unreached.
    const first = reachable(g, 0, 30, own).count;
    expect(first).toBe(256);
    const second = reachable(g, 0, 1, own);
    expect(second.count).toBe(3);
    expect(second.has(255)).toBe(false);
    expect(second.parents[255]).toBe(-1);
    expect(second.distances[255]).toBe(Infinity);
  });

  it('is stale after a grid edit', () => {
    const g = createNavGrid({ width: 4, height: 4, cellSize: 1 });
    const r = reachable(g, 0, 2);
    expect(r.stale).toBe(false);
    g.setWalkable(1, 0, false);
    expect(r.stale).toBe(true);
    g.touch();
    expect(g.version).toBe(2);
    reachable(g, 0, 2);
    expect(r.stale).toBe(false);
  });
});
