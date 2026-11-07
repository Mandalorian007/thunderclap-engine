// @vitest-environment happy-dom
/**
 * ws/render-12: XR scene mode carries aux through post, per eye. `createGame({ aux, xr })`
 * renders each eye into the surface's HDR `scene` target and resolves it at once, so the post
 * stack reads the eye's own velocity (the target's attachment, written by that eye's scene pass
 * just before) and, since ws/render-12, its own uniform block (reprojection, jitter): a block
 * staged per eye and copied on the encoder, not one `writeBuffer` the last eye overwrites.
 * Object motion blur on, fake XR, fake GPU.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CreateGameOptions, createGame } from '../core/game';
import {
  createFakeDevice,
  type FakeBuffer,
  type FakeDevice,
  type FakePass,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';
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

function options(): CreateGameOptions<'go', null> {
  return {
    root: document.getElementById('root') as HTMLElement,
    save: () => null,
    input: { bindings: { go: [{ key: 'Space' }] } },
    xr: { referenceSpace: 'local' },
    aux: { velocity: true },
    post: { motionBlur: { enabled: true, mode: 'object' } },
  };
}

const MOTION_BLUR = 'pass:post-motion-blur';

function viewOf(group: unknown, binding: number): unknown {
  const g = group as { entries: GPUBindGroupEntry[] };
  return g.entries.find((e) => e.binding === binding)?.resource;
}

describe('XR scene mode: post reads each eye’s aux (ws/render-12)', () => {
  it('each eye’s motion blur reads the scene velocity right after that eye’s scene pass', async () => {
    const ctx = await createGame(options());
    if (!ctx) throw new Error('no ctx');
    const fake = lastFake!;
    xr = installFakeXr();
    ctx.loop.start();
    await ctx.xr.enter();
    xr.step(1000 / 72);
    const before = fake.passes.length;
    xr.step(1000 / 72);
    const surface = ctx.xr.surface!;
    const scene = surface.scene!;
    expect(scene.velocity).not.toBeNull();
    // Both eyes render into `scene`; its velocity is what each eye wrote.
    const frame = fake.passes.slice(before);
    const order = frame
      .filter((p) => p.label === 'scene' || p.label === MOTION_BLUR)
      .map((p) => p.label);
    expect(order).toEqual(['scene', MOTION_BLUR, 'scene', MOTION_BLUR]);
    for (const p of frame.filter((q) => q.label === 'scene')) {
      const att = (p.desc as GPURenderPassDescriptor)
        .colorAttachments as GPURenderPassColorAttachment[];
      expect(att).toHaveLength(3);
      expect(att[2]!.view).toBe(scene.velocity!.view);
    }
    for (const p of frame.filter((q) => q.label === MOTION_BLUR)) {
      const bind = p.commands.find((c) => c.op === 'setBindGroup');
      expect(bind).toBeDefined();
      // @binding(5): the object velocity, the scene target's attachment.
      expect(viewOf((bind as { group: unknown }).group, 5)).toBe(scene.velocity!.view);
    }
    expect(ctx.post.motionBlurActive).toBe(true);
    expect(fake.errors).toEqual([]);
    await ctx.xr.exit();
  });

  it('each eye’s passes read that eye’s uniform block at submit, not the last eye’s', async () => {
    const ctx = await createGame(options());
    if (!ctx) throw new Error('no ctx');
    const fake = lastFake!;
    xr = installFakeXr();
    ctx.loop.start();
    await ctx.xr.enter();
    const session = xr.system.session as unknown as { opts: { ipd: number } };
    xr.step(1000 / 72);
    xr.step(1000 / 72);
    // Widen the eyes between frames: each eye moves its own way, so their reprojections differ.
    session.opts.ipd = 0.2;

    // What the stack packed for each eye, captured as each eye's encode ends.
    const post = ctx.post as unknown as {
      uniforms: Float32Array;
      encode: (...a: unknown[]) => void;
    };
    const packed: Float32Array[] = [];
    const encode = post.encode.bind(post);
    post.encode = (...a: unknown[]) => {
      encode(...a);
      packed.push(post.uniforms.slice());
    };
    // What the motion-blur pass's buffer holds when the pass runs (in submit order).
    const mbBuffer = (): FakeBuffer =>
      fake.buffers.find((b) => b.label === `${MOTION_BLUR}-uniforms`)!;
    const seen: Float32Array[] = [];
    fake.runPass = (p: FakePass) => {
      if (p.label !== MOTION_BLUR) return;
      const b = mbBuffer();
      seen.push(new Float32Array(b.data.slice().buffer, 0, packed[0]!.length));
    };
    const eyeBuffers = fake.buffers.filter((b) => b.label === 'post-eye-uniforms').length;
    xr.step(1000 / 72);
    fake.runPass = null;

    expect(packed).toHaveLength(2);
    expect(Array.from(packed[0]!)).not.toEqual(Array.from(packed[1]!));
    expect(seen).toHaveLength(2);
    expect(Array.from(seen[0]!)).toEqual(Array.from(packed[0]!));
    expect(Array.from(seen[1]!)).toEqual(Array.from(packed[1]!));
    // One staging ring, made on the first eye; steady state makes none.
    expect(eyeBuffers).toBe(1);
    expect(fake.buffers.filter((b) => b.label === 'post-eye-uniforms')).toHaveLength(1);
    expect(fake.errors).toEqual([]);
    await ctx.xr.exit();
  });
});
