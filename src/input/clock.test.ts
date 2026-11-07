import { describe, expect, it, vi } from 'vitest';
import { createTickClock, resolveClock, wallClock } from './clock';
import { createGestures, Gestures } from './gestures';
import { createLook, Look } from './look';

describe('createTickClock (ws/input-8)', () => {
  it('reads its start and moves only on advance', () => {
    const c = createTickClock();
    expect(c.now()).toBe(0);
    expect(c.now()).toBe(0);
    c.advance(16.5);
    c.advance(16.5);
    expect(c.now()).toBe(33);
    expect(createTickClock(1000).now()).toBe(1000);
    expect(createTickClock(Number.NaN).now()).toBe(0);
  });

  it('ignores negative and non-finite steps', () => {
    const c = createTickClock(10);
    c.advance(-5);
    c.advance(Number.NaN);
    c.advance(Number.POSITIVE_INFINITY);
    c.advance(0);
    expect(c.now()).toBe(10);
  });
});

describe('resolveClock', () => {
  it('prefers clock, then now, then the wall clock', () => {
    const clock = createTickClock(5);
    const now = () => 7;
    const a = resolveClock(clock, now);
    expect(a.clock).toBe(clock);
    expect(a.now()).toBe(5);
    clock.advance(1);
    expect(a.now()).toBe(6);
    const b = resolveClock(undefined, now);
    expect(b.now).toBe(now);
    expect(b.clock.now()).toBe(7);
    const c = resolveClock(undefined, undefined);
    expect(c.clock).toBe(wallClock);
  });

  it('the default is performance.now(), unchanged', () => {
    const spy = vi.spyOn(performance, 'now').mockReturnValue(1234);
    expect(new Gestures().now()).toBe(1234);
    expect(new Look().clock.now()).toBe(1234);
    spy.mockRestore();
  });
});

describe('gestures and look on one tick clock', () => {
  it('createGestures and createLook take the clock; gestures.now reads it', () => {
    const clock = createTickClock(100);
    const g = createGestures({ clock });
    const look = createLook({ clock });
    expect(g).toBeInstanceOf(Gestures);
    expect(look).toBeInstanceOf(Look);
    expect(g.clock).toBe(clock);
    expect(look.clock).toBe(clock);
    clock.advance(50);
    expect(g.now()).toBe(150);
  });

  it('a held pointer long-presses on the tick the clock passes longPressMs', () => {
    const clock = createTickClock();
    const g = createGestures({ clock, longPressMs: 100 });
    const fired: number[] = [];
    g.pointerDown(1, 10, 10, 'touch');
    for (let tick = 0; tick < 10; tick++) {
      clock.advance(25);
      g.update();
      if (g.longPress) fired.push(tick);
    }
    // 25 ms a tick: 100 ms after the down on the fourth tick, whatever the wall time.
    expect(fired).toEqual([3]);
  });

  it('look pad turn integrates over the clock step, not wall time', () => {
    const clock = createTickClock();
    const pad = { connected: true, buttons: [], axes: [0, 0, 1, 0] };
    const look = createLook({ clock, getGamepads: () => [pad], padSensitivity: 2, padDeadzone: 0 });
    const spy = vi.spyOn(performance, 'now');
    look.update();
    for (const wall of [5, 500, 7]) {
      spy.mockReturnValue(wall);
      clock.advance(50);
      look.update();
      expect(look.look.dx).toBeCloseTo(2 * 0.05);
    }
    spy.mockRestore();
  });
});
