import { describe, expect, it } from 'vitest';
import { createIso, ISO_ELEV_DEPTH, isoHiddenBy, isoInverseProbe } from './iso';

const iso = createIso({ tileW: 64, tileH: 32, elevH: 16, originX: 960, originY: 100 });
const out = { x: 0, y: 0 };

describe('createIso', () => {
  it('projects tile centres on the 2:1 lattice and lifts by elevation', () => {
    expect(iso.toScreen(0, 0, 0, out)).toEqual({ x: 960, y: 100 });
    expect(iso.toScreen(1, 0, 0, out)).toEqual({ x: 992, y: 116 });
    expect(iso.toScreen(0, 1, 0, out)).toEqual({ x: 928, y: 116 });
    expect(iso.toScreen(3, 1, 2, out)).toEqual({ x: 1024, y: 132 });
    expect(iso.elevH).toBe(16);
    expect(createIso({ tileW: 64, tileH: 32 }).elevH).toBe(16);
  });

  it('round-trips toScreen → toTile at every elevation, fractions included', () => {
    for (const [tx, ty, e] of [
      [0, 0, 0],
      [5, 2, 1],
      [2.5, 7.25, 3],
      [-3, 4, 0],
    ] as const) {
      iso.toScreen(tx, ty, e, out);
      iso.toTile(out.x, out.y, e, out);
      expect(out.x).toBeCloseTo(tx, 10);
      expect(out.y).toBeCloseTo(ty, 10);
    }
  });

  it('origin is live', () => {
    const i = createIso({ tileW: 10, tileH: 10 });
    i.originX = 5;
    i.originY = 7;
    expect(i.toScreen(0, 0, 0, out)).toEqual({ x: 5, y: 7 });
  });

  it('depth is monotone in tx + ty, elevation a tie-break inside one diagonal', () => {
    let last = -Infinity;
    for (let s = 0; s < 40; s++) {
      for (let tx = 0; tx <= s; tx++) {
        const d = iso.depth(tx, s - tx, 0);
        expect(d).toBeGreaterThanOrEqual(last);
        last = d;
      }
    }
    expect(iso.depth(2, 3, 1)).toBeGreaterThan(iso.depth(3, 2, 0));
    expect(iso.depth(2, 3, 5)).toBeLessThan(iso.depth(0, 6, 0));
    expect(iso.depth(1, 1, 1) - iso.depth(1, 1, 0)).toBe(ISO_ELEV_DEPTH);
  });

  it('refuses a degenerate tile', () => {
    expect(() => createIso({ tileW: 0, tileH: 32 })).toThrow(/tileW/);
  });
});

describe('isoInverseProbe', () => {
  // A two-step ramp along tx on a 12 × 12 map: tx < 4 flat, 4..7 one up, 8.. two up.
  const height = (tx: number, ty: number) =>
    tx < 0 || ty < 0 || tx >= 12 || ty >= 12 ? -1 : tx >= 8 ? 2 : tx >= 4 ? 1 : 0;

  it('finds the lifted tile under its raised centre, not the flat tile the pixel covers', () => {
    for (let ty = 0; ty < 12; ty++) {
      for (const tx of [1, 5, 9]) {
        const e = height(tx, ty);
        iso.toScreen(tx, ty, e, out);
        expect(isoInverseProbe(iso, out.x, out.y, height, 2, out)).toBe(true);
        expect([out.x, out.y]).toEqual([tx, ty]);
      }
    }
    // The same pixel at ground level would be a different tile: the probe prefers the top.
    iso.toScreen(9, 3, 2, out);
    const p = { x: out.x, y: out.y };
    iso.toTile(p.x, p.y, 0, out);
    expect([Math.round(out.x), Math.round(out.y)]).not.toEqual([9, 3]);
  });

  it('writes (-1, -1) and returns false off the map', () => {
    expect(isoInverseProbe(iso, -5000, -5000, height, 2, out)).toBe(false);
    expect([out.x, out.y]).toEqual([-1, -1]);
  });

  it('a flat tile wins at ground level when no raised tile claims the pixel', () => {
    iso.toScreen(2, 2, 0, out);
    expect(isoInverseProbe(iso, out.x, out.y, height, 2, out)).toBe(true);
    expect([out.x, out.y]).toEqual([2, 2]);
    // With no elevation above 0 allowed, a raised tile's top resolves as the flat tile under it.
    iso.toScreen(9, 3, 2, out);
    expect(isoInverseProbe(iso, out.x, out.y, () => 0, 0, out)).toBe(true);
    expect([out.x, out.y]).not.toEqual([9, 3]);
  });
});

describe('isoHiddenBy', () => {
  it('a top is hidden by a diagonal front neighbour two steps up, or both side ones', () => {
    const map = new Map<string, number>();
    const h = (tx: number, ty: number) => map.get(`${tx},${ty}`) ?? -1;
    for (let tx = 0; tx < 4; tx++) for (let ty = 0; ty < 4; ty++) map.set(`${tx},${ty}`, 0);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(false);
    map.set('2,2', 2);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(true);
    // The block's side neighbours behind it keep half their top: visible.
    expect(isoHiddenBy(iso, 2, 1, h)).toBe(false);
    expect(isoHiddenBy(iso, 1, 2, h)).toBe(false);
    // Beside and in front of the block: visible.
    expect(isoHiddenBy(iso, 3, 3, h)).toBe(false);
    expect(isoHiddenBy(iso, 3, 1, h)).toBe(false);
    expect(isoHiddenBy(iso, 0, 0, h)).toBe(false);
    // One step up only covers the lower quarter.
    map.set('2,2', 1);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(false);
    // Both side neighbours two steps up cover the two halves.
    map.set('2,1', 2);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(false);
    map.set('1,2', 2);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(true);
    // A raised tile is not hidden by lower front neighbours; off-map tiles hide nothing.
    map.set('1,1', 3);
    expect(isoHiddenBy(iso, 1, 1, h)).toBe(false);
    expect(isoHiddenBy(iso, 3, 3, h)).toBe(false);
    expect(isoHiddenBy(iso, 9, 9, h)).toBe(false);
    // A coarser elevation step: one step of a `tileH`-tall riser hides the top.
    const tall = createIso({ tileW: 64, tileH: 32, elevH: 32 });
    map.set('1,1', 0);
    map.set('2,2', 1);
    expect(isoHiddenBy(tall, 1, 1, h)).toBe(true);
  });
});
