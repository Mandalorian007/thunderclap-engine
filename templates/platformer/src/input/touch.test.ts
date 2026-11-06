import { describe, expect, it } from 'vitest';
import { createTouchZones, type TouchPointer } from './touch';

const t = (key: number, x: number, y: number, select = true): TouchPointer => ({
  key,
  device: 'touch',
  x,
  y,
  select,
});

describe('touch zones', () => {
  it('left half is a floating stick that reads sideways only', () => {
    const z = createTouchZones(1920, 1080);
    z.update([t(1, 400, 800)]);
    expect(z.reading.move).toBe(0);
    z.update([t(1, 420, 700)]);
    expect(z.reading.move).toBeGreaterThan(0);
    expect(z.reading.move).toBeLessThan(0.3);
    z.update([t(1, 300, 800)]);
    expect(z.reading.move).toBe(-1);
    z.update([]);
    expect(z.reading.move).toBe(0);
    expect(z.reading.active).toBe(false);
  });

  it('right half jumps on the down edge and holds while down, with a second finger on the stick', () => {
    const z = createTouchZones(1920, 1080);
    z.update([t(1, 300, 800)]);
    z.update([t(1, 300, 800), t(2, 1500, 800)]);
    expect(z.reading.jumpPressed).toBe(true);
    expect(z.reading.jumpHeld).toBe(true);
    z.update([t(1, 300, 800), t(2, 1500, 780)]);
    expect(z.reading.jumpPressed).toBe(false);
    expect(z.reading.jumpHeld).toBe(true);
    z.update([t(1, 300, 800)]);
    expect(z.reading.jumpHeld).toBe(false);
    z.update([t(1, 300, 800), t(3, 1500, 800)]);
    expect(z.reading.jumpPressed).toBe(true);
  });

  it('the top third of the right half dashes', () => {
    const z = createTouchZones(1920, 1080);
    z.update([t(5, 1700, 100)]);
    expect(z.reading.dashPressed).toBe(true);
    expect(z.reading.jumpPressed).toBe(false);
    z.update([t(5, 1700, 100)]);
    expect(z.reading.dashPressed).toBe(false);
  });

  it('ignores mice and lifted pointers', () => {
    const z = createTouchZones(1920, 1080);
    z.update([{ key: 9, device: 'mouse', x: 1500, y: 800, select: true }, t(2, 1500, 800, false)]);
    expect(z.reading.jumpPressed).toBe(false);
    expect(z.reading.active).toBe(false);
  });
});
