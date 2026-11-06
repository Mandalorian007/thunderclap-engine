import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  HAZARD,
  kindAt,
  MOVER_SPEED,
  moverAt,
  ONE_WAY,
  parseLevel,
  SOLID,
  TILE,
} from './format';
import { LEVELS } from './index';

describe('parseLevel', () => {
  it('reads tiles, coins, checkpoints, spawn and exit', () => {
    const level = parseLevel('t', 'T', [
      '      ', //
      ' p o x', //
      '##-^##', //
      ' c    ', //
      '######',
    ]);
    expect(level.cols).toBe(6);
    expect(level.rows).toBe(5);
    expect(level.spawn).toEqual({ col: 1, row: 1 });
    expect(level.exit).toEqual({ col: 5, row: 1 });
    expect(level.coins).toEqual([{ col: 3, row: 1 }]);
    expect(level.checkpoints).toEqual([{ col: 1, row: 3 }]);
    expect(kindAt(level, 0, 2)).toBe(SOLID);
    expect(kindAt(level, 2, 2)).toBe(ONE_WAY);
    expect(kindAt(level, 3, 2)).toBe(HAZARD);
    expect(kindAt(level, 3, 1)).toBe(EMPTY);
    // Outside: sides solid, above and below air.
    expect(kindAt(level, -1, 2)).toBe(SOLID);
    expect(kindAt(level, 6, 2)).toBe(SOLID);
    expect(kindAt(level, 2, -1)).toBe(EMPTY);
    expect(kindAt(level, 2, 9)).toBe(EMPTY);
  });

  it('groups moving-platform paths horizontally then vertically', () => {
    const level = parseLevel('t', 'T', [
      'p  m x', //
      'mmmm  ', //
      '   m  ', //
      '######',
    ]);
    expect(level.movers).toHaveLength(2);
    // Row 0 is scanned first: its lone 'm' has no horizontal neighbour, so it heads a vertical
    // path down column 3; the row-1 run then stops at that claimed cell.
    expect(level.movers[0]).toEqual(
      expect.objectContaining({ x0: 3 * TILE, y0: 0, x1: 3 * TILE, y1: 2 * TILE }),
    );
    expect(level.movers[1]).toEqual(
      expect.objectContaining({ x0: 0, y0: TILE, x1: 2 * TILE, y1: TILE }),
    );
  });

  it('builds a horizontal run with the right leg time', () => {
    const level = parseLevel('t', 'T', ['p x  ', 'mmmmm', '#####']);
    expect(level.movers).toEqual([
      { x0: 0, y0: TILE, x1: 4 * TILE, y1: TILE, legSeconds: (4 * TILE) / MOVER_SPEED },
    ]);
  });

  it('rejects ragged rows, unknown characters, missing or doubled spawn and exit', () => {
    expect(() => parseLevel('t', 'T', ['p x', '##'])).toThrow(/row 1 has 2 columns/);
    expect(() => parseLevel('t', 'T', ['p?x', '###'])).toThrow(
      /unknown character '\?' at row 0, col 1/,
    );
    expect(() => parseLevel('t', 'T', ['  x', '###'])).toThrow(/no spawn/);
    expect(() => parseLevel('t', 'T', ['p  ', '###'])).toThrow(/no exit/);
    expect(() => parseLevel('t', 'T', ['ppx', '###'])).toThrow(/second spawn/);
    expect(() => parseLevel('t', 'T', ['pxx', '###'])).toThrow(/second exit/);
    expect(() => parseLevel('t', 'T', ['p x', 'm##'])).toThrow(/one cell/);
    expect(() => parseLevel('t', 'T', [])).toThrow(/no rows/);
  });
});

describe('moverAt', () => {
  it('shuttles end to end and reports the delta since the previous tick', () => {
    const path = { x0: 0, y0: 100, x1: 240, y1: 100, legSeconds: 2 };
    const out = { x: 0, y: 0, dx: 0, dy: 0 };
    moverAt(path, 1, 0.5, out);
    expect(out.x).toBeCloseTo(120);
    expect(out.y).toBe(100);
    expect(out.dx).toBeCloseTo(60);
    expect(out.dy).toBe(0);
    moverAt(path, 2, 0.5, out);
    expect(out.x).toBeCloseTo(240);
    moverAt(path, 3, 0.5, out);
    expect(out.x).toBeCloseTo(120);
    expect(out.dx).toBeCloseTo(-60);
    moverAt(path, 4, 0.5, out);
    expect(out.x).toBeCloseTo(0);
  });
});

describe('shipped levels', () => {
  it('parse with a spawn, an exit, coins and at least one mover each', () => {
    expect(LEVELS.length).toBe(2);
    for (const level of LEVELS) {
      expect(level.coins.length).toBeGreaterThan(3);
      expect(level.movers.length).toBeGreaterThan(0);
      expect(level.checkpoints.length).toBeGreaterThan(0);
      expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    }
  });
});
