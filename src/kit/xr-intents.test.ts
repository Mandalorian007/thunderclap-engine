// @vitest-environment happy-dom
/**
 * ws/xr-merge (C8): controllers and hands are the game's intents. An XR controller's trigger is
 * the `{ xr: 'trigger' }` binding of a `press` intent, aimed by its target ray; the squeeze a
 * second intent's. The same handlers keys and touches reach. Fake XR, fake GPU.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '../core/game';
import { createIntents, type IntentAim } from '../input/intents';
import type { BootResult } from '../platform';
import { mountSurface } from '../platform/surface';
import { type FakeXr, FakeXrInputSource, installFakeXr } from '../platform/xr-fake';
import { createFakeDevice, fakeRendererGpu, installGpuGlobals } from '../render/fake-gpu';

vi.mock('../platform/boot', () => ({
  boot: async (root: HTMLElement, opts: { logicalWidth?: number }): Promise<BootResult> => {
    installGpuGlobals();
    const fake = createFakeDevice();
    const surface = mountSurface(root, opts);
    return {
      ok: true,
      surface,
      gpu: { ...fakeRendererGpu(fake), adapter: {} as GPUAdapter, timestamps: false },
      onDeviceLost: () => () => {},
    };
  },
}));

let xr: FakeXr | null = null;
beforeEach(() => {
  document.body.innerHTML = '<div id="root" style="width:320px;height:180px"></div>';
});
afterEach(() => {
  xr?.uninstall();
  xr = null;
});

/** Step one XR frame `ms` later, with the loop's clock moved too so a fixed update runs. */
let ahead = 0;
function later(ms: number): void {
  const realNow = performance.now;
  ahead += ms;
  const t = realNow.call(performance) + ahead;
  performance.now = () => t;
  try {
    xr!.step(ms);
  } finally {
    performance.now = realNow;
  }
}

describe('XR controllers as intents (ws/xr-merge)', () => {
  it('the trigger fires a press intent aimed by the controller ray; the squeeze another', async () => {
    const root = document.getElementById('root') as HTMLElement;
    const ctx = await createGame({
      root,
      save: () => null,
      input: { bindings: { use: [{ xr: 'trigger' }], grab: [{ xr: 'squeeze' }] } },
      xr: { referenceSpace: 'local' },
    });
    if (!ctx) throw new Error('no ctx');
    const log: string[] = [];
    const aims: number[][] = [];
    const intents = createIntents(
      { use: { kind: 'press', actions: ['use'] }, grab: { kind: 'press', actions: ['grab'] } },
      {
        use: (aim: IntentAim) => {
          log.push('use');
          if (aim) aims.push([...aim.origin, ...aim.dir]);
        },
        grab: () => log.push('grab'),
      },
      { input: ctx.input, camera: ctx.camera, pointers: ctx.pointers },
    );
    ctx.hooks.update = () => intents.update();
    xr = installFakeXr();
    ctx.loop.start();
    await ctx.xr.enter();
    const right = new FakeXrInputSource('right', { standard: true });
    right.position = [0.2, 1.2, -0.1];
    xr.system.session.addInputSource(right);
    later(40);
    expect(log).toEqual([]);
    right.press(0, true);
    later(40);
    expect(log).toEqual(['use']);
    // Aimed down the controller's ray (from its place, along -z), not the view's centre.
    expect(aims[0]![0]).toBeCloseTo(0.2, 6);
    expect(aims[0]![1]).toBeCloseTo(1.2, 6);
    expect(aims[0]![5]).toBeCloseTo(-1, 6);
    later(40);
    expect(log).toEqual(['use']);
    right.press(0, false);
    right.press(1, true);
    later(40);
    expect(log).toEqual(['use', 'grab']);
    expect(ctx.input.lastDevice).toBe('xr');
  });
});
