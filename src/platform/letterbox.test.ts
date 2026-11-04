import { describe, expect, it } from 'vitest';
import {
  clientToLogical,
  computeBackbuffer,
  computeFillWidth,
  computeLetterbox,
  logicalToClient,
} from './letterbox';

describe('computeLetterbox', () => {
  it('fills an exact 16:9 container', () => {
    expect(computeLetterbox(960, 540, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      scale: 0.5,
    });
  });

  it('pillarboxes a wide container', () => {
    const r = computeLetterbox(2560, 1080, 1920, 1080);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.x).toBe(320);
    expect(r.y).toBe(0);
  });

  it('letterboxes a tall container', () => {
    const r = computeLetterbox(1000, 1000, 1920, 1080);
    expect(r.width).toBe(1000);
    expect(r.height).toBe(563);
    expect(r.x).toBe(0);
    expect(r.y).toBe(218);
  });

  it('handles zero/negative sizes', () => {
    expect(computeLetterbox(0, 500, 1920, 1080).width).toBe(0);
    expect(computeLetterbox(-1, 500, 1920, 1080).scale).toBe(0);
  });
});

describe('coordinate transforms', () => {
  const box = computeLetterbox(1000, 1000, 1920, 1080);

  it('maps the letterbox corners to logical corners', () => {
    expect(clientToLogical(box, 1920, 1080, box.x, box.y)).toEqual({ x: 0, y: 0 });
    const br = clientToLogical(box, 1920, 1080, box.x + box.width, box.y + box.height);
    expect(br.x).toBeCloseTo(1920);
    expect(br.y).toBeCloseTo(1080);
  });

  it('round-trips', () => {
    const c = logicalToClient(box, 1920, 1080, 480, 270);
    const l = clientToLogical(box, 1920, 1080, c.x, c.y);
    expect(l.x).toBeCloseTo(480);
    expect(l.y).toBeCloseTo(270);
  });

  it('points in the bars land outside 0..logical', () => {
    const l = clientToLogical(box, 1920, 1080, 500, 10);
    expect(l.y).toBeLessThan(0);
  });

  it('writes into a provided out object', () => {
    const out = { x: 0, y: 0 };
    expect(clientToLogical(box, 1920, 1080, 500, 500, out)).toBe(out);
  });
});

describe('computeBackbuffer', () => {
  it('applies DPR up to the cap', () => {
    expect(computeBackbuffer(960, 540, 2)).toEqual({ width: 1920, height: 1080, pixelRatio: 2 });
    expect(computeBackbuffer(960, 540, 3, 2).width).toBe(1920);
  });

  it('scales down to respect maxPixels', () => {
    const b = computeBackbuffer(1920, 1080, 2, 2, 1920 * 1080);
    expect(b.width).toBe(1920);
    expect(b.height).toBe(1080);
    expect(b.pixelRatio).toBeCloseTo(1);
  });
});

describe('computeFillWidth', () => {
  it('matches the contain fit on a 16:9 container', () => {
    expect(computeFillWidth(960, 540, 1920, 1080, { minVisible: 800 })).toEqual(
      computeLetterbox(960, 540, 1920, 1080),
    );
  });

  it('fills a wide container and crops top and bottom evenly', () => {
    const r = computeFillWidth(750, 340, 1920, 1080, { minVisible: 800 });
    expect(r.x).toBe(0);
    expect(r.width).toBe(750);
    expect(r.y).toBeLessThan(0);
    expect(r.y + r.height).toBeGreaterThan(340);
    expect(Math.abs(-r.y - (r.y + r.height - 340))).toBeLessThanOrEqual(1);
  });

  it('keeps at least minVisible logical px on screen, leaving narrower bars', () => {
    const r = computeFillWidth(915, 360, 1920, 1080, { minVisible: 900 });
    expect(360 / r.scale).toBeGreaterThanOrEqual(899);
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(computeLetterbox(915, 360, 1920, 1080).x);
  });

  it('centres the band on focusY, clamped to the design', () => {
    const top = computeFillWidth(750, 340, 1920, 1080, { minVisible: 800, focusY: 0 });
    expect(top.y).toBe(0);
    const bottom = computeFillWidth(750, 340, 1920, 1080, { minVisible: 800, focusY: 1080 });
    expect(bottom.y + bottom.height).toBe(340);
  });

  it('keeps the contain fit on a tall container without minVisibleWidth', () => {
    expect(computeFillWidth(390, 500, 1920, 1080, { minVisible: 800 })).toEqual(
      computeLetterbox(390, 500, 1920, 1080),
    );
  });

  it('fills a tall container on its height and crops the sides around focusX', () => {
    const r = computeFillWidth(390, 480, 1920, 1080, {
      minVisible: 800,
      minVisibleWidth: 800,
      focusX: 600,
    });
    expect(r.y).toBe(0);
    expect(r.height).toBe(480);
    expect(r.x).toBeLessThan(0);
    const left = -r.x / r.scale;
    const right = left + 390 / r.scale;
    expect((left + right) / 2).toBeCloseTo(600, -1);
  });

  it('keeps at least minVisibleWidth logical px across, leaving bars above and below', () => {
    const r = computeFillWidth(390, 844, 1920, 1080, { minVisible: 800, minVisibleWidth: 900 });
    expect(390 / r.scale).toBeGreaterThanOrEqual(899);
    expect(r.y).toBeGreaterThan(0);
    expect(r.height).toBeLessThan(844);
  });

  it('clamps the side crop inside the design', () => {
    const r = computeFillWidth(390, 480, 1920, 1080, {
      minVisible: 800,
      minVisibleWidth: 600,
      focusX: 0,
    });
    expect(r.x).toBe(0);
  });
});
