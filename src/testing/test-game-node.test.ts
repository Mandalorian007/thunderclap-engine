/**
 * ws/testing-2: `createTestGame` in plain Node (Vitest's default `node` environment, no
 * happy-dom), with `overlay: false`, and device loss through `FakeDevice.loseDevice`.
 * ws/core-9: `createGame({ overlay: false })` itself on the headless `{ gpu, clock, host }`
 * path, touching no DOM.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCtx } from '../core/game';
import { createGame } from '../core/game';
import { createInputRecorder } from '../input';
import type { GpuContext } from '../platform';
import { createFakeDevice, fakeRendererGpu, installGpuGlobals } from '../render/fake-gpu';
import { createFakeHost } from './fake-host';
import { createFixedClock } from './fixed-clock';
import { createTestGame } from './test-game';

type Action = 'go';
const bindings = { go: [{ key: 'Space' }] };

// Read before any game is made: this file starts with no DOM at all.
const hadDom = typeof (globalThis as { document?: unknown }).document !== 'undefined';

function addMover(ctx: EngineCtx<Action>): { x: number } {
  const state = { x: 0 };
  ctx.hooks.update = () => {
    if (ctx.input.held('go')) state.x += 1;
  };
  return state;
}

describe('createTestGame with no DOM (ws/testing-2)', () => {
  it('starts in an environment with no document or window', () => {
    expect(hadDom).toBe(false);
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  });

  it('without `overlay: false` it throws and names both ways out', async () => {
    await expect(createTestGame<Action>({ input: { bindings } })).rejects.toThrow(
      /happy-dom.*overlay: false/,
    );
  });

  it('`overlay: false` runs the whole game: input, update, scenes, render, save', async () => {
    let flushes = 0;
    const g = await createTestGame<Action, { flush(): void }>({
      overlay: false,
      input: { bindings },
      save: () => ({
        flush() {
          flushes++;
        },
      }),
    });
    const state = addMover(g.ctx);
    const log: string[] = [];
    g.ctx.stack.push({ update: () => log.push('u'), render: () => log.push('r') });
    g.input.keyDown('Space');
    g.step(10);
    g.input.keyUp('Space');
    g.step(5);
    expect(state.x).toBe(10);
    expect(log.join('')).toBe('ur'.repeat(15));
    expect(g.clock.ticks).toBe(15);
    expect(g.clock.now()).toBe(15 * (1000 / 60));
    expect(g.device.submits).toBeGreaterThan(0);
    expect(g.device.errors).toEqual([]);
    // No overlay at all: `ctx.ui` says why it is missing.
    expect(() => g.ctx.ui).toThrow(/ctx\.ui.*overlay: false/);
    // The loop runs on the fake host's frames; going to the background stops it and flushes.
    g.ctx.loop.start();
    expect(g.host.runFrame()).toBe(1);
    g.host.setState('background');
    expect(g.ctx.loop.isRunning).toBe(false);
    expect(flushes).toBe(1);
  });

  it('two `overlay: false` games fed the same keys read the same state frame for frame', async () => {
    async function run() {
      const g = await createTestGame<Action>({ overlay: false, input: { bindings } });
      const state = addMover(g.ctx);
      const trace: number[] = [];
      for (let i = 0; i < 20; i++) {
        if (i === 3) g.input.keyDown('Space');
        if (i === 12) g.input.keyUp('Space');
        g.step();
        trace.push(state.x);
      }
      return { trace, submits: g.device.submits };
    }
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.trace.at(-1)).toBe(9);
  });
});

describe('device loss (ws/testing-2)', () => {
  it('FakeDevice.lost is device.lost, and resolves once with the first loss', async () => {
    const g = await createTestGame<Action>({ overlay: false, input: { bindings } });
    const dev = g.device.device as unknown as { lost: Promise<GPUDeviceLostInfo> };
    expect(dev.lost).toBe(g.device.lost);
    g.device.loseDevice('unknown', 'driver reset');
    g.device.loseDevice('destroyed', 'second');
    const info = await g.device.lost;
    expect(info.reason).toBe('unknown');
    expect(info.message).toBe('driver reset');
  });

  it('halts the loop and reports through hooks.deviceLost and ctx.onDeviceLost, as on a page', async () => {
    let flushes = 0;
    const g = await createTestGame<Action, { flush(): void }>({
      overlay: false,
      input: { bindings },
      save: () => ({
        flush() {
          flushes++;
        },
      }),
    });
    const state = addMover(g.ctx);
    const order: string[] = [];
    const seen: GPUDeviceLostInfo[] = [];
    g.ctx.hooks.deviceLost = (info) => {
      order.push(`hook:halted=${g.ctx.loop.halted}`);
      seen.push(info);
    };
    g.ctx.onDeviceLost((info) => {
      order.push('listener');
      seen.push(info);
    });
    const off = g.ctx.onDeviceLost(() => order.push('removed'));
    off();
    g.input.keyDown('Space');
    g.step(3);
    expect(state.x).toBe(3);
    const submits = g.device.submits;

    await g.loseDevice('unknown', 'gpu reset');

    expect(g.ctx.loop.halted).toBe(true);
    expect(order).toEqual(['hook:halted=true', 'listener']);
    expect(seen.map((i) => `${i.reason}:${i.message}`)).toEqual([
      'unknown:gpu reset',
      'unknown:gpu reset',
    ]);
    expect(flushes).toBe(1);
    // A halted loop runs nothing: no update, no render, no clock, and start() is ignored.
    g.step(5);
    g.ctx.loop.start();
    expect(g.ctx.loop.isRunning).toBe(false);
    expect(state.x).toBe(3);
    expect(g.clock.ticks).toBe(3);
    expect(g.device.submits).toBe(submits);
  });

  it("an explicit destroy ('destroyed') is not a loss: the game keeps running", async () => {
    const g = await createTestGame<Action>({ overlay: false, input: { bindings } });
    let lost = 0;
    g.ctx.onDeviceLost(() => lost++);
    await g.loseDevice('destroyed');
    g.step(2);
    expect(lost).toBe(0);
    expect(g.ctx.loop.halted).toBe(false);
    expect(g.clock.ticks).toBe(2);
  });
});

const g0 = globalThis as Record<string, unknown>;
const noDom = () =>
  ['document', 'window', 'HTMLElement', 'ResizeObserver', 'getComputedStyle'].filter(
    (k) => g0[k] !== undefined,
  );

function headlessGpu(): { gpu: GpuContext; device: ReturnType<typeof createFakeDevice> } {
  installGpuGlobals();
  const device = createFakeDevice();
  return {
    device,
    gpu: { ...fakeRendererGpu(device), adapter: {} as GPUAdapter, timestamps: false },
  };
}

describe('createGame({ overlay: false }) (ws/core-9)', () => {
  it('runs on { gpu, clock, host } and leaves no DOM global behind', async () => {
    const { gpu, device } = headlessGpu();
    const host = createFakeHost();
    const clock = createFixedClock(1000 / 60);
    const ctx = await createGame<Action>({ overlay: false, gpu, host, clock, input: { bindings } });
    expect(ctx).not.toBeNull();
    const c = ctx!;
    const state = addMover(c);
    c.input.keyDown('Space');
    for (let i = 0; i < 4; i++) c.loop.tickOnce(1 / 60);
    expect(state.x).toBe(4);
    expect(clock.ticks).toBe(4);
    expect(device.submits).toBeGreaterThan(0);
    expect(device.errors).toEqual([]);
    expect(noDom()).toEqual([]);
    // The pad belongs to the game; padNav runs and reads nothing.
    expect(() => c.padNav.update()).not.toThrow();
  });

  it('ctx.ui, surface.root and surface.canvas throw a clear error; the surface still maps', async () => {
    const { gpu } = headlessGpu();
    const ctx = (await createGame<Action>({
      overlay: false,
      gpu,
      host: createFakeHost(),
      design: { width: 640, height: 360 },
      input: { bindings },
    }))!;
    expect(() => ctx.ui).toThrow(
      'ctx.ui: this game was created with `overlay: false`, which has no overlay and no DOM',
    );
    expect(() => ctx.surface.root).toThrow(/surface\.root.*overlay: false/);
    expect(() => ctx.surface.canvas).toThrow(/surface\.canvas.*overlay: false/);
    // A spread of the ctx does not trip over the missing overlay.
    expect(Object.keys({ ...ctx })).not.toContain('ui');
    // The virtual container is the design size at ratio 1: client px are design px.
    expect(ctx.surface.rect).toEqual({ x: 0, y: 0, width: 640, height: 360, scale: 1 });
    expect(ctx.surface.backbuffer).toMatchObject({ width: 640, height: 360 });
    ctx.input.pointerAt(100, 50);
    expect(ctx.input.pointer).toMatchObject({ x: 100, y: 50, inside: true });
  });

  it('needs gpu and host, since it boots nothing and has no page', async () => {
    const { gpu } = headlessGpu();
    await expect(createGame<Action>({ overlay: false, gpu, input: { bindings } })).rejects.toThrow(
      /overlay: false.*gpu.*host/,
    );
    await expect(
      createGame<Action>({ overlay: false, host: createFakeHost(), input: { bindings } }),
    ).rejects.toThrow(/overlay: false.*gpu.*host/);
  });

  it('host lifecycle and device loss still reach the game', async () => {
    const { gpu, device } = headlessGpu();
    const host = createFakeHost();
    let flushes = 0;
    const ctx = (await createGame<Action, { flush(): void }>({
      overlay: false,
      gpu,
      host,
      input: { bindings },
      save: () => ({ flush: () => void flushes++ }),
    }))!;
    const seen: string[] = [];
    ctx.hooks.lifecycle = (s) => seen.push(s);
    ctx.loop.start();
    host.setState('background');
    expect(ctx.loop.isRunning).toBe(false);
    host.setState('active');
    expect(ctx.loop.isRunning).toBe(true);
    expect(seen).toEqual(['background', 'active']);
    expect(flushes).toBe(1);
    device.loseDevice('unknown', 'gone');
    await device.lost;
    expect(ctx.loop.halted).toBe(true);
    expect(flushes).toBe(2);
  });

  it('a recording replays through ctx.replay with no DOM: same keys, same state', async () => {
    const live = await createTestGame<Action>({ overlay: false, input: { bindings } });
    const liveState = addMover(live.ctx);
    const rec = createInputRecorder(live.input);
    for (let i = 0; i < 12; i++) {
      if (i === 2) live.input.keyDown('Space');
      if (i === 8) live.input.keyUp('Space');
      live.step();
    }
    const recording = rec.stop();
    expect(liveState.x).toBe(6);

    const again = await createTestGame<Action>({ overlay: false, input: { bindings } });
    const state = addMover(again.ctx);
    let ended = 0;
    again.ctx.replay(recording, { onEnd: () => ended++ });
    again.step(14);
    expect(state.x).toBe(6);
    expect(ended).toBe(1);
  });

  it('createTestGame viewport letterboxes the virtual container', async () => {
    const g = await createTestGame<Action>({
      overlay: false,
      design: { width: 200, height: 100 },
      viewport: { width: 400, height: 400 },
      input: { bindings },
    });
    expect(g.ctx.surface.rect).toEqual({ x: 0, y: 100, width: 400, height: 200, scale: 2 });
    g.input.pointerAt(200, 200);
    expect(g.input.pointer).toMatchObject({ x: 100, y: 50 });
  });
});
