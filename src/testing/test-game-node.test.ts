/**
 * ws/testing-2: `createTestGame` in plain Node (Vitest's default `node` environment, no
 * happy-dom), with `overlay: false`, and device loss through `FakeDevice.loseDevice`.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCtx } from '../core/game';
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
    // The overlay is built but inert: it exists and nothing breaks when the game uses it.
    expect(g.ctx.ui.root).toBeTruthy();
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
