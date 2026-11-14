import { describe, expect, it } from 'vitest';
import { NetClock } from './clock';

function fakeTime() {
  const t = { ms: 1000 };
  return { t, local: () => t.ms };
}

describe('NetClock', () => {
  it("returns the server's time exactly while paused", () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(500, true, 50, local);
    t.ms += 10_000;
    expect(clock.now()).toBe(500);
    clock.observe(612, true);
    expect(clock.now()).toBe(612);
    expect(clock.paused).toBe(true);
  });

  it('advances a step per step length while running', () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(500, false, 50, local);
    t.ms += 1000;
    expect(clock.now()).toBe(520);
    t.ms += 50;
    expect(clock.now()).toBe(521);
    const slow = new NetClock(0, false, 100, local);
    t.ms += 1000;
    expect(slow.now()).toBe(10);
    expect(slow.stepMs).toBe(100);
  });

  it("freezes at the server's time when paused, and runs from it again", () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(0, false, 50, local);
    t.ms += 500;
    clock.observe(9, true);
    t.ms += 5000;
    expect(clock.now()).toBe(9);
    clock.observe(9, false);
    t.ms += 100;
    expect(clock.now()).toBe(11);
  });

  it('moves the estimate forward by the latency a ping measured', () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(0, true, 50, local);
    clock.observe(200, false, 100);
    expect(clock.latencyMs).toBe(100);
    expect(clock.now()).toBe(202);
    t.ms += 1000;
    clock.observe(220, false);
    expect(clock.now()).toBe(222);
  });

  it('smooths small disagreements and snaps to large ones', () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(100, false, 50, local);
    t.ms += 1000;
    clock.observe(120.8, false);
    expect(clock.now()).toBeCloseTo(120.2, 9);
    clock.observe(150, false);
    expect(clock.now()).toBe(150);
    clock.observe(140, false);
    expect(clock.now()).toBe(140);
  });

  it('never goes backwards on a smoothed correction', () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(100, false, 50, local);
    t.ms += 1000;
    expect(clock.now()).toBe(120);
    clock.observe(119.2, false);
    expect(clock.now()).toBe(120);
    t.ms += 50;
    expect(clock.now()).toBeCloseTo(120.8, 9);
  });

  it("takes the caller's reading of the local clock without reading it", () => {
    const { t, local } = fakeTime();
    let reads = 0;
    const clock = new NetClock(100, false, 50, () => {
      reads++;
      return local();
    });
    t.ms += 500;
    const before = reads;
    expect(clock.now(t.ms)).toBeCloseTo(110, 9);
    expect(reads).toBe(before);
    expect(clock.now(t.ms - 100)).toBeCloseTo(110, 9);
  });

  it('starts over from a reset', () => {
    const { t, local } = fakeTime();
    const clock = new NetClock(100, false, 50, local);
    t.ms += 1000;
    clock.reset(5, false, 100);
    t.ms += 1000;
    expect(clock.now()).toBe(15);
  });
});
