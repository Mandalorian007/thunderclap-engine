// @vitest-environment happy-dom
/**
 * ws/render-11: `createGame({ aux })` in XR. The surface gets the game's aux set, so each eye's
 * scene pass (into the surface's HDR scene target) has the aux attachments the game asked for,
 * every scene-pass pipeline matches it, and the fake GPU records no error. Fake XR, fake GPU.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CreateGameOptions, createGame } from '../core/game';
import {
  createFakeDevice,
  type FakeDevice,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';
import type { SceneTargetAux } from '../render/scene-target';
import type { BootResult } from '.';
import { mountSurface } from './surface';
import { type FakeXr, installFakeXr } from './xr-fake';

let lastFake: FakeDevice | null = null;

vi.mock('./boot', () => ({
  boot: async (root: HTMLElement, opts: { logicalWidth?: number }): Promise<BootResult> => {
    installGpuGlobals();
    const fake = createFakeDevice();
    lastFake = fake;
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

function options(aux: SceneTargetAux): CreateGameOptions<'go', null> {
  return {
    root: document.getElementById('root') as HTMLElement,
    save: () => null,
    input: { bindings: { go: [{ key: 'Space' }] } },
    xr: { referenceSpace: 'local' },
    aux,
  };
}

describe('createGame({ aux }) in XR (ws/render-11)', () => {
  const cases: [string, SceneTargetAux, number][] = [
    ['velocity', { velocity: true }, 3],
    ['rough-metal + velocity', { roughMetal: true, velocity: true }, 4],
  ];
  for (const [name, aux, n] of cases) {
    it(`${name}: both eyes' scene passes have ${n} attachments, no GPU error`, async () => {
      const ctx = await createGame(options(aux));
      if (!ctx) throw new Error('no ctx');
      const fake = lastFake!;
      xr = installFakeXr();
      ctx.loop.start();
      await ctx.xr.enter();
      const surface = ctx.xr.surface!;
      const before = fake.passes.length;
      xr.step(1000 / 72);
      xr.step(1000 / 72);
      const scene = fake.passes.slice(before).filter((p) => p.label === 'scene');
      expect(scene).toHaveLength(4);
      for (const p of scene) {
        const att = (p.desc as GPURenderPassDescriptor)
          .colorAttachments as GPURenderPassColorAttachment[];
        expect(att).toHaveLength(n);
        for (const c of p.commands) {
          if (c.op !== 'setPipeline') continue;
          const pl = c.pipeline as { desc: GPURenderPipelineDescriptor };
          expect(pl.desc.fragment!.targets).toHaveLength(n);
        }
      }
      expect(surface.scene!.auxKey).toBe(ctx.renderer.target.auxKey);
      expect(fake.errors).toEqual([]);
      await ctx.xr.exit();
    });
  }
});
