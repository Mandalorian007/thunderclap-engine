import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from './snapshots';

// Ported from the original snapshot buffer tests, in 3D (dims 3) unless said.
const TICK_MS = 50;
const out = [0, 0, 0];
const p = [0, 0, 0];
const v = [0, 0, 0];

function push(
  b: SnapshotBuffer,
  id: number,
  step: number,
  x: number,
  vx: number,
  now: number,
  snap = false,
) {
  p[0] = x;
  v[0] = vx;
  b.push(id, step, p, v, now, snap);
}

function xAt(b: SnapshotBuffer, id: number, now: number): number {
  b.frame(now);
  expect(b.at(id, out)).toBe(true);
  return out[0]!;
}

function walk(b: SnapshotBuffer, n: number, speed = 0.2): void {
  for (let s = 0; s <= n; s++) push(b, 1, s, s * speed, speed, s * TICK_MS);
}

describe('SnapshotBuffer', () => {
  it('draws about 100 ms in the past, between the snapshots around it', () => {
    const b = new SnapshotBuffer();
    walk(b, 10);
    expect(b.delay).toBe(100);
    expect(xAt(b, 1, 500)).toBeCloseTo(1.6, 9);
    expect(xAt(b, 1, 525)).toBeCloseTo(1.7, 9);
    b.velocity(1, out);
    expect(out[0]).toBeCloseTo(4, 9);
    expect(b.latest(1, out) && out[0] === 2).toBe(true);
    expect(b.at(2, out)).toBe(false);
  });

  it('goes on for one step past the newest snapshot, then holds', () => {
    const b = new SnapshotBuffer();
    walk(b, 10);
    expect(xAt(b, 1, 10 * TICK_MS + 100)).toBeCloseTo(2.0, 9);
    expect(xAt(b, 1, 10 * TICK_MS + 125)).toBeCloseTo(2.1, 9);
    expect(xAt(b, 1, 10 * TICK_MS + 150)).toBeCloseTo(2.2, 9);
    expect(xAt(b, 1, 10 * TICK_MS + 1000)).toBeCloseTo(2.2, 9);
    b.velocity(1, out);
    expect(out[0]).toBe(0);
  });

  it('fades in a late snapshot that moves what is drawn instead of jumping', () => {
    const b = new SnapshotBuffer();
    walk(b, 10);
    const before = xAt(b, 1, 10 * TICK_MS + 140);
    push(b, 1, 11, 2.05, 0, 10 * TICK_MS + 140);
    expect(xAt(b, 1, 10 * TICK_MS + 140)).toBeCloseTo(before, 9);
    expect(xAt(b, 1, 10 * TICK_MS + 300)).toBeCloseTo(2.05, 9);
  });

  it('starts over at a snap, a step back, or a big jump', () => {
    const b = new SnapshotBuffer();
    walk(b, 10);
    const now = 10 * TICK_MS + 20;
    xAt(b, 1, now);
    push(b, 1, 11, 5.2, 0, now, true);
    expect(xAt(b, 1, now)).toBeCloseTo(5.2, 9);
    push(b, 1, 5, 9, 0, now + 10);
    expect(xAt(b, 1, now + 10)).toBeCloseTo(9, 9);
    push(b, 1, 6, 40, 0, now + 60);
    expect(xAt(b, 1, now + 60)).toBeCloseTo(40, 9);
  });

  it('starts one that stood still at its first move, not over the wait', () => {
    const b = new SnapshotBuffer();
    walk(b, 10);
    push(b, 1, 10, 2, 0, 10 * TICK_MS);
    push(b, 1, 30, 2.2, 0.2, 30 * TICK_MS);
    expect(xAt(b, 1, 29 * TICK_MS + 100)).toBeCloseTo(2, 9);
    expect(xAt(b, 1, 29 * TICK_MS + 125)).toBeCloseTo(2.1, 9);
  });

  it('draws one whose clock stalled from where it went, after the delay', () => {
    const b = new SnapshotBuffer();
    walk(b, 10, 0);
    const late = 11 * TICK_MS + 2000;
    push(b, 1, 11, 1, 0, late);
    expect(xAt(b, 1, late)).toBeCloseTo(0, 9);
    expect(xAt(b, 1, late + 75)).toBeCloseTo(0.5, 9);
    expect(xAt(b, 1, late + 100)).toBeCloseTo(1, 9);
    expect(b.delay).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('follows the jitter within its bounds, and eases back', () => {
    const b = new SnapshotBuffer();
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let s = 0; s < 100; s++) push(b, 1, s, s * 0.2, 0.2, s * TICK_MS + rand() * 120);
    b.frame(100 * TICK_MS);
    expect(b.jitter).toBeGreaterThan(60);
    expect(b.jitter).toBeLessThanOrEqual(120);
    expect(b.delay).toBeGreaterThan(120);
    expect(b.delay).toBeLessThanOrEqual(300);
    b.frame(100 * TICK_MS + 5000);
    expect(b.delay).toBe(100);
  });

  it('reuses tracks as things come and go', () => {
    const b = new SnapshotBuffer();
    for (let id = 1; id <= 3; id++) push(b, id, 0, id, 0, 0);
    expect(b.size).toBe(3);
    b.remove(1);
    b.remove(9);
    expect(b.size).toBe(2);
    expect(!b.has(1) && b.has(2) && b.has(3)).toBe(true);
    expect(xAt(b, 3, 10)).toBeCloseTo(3, 9);
    push(b, 4, 0, 4, 0, 0);
    expect(xAt(b, 4, 10)).toBeCloseTo(4, 9);
    b.clear();
    expect(b.size).toBe(0);
  });

  it('works in 2D with another step length', () => {
    const b = new SnapshotBuffer({ dims: 2, stepMs: 100 });
    const o2 = [9, 9, 9];
    for (let s = 0; s <= 10; s++) b.push(7, s, [s, -s], [1, -1], s * 100);
    b.frame(1000 + 50);
    expect(b.at(7, o2)).toBe(true);
    // Drawn 110 ms behind (one 100 ms step + 10 ms margin): step 9.4.
    expect(o2[0]).toBeCloseTo(9.4, 9);
    expect(o2[1]).toBeCloseTo(-9.4, 9);
    expect(o2[2]).toBe(9);
  });

  it('never draws a walker under jitter faster than twice its walk', () => {
    for (const jitter of [0, 20, 40, 80]) {
      let seed = 0x9e3779b9 + jitter;
      const rand = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 4294967296;
      };
      const SPEED = 4.3;
      const perStep = (SPEED * TICK_MS) / 1000;
      const b = new SnapshotBuffer();
      const frames: { at: number; step: number; x: number }[] = [];
      let arrive = 0;
      for (let k = 0; k <= 200; k++) {
        arrive = Math.max(arrive, k * TICK_MS + 30 + rand() * jitter);
        frames.push({ at: arrive, step: k, x: k * perStep });
      }
      let next = 0;
      let prev = Number.NaN;
      let teleports = 0;
      for (let now = 0; now < arrive + 400; now += 1000 / 60) {
        while (next < frames.length && frames[next]!.at <= now) {
          const f = frames[next++]!;
          push(b, 1, f.step, f.x, perStep, f.at);
        }
        if (!b.has(1)) continue;
        const x = xAt(b, 1, now);
        if (!Number.isNaN(prev) && Math.abs((x - prev) * 60) > 2 * SPEED) teleports++;
        prev = x;
      }
      expect(teleports).toBe(0);
    }
  });
});
