import { describe, expect, it } from 'vitest';
import { createNavGrid, hasLineOfWalkable, type NavCell, type NavPoint } from './grid';

describe('createNavGrid', () => {
  it('starts walkable at cost 1 and takes the callbacks', () => {
    const g = createNavGrid({ width: 4, height: 3, cellSize: 2 });
    expect(g.size).toBe(12);
    expect(g.isWalkable(3, 2)).toBe(true);
    expect(g.costAt(0, 0)).toBe(1);
    const h = createNavGrid({
      width: 4,
      height: 3,
      cellSize: 1,
      walkable: (x) => x !== 1,
      cost: (_x, y) => y + 1,
    });
    expect(h.isWalkable(1, 0)).toBe(false);
    expect(h.costAt(1, 2)).toBe(0);
    expect(h.costAt(2, 2)).toBe(3);
    expect(h.version).toBe(0);
  });

  it('rejects an empty grid or a bad cell size', () => {
    expect(() => createNavGrid({ width: 0, height: 2, cellSize: 1 })).toThrow();
    expect(() => createNavGrid({ width: 2, height: 2, cellSize: 0 })).toThrow();
  });

  it('bumps version on every change and not on a no-op', () => {
    const g = createNavGrid({ width: 3, height: 3, cellSize: 1 });
    g.setWalkable(1, 1, false);
    expect(g.version).toBe(1);
    g.setWalkable(1, 1, false);
    expect(g.version).toBe(1);
    g.setCost(0, 0, 4);
    expect(g.version).toBe(2);
    g.setCost(0, 0, 4);
    expect(g.version).toBe(2);
    g.setCost(0, 0, 0);
    expect(g.isWalkable(0, 0)).toBe(false);
    expect(g.version).toBe(3);
    g.setWalkable(0, 0, true);
    expect(g.costAt(0, 0)).toBe(1);
    g.setWalkable(9, 9, false);
    g.setCost(-1, 0, 2);
    expect(g.version).toBe(4);
    expect(g.isWalkable(9, 9)).toBe(false);
    expect(g.costAt(-1, 0)).toBe(0);
  });

  it('maps world points to cells (clamped) and cells to centres', () => {
    const g = createNavGrid({ width: 4, height: 2, cellSize: 10, origin: { x: 100, z: -50 } });
    const c: NavCell = { x: 0, y: 0 };
    expect(g.toCell(105, -45, c)).toEqual({ x: 0, y: 0 });
    expect(g.toCell(139.9, -30.1, c)).toEqual({ x: 3, y: 1 });
    expect(g.toCell(1000, -1000, c)).toEqual({ x: 3, y: 0 });
    expect(g.toCell(-1000, 1000, c)).toEqual({ x: 0, y: 1 });
    const p: NavPoint = { x: 0, z: 0 };
    expect(g.toWorld(0, 0, p)).toEqual({ x: 105, z: -45 });
    expect(g.toWorld(3, 1, p)).toEqual({ x: 135, z: -35 });
    expect(g.toCell(p.x, p.z, c)).toEqual({ x: 3, y: 1 });
  });
});

describe('hasLineOfWalkable', () => {
  const g = createNavGrid({ width: 6, height: 6, cellSize: 1 });

  it('sees along rows, columns and diagonals of an open grid', () => {
    expect(hasLineOfWalkable(g, 0, 0, 5, 0)).toBe(true);
    expect(hasLineOfWalkable(g, 2, 5, 2, 0)).toBe(true);
    expect(hasLineOfWalkable(g, 0, 0, 5, 5)).toBe(true);
    expect(hasLineOfWalkable(g, 5, 0, 0, 5)).toBe(true);
    expect(hasLineOfWalkable(g, 0, 0, 5, 2)).toBe(true);
    expect(hasLineOfWalkable(g, 3, 3, 3, 3)).toBe(true);
  });

  it('is blocked by a wall across the line and by either endpoint', () => {
    const w = createNavGrid({ width: 6, height: 6, cellSize: 1, walkable: (x) => x !== 3 });
    expect(hasLineOfWalkable(w, 0, 0, 5, 0)).toBe(false);
    expect(hasLineOfWalkable(w, 0, 0, 2, 5)).toBe(true);
    expect(hasLineOfWalkable(w, 3, 0, 0, 0)).toBe(false);
    expect(hasLineOfWalkable(w, 0, 0, 3, 0)).toBe(false);
    expect(hasLineOfWalkable(w, -1, 0, 0, 0)).toBe(false);
  });

  it('does not slip between two diagonal walls', () => {
    // Walls at (1,0) and (0,1): the exact diagonal (0,0)→(1,1) passes through their corner.
    const w = createNavGrid({
      width: 3,
      height: 3,
      cellSize: 1,
      walkable: (x, y) => !((x === 1 && y === 0) || (x === 0 && y === 1)),
    });
    expect(hasLineOfWalkable(w, 0, 0, 1, 1)).toBe(false);
    expect(hasLineOfWalkable(w, 0, 0, 2, 2)).toBe(false);
    // One wall only: the corner is open on the other side.
    w.setWalkable(0, 1, true);
    expect(hasLineOfWalkable(w, 0, 0, 1, 1)).toBe(false);
    w.setWalkable(1, 0, true);
    expect(hasLineOfWalkable(w, 0, 0, 2, 2)).toBe(true);
  });

  it('follows a shallow line through the cells it crosses', () => {
    // (0,0)→(4,1) crosses rows at x = 2; a wall at (2,1) blocks it, one at (1,1) does not.
    const w = createNavGrid({ width: 5, height: 2, cellSize: 1 });
    w.setWalkable(1, 1, false);
    expect(hasLineOfWalkable(w, 0, 0, 4, 1)).toBe(true);
    w.setWalkable(2, 1, false);
    expect(hasLineOfWalkable(w, 0, 0, 4, 1)).toBe(false);
  });
});

describe('NavGridOptions.neighbours, edgeCost and index edits', () => {
  it('defaults to 8 neighbours, takes 4 and rejects anything else', () => {
    expect(createNavGrid({ width: 2, height: 2, cellSize: 1 }).neighbours).toBe(8);
    expect(createNavGrid({ width: 2, height: 2, cellSize: 1, neighbours: 4 }).neighbours).toBe(4);
    expect(() =>
      createNavGrid({ width: 2, height: 2, cellSize: 1, neighbours: 6 as unknown as 4 }),
    ).toThrow();
  });

  it('keeps the hook and edits by index, bumping version; touch bumps it alone', () => {
    const hook = () => 0;
    const g = createNavGrid({ width: 3, height: 2, cellSize: 1, edgeCost: hook });
    expect(g.edgeCost).toBe(hook);
    g.setCost(4, 2.5);
    expect(g.costAt(1, 1)).toBe(2.5);
    expect(g.version).toBe(1);
    g.setCost(4, 2.5);
    expect(g.version).toBe(1);
    g.setWalkable(4, false);
    expect(g.isWalkable(1, 1)).toBe(false);
    expect(g.version).toBe(2);
    g.setWalkable(4, true);
    expect(g.costAt(1, 1)).toBe(1);
    g.setWalkable(6, false);
    g.setCost(-1, 3);
    expect(g.version).toBe(3);
    g.touch();
    expect(g.version).toBe(4);
    expect(g.costs).toEqual(new Float32Array([1, 1, 1, 1, 1, 1]));
  });
});
