import { describe, expect, it } from 'vitest';
import { createScheduler } from './timer';

const STEP = 1 / 60;

describe('createScheduler', () => {
  it('fires in due order, ties in scheduling order', () => {
    const s = createScheduler();
    const log: string[] = [];
    s.after(0.3, () => log.push('c'));
    s.after(0.1, () => log.push('a'));
    s.after(0.2, () => log.push('b1'));
    s.after(0.2, () => log.push('b2'));
    s.update(0.05);
    expect(log).toEqual([]);
    s.update(1);
    expect(log).toEqual(['a', 'b1', 'b2', 'c']);
    expect(s.active).toBe(0);
  });

  it('after(1) fires on the 60th step of 1/60', () => {
    const s = createScheduler();
    let at = -1;
    s.after(1, () => {
      at = tick;
    });
    let tick = 0;
    for (tick = 1; tick <= 61; tick++) s.update(STEP);
    expect(at).toBe(60);
  });

  it('every with count, interleaved with other timers and catching up', () => {
    const s = createScheduler();
    const log: string[] = [];
    const h = s.every(0.1, () => log.push('e'), { count: 3 });
    s.after(0.15, () => log.push('x'));
    s.update(0.35);
    expect(log).toEqual(['e', 'x', 'e', 'e']);
    expect(s.remaining(h)).toBe(-1);
    s.update(1);
    expect(log.length).toBe(4);
    let n = 0;
    const forever = s.every(0.5, () => n++);
    for (let i = 0; i < 10; i++) s.update(0.5);
    expect(n).toBe(10);
    expect(s.cancel(forever)).toBe(true);
    expect(s.cancel(forever)).toBe(false);
    s.update(1);
    expect(n).toBe(10);
  });

  it('a callback that schedules during update runs next tick', () => {
    const s = createScheduler();
    const log: string[] = [];
    s.after(0.1, () => {
      log.push('first');
      s.after(0, () => log.push('zero'));
      s.after(0.05, () => log.push('soon'));
    });
    s.update(1);
    expect(log).toEqual(['first']);
    s.update(STEP);
    expect(log).toEqual(['first', 'zero']);
    s.update(0.1);
    expect(log).toEqual(['first', 'zero', 'soon']);
  });

  it('cancel from inside a callback and stale handles', () => {
    const s = createScheduler();
    const log: string[] = [];
    let b = 0;
    s.after(0.1, () => {
      log.push('a');
      s.cancel(b);
    });
    b = s.after(0.2, () => log.push('b'));
    const e = s.every(0.1, () => {
      log.push('e');
      s.cancel(e);
    });
    s.update(1);
    expect(log).toEqual(['a', 'e']);
    expect(s.active).toBe(0);
    // Slots are reused under a new generation: an old handle does not cancel the new timer.
    const c = s.after(1, () => log.push('c'));
    expect(c).not.toBe(b);
    expect(s.cancel(b)).toBe(false);
    expect(s.cancel(0)).toBe(false);
    s.update(1);
    expect(log).toEqual(['a', 'e', 'c']);
  });

  it('pause holds remaining time', () => {
    const s = createScheduler();
    let fired = 0;
    const h = s.after(1, () => fired++);
    const cd = s.cooldown('dash', 1);
    cd.use();
    s.update(0.4);
    s.pause();
    expect(s.paused).toBe(true);
    for (let i = 0; i < 100; i++) s.update(0.1);
    expect(fired).toBe(0);
    expect(s.remaining(h)).toBeCloseTo(0.6, 9);
    expect(cd.remaining).toBeCloseTo(0.6, 9);
    expect(s.time).toBeCloseTo(0.4, 9);
    s.resume();
    s.update(0.5);
    expect(fired).toBe(0);
    s.update(0.1);
    expect(fired).toBe(1);
  });

  it('a cooldown use() returns false until ready', () => {
    const s = createScheduler();
    const cd = s.cooldown('dash', 0.5);
    expect(s.cooldown('dash', 0.5)).toBe(cd);
    expect(cd.ready).toBe(true);
    expect(cd.progress).toBe(1);
    expect(cd.use()).toBe(true);
    expect(cd.ready).toBe(false);
    expect(cd.use()).toBe(false);
    expect(cd.remaining).toBeCloseTo(0.5, 9);
    for (let i = 0; i < 29; i++) {
      s.update(STEP);
      expect(cd.use()).toBe(false);
    }
    expect(cd.progress).toBeGreaterThan(0.9);
    s.update(STEP);
    expect(cd.ready).toBe(true);
    expect(cd.remaining).toBe(0);
    expect(cd.use()).toBe(true);
    cd.reset();
    expect(cd.ready).toBe(true);
  });

  it('clear cancels timers and readies cooldowns; nothing grows in steady state', () => {
    const s = createScheduler();
    let n = 0;
    s.after(1, () => n++);
    s.every(0.2, () => n++);
    const cd = s.cooldown('a', 5);
    cd.use();
    s.clear();
    expect(s.active).toBe(0);
    expect(cd.ready).toBe(true);
    s.update(2);
    expect(n).toBe(0);
    // Re-arming one-shots from their own callback reuses one slot.
    let fires = 0;
    const tick = () => {
      fires++;
      s.after(0.1, tick);
    };
    s.after(0.1, tick);
    const internals = s as unknown as { entries: unknown[] };
    for (let i = 0; i < 100; i++) s.update(0.1);
    expect(fires).toBeGreaterThanOrEqual(99);
    expect(internals.entries.length).toBeLessThanOrEqual(2);
  });
});
