// @vitest-environment happy-dom
/**
 * createGame wiring on a fake GPU device: lifecycle (hide flushes and stops, show resumes),
 * device loss (halt for good), hook order in a frame, the host's frames, the pointer router
 * and the modal input block.
 * The real-browser checks are in e2e/lifecycle.spec.ts and e2e/surface.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../platform';
import { mountSurface } from '../platform/surface';
import { createFakeDevice, fakeRendererGpu, installGpuGlobals } from '../render/fake-gpu';
import { type CreateGameOptions, createGame } from './game';

const lost = new Set<(info: GPUDeviceLostInfo) => void>();
let bootOk = true;

vi.mock('../platform/boot', () => ({
  boot: async (root: HTMLElement, opts: { logicalWidth?: number }): Promise<BootResult> => {
    if (!bootOk) return { ok: false, reason: 'no-webgpu' as never };
    installGpuGlobals();
    const fake = createFakeDevice();
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

afterEach(() => {
  setHidden(false);
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
    expect(ctx.input.getGestures()).toBe(ctx.gestures);
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
    expect(ctx.input.getPointers()).toBe(ctx.pointers);
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
});
