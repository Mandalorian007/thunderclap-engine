import { describe, expect, it } from 'vitest';
import {
  clientToLogical,
  computeBackbuffer,
  computeCover,
  computeLetterbox,
  logicalToClient,
  visibleLogicalRect,
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

describe('computeCover', () => {
  it('fills a wide frame and crops the top and bottom evenly', () => {
    // 844×340 (a phone): the letterbox is 604×340; cover fills the width.
    const r = computeCover(844, 340, 1920, 1080);
    expect(r.x).toBe(0);
    expect(r.width).toBe(844);
    expect(r.height).toBe(Math.round(1080 * (844 / 1920)));
    expect(r.y).toBe(-Math.round(((1080 - 340 / r.scale) / 2) * r.scale));
    expect(r.y + r.height).toBeGreaterThanOrEqual(340);
  });

  it('stops at the band and brings narrower bars back', () => {
    // Keep 900 of 1080 rows: 340 / 900 px per unit at most, so the width is 725 < 844.
    const r = computeCover(844, 340, 1920, 1080, { minVisibleHeight: 900 });
    expect(r.width).toBe(Math.round(1920 * (340 / 900)));
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(computeLetterbox(844, 340, 1920, 1080).x);
    expect(340 / r.scale).toBeGreaterThanOrEqual(899.5);
  });

  it('centres the band on focusY, clamped inside the design', () => {
    const top = computeCover(844, 340, 1920, 1080, { focusY: 0 });
    expect(top.y).toBe(0);
    const bottom = computeCover(844, 340, 1920, 1080, { focusY: 1080 });
    expect(bottom.y + bottom.height).toBe(340);
  });

  it('crops the sides of a tall frame, or letterboxes when the width must stay', () => {
    const r = computeCover(390, 844, 1920, 1080);
    expect(r.height).toBe(844);
    expect(r.x).toBeLessThan(0);
    expect(r.x + r.width).toBeGreaterThanOrEqual(390);
    expect(computeCover(390, 844, 1920, 1080, { minVisibleWidth: 1920 })).toEqual(
      computeLetterbox(390, 844, 1920, 1080),
    );
  });

  it('matches the letterbox in an exact-aspect frame and on zero sizes', () => {
    expect(computeCover(1280, 720, 1920, 1080)).toEqual(computeLetterbox(1280, 720, 1920, 1080));
    expect(computeCover(0, 720, 1920, 1080).scale).toBe(0);
  });

  it("maps the frame's corners inside the design", () => {
    const r = computeCover(932, 380, 1920, 1080);
    const tl = clientToLogical(r, 1920, 1080, 0, 0);
    const br = clientToLogical(r, 1920, 1080, 932, 380);
    expect(tl.x).toBeCloseTo(0, 5);
    expect(tl.y).toBeGreaterThan(0);
    expect(br.x).toBeCloseTo(1920, 5);
    expect(br.y).toBeLessThan(1080);
    const back = logicalToClient(r, 1920, 1080, tl.x, tl.y);
    expect(back.x).toBeCloseTo(0, 5);
    expect(back.y).toBeCloseTo(0, 5);
  });
});

describe('visibleLogicalRect', () => {
  it('is the whole design for a letterbox inside its container', () => {
    const box = computeLetterbox(844, 340, 1920, 1080);
    const clip = { x: 0, y: 0, width: 844, height: 340 };
    const v = visibleLogicalRect(box, clip, 1920, 1080);
    expect([v.x, v.y]).toEqual([0, 0]);
    expect(v.width).toBeCloseTo(1920, 5);
    expect(v.height).toBeCloseTo(1080, 5);
  });

  it('is the band a cover shows, and writes into out', () => {
    const box = computeCover(844, 340, 1920, 1080);
    const out = { x: 9, y: 9, width: 9, height: 9 };
    const v = visibleLogicalRect(box, { x: 0, y: 0, width: 844, height: 340 }, 1920, 1080, out);
    expect(v).toBe(out);
    expect(v.x).toBe(0);
    expect(v.width).toBe(1920);
    expect(v.height).toBeCloseTo((340 * 1080) / box.height, 5);
    // Centred to within the whole-px rounding of the canvas edges.
    expect(Math.abs(v.y + v.height / 2 - 540)).toBeLessThan(2);
  });

  it('is empty when the clip misses the canvas', () => {
    const v = visibleLogicalRect(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 10, height: 10 },
      1920,
      1080,
    );
    expect(v).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
