import { describe, expect, it } from 'vitest';
import { findPath, smoothPath } from './astar';
import { type Cell, createNavGrid, type NavGrid } from './grid';
import { createNavPath, type NavPath, pathDistance } from './path';

/** The cells a path visits, from world centres back to cells. */
function cells(grid: NavGrid, path: NavPath): [number, number][] {
  const c: Cell = { x: 0, y: 0 };
  const out: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    grid.toCell(path.points[i * 2]!, path.points[i * 2 + 1]!, c);
    out.push([c.x, c.y]);
  }
  return out;
}

/** Every consecutive pair is one king move and every cell is walkable. */
function expectConnected(grid: NavGrid, path: NavPath, diagonal = true): void {
  const cs = cells(grid, path);
  for (let i = 0; i < cs.length; i++) {
    expect(grid.isWalkable(cs[i]![0], cs[i]![1])).toBe(true);
    if (i === 0) continue;
    const dx = Math.abs(cs[i]![0] - cs[i - 1]![0]);
    const dy = Math.abs(cs[i]![1] - cs[i - 1]![1]);
    expect(dx <= 1 && dy <= 1 && dx + dy > 0).toBe(true);
    if (!diagonal) expect(dx + dy).toBe(1);
  }
}

describe('findPath', () => {
  it('finds a straight path on an open grid, start to goal', () => {
    const g = createNavGrid({ width: 10, height: 10, cellSize: 2, origin: { x: 10, z: 20 } });
    const p = createNavPath(4);
    expect(findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 }, p)).toBe(true);
    expect(p.length).toBe(10);
    expect(p.cursor).toBe(0);
    expect(p.version).toBe(0);
    expect(p.points[0]).toBe(11);
    expect(p.points[1]).toBe(21);
    expect(p.points[18]).toBe(29);
    expect(p.points[19]).toBe(21);
    expect(cells(g, p)[0]).toEqual([0, 0]);
    expect(cells(g, p)[9]).toEqual([9, 0]);
    expect(p.points.length).toBeGreaterThanOrEqual(20);
  });

  it('takes diagonals when allowed and only orthogonal steps when not', () => {
    const g = createNavGrid({ width: 8, height: 8, cellSize: 1 });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 7, y: 7 }, p)).toBe(true);
    expect(p.length).toBe(8);
    expect(pathDistance(p)).toBeCloseTo(7 * Math.SQRT2, 5);
    expectConnected(g, p);
    expect(findPath(g, { x: 0, y: 0 }, { x: 7, y: 7 }, p, { diagonal: false })).toBe(true);
    expect(p.length).toBe(15);
    expect(pathDistance(p)).toBeCloseTo(14, 5);
    expectConnected(g, p, false);
  });

  it('routes around a wall with one gap', () => {
    // A wall down column 5 with a gap at row 7.
    const g = createNavGrid({
      width: 10,
      height: 10,
      cellSize: 1,
      walkable: (x, y) => x !== 5 || y === 7,
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 }, p)).toBe(true);
    expectConnected(g, p);
    expect(cells(g, p)).toContainEqual([5, 7]);
    // Through the gap: 7 down and 7 up at least, mostly diagonal.
    expect(pathDistance(p)).toBeGreaterThan(14);
    expect(pathDistance(p)).toBeLessThan(20);
  });

  it('returns false with an empty path when there is no route, and on bad endpoints', () => {
    // Column 3 is a wall from top to bottom.
    const g = createNavGrid({ width: 6, height: 6, cellSize: 1, walkable: (x) => x !== 3 });
    // Fill the path, then fail: the failure empties it.
    const q = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 }, q)).toBe(true);
    expect(findPath(g, { x: 0, y: 0 }, { x: 5, y: 5 }, q)).toBe(false);
    expect(q.length).toBe(0);
    expect(findPath(g, { x: 0, y: 0 }, { x: 3, y: 0 }, q)).toBe(false);
    expect(findPath(g, { x: 3, y: 0 }, { x: 0, y: 0 }, q)).toBe(false);
    expect(findPath(g, { x: 0, y: 0 }, { x: 6, y: 0 }, q)).toBe(false);
    expect(findPath(g, { x: -1, y: 0 }, { x: 0, y: 0 }, q)).toBe(false);
  });

  it('never cuts a corner between two diagonal walls', () => {
    // Open except (1,0) and (0,1): from (0,0) the only way out is... nowhere.
    const g = createNavGrid({
      width: 3,
      height: 3,
      cellSize: 1,
      walkable: (x, y) => !((x === 1 && y === 0) || (x === 0 && y === 1)),
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 }, p)).toBe(false);
    // One wall beside the corner still blocks the diagonal: go round through the open side.
    g.setWalkable(0, 1, true);
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 }, p)).toBe(true);
    expect(cells(g, p)).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 }, p, { cutCorners: false })).toBe(true);
    expect(p.length).toBe(3);
  });

  it('prefers cheap cells over short ones', () => {
    // Row 0 is mud (cost 5); rows 1-2 are plain. From (0,0) to (4,0) it dips down.
    const g = createNavGrid({
      width: 5,
      height: 3,
      cellSize: 1,
      cost: (_x, y) => (y === 0 ? 5 : 1),
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 }, p)).toBe(true);
    const cs = cells(g, p);
    expect(cs.slice(1, -1).every(([, y]) => y > 0)).toBe(true);
  });

  it('is a one-point path when start equals goal', () => {
    const g = createNavGrid({ width: 3, height: 3, cellSize: 4 });
    const p = createNavPath();
    expect(findPath(g, { x: 1, y: 1 }, { x: 1, y: 1 }, p)).toBe(true);
    expect(p.length).toBe(1);
    expect(p.points[0]).toBe(6);
    expect(p.points[1]).toBe(6);
  });

  it('gives up at maxExpand', () => {
    const g = createNavGrid({ width: 30, height: 30, cellSize: 1 });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 29, y: 29 }, p, { maxExpand: 5 })).toBe(false);
    expect(p.length).toBe(0);
    expect(findPath(g, { x: 0, y: 0 }, { x: 29, y: 29 }, p, { maxExpand: 900 })).toBe(true);
  });

  it('stamps the grid version so an edit marks the path stale, and reroutes after it', () => {
    const g = createNavGrid({ width: 8, height: 3, cellSize: 1 });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 1 }, { x: 7, y: 1 }, p)).toBe(true);
    expect(p.version).toBe(g.version);
    expect(p.length).toBe(8);
    g.setWalkable(4, 1, false);
    expect(p.version).not.toBe(g.version);
    expect(findPath(g, { x: 0, y: 1 }, { x: 7, y: 1 }, p)).toBe(true);
    expect(p.version).toBe(g.version);
    expectConnected(g, p);
    expect(cells(g, p)).not.toContainEqual([4, 1]);
    expect(p.length).toBe(8);
    expect(pathDistance(p)).toBeCloseTo(5 + 2 * Math.SQRT2, 5);
  });

  it('reuses its scratch across queries and grows the path only when it must', () => {
    const g = createNavGrid({ width: 40, height: 40, cellSize: 1 });
    const p = createNavPath(8);
    expect(findPath(g, { x: 0, y: 0 }, { x: 39, y: 0 }, p)).toBe(true);
    const buf = p.points;
    expect(buf.length).toBeGreaterThanOrEqual(80);
    for (let i = 0; i < 20; i++) {
      expect(findPath(g, { x: i, y: 0 }, { x: 39 - i, y: 39 }, p)).toBe(true);
      expect(p.points).toBe(buf);
    }
  });
});

describe('smoothPath', () => {
  it('collapses an open-grid staircase to its two ends', () => {
    const g = createNavGrid({ width: 10, height: 10, cellSize: 1 });
    const p = createNavPath();
    findPath(g, { x: 0, y: 0 }, { x: 9, y: 4 }, p);
    expect(p.length).toBeGreaterThan(2);
    p.cursor = 3;
    smoothPath(g, p);
    expect(p.length).toBe(2);
    expect(p.cursor).toBe(0);
    expect(cells(g, p)).toEqual([
      [0, 0],
      [9, 4],
    ]);
  });

  it('keeps the bend around a wall and never crosses it', () => {
    const g = createNavGrid({
      width: 10,
      height: 10,
      cellSize: 1,
      walkable: (x, y) => x !== 5 || y === 7,
    });
    const p = createNavPath();
    findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 }, p);
    const before = pathDistance(p);
    smoothPath(g, p);
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.length).toBeLessThan(8);
    expect(pathDistance(p)).toBeLessThanOrEqual(before + 1e-6);
    const cs = cells(g, p);
    // Every route enters the gap from (4,7); nothing past it is visible from the start.
    expect(cs[1]).toEqual([4, 7]);
    // Each leg is a clear line of walkable cells.
    for (let i = 1; i < cs.length; i++) {
      const [ax, ay] = cs[i - 1]!;
      const [bx, by] = cs[i]!;
      const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let k = 0; k <= n; k++) {
        const x = Math.round(ax + ((bx - ax) * k) / n);
        const y = Math.round(ay + ((by - ay) * k) / n);
        expect(g.isWalkable(x, y)).toBe(true);
      }
    }
  });

  it('leaves short and empty paths alone', () => {
    const g = createNavGrid({ width: 4, height: 4, cellSize: 1 });
    const p = createNavPath();
    expect(smoothPath(g, p).length).toBe(0);
    findPath(g, { x: 0, y: 0 }, { x: 1, y: 0 }, p);
    expect(smoothPath(g, p).length).toBe(2);
  });
});
