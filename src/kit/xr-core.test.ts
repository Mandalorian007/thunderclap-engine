// @vitest-environment happy-dom
/**
 * ws/xr-merge (C8): XR sessions on the render core. Each eye is a core view, both eyes one union
 * cull group, so a frame in the headset is one cull dispatch and one prepare for the pair, then a
 * core pass per eye into its half of the layer. With `immediate: false` the renderer draws no
 * eye. Fake XR, fake GPU.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '../core/game';
import type { BootResult } from '../platform';
import { mountSurface } from '../platform/surface';
import { type FakeXr, installFakeXr } from '../platform/xr-fake';
import { Arena } from '../render/core/arena';
import { createRenderCore, type RenderCore } from '../render/core/core';
import { createInstanceLayout, createVertexLayout } from '../render/core/layout';
import {
  createFakeDevice,
  type FakeDevice,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';

let lastFake: FakeDevice | null = null;

vi.mock('../platform/boot', () => ({
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

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const PLACE = createInstanceLayout({
  stride: 16,
  attributes: [{ name: 'place', format: 'float32x4', offset: 0 }],
});
const SHADER = {
  code: '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.place); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
};

/** A GPU-culled set of `n` boxes in front of the fake head (it looks down -z from 0, 1.6, 0). */
function boxes(device: GPUDevice, n: number): RenderCore {
  const core = createRenderCore(device);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 20 });
  const instances = new Arena(device, { kind: 'instance', blockBytes: 1 << 20 });
  const set = core.createDrawSet({
    label: 'boxes',
    shader: SHADER,
    vertexLayout: PACKED,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 1024,
    kind: 'static',
    cull: 'gpu',
  });
  const box = vertices.alloc(24 * 8, 8);
  vertices.write(box, new Uint32Array(48));
  const place = new Float32Array([0, 0, 0, 1]);
  for (let i = 0; i < n; i++) {
    const inst = instances.alloc(16, 16);
    instances.write(inst, place);
    set.add({
      vertices: box,
      indexCount: 36,
      instances: inst,
      bounds: [(i % 16) * 2 - 16, 1, -4 - Math.floor(i / 16) * 2, 0.9],
    });
  }
  return core;
}

async function game(immediate: boolean, n = 300) {
  const root = document.getElementById('root') as HTMLElement;
  const ctx = await createGame({
    root,
    save: () => null,
    input: { bindings: { go: [{ key: 'Space' }] } },
    xr: { referenceSpace: 'local' },
  });
  if (!ctx) throw new Error('no ctx');
  const fake = lastFake!;
  // The core is made on the game's device, after `createGame`.
  const core = n > 0 ? boxes(ctx.gpu.device, n) : null;
  if (core) ctx.xr.setCore(core, { immediate });
  return { ctx, fake, core: core! };
}

describe('XR on the render core (ws/xr-merge)', () => {
  it('each eye is a core view of the XRView; both eyes are one union group', async () => {
    const { ctx } = await game(true, 0);
    xr = installFakeXr({ ipd: 0.064 });
    ctx.loop.start();
    await ctx.xr.enter();
    xr.step(1000 / 72);
    const surface = ctx.xr.surface!;
    const views = surface.group.views;
    expect(surface.group.planes).toBe('union');
    expect(views).toHaveLength(2);
    expect(views[0]!.eye![0]).toBeCloseTo(-0.032, 6);
    expect(views[1]!.eye![0]).toBeCloseTo(0.032, 6);
    expect(views[0]!.eye![1]).toBeCloseTo(1.6, 6);
    // The planes are the eye's own view-projection's: a point straight ahead is inside.
    const p = views[0]!.planes;
    for (let i = 0; i < 24; i += 4) {
      expect(p[i]! * -0.032 + p[i + 1]! * 1.6 + p[i + 2]! * -5 + p[i + 3]!).toBeGreaterThan(0);
    }
  });

  it('immediate off: one cull dispatch for both eyes, a core pass per eye, no scene pass', async () => {
    const g = await game(false);
    const core2 = g.core;
    expect(g.ctx.xr.core).toBe(core2);
    // The fake records pass descriptors by reference (the core reuses its): read the targets.
    const clears: (GPUColor | undefined)[] = [];
    const draw = core2.draw.bind(core2);
    core2.draw = (enc, i, t) => {
      clears.push(t.clear);
      draw(enc, i, t);
    };
    xr = installFakeXr({ eyeWidth: 64, eyeHeight: 32 });
    g.ctx.loop.start();
    await g.ctx.xr.enter();
    const before = g.fake.passes.length;
    for (let f = 0; f < 3; f++) {
      xr.step(1000 / 72);
      expect(core2.stats.dispatches).toBe(1);
    }
    const passes = g.fake.passes.slice(before);
    expect(passes.filter((p) => p.label === 'scene')).toHaveLength(0);
    const corePasses = passes.filter((p) => p.label === 'core pass');
    expect(corePasses).toHaveLength(6);
    expect(passes.filter((p) => p.label === 'core cull')).toHaveLength(3);
    // The first eye clears the shared side-by-side layer; the second loads it.
    expect(clears.slice(0, 2)).toEqual([{ r: 0, g: 0, b: 0, a: 1 }, undefined]);
    // Each eye into its half (viewport x 0 and 64).
    const vp = (i: number) => {
      const c = corePasses[i]!.commands.find((c) => c.op === 'other' && c.name === 'setViewport');
      return c && c.op === 'other' ? c.args?.[0] : undefined;
    };
    expect(vp(0)).toBe(0);
    expect(vp(1)).toBe(64);
    expect(g.fake.errors).toEqual([]);
  });

  it('immediate on: the renderer draws and resolves each eye, then the core draws over it', async () => {
    const g = await game(true);
    const core = g.core;
    xr = installFakeXr();
    g.ctx.loop.start();
    await g.ctx.xr.enter();
    const before = g.fake.passes.length;
    xr.step(1000 / 72);
    const passes = g.fake.passes.slice(before);
    expect(passes.filter((p) => p.label === 'scene')).toHaveLength(2);
    expect(core.stats.dispatches).toBe(1);
    const corePasses = passes.filter((p) => p.label === 'core pass');
    expect(corePasses).toHaveLength(2);
    // Over the resolved eyes: both load.
    for (const p of corePasses) {
      const att = (p.desc as GPURenderPassDescriptor)
        .colorAttachments as GPURenderPassColorAttachment[];
      expect(att[0]!.loadOp).toBe('load');
    }
    expect(g.ctx.xr.surface!.coreClear).toBe(null);
    // The core's passes come after the renderer's last pass of the frame.
    const lastScene = passes.map((p) => p.label).lastIndexOf('scene');
    expect(passes.findIndex((p) => p.label === 'core pass')).toBeGreaterThan(lastScene);
  });

  it('without a core (or after setCore(null)) nothing extra is drawn', async () => {
    const g = await game(true);
    g.ctx.xr.setCore(null);
    expect(g.ctx.xr.core).toBe(null);
    xr = installFakeXr();
    g.ctx.loop.start();
    await g.ctx.xr.enter();
    const before = g.fake.passes.length;
    xr.step(1000 / 72);
    const passes = g.fake.passes.slice(before);
    expect(passes.filter((p) => p.label?.startsWith('core'))).toHaveLength(0);
  });
});
