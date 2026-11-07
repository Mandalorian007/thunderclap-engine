// @vitest-environment happy-dom
/**
 * createGame wiring on a fake GPU device: lifecycle (hide flushes and stops, show resumes),
 * device loss (halt for good), hook order in a frame, the host's frames, the pointer router
 * and the modal input block.
 * The real-browser checks are in e2e/lifecycle.spec.ts and e2e/surface.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInputPlayback,
  createSample,
  type InputRecording,
  type PointerSource,
  planeTester,
  screenRay,
} from '../input';
import type { BootResult } from '../platform';
import { mountSurface } from '../platform/surface';
import { type FakeXr, FakeXrInputSource, installFakeXr } from '../platform/xr-fake';
import { Camera } from '../render/camera';
import {
  createFakeDevice,
  type FakeDevice,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';
import { type CreateGameOptions, createGame, type EngineCtx } from './game';

const lost = new Set<(info: GPUDeviceLostInfo) => void>();
let bootOk = true;
/** The fake device of the last boot. */
let lastFake: FakeDevice | null = null;

vi.mock('../platform/boot', () => ({
  boot: async (root: HTMLElement, opts: { logicalWidth?: number }): Promise<BootResult> => {
    if (!bootOk) return { ok: false, reason: 'no-webgpu' as never };
    installGpuGlobals();
    const fake = createFakeDevice();
    lastFake = fake;
    const surface = mountSurface(root, opts);
    return {
      ok: true,
      surface,
      gpu: { ...fakeRendererGpu(fake), adapter: {} as GPUAdapter, timestamps: false },
      onDeviceLost(fn) {
        lost.add(fn);
        return () => lost.delete(fn);
      },
    };
  },
}));

type Save = { flush: () => void };

function options(log: string[]): CreateGameOptions<'go', Save> {
  return {
    root: document.getElementById('root') as HTMLElement,
    save: () => ({ flush: () => log.push('flush') }),
    input: { bindings: { go: [{ key: 'Space' }] } },
  };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  document.body.innerHTML = '<main id="root"></main>';
  bootOk = true;
  lost.clear();
});

let xr: FakeXr | null = null;

afterEach(() => {
  setHidden(false);
  xr?.uninstall();
  xr = null;
});

describe('createGame', () => {
  it('resolves null when WebGPU does not come up', async () => {
    bootOk = false;
    expect(await createGame(options([]))).toBeNull();
  });

  it('builds the noun-free ctx; scenes get that same object', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(ctx.design).toEqual({ width: 1920, height: 1080 });
    expect(ctx.renderer.post).toBe(ctx.post);
    expect(ctx.surface.root.querySelector('.tc-overlay')).toBe(ctx.ui.root);
    let entered: unknown = null;
    ctx.stack.push({
      enter: (c) => {
        entered = c;
      },
    });
    expect(entered).toBe(ctx);
  });

  it('runs game hooks inside the frame, in order', async () => {
    const log: string[] = [];
    const ctx = await createGame(options(log));
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.update = () => log.push('update');
    ctx.hooks.beforeRender = () => log.push('before');
    ctx.hooks.afterRender = () => log.push('after');
    ctx.stack.push({
      update: () => log.push('scene.update'),
      render: () => log.push('scene.render'),
    });
    ctx.loop.tickOnce(1 / 60);
    expect(log).toEqual(['update', 'scene.update', 'before', 'scene.render', 'after']);
  });

  it('hiding the page stops the loop and flushes the save after the hide hook; showing resumes', async () => {
    const log: string[] = [];
    const ctx = await createGame(options(log));
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.hide = (why) => log.push(`hide ${why} running=${ctx.loop.isRunning}`);
    ctx.hooks.show = (why) => log.push(`show ${why} running=${ctx.loop.isRunning}`);
    ctx.loop.start();
    setHidden(true);
    expect(log).toEqual(['hide hidden running=false', 'flush']);
    expect(ctx.loop.isRunning).toBe(false);
    setHidden(false);
    expect(ctx.loop.isRunning).toBe(true);
    expect(log.at(-1)).toBe('show visible running=true');

    log.length = 0;
    window.dispatchEvent(new Event('pagehide'));
    expect(log).toEqual(['hide pagehide running=false', 'flush']);
    window.dispatchEvent(new Event('pageshow'));
    expect(ctx.loop.isRunning).toBe(true);
    log.length = 0;
    document.dispatchEvent(new Event('freeze'));
    expect(log).toEqual(['hide freeze running=false', 'flush']);
  });

  it('hooks.lifecycle follows host.lifecycle: background after the stop and flush, active after the restart', async () => {
    const log: string[] = [];
    const ctx = await createGame(options(log));
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.lifecycle = (s) => log.push(`lifecycle ${s} running=${ctx.loop.isRunning}`);
    ctx.loop.start();
    setHidden(true);
    // The page events stop and flush first; the lifecycle facet does not flush a second time.
    expect(log).toEqual(['flush', 'lifecycle background running=false']);
    setHidden(false);
    expect(log.at(-1)).toBe('lifecycle active running=true');
  });

  it('a host whose lifecycle changes without a page event still stops, flushes and resumes', async () => {
    const log: string[] = [];
    const { createWebHost } = await import('../host');
    let fire: ((s: 'active' | 'background') => void) | null = null;
    const host = {
      ...createWebHost(),
      lifecycle: {
        state: () => 'active' as const,
        watch: (fn: (s: 'active' | 'background') => void) => {
          fire = fn;
          return () => {};
        },
      },
    };
    const ctx = await createGame({ ...options(log), host });
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.lifecycle = (s) => log.push(`lifecycle ${s} running=${ctx.loop.isRunning}`);
    ctx.loop.start();
    fire!('background');
    expect(log).toEqual(['flush', 'lifecycle background running=false']);
    fire!('active');
    expect(ctx.loop.isRunning).toBe(true);
    expect(log.at(-1)).toBe('lifecycle active running=true');
  });

  it('a lost device halts the loop, audio and captions for good and flushes the save', async () => {
    const log: string[] = [];
    const ctx = await createGame(options(log));
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.deviceLost = () => log.push(`lost halted=${ctx.loop.halted}`);
    ctx.hooks.show = () => log.push('show');
    ctx.loop.start();
    for (const fn of lost) fn({ reason: 'unknown', message: 'test' } as GPUDeviceLostInfo);
    expect(log).toEqual(['lost halted=true', 'flush']);
    expect(ctx.audio.halted).toBe(true);
    // A later show (tab back) does not bring the loop back.
    setHidden(true);
    setHidden(false);
    expect(ctx.loop.isRunning).toBe(false);
  });

  it('without save: ctx.save is null, host.storage is never read, hide and loss still work', async () => {
    const reads: string[] = [];
    const { createWebHost } = await import('../host');
    const web = createWebHost();
    const host = { ...web };
    Object.defineProperty(host, 'storage', {
      get: () => {
        reads.push('storage');
        return web.storage;
      },
    });
    const { save: _drop, ...rest } = options([]);
    const ctx = await createGame({ ...rest, host });
    if (!ctx) throw new Error('no ctx');
    const save: null = ctx.save;
    expect(save).toBeNull();
    const log: string[] = [];
    ctx.hooks.hide = (why) => log.push(why);
    ctx.loop.start();
    setHidden(true);
    setHidden(false);
    for (const fn of lost) fn({ reason: 'unknown', message: 'test' } as GPUDeviceLostInfo);
    expect(log).toEqual(['hidden']);
    expect(ctx.loop.halted).toBe(true);
    expect(reads).toEqual([]);
  });

  it('sim: false runs hooks.frame and the scenes once per frame with the real delta', async () => {
    const log: string[] = [];
    const ctx = await createGame({ ...options([]), sim: false });
    if (!ctx) throw new Error('no ctx');
    ctx.hooks.update = () => log.push('update');
    ctx.hooks.frame = (dt) => log.push(`frame ${dt.toFixed(3)}`);
    ctx.hooks.afterRender = () => log.push('after');
    ctx.stack.push({
      update: (dt) => log.push(`scene.update ${dt.toFixed(3)}`),
      render: (_f, _camera, alpha) => log.push(`scene.render ${alpha}`),
    });
    ctx.loop.tickOnce(1 / 30);
    ctx.loop.tickOnce(0.007);
    expect(log).toEqual([
      'frame 0.033',
      'scene.update 0.033',
      'scene.render 1',
      'after',
      'frame 0.007',
      'scene.update 0.007',
      'scene.render 1',
      'after',
    ]);
  });

  it('sim.step sets the fixed step', async () => {
    const ctx = await createGame({ ...options([]), sim: { step: 1 / 30 } });
    if (!ctx) throw new Error('no ctx');
    let updates = 0;
    ctx.hooks.update = () => updates++;
    ctx.loop.tickOnce(1 / 15);
    expect(updates).toBe(2);
    expect(ctx.loop.time.step).toBeCloseTo(1 / 30);
  });

  it('the loop takes its frames from the host, never from the globals', async () => {
    const { createWebHost } = await import('../host');
    const calls: string[] = [];
    const host = {
      ...createWebHost(),
      requestFrame: (_cb: (t: number) => void) => {
        calls.push('request');
        return 3;
      },
      cancelFrame: (h: number) => calls.push(`cancel ${h}`),
    };
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    try {
      const ctx = await createGame({ ...options([]), host });
      if (!ctx) throw new Error('no ctx');
      expect(ctx.host).toBe(host);
      ctx.loop.start();
      ctx.loop.stop();
      expect(calls).toEqual(['request', 'cancel 3']);
      expect(raf).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes ctx.camera to the scenes and renders the frame through it', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(ctx.camera).toBe(ctx.renderer.camera);
    const seen: unknown[] = [];
    const rendered: unknown[] = [];
    const render = ctx.renderer.render.bind(ctx.renderer);
    ctx.renderer.render = (frame, camera, target) => {
      rendered.push(camera);
      return render(frame, camera, target);
    };
    ctx.stack.push({ render: (_f, camera) => seen.push(camera) });
    ctx.loop.tickOnce(1 / 60);
    expect(seen).toEqual([ctx.camera]);
    expect(rendered).toEqual([ctx.camera]);
  });

  it('builds the gestures, linked to the input, with the magnify option', async () => {
    const log: string[] = [];
    const base = options(log);
    const ctx = await createGame({
      ...base,
      input: {
        bindings: { go: [{ key: 'Space' }, { gesture: 'tap' }] },
        magnify: { pitch: () => 100, snap: (x, y) => ({ x, y, r: 10 }) },
      },
    });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.input.gestures).toBe(ctx.gestures);
    const canvas = ctx.surface.canvas;
    const ev = (type: string, extra: PointerEventInit = {}) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: 'touch',
          clientX: 100,
          clientY: 100,
          isPrimary: true,
          bubbles: true,
          ...extra,
        }),
      );
    ev('pointerdown', { button: 0, buttons: 1 });
    ctx.input.update();
    // One touch down with `magnify` set reports an aim; without it `aim` stays null.
    expect(ctx.gestures.aim).not.toBeNull();
    ev('pointerup', { button: 0, buttons: 0 });
    ctx.input.update();
    expect(ctx.gestures.tap).not.toBeNull();
    expect(ctx.input.pressed('go')).toBe(true);
  });

  it('wires a pointer router through the renderer camera and the input', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(ctx.input.pointers).toBe(ctx.pointers);
    const hits: number[] = [];
    ctx.pointers.addTester(() => {
      hits.push(1);
      return null;
    });
    // A pointer over the canvas is routed each update, through the camera the renderer draws with.
    ctx.surface.canvas.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 10, bubbles: true }),
    );
    ctx.input.update();
    expect(hits.length).toBeGreaterThan(0);
    // Blocked under a modal, like the rest of the input.
    hits.length = 0;
    ctx.ui.stack.push({ title: 'Modal', content: document.createElement('p') });
    ctx.input.update();
    expect(hits).toEqual([]);
  });

  it('input is blocked while a modal panel is open', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const press = () => {
      ctx.input.keyDown('Space');
      ctx.input.update();
      const held = ctx.input.held('go');
      ctx.input.keyUp('Space');
      ctx.input.update();
      return held;
    };
    expect(press()).toBe(true);
    ctx.ui.stack.push({ title: 'Modal', content: document.createElement('p') });
    expect(ctx.ui.stack.hasModal).toBe(true);
    expect(press()).toBe(false);
  });

  it('input.getGamepads feeds the action map and the pad navigation of modal panels', async () => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    const pad = { connected: true, buttons, axes: [0, 0, 0, 0] };
    const press = (i: number, down: boolean) => {
      buttons[i]!.pressed = down;
      buttons[i]!.value = down ? 1 : 0;
    };
    const ctx = await createGame<'go' | 'fire', Save>({
      ...options([]),
      input: {
        bindings: { go: [{ key: 'Space' }], fire: [{ padButton: 0 }] },
        getGamepads: () => [pad],
      },
    });
    if (!ctx) throw new Error('no ctx');
    // The action map reads the fake pad.
    press(0, true);
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.held('fire')).toBe(true);
    press(0, false);
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.held('fire')).toBe(false);

    // The pad drives a modal panel: d-pad down moves focus, B dismisses it.
    const first = document.createElement('button');
    first.textContent = 'First';
    const second = document.createElement('button');
    second.textContent = 'Second';
    const content = document.createElement('div');
    content.append(first, second);
    const panel = ctx.ui.stack.push({ title: 'Pad', content });
    expect(document.activeElement).toBe(first);
    press(13, true);
    ctx.loop.tickOnce(1 / 60);
    expect(document.activeElement).toBe(second);
    press(13, false);
    ctx.loop.tickOnce(1 / 60);
    press(1, true);
    ctx.loop.tickOnce(1 / 60);
    expect(panel.open).toBe(false);
    expect(ctx.ui.stack.size).toBe(0);
  });

  it('input.replay drives ctx.input from the recording with no DOM attached', async () => {
    // Record a session on one game: Space held for ticks 1 and 2, then released.
    const recorded = await createGame({
      ...options([]),
      input: { ...options([]).input, record: true },
    });
    if (!recorded) throw new Error('no ctx');
    const rec = recorded.input.recorder;
    if (!rec) throw new Error('no recorder');
    const held: boolean[] = [];
    recorded.hooks.update = () => held.push(recorded.input.held('go'));
    recorded.loop.tickOnce(1 / 60);
    recorded.input.keyDown('Space');
    recorded.loop.tickOnce(1 / 60);
    recorded.loop.tickOnce(1 / 60);
    recorded.input.keyUp('Space');
    recorded.loop.tickOnce(1 / 60);
    const recording = rec.stop();
    expect(recorded.input.recorder).toBeNull();
    expect(held).toEqual([false, true, true, false]);
    expect(recording.ticks.length).toBeGreaterThan(0);

    // Replay it on a second game: a real key press on the window is never seen.
    document.body.innerHTML = '<main id="root"></main>';
    const ctx = await createGame({
      ...options([]),
      input: { ...options([]).input, replay: recording },
    });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.input.playback).not.toBeNull();
    expect(ctx.input.recorder).toBeNull();
    const seen: boolean[] = [];
    ctx.hooks.update = () => seen.push(ctx.input.held('go'));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    for (let i = 0; i < 6; i++) ctx.loop.tickOnce(1 / 60);
    expect(seen).toEqual([false, true, true, false, false, false]);
    expect(ctx.input.playback?.done).toBe(true);
  });
});

describe('createGame: tick clock (ws/core-4)', () => {
  it('N fixed steps advance ctx.clock by exactly N × step; the gestures read it', async () => {
    const ctx = await createGame({ ...options([]), sim: { step: 1 / 64 } });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.gestures.clock).toBe(ctx.clock);
    expect(ctx.clock.now()).toBe(0);
    for (let i = 0; i < 37; i++) ctx.loop.tickOnce(1 / 64);
    expect(ctx.loop.time.tick).toBe(37);
    expect(ctx.clock.now()).toBe(37 * 15.625);
    // One frame of three steps advances three steps' worth.
    ctx.loop.tickOnce(3 / 64);
    expect(ctx.clock.now()).toBe(40 * 15.625);
  });

  it('the default 1/60 step advances the clock by the step per fixed update', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const seen: number[] = [];
    ctx.hooks.update = () => seen.push(ctx.clock.now());
    for (let i = 0; i < 60; i++) ctx.loop.tickOnce(1 / 60);
    expect(seen.length).toBe(60);
    expect(seen[0]).toBeCloseTo(1000 / 60, 9);
    expect(ctx.clock.now()).toBeCloseTo(1000, 6);
  });

  it('a paused loop advances the clock by 0', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    ctx.loop.tickOnce(1 / 60);
    const before = ctx.clock.now();
    ctx.loop.paused = true;
    for (let i = 0; i < 10; i++) ctx.loop.tickOnce(1 / 60);
    expect(ctx.clock.now()).toBe(before);
    ctx.loop.paused = false;
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.clock.now()).toBeCloseTo(before + 1000 / 60, 9);
  });

  it('sim: false advances the clock by the frame delta', async () => {
    const ctx = await createGame({ ...options([]), sim: false });
    if (!ctx) throw new Error('no ctx');
    ctx.loop.tickOnce(0.03125);
    ctx.loop.tickOnce(0.0078125);
    expect(ctx.clock.now()).toBe(31.25 + 7.8125);
  });

  it('a long-press recorded under createGame replays on the same tick and game time at 1× and 2×', async () => {
    // The playback drives ctx.clock (ws/input-9), so at `speed` 2 each loop tick feeds and
    // times two recorded ticks and createGame does not advance the clock a second time.
    // A 1/64 s step keeps the clock's sums exact. The playback anchors the first replayed
    // event at the tick it is fed, dropping its live age (2 ms here), so a long-press whose
    // threshold falls within that age of a tick boundary can still move by one tick.
    let wall = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    try {
      /**
       * Each gesture with the input tick it fired on (input updates so far, so the extra
       * updates a fast playback runs inside `step()` count) and the game clock's reading.
       */
      const watch = (ctx: NonNullable<Awaited<ReturnType<typeof createGame>>>) => {
        let tick = 0;
        const fired: string[] = [];
        ctx.gestures.onGesture((kind, phase) =>
          fired.push(`${kind}:${phase}@${tick}/${ctx.clock.now()}`),
        );
        ctx.input.onUpdated(() => tick++);
        return fired;
      };
      const recorded = await createGame({
        ...options([]),
        sim: { step: 1 / 64 },
        input: { ...options([]).input, record: true },
      });
      if (!recorded) throw new Error('no ctx');
      const live = watch(recorded);
      const canvas = recorded.surface.canvas;
      const ev = (type: string, buttons: number) => {
        const e = new PointerEvent(type, {
          pointerId: 3,
          pointerType: 'touch',
          clientX: 200,
          clientY: 150,
          isPrimary: true,
          button: 0,
          buttons,
          bubbles: true,
        });
        Object.defineProperty(e, 'timeStamp', { value: wall - 2 });
        canvas.dispatchEvent(e);
      };
      const tick = (spacing: number, ctx: typeof recorded) => {
        wall += spacing;
        ctx.loop.tickOnce(1 / 64);
      };
      tick(16, recorded);
      ev('pointerdown', 1);
      // Held for 40 ticks (625 ms of game time) at 16 ms of wall time per tick.
      for (let i = 0; i < 40; i++) tick(16, recorded);
      ev('pointerup', 0);
      tick(16, recorded);
      tick(16, recorded);
      const recording = recorded.input.recorder?.stop();
      if (!recording) throw new Error('no recording');
      const longs = live.filter((g) => g.startsWith('longPress'));
      expect(longs.length).toBe(1);
      expect(live.some((g) => g.startsWith('tap'))).toBe(false);
      expect(recording.tickMs).toBe(15.625);

      // Replay with 50 ms of wall time between ticks, at 1× and 2×: the long-press lands on the
      // same recorded tick at the same game time.
      const recordedTicks = recording.ticks.reduce((n, e) => n + ('n' in e ? e.n : 1), 0);
      expect(recordedTicks).toBe(43);
      for (const speed of [1, 2]) {
        document.body.innerHTML = '<main id="root"></main>';
        wall = 90_000;
        const ctx = await createGame({
          ...options([]),
          sim: { step: 1 / 64 },
          input: { ...options([]).input, replay: recording },
        });
        if (!ctx) throw new Error('no ctx');
        const playback = ctx.input.playback;
        if (!playback) throw new Error('no playback');
        expect(playback.clock).toBe(ctx.clock);
        playback.speed = speed;
        const again = watch(ctx);
        // A real pointer on the canvas never reaches the replayed gestures.
        ctx.surface.canvas.dispatchEvent(
          new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true }),
        );
        let loopTicks = 0;
        while (!playback.done && loopTicks < 60) {
          tick(50, ctx);
          loopTicks++;
        }
        expect(loopTicks).toBe(Math.ceil(recordedTicks / speed));
        expect(again).toEqual(live);
        // One advance per recorded tick, never two.
        const recordedMs = recordedTicks * 15.625;
        expect(ctx.clock.now()).toBe(recordedMs);
        // After the recording ends the loop's own step moves the clock again.
        tick(50, ctx);
        expect(ctx.clock.now()).toBe(recordedMs + 15.625);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a playback installed mid-session drives ctx.clock: the long-press fires on its recorded tick at 1× and 4×', async () => {
    // The path a game takes when it starts a replay from a menu: the session has run live for
    // a while (the clock is far from 0) and the game builds the playback itself on ctx.input
    // with { clock: ctx.clock }. A 1/64 s step keeps the clock's sums exact.
    const step = 15.625;
    let wall = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    try {
      type Ctx = NonNullable<Awaited<ReturnType<typeof createGame>>>;
      /** Each gesture with the input updates since `watch` and the clock since then. */
      const watch = (ctx: Ctx) => {
        let tick = 0;
        const t0 = ctx.clock.now();
        const fired: string[] = [];
        ctx.gestures.onGesture((kind, phase) =>
          fired.push(`${kind}:${phase}@${tick}/${ctx.clock.now() - t0}`),
        );
        ctx.input.onUpdated(() => tick++);
        return fired;
      };
      const tickOnce = (ctx: Ctx, spacing: number) => {
        wall += spacing;
        ctx.loop.tickOnce(1 / 64);
      };

      // Record a long-press on a fresh game.
      const recorded = await createGame({
        ...options([]),
        sim: { step: 1 / 64 },
        input: { ...options([]).input, record: true },
      });
      if (!recorded) throw new Error('no ctx');
      const live = watch(recorded);
      const press = (ctx: Ctx, type: string, buttons: number) => {
        const e = new PointerEvent(type, {
          pointerId: 3,
          pointerType: 'touch',
          clientX: 200,
          clientY: 150,
          isPrimary: true,
          button: 0,
          buttons,
          bubbles: true,
        });
        Object.defineProperty(e, 'timeStamp', { value: wall - 2 });
        ctx.surface.canvas.dispatchEvent(e);
      };
      tickOnce(recorded, 16);
      press(recorded, 'pointerdown', 1);
      for (let i = 0; i < 40; i++) tickOnce(recorded, 16);
      press(recorded, 'pointerup', 0);
      tickOnce(recorded, 16);
      tickOnce(recorded, 16);
      const recording = recorded.input.recorder?.stop();
      if (!recording) throw new Error('no recording');
      expect(live.filter((g) => g.startsWith('longPress')).length).toBe(1);
      const recordedTicks = recording.ticks.reduce((n, e) => n + ('n' in e ? e.n : 1), 0);
      expect(recordedTicks).toBe(43);

      for (const speed of [1, 4]) {
        document.body.innerHTML = '<main id="root"></main>';
        wall = 50_000;
        const ctx = await createGame({ ...options([]), sim: { step: 1 / 64 } });
        if (!ctx) throw new Error('no ctx');
        expect(ctx.input.playback).toBeNull();
        // Live for 30 ticks: the clock has advanced by the loop's own steps.
        for (let i = 0; i < 30; i++) tickOnce(ctx, 16);
        expect(ctx.clock.now()).toBe(30 * step);

        // The menu starts the replay on the game's tick clock (typed `TickClock`, ws/core-6).
        const clock = ctx.clock;
        const playback = createInputPlayback(ctx.input, recording, { clock: ctx.clock, speed });
        expect(ctx.input.playback).toBe(playback);
        const again = watch(ctx);

        // Fixed-update order, logged on each loop tick.
        const order: string[] = [];
        const step0 = playback.step.bind(playback);
        playback.step = () => {
          order.push('step');
          const fed = step0();
          order.push('/step');
          return fed;
        };
        const advance0 = clock.advance.bind(clock);
        clock.advance = (ms: number) => {
          order.push(`advance:${ms}`);
          advance0(ms);
        };
        ctx.hooks.update = () => order.push('update');
        const updates = (): number => order.filter((o) => o === 'update').length;

        let loopTicks = 0;
        while (!playback.done && loopTicks < 60) {
          const before = ctx.clock.now();
          order.length = 0;
          tickOnce(ctx, 50);
          loopTicks++;
          const fed = Math.min(speed, recordedTicks - (loopTicks - 1) * speed);
          // The playback alone moves the clock, by its tickMs per fed tick; the loop skips its own.
          expect(ctx.clock.now() - before).toBe(fed * step);
          expect(order.filter((o) => o.startsWith('advance'))).toEqual(
            Array.from({ length: fed }, () => `advance:${step}`),
          );
          // playback.step() first (its advances inside it), then the game's update.
          expect(order[0]).toBe('step');
          expect(order.indexOf('/step')).toBeLessThan(order.indexOf('update'));
          expect(updates()).toBe(1);
        }
        expect(loopTicks).toBe(Math.ceil(recordedTicks / speed));
        // The long-press fires on its recorded tick index and game time since the start.
        expect(again).toEqual(live);
        expect(ctx.clock.now()).toBe(30 * step + recordedTicks * step);

        // Once the recording ends the loop's own advance resumes, after step() and before update().
        order.length = 0;
        tickOnce(ctx, 50);
        expect(ctx.clock.now()).toBe((31 + recordedTicks) * step);
        expect(order).toEqual(['step', '/step', `advance:${step}`, 'update']);
        playback.detach();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('createGame: ctx.replay (ws/core-6)', () => {
  type Ctx = NonNullable<Awaited<ReturnType<typeof createGame>>>;
  const realKey = (type: 'keydown' | 'keyup') =>
    window.dispatchEvent(new KeyboardEvent(type, { code: 'Space' }));
  const realPointer = (ctx: Ctx, type: string, id = 9) =>
    ctx.surface.canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );

  /** Ten ticks with Space held on ticks 3 to 5, recorded under createGame. */
  async function recordSpace(): Promise<InputRecording> {
    const recorded = await createGame({
      ...options([]),
      input: { ...options([]).input, record: true },
    });
    if (!recorded) throw new Error('no ctx');
    for (let i = 0; i < 10; i++) {
      if (i === 3) recorded.input.keyDown('Space');
      if (i === 6) recorded.input.keyUp('Space');
      recorded.loop.tickOnce(1 / 60);
    }
    const recording = recorded.input.recorder?.stop();
    if (!recording) throw new Error('no recording');
    document.body.innerHTML = '<main id="root"></main>';
    return recording;
  }

  it('real keys and pointers never reach ctx.input during the replay, and do again once it ends', async () => {
    const recording = await recordSpace();
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const held: boolean[] = [];
    ctx.hooks.update = () => held.push(ctx.input.held('go'));
    // Live: the real key reaches the input.
    realKey('keydown');
    ctx.loop.tickOnce(1 / 60);
    expect(held).toEqual([true]);
    // Still held when the replay starts: the replay releases it, the player's key-up is not seen.
    const playback = ctx.replay(recording);
    expect(ctx.input.playback).toBe(playback);
    expect(playback.clock).toBe(ctx.clock);
    held.length = 0;
    let downs = 0;
    for (let i = 0; i < 10; i++) {
      // The player mashes Space and clicks the canvas on every tick of the replay.
      realKey(i % 2 ? 'keyup' : 'keydown');
      realPointer(ctx, 'pointerdown');
      if (ctx.input.pointer.down) downs++;
      realPointer(ctx, 'pointerup');
      ctx.loop.tickOnce(1 / 60);
    }
    // Exactly the recording: Space on ticks 3 to 5, never the player's.
    expect(held).toEqual([false, false, false, true, true, true, false, false, false, false]);
    expect(downs).toBe(0);
    expect(playback.done).toBe(true);
    expect(ctx.input.playback).toBe(playback);

    // The first step after the last tick gives the input back, before that step's update.
    held.length = 0;
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.playback).toBeNull();
    expect(held).toEqual([false]);
    realKey('keydown');
    realPointer(ctx, 'pointerdown');
    expect(ctx.input.pointer.down).toBe(true);
    ctx.loop.tickOnce(1 / 60);
    expect(held).toEqual([false, true]);
    realKey('keyup');
    realPointer(ctx, 'pointerup');
    ctx.loop.tickOnce(1 / 60);
    expect(held).toEqual([false, true, false]);
  });

  it('a live screen or XR press never reaches the game during a replay; a game mute outlives it (ws/api-core)', async () => {
    const recording = await recordSpace();
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const selects: string[] = [];
    ctx.pointers.addTester(planeTester(0, 'plane'));
    ctx.pointers.on('select', (e) => selects.push(e.pointer.device));
    // A world-space source like an XR controller, pressing on every tick.
    const s = createSample(0, 'xr');
    screenRay(ctx.camera, 100, 100, s.ray);
    const xrLike: PointerSource = { poll: () => [s] };
    ctx.pointers.addSource(xrLike);
    const other: PointerSource = { poll: () => [] };
    ctx.pointers.addSource(other);
    const gameMute = ctx.pointers.mute([other]);
    const press = () => {
      s.select = !s.select;
      // The screen source driven directly, not through the DOM the sink stops.
      if (s.select) ctx.pointers.screen.pointerDown(5, 100, 100, 'touch');
      else ctx.pointers.screen.pointerUp(5, 100, 100);
    };
    const playback = ctx.replay(recording);
    expect(ctx.pointers.isMuted(xrLike)).toBe(true);
    expect(ctx.pointers.isMuted(ctx.pointers.screen)).toBe(true);
    for (let i = 0; i < 10; i++) {
      press();
      ctx.loop.tickOnce(1 / 60);
    }
    expect(selects).toEqual([]);
    expect(playback.done).toBe(true);
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.playback).toBeNull();
    // The replay's mute is gone; the game's stays.
    expect(ctx.pointers.isMuted(xrLike)).toBe(false);
    expect(ctx.pointers.isMuted(ctx.pointers.screen)).toBe(false);
    expect(ctx.pointers.isMuted(other)).toBe(true);
    // Live again: a fresh press selects (a press held across the end is not a new one).
    s.select = false;
    ctx.loop.tickOnce(1 / 60);
    s.select = true;
    ctx.loop.tickOnce(1 / 60);
    expect(selects).toContain('xr');
    gameMute();
    expect(ctx.pointers.isMuted(other)).toBe(false);
  });

  it('stop() gives the input back at once; a second replay replaces the first', async () => {
    const recording = await recordSpace();
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const first = ctx.replay(recording);
    for (let i = 0; i < 4; i++) ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.held('go')).toBe(true);
    // A second replay stops the first and starts from tick 0 with nothing held (the action
    // state is read at the next update).
    const second = ctx.replay(recording);
    expect(ctx.input.playback).toBe(second);
    first.stop();
    expect(ctx.input.playback).toBe(second);
    realKey('keydown');
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.held('go')).toBe(false);
    second.stop();
    expect(ctx.input.playback).toBeNull();
    second.stop();
    realKey('keydown');
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.input.held('go')).toBe(true);
    realKey('keyup');
    // Live steps move the clock again.
    const before = ctx.clock.now();
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.clock.now()).toBeCloseTo(before + 1000 / 60, 9);
  });

  it('a long-press fires on its recorded tick at 1× and 4×, with a real tap ignored', async () => {
    const step = 15.625;
    let wall = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    try {
      const watch = (ctx: Ctx) => {
        let tick = 0;
        const t0 = ctx.clock.now();
        const fired: string[] = [];
        ctx.gestures.onGesture((kind, phase) =>
          fired.push(`${kind}:${phase}@${tick}/${ctx.clock.now() - t0}`),
        );
        ctx.input.onUpdated(() => tick++);
        return fired;
      };
      const tickOnce = (ctx: Ctx, spacing: number) => {
        wall += spacing;
        ctx.loop.tickOnce(1 / 64);
      };
      const press = (ctx: Ctx, type: string, buttons: number) => {
        const e = new PointerEvent(type, {
          pointerId: 3,
          pointerType: 'touch',
          clientX: 200,
          clientY: 150,
          isPrimary: true,
          button: 0,
          buttons,
          bubbles: true,
        });
        Object.defineProperty(e, 'timeStamp', { value: wall - 2 });
        ctx.surface.canvas.dispatchEvent(e);
      };
      const recorded = await createGame({
        ...options([]),
        sim: { step: 1 / 64 },
        input: { ...options([]).input, record: true },
      });
      if (!recorded) throw new Error('no ctx');
      const live = watch(recorded);
      tickOnce(recorded, 16);
      press(recorded, 'pointerdown', 1);
      for (let i = 0; i < 40; i++) tickOnce(recorded, 16);
      press(recorded, 'pointerup', 0);
      tickOnce(recorded, 16);
      tickOnce(recorded, 16);
      const recording = recorded.input.recorder?.stop();
      if (!recording) throw new Error('no recording');
      expect(live.filter((g) => g.startsWith('longPress')).length).toBe(1);
      expect(live.some((g) => g.startsWith('tap'))).toBe(false);
      const recordedTicks = 43;

      for (const speed of [1, 4]) {
        document.body.innerHTML = '<main id="root"></main>';
        wall = 50_000;
        const ctx = await createGame({ ...options([]), sim: { step: 1 / 64 } });
        if (!ctx) throw new Error('no ctx');
        for (let i = 0; i < 30; i++) tickOnce(ctx, 16);
        expect(ctx.clock.now()).toBe(30 * step);
        const playback = ctx.replay(recording, { speed });
        expect(playback.speed).toBe(speed);
        const again = watch(ctx);
        let loopTicks = 0;
        while (!playback.done && loopTicks < 60) {
          // A real tap on the canvas mid-replay would be a `tap` gesture if it got through.
          if (loopTicks === 2) {
            realPointer(ctx, 'pointerdown');
            realPointer(ctx, 'pointerup');
          }
          tickOnce(ctx, 50);
          loopTicks++;
        }
        expect(loopTicks).toBe(Math.ceil(recordedTicks / speed));
        expect(again).toEqual(live);
        expect(ctx.clock.now()).toBe((30 + recordedTicks) * step);
        tickOnce(ctx, 50);
        expect(ctx.input.playback).toBeNull();
        expect(ctx.clock.now()).toBe((31 + recordedTicks) * step);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('onEnd fires once, on the step that gives the input back, at 1× and 4×', async () => {
    const recording = await recordSpace();
    const ticks = 10;
    for (const speed of [1, 4]) {
      document.body.innerHTML = '<main id="root"></main>';
      const ctx = await createGame(options([]));
      if (!ctx) throw new Error('no ctx');
      const held: boolean[] = [];
      ctx.hooks.update = () => held.push(ctx.input.held('go'));
      const ends: { step: number; updates: number; playback: unknown }[] = [];
      let step = 0;
      const playback = ctx.replay(recording, {
        speed,
        onEnd: () => {
          ends.push({ step, updates: held.length, playback: ctx.input.playback });
          // The input is back on the canvas: a real key pressed here is seen by this step.
          realKey('keydown');
        },
      });
      const feeding = Math.ceil(ticks / speed);
      for (step = 1; step <= feeding; step++) ctx.loop.tickOnce(1 / 60);
      expect(playback.done).toBe(true);
      expect(ends).toEqual([]);
      for (; step <= feeding + 3; step++) ctx.loop.tickOnce(1 / 60);
      // The step after the last fed tick, before its update; never again.
      expect(ends).toEqual([{ step: feeding + 1, updates: feeding, playback: null }]);
      expect(held[feeding - 1]).toBe(false);
      expect(held[feeding]).toBe(true);
      realKey('keyup');
    }
  });

  it('onEnd does not fire on stop() or when a second replay replaces the first', async () => {
    const recording = await recordSpace();
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const ends: string[] = [];
    const first = ctx.replay(recording, { onEnd: () => ends.push('first') });
    ctx.loop.tickOnce(1 / 60);
    const second = ctx.replay(recording, { onEnd: () => ends.push('second') });
    for (let i = 0; i < 3; i++) ctx.loop.tickOnce(1 / 60);
    second.stop();
    for (let i = 0; i < 12; i++) ctx.loop.tickOnce(1 / 60);
    expect(first.done).toBe(false);
    expect(ends).toEqual([]);
    // A replay chained from onEnd runs from the next step and reports its own end.
    let chained = 0;
    ctx.replay(recording, {
      onEnd: () => {
        ends.push('third');
        if (chained++ === 0) ctx.replay(recording, { onEnd: () => ends.push('fourth') });
      },
    });
    for (let i = 0; i < 30; i++) ctx.loop.tickOnce(1 / 60);
    expect(ends).toEqual(['third', 'fourth']);
    expect(ctx.input.playback).toBeNull();
  });
});

describe('createGame: ergonomics (ws/api-core)', () => {
  it('setCamera swaps the camera the loop, ctx.camera and the pointer rays use', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const first = ctx.camera;
    const seen: unknown[] = [];
    ctx.stack.push({ render: (_f, camera) => seen.push(camera) });
    const persp = Camera.perspective(1, 16 / 9, 0.1, 100);
    ctx.setCamera(persp);
    expect(ctx.camera).toBe(persp);
    expect(ctx.renderer.camera).toBe(persp);
    expect(ctx.pointers.camera).toBe(persp);
    ctx.loop.tickOnce(1 / 60);
    ctx.setCamera(first);
    ctx.loop.tickOnce(1 / 60);
    expect(seen).toEqual([persp, first]);
  });

  it('ui.anchors() and ui.floats() default to the game camera', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(() => ctx.ui.anchors()).not.toThrow();
    expect(ctx.ui.floats()).toBe(ctx.ui.floats());
  });

  it('theme and textScale reach the overlay', async () => {
    const ctx = await createGame({
      ...options([]),
      theme: { colorAccent: '#ff00ff' },
      textScale: 1.5,
    });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.ui.root.style.getPropertyValue('--tc-color-accent')).toBe('#ff00ff');
    expect(ctx.ui.root.dataset.textScale).toBe('150');
    const plain = await createGame(options([]));
    expect(plain?.ui.root.dataset.textScale).toBeUndefined();
  });

  it('types: a ctx without a save is an EngineCtx<A>; P types the pointer hits', async () => {
    const ctx = await createGame<'go', null, unknown, { id: number }>({
      root: document.getElementById('root') as HTMLElement,
      input: { bindings: { go: [{ key: 'Space' }] } },
    });
    if (!ctx) throw new Error('no ctx');
    const takesAny = (c: EngineCtx<'go'>) => c.save;
    expect(takesAny(ctx)).toBeNull();
    const withSave = await createGame(options([]));
    if (!withSave) throw new Error('no ctx');
    expect(takesAny(withSave)).not.toBeNull();
    ctx.pointers.addTester(planeTester(0, { id: 3 }));
    const ids: number[] = [];
    ctx.pointers.on('hit', (e) => {
      if (e.hit) ids.push(e.hit.target.id);
    });
    // @ts-expect-error the router's targets are `{ id: number }`
    ctx.pointers.addTester(planeTester(0, 'not an id'));
    expect(ids).toEqual([]);
  });

  it('the pointer rays go through the head camera while VR runs', async () => {
    xr = installFakeXr();
    const ctx = await createGame({ ...options([]), xr: {} });
    if (!ctx) throw new Error('no ctx');
    ctx.loop.start();
    expect(ctx.pointers.camera).toBe(ctx.camera);
    await ctx.xr.enter();
    expect(ctx.xr.surface).not.toBeNull();
    expect(ctx.pointers.camera).toBe(ctx.xr.surface?.head);
    await ctx.xr.exit();
    expect(ctx.pointers.camera).toBe(ctx.camera);
  });
});

describe('createGame: aux targets (ws/core-7)', () => {
  /** The `PostInputs` the post stack is handed on one rendered frame. */
  function postInputsOf(ctx: NonNullable<Awaited<ReturnType<typeof createGame>>>) {
    const spy = vi.spyOn(ctx.post, 'encode');
    try {
      ctx.loop.tickOnce(1 / 60);
      expect(spy).toHaveBeenCalled();
      const inputs = spy.mock.calls.at(-1)![1];
      return { velocity: inputs.velocity, roughMetal: inputs.roughMetal };
    } finally {
      spy.mockRestore();
    }
  }

  it('aux: { velocity: true } puts a velocity target in PostInputs', async () => {
    const ctx = await createGame({ ...options([]), aux: { velocity: true } });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.renderer.target.velocity).not.toBeNull();
    const inputs = postInputsOf(ctx);
    expect(inputs.velocity).toBe(ctx.renderer.target.velocity);
    expect(inputs.velocity).not.toBeNull();
    expect(inputs.roughMetal).toBeNull();
    // A resize keeps it.
    ctx.renderer.resize(320, 180);
    expect(postInputsOf(ctx).velocity).toBe(ctx.renderer.target.velocity);
    expect(ctx.renderer.target.velocity).not.toBeNull();
  });

  it('without aux the target and PostInputs have no aux attachments', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(ctx.renderer.target.velocity).toBeNull();
    expect(ctx.renderer.target.roughMetal).toBeNull();
    expect(ctx.renderer.target.auxKey).toBe(0);
    expect(postInputsOf(ctx)).toEqual({ velocity: null, roughMetal: null });
  });
});

describe('createGame: xr', () => {
  it('ctx.xr.supported() is false without WebXR or the binding, and enter() rejects', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    expect(ctx.xr.active).toBe(false);
    expect(ctx.xr.session).toBeNull();
    expect(await ctx.xr.supported()).toBe(false);
    await expect(ctx.xr.enter()).rejects.toThrow(/WebXR/);
    xr = installFakeXr({ supported: false });
    expect(await ctx.xr.supported()).toBe(false);
    await expect(ctx.xr.enter()).rejects.toThrow();
    expect(ctx.xr.active).toBe(false);
    await ctx.xr.exit();
  });

  it('enter: the session drives frames, both eyes render into the layer, no present; exit restores', async () => {
    const { createWebHost } = await import('../host');
    const web = createWebHost();
    const frames = { log: [] as string[], pending: null as ((t: number) => void) | null };
    const host = {
      ...web,
      requestFrame: (cb: (t: number) => void) => {
        frames.log.push('web.request');
        frames.pending = cb;
        return 1;
      },
      cancelFrame: () => {
        frames.log.push('web.cancel');
        frames.pending = null;
      },
    };
    const events: string[] = [];
    const ctx = await createGame({
      ...options([]),
      host,
      xr: {
        referenceSpace: 'local',
        onEnter: () => events.push('enter'),
        onExit: () => events.push('exit'),
      },
    });
    if (!ctx) throw new Error('no ctx');
    const fake = lastFake!;
    xr = installFakeXr();
    expect(await ctx.xr.supported()).toBe(true);
    const cameras: { viewIndex: number; screenX: number }[] = [];
    ctx.stack.push({
      render: (_f, camera) => {
        cameras.push({ viewIndex: camera.viewIndex, screenX: camera.screen.x });
      },
    });
    ctx.loop.start();
    expect(frames.log).toEqual(['web.request']);

    const entering = ctx.xr.enter();
    const again = ctx.xr.enter();
    expect(again).toBe(entering);
    await entering;
    await ctx.xr.enter();
    expect(events).toEqual(['enter']);
    expect(ctx.xr.active).toBe(true);
    const session = xr.system.session;
    expect(ctx.xr.session).toBe(session);
    expect(session.init).toEqual({
      requiredFeatures: ['webgpu', 'local'],
      optionalFeatures: ['hand-tracking'],
    });
    expect(session.referenceSpaceRequests).toEqual(['local']);
    // The page's pending frame was cancelled; the session has one.
    expect(frames.log).toEqual(['web.request', 'web.cancel']);
    expect(frames.pending).toBeNull();
    expect(session.pendingFrames).toBe(1);
    expect(ctx.host).toBe(host);

    // One XR frame: the scenes record once through the head, each eye is a scene pass into
    // the surface's HDR target resolved by the post stack into its half of the layer, and
    // nothing goes to the swapchain.
    const before = fake.passes.length;
    const right = new FakeXrInputSource('right');
    right.buttons[0]!.pressed = true;
    session.addInputSource(right);
    let xrPointers = 0;
    ctx.hooks.beforeRender = () => {
      xrPointers = ctx.pointers.pointers.filter((p) => p.device === 'xr').length;
    };
    // The loop clocks frames with performance.now: move it past one fixed step so update
    // (and with it the pointer poll) runs inside this XR frame.
    const realNow = performance.now;
    const later = (ms: number, fn: () => void) => {
      const t0 = realNow.call(performance);
      performance.now = () => t0 + ms;
      try {
        fn();
      } finally {
        performance.now = realNow;
      }
    };
    later(40, () => xr!.step(40));
    const passes = fake.passes.slice(before);
    const scene = passes.filter((p) => p.label === 'scene');
    expect(scene.length).toBe(2);
    expect(passes.some((p) => p.label?.includes('present'))).toBe(false);
    const composites = passes.filter((p) => p.label === 'pass:post-composite');
    expect(composites.length).toBe(2);
    const viewports = composites.map(
      (p) =>
        (
          p.commands.find((c) => c.op === 'other' && c.name === 'setViewport') as {
            args?: number[];
          }
        ).args,
    );
    expect(viewports).toEqual([
      [0, 0, 64, 32, 0, 1],
      [64, 0, 64, 32, 0, 1],
    ]);
    for (const p of composites) {
      const ca = (
        (p.desc as GPURenderPassDescriptor).colorAttachments as GPURenderPassColorAttachment[]
      )[0]!;
      expect(ca.loadOp).toBe('load');
      expect((ca.view as unknown as { texture: { label: string } }).texture.label).toBe(
        'xr-layer-color',
      );
    }
    expect(cameras).toEqual([{ viewIndex: 0, screenX: 0 }]);
    const eyes = ctx.xr.surface!.views(xr.step(0));
    expect(eyes.map((e) => e.camera.viewIndex)).toEqual([0, 1]);
    expect(eyes.map((e) => e.camera.screen.width)).toEqual([1, 1]);
    expect(eyes.map((e) => e.viewport.x)).toEqual([0, 64]);
    expect(ctx.xr.surface!.scene).not.toBeNull();
    // Steady state: no allocations per XR frame once warm.
    later(80, () => xr!.step(80));
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const warm = counts();
    later(120, () => xr!.step(120));
    later(160, () => xr!.step(160));
    expect(counts()).toEqual(warm);
    expect(xrPointers).toBe(1);
    expect(session.pendingFrames).toBe(1);
    expect(fake.errors).toEqual([]);

    // Exit: the session ends, the page host schedules again, the surface is gone.
    const layer = ctx.xr.surface!.layer as { destroyed?: boolean };
    await ctx.xr.exit();
    expect(events).toEqual(['enter', 'exit']);
    expect(ctx.xr.active).toBe(false);
    expect(ctx.xr.surface).toBeNull();
    expect(layer.destroyed).toBe(true);
    expect(frames.log).toEqual(['web.request', 'web.cancel', 'web.request']);
    expect(frames.pending).not.toBeNull();
    await ctx.xr.exit();
    expect(events).toEqual(['enter', 'exit']);
    // The next page frame renders the ordinary way (one camera, presented to the swapchain).
    cameras.length = 0;
    const b2 = fake.passes.length;
    later(200, () => frames.pending!(200));
    const after = fake.passes.slice(b2);
    expect(after.filter((p) => p.label === 'scene').length).toBe(1);
    expect(after.some((p) => p.label?.includes('present') || p.label?.includes('post'))).toBe(true);
    expect(cameras).toEqual([{ viewIndex: 0, screenX: 0 }]);
    expect(ctx.pointers.pointers.filter((p) => p.device === 'xr').length).toBe(0);
  });

  it('the headset ending the session restores the page host too', async () => {
    xr = installFakeXr();
    const exits: number[] = [];
    const ctx = await createGame({ ...options([]), xr: { onExit: () => exits.push(1) } });
    if (!ctx) throw new Error('no ctx');
    ctx.loop.start();
    await ctx.xr.enter();
    const session = xr.system.session;
    expect(session.init?.requiredFeatures).toEqual(['webgpu', 'local-floor']);
    await session.end();
    expect(ctx.xr.active).toBe(false);
    expect(exits).toEqual([1]);
    expect(ctx.loop.isRunning).toBe(true);
    await ctx.xr.exit();
    expect(exits).toEqual([1]);
  });
});
