import { describe, expect, it } from 'vitest';
import { FixedStepper, GameLoop } from './loop';

describe('FixedStepper', () => {
  it('runs one step per 1/60 s frame', () => {
    const s = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 60; i++) total += s.advance(1 / 60);
    expect(total).toBe(60);
  });

  it('accumulates partial frames (120 Hz display)', () => {
    const s = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 120; i++) total += s.advance(1 / 120);
    expect(total).toBe(60);
  });

  it('catches up on a 30 Hz display', () => {
    const s = new FixedStepper();
    expect(s.advance(1 / 30)).toBe(2);
  });

  it('clamps huge deltas', () => {
    const s = new FixedStepper({ maxFrameDt: 0.25, maxSteps: 100 });
    expect(s.advance(10)).toBe(15);
  });

  it('caps steps per frame and drops the remainder', () => {
    const s = new FixedStepper({ maxFrameDt: 1, maxSteps: 4 });
    expect(s.advance(1)).toBe(4);
    expect(s.accumulator).toBe(0);
  });

  it('reports alpha in [0,1)', () => {
    const s = new FixedStepper();
    s.advance(1.5 / 60);
    expect(s.alpha).toBeCloseTo(0.5);
  });

  it('ignores negative deltas', () => {
    const s = new FixedStepper();
    expect(s.advance(-1)).toBe(0);
  });
});

describe('GameLoop', () => {
  it('calls update at fixed rate and render once per frame', () => {
    let updates = 0;
    let renders = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => renders++ },
      { raf: () => 0, caf: () => {}, now: () => 0 },
    );
    loop.tickOnce(1 / 30);
    loop.tickOnce(1 / 30);
    expect(updates).toBe(4);
    expect(renders).toBe(2);
    expect(loop.time.tick).toBe(4);
    expect(loop.time.simTime).toBeCloseTo(4 / 60);
  });

  it('skips update while paused but keeps rendering', () => {
    let updates = 0;
    let renders = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => renders++ },
      { raf: () => 0, caf: () => {}, now: () => 0 },
    );
    loop.paused = true;
    loop.tickOnce(0.1);
    expect(updates).toBe(0);
    expect(renders).toBe(1);
  });

  it('drives frames from raf', () => {
    let t = 0;
    let pending: ((t: number) => void) | null = null;
    let updates = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => {} },
      {
        now: () => t,
        raf: (cb) => {
          pending = cb;
          return 1;
        },
        caf: () => {
          pending = null;
        },
      },
    );
    loop.start();
    for (let i = 0; i < 10; i++) {
      t += 1000 / 60;
      pending!(t);
    }
    expect(updates).toBe(10);
    loop.stop();
    expect(loop.isRunning).toBe(false);
  });

  it('halt stops for good: a later start (tab visible again) schedules nothing', () => {
    let scheduled = 0;
    let renders = 0;
    const loop = new GameLoop(
      { update: () => {}, render: () => renders++ },
      {
        now: () => 0,
        raf: () => {
          scheduled++;
          return scheduled;
        },
        caf: () => {},
      },
    );
    loop.start();
    expect(scheduled).toBe(1);
    loop.halt();
    expect(loop.halted).toBe(true);
    expect(loop.isRunning).toBe(false);
    loop.start();
    loop.tickOnce(1 / 60);
    expect(scheduled).toBe(1);
    expect(renders).toBe(0);
    expect(loop.isRunning).toBe(false);
  });
});

describe('GameLoop.maxFps', () => {
  /** Drive the loop from a fake vsync of `hz` for `frames` display frames. */
  function drive(clock: { t: number; cb: (() => void) | null }, hz: number, n: number) {
    for (let i = 0; i < n; i++) {
      clock.t += 1000 / hz;
      const cb = clock.cb;
      clock.cb = null;
      cb?.();
    }
  }

  function make() {
    const clock = { t: 0, cb: null as (() => void) | null };
    let renders = 0;
    let updates = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => renders++ },
      {
        now: () => clock.t,
        raf: (f) => {
          clock.cb = () => f(clock.t);
          return 1;
        },
        caf: () => {
          clock.cb = null;
        },
      },
    );
    return { loop, clock, renders: () => renders, updates: () => updates };
  }

  it('renders every display frame by default', () => {
    const h = make();
    h.loop.start();
    drive(h.clock, 60, 60);
    expect(h.renders()).toBe(60);
  });

  it('at 30 renders every other frame on 60 Hz and every 4th on 120 Hz, keeping sim time', () => {
    const h = make();
    h.loop.maxFps = 30;
    h.loop.start();
    drive(h.clock, 60, 60);
    expect(h.renders()).toBe(30);
    expect(h.updates()).toBe(60);
    const k = make();
    k.loop.maxFps = 30;
    k.loop.start();
    drive(k.clock, 120, 120);
    expect(k.renders()).toBe(30);
    expect(k.updates()).toBe(60);
  });

  it('null lifts the cap', () => {
    const h = make();
    h.loop.maxFps = 30;
    expect(h.loop.maxFps).toBeCloseTo(30);
    h.loop.maxFps = null;
    expect(h.loop.maxFps).toBeNull();
    h.loop.start();
    drive(h.clock, 60, 10);
    expect(h.renders()).toBe(10);
  });
});
