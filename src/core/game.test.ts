// @vitest-environment happy-dom
/**
 * createGame wiring on a fake GPU device: lifecycle (hide flushes and stops, show resumes),
 * device loss (halt for good), hook order in a frame, fill bands and the modal input block.
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
    fillBands: { wide: { minVisible: 700, focusY: 540 } },
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
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  setHidden(false);
  vi.unstubAllGlobals();
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
      render: (_f, alpha) => log.push(`scene.render ${alpha}`),
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

  it('fill bands apply only on a phone-sized letterbox', async () => {
    const ctx = await createGame(options([]));
    if (!ctx) throw new Error('no ctx');
    const setFill = vi.spyOn(ctx.surface, 'setFill');
    ctx.surface.fitRect = { ...ctx.surface.fitRect, scale: 0.4 };
    ctx.setFill('wide');
    expect(setFill).toHaveBeenLastCalledWith({ minVisible: 700, focusY: 540 });
    ctx.setFill('other');
    expect(setFill).toHaveBeenLastCalledWith(null);
    ctx.surface.fitRect = { ...ctx.surface.fitRect, scale: 0.9 };
    ctx.setFill('wide');
    expect(setFill).toHaveBeenLastCalledWith(null);
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
