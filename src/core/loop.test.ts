import { describe, expect, it } from 'vitest';
import { setDefaultHost } from '../host/default';
import type { FrameSource, Host } from '../host/types';
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
      { now: () => 0 },
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
      { now: () => 0 },
    );
    loop.paused = true;
    loop.tickOnce(0.1);
    expect(updates).toBe(0);
    expect(renders).toBe(1);
  });

  it('fixed: false updates once per frame with the real delta, alpha 1', () => {
    const log: string[] = [];
    const loop = new GameLoop(
      {
        update: (dt) => log.push(`u${dt.toFixed(3)}`),
        render: (alpha) => log.push(`r${alpha}`),
      },
      { now: () => 0, fixed: false },
    );
    loop.tickOnce(1 / 30);
    loop.tickOnce(0.004);
    loop.tickOnce(5); // clamped to maxFrameDt
    expect(log).toEqual(['u0.033', 'r1', 'u0.004', 'r1', 'u0.250', 'r1']);
    expect(loop.time.tick).toBe(3);
    expect(loop.time.simTime).toBeCloseTo(1 / 30 + 0.004 + 0.25);
    loop.paused = true;
    loop.tickOnce(1 / 60);
    expect(log.slice(-1)).toEqual(['r0']);
  });

  it('drives frames from the frame source', () => {
    let t = 0;
    let pending: ((t: number) => void) | null = null;
    let updates = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => {} },
      {
        now: () => t,
        frames: {
          requestFrame: (cb) => {
            pending = cb;
            return 1;
          },
          cancelFrame: () => {
            pending = null;
          },
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

  it('without a frame source, start() schedules through the default host', () => {
    const calls: string[] = [];
    const host = {
      requestFrame: (_cb: (t: number) => void) => {
        calls.push('request');
        return 7;
      },
      cancelFrame: (h: number) => calls.push(`cancel ${h}`),
    } as unknown as Host;
    setDefaultHost(host);
    try {
      const loop = new GameLoop({ update: () => {}, render: () => {} }, { now: () => 0 });
      loop.start();
      loop.stop();
      expect(calls).toEqual(['request', 'cancel 7']);
    } finally {
      setDefaultHost(null);
    }
  });

  it('halt stops for good: a later start (tab visible again) schedules nothing', () => {
    let scheduled = 0;
    let renders = 0;
    const loop = new GameLoop(
      { update: () => {}, render: () => renders++ },
      {
        now: () => 0,
        frames: {
          requestFrame: () => {
            scheduled++;
            return scheduled;
          },
          cancelFrame: () => {},
        },
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
        frames: {
          requestFrame: (f) => {
            clock.cb = () => f(clock.t);
            return 1;
          },
          cancelFrame: () => {
            clock.cb = null;
          },
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

  it('never caps an XR session: a kind xr source renders every headset frame (ws/xr-fixes)', () => {
    const clock = { t: 0, cb: null as (() => void) | null };
    let renders = 0;
    const loop = new GameLoop(
      { update: () => {}, render: () => renders++ },
      {
        now: () => clock.t,
        frames: {
          kind: 'xr',
          requestFrame: (f: (t: number) => void) => {
            clock.cb = () => f(clock.t);
            return 1;
          },
          cancelFrame: () => {
            clock.cb = null;
          },
        } as FrameSource,
      },
    );
    loop.maxFps = 30;
    loop.start();
    drive(clock, 90, 90);
    expect(renders).toBe(90);
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

describe('GameLoop.setFrames', () => {
  function source(log: string[], name: string) {
    let pending: ((t: number) => void) | null = null;
    return {
      src: {
        requestFrame: (cb: (t: number) => void) => {
          log.push(`${name}.request`);
          pending = cb;
          return name === 'a' ? 1 : 2;
        },
        cancelFrame: (h: number) => {
          log.push(`${name}.cancel ${h}`);
          pending = null;
        },
      },
      fire: (t: number) => {
        const cb = pending;
        pending = null;
        cb?.(t);
      },
      get pending() {
        return pending !== null;
      },
    };
  }

  it('while running, cancels the pending frame on the old source and requests from the new', () => {
    const log: string[] = [];
    const a = source(log, 'a');
    const b = source(log, 'b');
    let renders = 0;
    const loop = new GameLoop(
      { update: () => {}, render: () => renders++ },
      { now: () => 0, frames: a.src },
    );
    loop.start();
    loop.setFrames(b.src);
    loop.setFrames(b.src);
    expect(log).toEqual(['a.request', 'a.cancel 1', 'b.request']);
    expect(a.pending).toBe(false);
    b.fire(16);
    expect(renders).toBe(1);
    expect(log.at(-1)).toBe('b.request');
    loop.stop();
    expect(log.at(-1)).toBe('b.cancel 2');
  });

  it('from inside a frame, the running frame finishes and reschedules through the new source', () => {
    const log: string[] = [];
    const a = source(log, 'a');
    const b = source(log, 'b');
    let loop: GameLoop | null = null;
    const l = new GameLoop(
      {
        update: () => {},
        render: () => {
          loop?.setFrames(b.src);
        },
      },
      { now: () => 0, frames: a.src },
    );
    loop = l;
    l.start();
    a.fire(16);
    expect(log).toEqual(['a.request', 'b.request']);
    l.stop();
    expect(log.at(-1)).toBe('b.cancel 2');
  });

  it('before start, only the source changes; start then schedules through it', () => {
    const log: string[] = [];
    const a = source(log, 'a');
    const b = source(log, 'b');
    const loop = new GameLoop(
      { update: () => {}, render: () => {} },
      { now: () => 0, frames: a.src },
    );
    loop.setFrames(b.src);
    expect(log).toEqual([]);
    loop.start();
    expect(log).toEqual(['b.request']);
    loop.stop();
  });
});

describe('GameLoop: a frame that throws (ws/xr-fixes)', () => {
  it('schedules the next frame, clears inFrame and rethrows to the frame source', () => {
    let pending: ((t: number) => void) | null = null;
    let requests = 0;
    let renders = 0;
    let fail = true;
    const log: string[] = [];
    const b = { requestFrame: () => 7, cancelFrame: () => {} };
    let loop: GameLoop | null = null;
    const l = new GameLoop(
      {
        update: () => {},
        render: () => {
          renders++;
          if (fail) throw new Error('boom');
        },
      },
      {
        now: () => renders * 16,
        frames: {
          requestFrame: (cb) => {
            requests++;
            pending = cb;
            return requests;
          },
          cancelFrame: (h) => log.push(`cancel ${h}`),
        },
      },
    );
    loop = l;
    l.start();
    const fire = () => {
      const cb = pending;
      pending = null;
      cb?.(0);
    };
    expect(fire).toThrow('boom');
    expect(requests).toBe(2);
    expect(pending).not.toBeNull();
    fail = false;
    fire();
    expect(renders).toBe(2);
    expect(requests).toBe(3);
    // inFrame was cleared: a setFrames outside a frame swaps the pending request at once.
    loop.setFrames(b);
    expect(log).toEqual(['cancel 3']);
  });
});

describe('GameLoop: a clock that throws (#7)', () => {
  /** A loop on a hand-fired frame source; `fire()` runs the pending frame. */
  function rig(now: () => number) {
    let pending: ((t: number) => void) | null = null;
    let requests = 0;
    let renders = 0;
    const loop = new GameLoop(
      {
        update: () => {},
        render: () => {
          renders++;
        },
      },
      {
        now,
        frames: {
          requestFrame: (cb) => {
            requests++;
            pending = cb;
            return requests;
          },
          cancelFrame: () => {},
        },
      },
    );
    const fire = () => {
      const cb = pending;
      pending = null;
      cb?.(0);
    };
    return {
      loop,
      fire,
      requests: () => requests,
      renders: () => renders,
      pending: () => pending,
    };
  }

  it('still schedules the next frame and rethrows to the frame source', () => {
    let fail = false;
    let calls = 0;
    const r = rig(() => {
      calls++;
      if (fail) throw new Error('clock');
      return calls * 16;
    });
    r.loop.start();
    fail = true;
    expect(r.fire).toThrow('clock');
    expect(r.requests()).toBe(2);
    expect(r.pending()).not.toBeNull();
    expect(r.renders()).toBe(0);
    fail = false;
    r.fire();
    expect(r.renders()).toBe(1);
    expect(r.requests()).toBe(3);
  });

  it('a frame skipped by maxFps is requested once, not twice', () => {
    let t = 0;
    const r = rig(() => t);
    r.loop.maxFps = 30;
    r.loop.start();
    t = 10;
    r.fire();
    expect(r.requests()).toBe(2);
    expect(r.renders()).toBe(0);
  });
});
