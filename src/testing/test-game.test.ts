// @vitest-environment happy-dom
/**
 * ws/core-8: headless `createGame` (`gpu`, `clock`, `host`) through `createTestGame`. A game on
 * the fake GPU and the fixed clock steps N frames deterministically, and its scene stack, save
 * and pointers work; a touch stick recorded under it replays frame for frame through
 * `ctx.replay`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineCtx } from '../core/game';
import { createGame } from '../core/game';
import { createTouchZones, type InputRecording, planeTester } from '../input';
import { createFakeDevice, fakeRendererGpu, installGpuGlobals } from '../render/fake-gpu';
import { createFakeHost } from './fake-host';
import { createFixedClock } from './fixed-clock';
import { createTestGame } from './test-game';

type Action = 'go' | 'left' | 'right' | 'up' | 'down';

const bindings = {
  go: [{ key: 'Space' }],
  left: [],
  right: [],
  up: [],
  down: [],
};

afterEach(() => {
  document.body.innerHTML = '';
});

/** A tiny game: `x` moves by 1 per fixed step while `go` is held. */
function addMover(ctx: EngineCtx<Action>): { x: number } {
  const state = { x: 0 };
  ctx.hooks.update = () => {
    if (ctx.input.held('go')) state.x += 1;
  };
  return state;
}

describe('createGame headless (ws/core-8)', () => {
  it('runs on an injected fake GPU, host and clock with no root, canvas context or WebGPU', async () => {
    installGpuGlobals();
    const fake = createFakeDevice();
    const host = createFakeHost();
    const clock = createFixedClock(1000 / 60);
    const ctx = await createGame({
      gpu: { ...fakeRendererGpu(fake), adapter: {} as GPUAdapter, timestamps: false },
      host,
      clock,
      input: { bindings },
    });
    if (!ctx) throw new Error('no ctx');
    expect(ctx.host).toBe(host);
    expect(ctx.clock).toBe(clock);
    expect(ctx.gpu.device).toBe(fake.device);
    // No WebGPU: the canvas never got a context, and nothing is in the page.
    expect(document.body.contains(ctx.surface.root)).toBe(false);
    ctx.loop.tickOnce(1 / 60);
    ctx.loop.tickOnce(1 / 60);
    expect(clock.ticks).toBe(2);
    expect(fake.submits).toBeGreaterThan(0);
    expect(fake.errors).toEqual([]);
  });

  it('throws without root and gpu', async () => {
    await expect(createGame({ input: { bindings } } as never)).rejects.toThrow(/root/);
  });
});

describe('createTestGame (ws/core-8)', () => {
  it('steps N frames deterministically: same state, same clock, same GPU work every run', async () => {
    async function run() {
      const g = await createTestGame<Action>({ input: { bindings } });
      const state = addMover(g.ctx);
      const trace: string[] = [];
      for (let i = 0; i < 30; i++) {
        if (i === 5) g.input.keyDown('Space');
        if (i === 20) g.input.keyUp('Space');
        g.step();
        trace.push(`${g.ctx.loop.time.tick}:${g.clock.now()}:${state.x}`);
      }
      return { g, state, trace, submits: g.device.submits };
    }
    const a = await run();
    const b = await run();
    expect(a.trace).toEqual(b.trace);
    expect(a.submits).toBe(b.submits);
    expect(a.state.x).toBe(15);
    // N steps read exactly N × step: no float drift.
    expect(a.g.clock.ticks).toBe(30);
    expect(a.g.clock.now()).toBe(30 * (1000 / 60));
    expect(a.g.ctx.loop.time.tick).toBe(30);
    expect(a.g.ctx.loop.time.frame).toBe(30);
    expect(a.g.device.errors).toEqual([]);
  });

  it('step(n) runs n frames; sim.step sets the clock step', async () => {
    const g = await createTestGame<Action>({ input: { bindings }, sim: { step: 1 / 30 } });
    g.step(4);
    expect(g.clock.stepMs).toBe((1 / 30) * 1000);
    expect(g.clock.ticks).toBe(4);
    expect(g.ctx.loop.time.tick).toBe(4);
  });

  it('runs the scene stack: update per step, render per frame, in the engine order', async () => {
    const g = await createTestGame<Action>({ input: { bindings } });
    const log: string[] = [];
    g.ctx.hooks.update = () => log.push('update');
    g.ctx.stack.push({
      update: () => log.push('scene.update'),
      render: () => log.push('scene.render'),
    });
    g.step(2);
    expect(log).toEqual([
      'update',
      'scene.update',
      'scene.render',
      'update',
      'scene.update',
      'scene.render',
    ]);
    g.ctx.stack.pop();
    log.length = 0;
    g.step();
    expect(log).toEqual(['update']);
  });

  it('the save lives in the fake host storage and flushes when the app goes to the background', async () => {
    let writes = 0;
    const g = await createTestGame<Action, { flush(): void; best: number }>({
      input: { bindings },
      save: (host) => {
        const store = host.storage.open();
        const save = {
          best: Number(store?.getItem('best') ?? 0),
          flush() {
            writes++;
            store?.setItem('best', String(save.best));
          },
        };
        return save;
      },
    });
    g.ctx.save.best = 7;
    g.ctx.loop.start();
    g.host.setState('background');
    expect(writes).toBe(1);
    expect(g.host.memory?.getItem('best')).toBe('7');
    expect(g.ctx.loop.isRunning).toBe(false);
    g.host.setState('active');
    expect(g.ctx.loop.isRunning).toBe(true);
    g.ctx.loop.stop();
  });

  it('routes pointers: a press on the canvas hits a plane through the game camera', async () => {
    const g = await createTestGame<Action>({ input: { bindings } });
    g.ctx.pointers.addTester(planeTester(0, 'floor'));
    const selects: { x: number; y: number; target: unknown }[] = [];
    g.ctx.pointers.on('select', (e) => {
      if (e.hit) selects.push({ x: e.hit.point[0], y: e.hit.point[1], target: e.hit.target });
    });
    const canvas = g.ctx.surface.canvas;
    const ev = (type: string) =>
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: 480,
        clientY: 270,
        bubbles: true,
      });
    canvas.dispatchEvent(ev('pointermove'));
    canvas.dispatchEvent(ev('pointerdown'));
    g.step();
    canvas.dispatchEvent(ev('pointerup'));
    g.step();
    expect(selects).toHaveLength(1);
    expect(selects[0]!.target).toBe('floor');
    // The viewport is the design size, so client px are design px.
    expect(selects[0]!.x).toBeCloseTo(480, 3);
    expect(Math.abs(selects[0]!.y)).toBeCloseTo(270, 3);
  });
});

describe('touch replay through ctx.replay (ws/core-8)', () => {
  const zonesFor = (g: { ctx: EngineCtx<Action> }) =>
    createTouchZones(g.ctx.input, {
      zones: {
        move: {
          kind: 'stick',
          rect: (w, h) => ({ x: 0, y: h / 2, w: w / 2, h: h / 2 }),
          radius: 100,
          deadZone: 0,
        },
      },
      bindings: {
        left: { zone: 'move', axis: 'x', dir: -1 },
        right: { zone: 'move', axis: 'x', dir: 1 },
        up: { zone: 'move', axis: 'y', dir: -1 },
        down: { zone: 'move', axis: 'y', dir: 1 },
      },
    });

  /** Each frame's action values. */
  const sample = (g: { ctx: EngineCtx<Action> }) => {
    const i = g.ctx.input;
    return [i.value('left'), i.value('right'), i.value('up'), i.value('down')].join(',');
  };

  const touch = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      pointerId: 3,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
      bubbles: true,
    });

  /** A thumb lands bottom-left at frame 2, drags right and up for 8 frames, lifts at 12. */
  async function recordDrag(): Promise<{ rec: InputRecording; values: string[] }> {
    const g = await createTestGame<Action>({ input: { bindings, record: true } });
    zonesFor(g);
    const canvas = g.ctx.surface.canvas;
    const values: string[] = [];
    for (let f = 0; f < 16; f++) {
      if (f === 2) canvas.dispatchEvent(touch('pointerdown', 300, 800));
      if (f > 2 && f <= 10) canvas.dispatchEvent(touch('pointermove', 300 + f * 10, 800 - f * 6));
      if (f === 12) canvas.dispatchEvent(touch('pointerup', 400, 740));
      g.step();
      values.push(sample(g));
    }
    const rec = g.input.recorder?.stop();
    if (!rec) throw new Error('no recording');
    return { rec, values };
  }

  it('a recorded stick drag replays with the same action values frame for frame', async () => {
    const { rec, values } = await recordDrag();
    // The live drag moved the stick (bottom-left is inside the zone).
    expect(values.some((v) => v !== '0,0,0,0')).toBe(true);
    expect(values.at(-1)).toBe('0,0,0,0');

    const g = await createTestGame<Action>({ input: { bindings } });
    zonesFor(g);
    let ended = false;
    g.ctx.replay(rec, { onEnd: () => (ended = true) });
    const replayed: string[] = [];
    for (let f = 0; f < 16; f++) {
      g.step();
      replayed.push(sample(g));
    }
    expect(replayed).toEqual(values);
    g.step();
    expect(ended).toBe(true);
  });

  it('a live thumb on the screen never moves the replayed stick', async () => {
    const { rec, values } = await recordDrag();
    const g = await createTestGame<Action>({ input: { bindings } });
    zonesFor(g);
    g.ctx.replay(rec);
    const canvas = g.ctx.surface.canvas;
    const replayed: string[] = [];
    for (let f = 0; f < 16; f++) {
      if (f === 1) canvas.dispatchEvent(touch('pointerdown', 100, 1000));
      if (f === 4) canvas.dispatchEvent(touch('pointermove', 50, 1050));
      g.step();
      replayed.push(sample(g));
    }
    expect(replayed).toEqual(values);
  });
});
