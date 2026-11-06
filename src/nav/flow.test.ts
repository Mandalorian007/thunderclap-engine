import { describe, expect, it } from 'vitest';
import { findPath } from './astar';
import { createFlowField } from './flow';
import { createNavGrid, type NavPoint } from './grid';
import { createNavPath } from './path';

const out: NavPoint = { x: 0, z: 0 };

describe('createFlowField', () => {
  it('is unbuilt until build: every distance Infinity, every direction zero', () => {
    const g = createNavGrid({ width: 4, height: 4, cellSize: 1 });
    const f = createFlowField(g);
    expect(f.version).toBe(-1);
    expect(f.distance(1, 1)).toBe(Infinity);
    expect(f.direction(1, 1, out)).toEqual({ x: 0, z: 0 });
  });

  it('builds distances from one goal and points every cell at it', () => {
    const g = createNavGrid({ width: 5, height: 5, cellSize: 2, origin: { x: 10, z: 10 } });
    const f = createFlowField(g);
    f.build([{ x: 4, y: 4 }]);
    expect(f.version).toBe(0);
    expect(f.distance(4, 4)).toBe(0);
    expect(f.distance(0, 0)).toBeCloseTo(4 * Math.SQRT2, 5);
    expect(f.distance(0, 4)).toBe(4);
    expect(f.direction(4, 4, out)).toEqual({ x: 0, z: 0 });
    f.direction(0, 4, out);
    expect(out).toEqual({ x: 1, z: 0 });
    f.direction(4, 0, out);
    expect(out).toEqual({ x: 0, z: 1 });
    f.direction(0, 0, out);
    expect(out.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out.z).toBeCloseTo(Math.SQRT1_2, 6);
    // World lookup: the centre of cell (0, 4) is (11, 19).
    f.directionAt(11, 19, out);
    expect(out).toEqual({ x: 1, z: 0 });
    expect(f.direction(-1, 0, out)).toEqual({ x: 0, z: 0 });
    expect(f.distance(5, 5)).toBe(Infinity);
  });

  it('serves several goals, skipping unwalkable ones', () => {
    const g = createNavGrid({ width: 9, height: 1, cellSize: 1 });
    g.setWalkable(4, 0, false);
    const f = createFlowField(g);
    f.build([
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 4, y: 0 },
      { x: 20, y: 0 },
    ]);
    expect(f.distance(2, 0)).toBe(2);
    expect(f.distance(6, 0)).toBe(2);
    expect(f.distance(4, 0)).toBe(Infinity);
    f.direction(2, 0, out);
    expect(out).toEqual({ x: -1, z: 0 });
    f.direction(6, 0, out);
    expect(out).toEqual({ x: 1, z: 0 });
    expect(f.direction(4, 0, out)).toEqual({ x: 0, z: 0 });
  });

  it('flows around a wall without cutting its corners, and leaves sealed cells unreachable', () => {
    // Wall down column 3 with a gap at row 0; a sealed room at the bottom right.
    const g = createNavGrid({
      width: 7,
      height: 5,
      cellSize: 1,
      walkable: (x, y) => {
        if (x === 3 && y !== 0) return false;
        if (y === 3 && x >= 5) return false;
        if (x === 5 && y >= 3) return false;
        return true;
      },
    });
    const f = createFlowField(g);
    f.build([{ x: 6, y: 0 }]);
    // (2,4) → straight up to row 0 (the diagonal into the gap would cut the wall's corner),
    // through the gap and across: 4 + 4.
    expect(f.distance(2, 4)).toBeCloseTo(8, 5);
    expect(f.distance(6, 4)).toBe(Infinity);
    expect(f.direction(6, 4, out)).toEqual({ x: 0, z: 0 });
    // Beside the wall, under the gap: the step is straight up, not diagonally through the wall.
    f.direction(2, 1, out);
    expect(out.z).toBeLessThan(0);
    expect(g.isWalkable(2 + Math.round(out.x), 1 + Math.round(out.z))).toBe(true);
    // Following the directions from any reachable cell reaches the goal.
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        if (f.distance(x, y) === Infinity) continue;
        let cx = x;
        let cy = y;
        let steps = 0;
        while (!(cx === 6 && cy === 0) && steps < 50) {
          f.direction(cx, cy, out);
          const nx = cx + Math.sign(out.x);
          const ny = cy + Math.sign(out.z);
          expect(f.distance(nx, ny)).toBeLessThan(f.distance(cx, cy));
          cx = nx;
          cy = ny;
          steps++;
        }
        expect([cx, cy]).toEqual([6, 0]);
      }
    }
  });

  it('weights costs and rebuilds after an edit with the new version', () => {
    const g = createNavGrid({ width: 3, height: 1, cellSize: 1, cost: (x) => (x === 1 ? 4 : 1) });
    const f = createFlowField(g);
    f.build([{ x: 2, y: 0 }]);
    expect(f.distance(0, 0)).toBe(5);
    g.setCost(1, 0, 1);
    expect(f.version).not.toBe(g.version);
    f.build([{ x: 2, y: 0 }]);
    expect(f.version).toBe(g.version);
    expect(f.distance(0, 0)).toBe(2);
    g.setWalkable(1, 0, false);
    f.build([{ x: 2, y: 0 }]);
    expect(f.distance(0, 0)).toBe(Infinity);
  });
});

describe('FlowField neighbourhood, edge costs, staleness and goals', () => {
  it('on a 4-neighbour grid every direction is orthogonal and distances are Manhattan', () => {
    const g = createNavGrid({ width: 5, height: 5, cellSize: 1, neighbours: 4 });
    const f = createFlowField(g);
    f.build([{ x: 4, y: 4 }]);
    expect(f.distance(0, 0)).toBe(8);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        f.direction(x, y, out);
        expect(Math.abs(out.x) + Math.abs(out.z)).toBeLessThanOrEqual(1);
        expect(out.x === 0 || out.z === 0).toBe(true);
      }
    }
    const eight = createFlowField(createNavGrid({ width: 5, height: 5, cellSize: 1 }));
    eight.build([{ x: 4, y: 4 }]);
    expect(eight.distance(0, 0)).toBeCloseTo(4 * Math.SQRT2, 5);
  });

  it('honours the edge-cost hook, and never points over a one-way ledge', () => {
    // Row 0 to row 1 is a drop (free down, impossible up) across the whole width.
    const g = createNavGrid({
      width: 3,
      height: 2,
      cellSize: 1,
      neighbours: 4,
      edgeCost: (from, to) => (from >= 3 && to < 3 ? Infinity : 0),
    });
    const f = createFlowField(g, { goals: [0] });
    expect(f.version).toBe(0);
    expect(f.distance(2, 0)).toBe(2);
    expect(f.distance(0, 1)).toBe(Infinity);
    expect(f.direction(0, 1, out)).toEqual({ x: 0, z: 0 });
    // Goal on the lower row: the upper row drops down, the lower walks along.
    f.setGoals([3]);
    expect(f.goalCount).toBe(1);
    expect(f.distance(0, 0)).toBe(1);
    expect(f.distance(2, 0)).toBe(3);
    f.direction(0, 0, out);
    expect(out).toEqual({ x: 0, z: 1 });
    f.direction(2, 1, out);
    expect(out).toEqual({ x: -1, z: 0 });
    // A climb penalty: the field walks around a ridge that costs more than the detour.
    const ridge = createNavGrid({
      width: 3,
      height: 3,
      cellSize: 1,
      neighbours: 4,
      edgeCost: (_from, to) => (to === 4 ? 10 : 0),
    });
    const r = createFlowField(ridge, { goals: [5] });
    expect(r.distance(0, 1)).toBe(4);
    r.direction(1, 1, out);
    expect(out).toEqual({ x: 1, z: 0 });
    r.direction(0, 1, out);
    expect(out.x).toBe(0);
    expect(Math.abs(out.z)).toBe(1);
  });

  it('is stale after a grid edit and update() recomputes in place from the kept goals', () => {
    const g = createNavGrid({ width: 4, height: 1, cellSize: 1 });
    const f = createFlowField(g);
    expect(f.stale).toBe(true);
    f.build([{ x: 3, y: 0 }]);
    expect(f.stale).toBe(false);
    const dist = f.distances;
    const dirs = f.directions;
    expect(f.distance(0, 0)).toBe(3);
    g.setCost(1, 0, 5);
    expect(f.stale).toBe(true);
    expect(f.distance(0, 0)).toBe(3);
    f.update();
    expect(f.stale).toBe(false);
    expect(f.version).toBe(g.version);
    expect(f.distance(0, 0)).toBe(7);
    expect(f.distances).toBe(dist);
    expect(f.directions).toBe(dirs);
    g.touch();
    expect(f.stale).toBe(true);
    f.update();
    expect(f.stale).toBe(false);
    // A goal made unwalkable is skipped by the next update; walkable again, it is back.
    g.setWalkable(3, 0, false);
    f.update();
    expect(f.distance(0, 0)).toBe(Infinity);
    expect(f.goalCount).toBe(1);
    g.setWalkable(3, 0, true);
    f.update();
    expect(f.distance(0, 0)).toBe(7);
  });

  it('seeds from every goal at once: the nearest goal wins per cell', () => {
    const g = createNavGrid({ width: 12, height: 1, cellSize: 1, neighbours: 4 });
    const f = createFlowField(g, { goals: [1, 10] });
    expect(f.goalCount).toBe(2);
    expect(Array.from(f.goals.subarray(0, 2))).toEqual([1, 10]);
    for (let x = 0; x < 12; x++) {
      expect(f.distance(x, 0)).toBe(Math.min(Math.abs(x - 1), Math.abs(x - 10)));
    }
    f.direction(4, 0, out);
    expect(out).toEqual({ x: -1, z: 0 });
    f.direction(7, 0, out);
    expect(out).toEqual({ x: 1, z: 0 });
    // The cell midway between them points one way or the other, never nowhere.
    f.direction(5, 0, out);
    expect(Math.abs(out.x)).toBe(1);
    f.setGoals([-1, 100, 6]);
    expect(f.goalCount).toBe(1);
    expect(f.distance(0, 0)).toBe(6);
    f.direction(4, 0, out);
    expect(out).toEqual({ x: 1, z: 0 });
  });
});

describe('FlowField step cost (ws/nav-4)', () => {
  it('writes the step cost next to the direction, Infinity off the field', () => {
    const g = createNavGrid({
      width: 3,
      height: 1,
      cellSize: 1,
      neighbours: 4,
      cost: (x) => (x === 1 ? 3 : 1),
      edgeCost: (_from, to) => (to === 1 ? 2 : 0),
    });
    const f = createFlowField(g, { goals: [0] });
    const d = { x: 0, z: 0, cost: -1 };
    // From cell 2 into cell 1: length 1 × cost 3 + hook 2.
    f.direction(2, 0, d);
    expect(d.x).toBe(-1);
    expect(d.cost).toBe(5);
    expect(f.stepCosts[2]).toBe(5);
    f.direction(1, 0, d);
    expect(d.cost).toBe(1);
    f.direction(0, 0, d);
    expect(d.cost).toBe(0);
    f.directionAt(-5, 0, d);
    expect(d.cost).toBe(Infinity);
    // The cost matches findPath: sum of steps along the field equals the path's cost.
    const path = createNavPath();
    expect(findPath(g, { x: 2, y: 0 }, { x: 0, y: 0 }, path)).toBe(true);
    expect(path.length).toBe(3);
    expect(f.stepCosts[2]! + f.stepCosts[1]!).toBe(6);
    expect(f.distance(2, 0)).toBe(6);
  });
});
