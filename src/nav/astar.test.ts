import { describe, expect, it } from 'vitest';
import { findPath, smoothPath } from './astar';
import { createNavGrid, type NavCell, type NavGrid } from './grid';
import { createNavPath, type NavPath, pathDistance } from './path';

/** The cells a path visits, from world centres back to cells. */
function cells(grid: NavGrid, path: NavPath): [number, number][] {
  const c: NavCell = { x: 0, y: 0 };
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

describe('findPath with edge costs', () => {
  it('goes around a climb when the penalty beats the detour', () => {
    // A ridge: column 2 sits one level up; crossing it costs the climb both ways.
    const level = (i: number) => (i % 5 === 2 ? 1 : 0);
    const g = createNavGrid({
      width: 5,
      height: 3,
      cellSize: 1,
      neighbours: 4,
      edgeCost: (from, to) => Math.abs(level(to) - level(from)) * 10,
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 }, p)).toBe(true);
    // No way round: the ridge spans every row, so the path pays the climb: 4 steps.
    expect(p.length).toBe(5);
    // Open a gap in the ridge at row 0 (level 0 there): the path detours through it.
    const lv = (i: number) => (i % 5 === 2 && i >= 5 ? 1 : 0);
    const ridge = createNavGrid({
      width: 5,
      height: 3,
      cellSize: 1,
      neighbours: 4,
      edgeCost: (from, to) => Math.abs(lv(to) - lv(from)) * 10,
    });
    expect(findPath(ridge, { x: 0, y: 1 }, { x: 4, y: 1 }, p)).toBe(true);
    expect(p.length).toBe(7);
    expect(cells(ridge, p)).toContainEqual([2, 0]);
    expect(cells(ridge, p)).not.toContainEqual([2, 1]);
  });

  it('blocks an edge one way only with Infinity', () => {
    // A ledge between (1,0) and (2,0): dropping east is free, climbing west is impossible.
    const g = createNavGrid({
      width: 4,
      height: 1,
      cellSize: 1,
      edgeCost: (from, to) => (from === 2 && to === 1 ? Infinity : 0),
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 3, y: 0 }, p)).toBe(true);
    expect(p.length).toBe(4);
    expect(findPath(g, { x: 3, y: 0 }, { x: 0, y: 0 }, p)).toBe(false);
    expect(p.length).toBe(0);
  });

  it('adds the hook to the weighted step and clamps a negative hook to zero', () => {
    const g = createNavGrid({
      width: 3,
      height: 1,
      cellSize: 1,
      cost: (x) => (x === 1 ? 2 : 1),
      edgeCost: (_from, to) => (to === 1 ? 0.5 : -5),
    });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, p)).toBe(true);
    expect(p.length).toBe(3);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, p, { maxCost: 3.4 })).toBe(false);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, p, { maxCost: 3.5 })).toBe(true);
  });
});

describe('findPath and smoothPath on a 4-neighbour grid', () => {
  // A corridor two cells wide with a jog: 8 neighbours cut the corners, 4 cannot.
  const make = (neighbours: 4 | 8) =>
    createNavGrid({
      width: 8,
      height: 4,
      cellSize: 1,
      neighbours,
      walkable: (x, y) => (x < 4 ? y < 2 : y >= 2),
    });

  it('gives different lengths for 4 and 8 neighbours on the same corridor', () => {
    const p = createNavPath();
    const g8 = make(8);
    expect(findPath(g8, { x: 0, y: 0 }, { x: 7, y: 3 }, p)).toBe(false);
    // Join the halves with a cell at the jog.
    g8.setWalkable(4, 1, true);
    expect(findPath(g8, { x: 0, y: 0 }, { x: 7, y: 3 }, p)).toBe(true);
    const eight = pathDistance(p);
    expectConnected(g8, p);
    const g4 = make(4);
    g4.setWalkable(4, 1, true);
    expect(findPath(g4, { x: 0, y: 0 }, { x: 7, y: 3 }, p)).toBe(true);
    expectConnected(g4, p, false);
    expect(pathDistance(p)).toBe(10);
    expect(eight).toBeLessThan(10);
    // `diagonal` overrides the grid either way.
    expect(findPath(g4, { x: 0, y: 0 }, { x: 7, y: 3 }, p, { diagonal: true })).toBe(true);
    expect(pathDistance(p)).toBeCloseTo(eight, 6);
    expect(findPath(g8, { x: 0, y: 0 }, { x: 7, y: 3 }, p, { diagonal: false })).toBe(true);
    expect(pathDistance(p)).toBe(10);
  });

  it('smoothPath keeps every corner in 4 mode: no diagonal legs', () => {
    const g4 = make(4);
    g4.setWalkable(4, 1, true);
    const p = createNavPath();
    findPath(g4, { x: 0, y: 0 }, { x: 7, y: 3 }, p);
    const before = pathDistance(p);
    p.cursor = 2;
    smoothPath(g4, p);
    expect(p.cursor).toBe(0);
    expect(pathDistance(p)).toBe(before);
    const cs = cells(g4, p);
    expect(cs[0]).toEqual([0, 0]);
    expect(cs[cs.length - 1]).toEqual([7, 3]);
    for (let i = 1; i < cs.length; i++) {
      // Each leg is along a row or a column, and the kept points are the bends only.
      expect(cs[i]![0] === cs[i - 1]![0] || cs[i]![1] === cs[i - 1]![1]).toBe(true);
    }
    expect(p.length).toBeLessThan(11);
    expect(p.length).toBeGreaterThanOrEqual(4);
    // An open 4-grid row collapses to its two ends.
    const open4 = createNavGrid({ width: 6, height: 1, cellSize: 1, neighbours: 4 });
    findPath(open4, { x: 0, y: 0 }, { x: 5, y: 0 }, p);
    expect(smoothPath(open4, p).length).toBe(2);
  });
});

describe('findPath options maxCost and heuristicWeight', () => {
  it('gives up on a cost cap without exploring the whole grid', () => {
    const g = createNavGrid({ width: 50, height: 50, cellSize: 1, neighbours: 4 });
    const p = createNavPath();
    expect(findPath(g, { x: 0, y: 0 }, { x: 49, y: 49 }, p, { maxCost: 97 })).toBe(false);
    expect(p.length).toBe(0);
    expect(findPath(g, { x: 0, y: 0 }, { x: 49, y: 49 }, p, { maxCost: 98 })).toBe(true);
    expect(p.length).toBe(99);
    // A cap of 4 opens at most the cells within 4 steps (41), so a `maxExpand` of 60 is never
    // hit: the false comes from the cap. Without the cap the same `maxExpand` gives up.
    const far = { x: 49, y: 49 };
    expect(findPath(g, { x: 25, y: 25 }, far, p, { maxCost: 4, maxExpand: 60 })).toBe(false);
    expect(findPath(g, { x: 25, y: 25 }, far, p, { maxExpand: 60 })).toBe(false);
    expect(findPath(g, { x: 25, y: 25 }, { x: 27, y: 27 }, p, { maxCost: 4 })).toBe(true);
    expect(findPath(g, { x: 25, y: 25 }, { x: 27, y: 27 }, p, { maxCost: 3 })).toBe(false);
    // NavCell costs count towards the cap.
    const mud = createNavGrid({ width: 4, height: 1, cellSize: 1, cost: () => 3 });
    expect(findPath(mud, { x: 0, y: 0 }, { x: 3, y: 0 }, p, { maxCost: 8 })).toBe(false);
    expect(findPath(mud, { x: 0, y: 0 }, { x: 3, y: 0 }, p, { maxCost: 9 })).toBe(true);
  });

  it('a weighted heuristic expands fewer cells for the same route, and 0 is Dijkstra', () => {
    // A wall with one gap: exact A* must spread wide; weighted A* dives for the gap.
    const g = createNavGrid({
      width: 60,
      height: 30,
      cellSize: 1,
      walkable: (x, y) => x !== 30 || y === 0,
    });
    const p = createNavPath();
    const from = { x: 5, y: 29 };
    const to = { x: 55, y: 29 };
    expect(findPath(g, from, to, p)).toBe(true);
    const exact = pathDistance(p);
    // The smallest `maxExpand` that finds the path measures the cells expanded.
    const expanded = (heuristicWeight: number): number => {
      let lo = 1;
      let hi = g.size;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (findPath(g, from, to, p, { maxExpand: mid, heuristicWeight })) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const w1 = expanded(1);
    const w3 = expanded(3);
    expect(w3).toBeLessThan(w1);
    expect(findPath(g, from, to, p, { heuristicWeight: 3 })).toBe(true);
    expect(pathDistance(p)).toBeLessThanOrEqual(exact * 3 + 1e-9);
    expect(pathDistance(p)).toBeGreaterThanOrEqual(exact - 1e-9);
    expect(findPath(g, from, to, p, { heuristicWeight: 0 })).toBe(true);
    expect(pathDistance(p)).toBeCloseTo(exact, 6);
    expect(expanded(0)).toBeGreaterThanOrEqual(w1);
  });
});
