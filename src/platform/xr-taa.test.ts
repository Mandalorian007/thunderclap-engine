// @vitest-environment happy-dom
/**
 * ws/xr-taa: TAA in XR scene mode keeps one history per eye. `createGame({ xr })` renders each
 * eye into the surface's HDR `scene` target and resolves it into that eye's viewport of the
 * layer, one eye after the other on one encoder. Each eye's TAA resolve reads and writes its
 * own history pair (keyed by the eye's viewport), so the right eye never reprojects the left
 * eye's last frame, and reads its own uniform block (reprojection, jitter) at submit. Fake XR,
 * fake GPU.
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
    post: { taa: { enabled: true } },
  };
}

const TAA = 'pass:post-taa';

/** The label of the texture behind a view. */
const texLabel = (view: unknown): string =>
  (view as { texture?: { label?: string } }).texture?.label ?? '';

interface TaaIo {
  write: string;
  read: string;
}

/**
 * Record each TAA pass's history target (attachment 0) as the pass begins (the pass reuses its
 * descriptor, so it must be read then) and, once the frame is done, the history it reads
 * (`@binding(5)`).
 */
function watchTaa(fake: FakeDevice): (run: () => void) => TaaIo[] {
  const writes = new Map<FakePass, string>();
  const push = fake.passes.push.bind(fake.passes);
  fake.passes.push = (...ps: FakePass[]) => {
    for (const p of ps) {
      if (p.label !== TAA) continue;
      const att = (p.desc as GPURenderPassDescriptor)
        .colorAttachments as GPURenderPassColorAttachment[];
      writes.set(p, texLabel(att[0]!.view));
    }
    return push(...ps);
  };
  return (run) => {
    const before = fake.passes.length;
    run();
    return fake.passes
      .slice(before)
      .filter((p) => p.label === TAA)
      .map((p) => {
        const bind = p.commands.find((c) => c.op === 'setBindGroup') as
          | { group: unknown }
          | undefined;
        const entries =
          (bind?.group as { entries: GPUBindGroupEntry[] } | undefined)?.entries ?? [];
        return {
          write: writes.get(p) ?? '',
          read: texLabel(entries.find((e) => e.binding === 5)?.resource),
        };
      });
  };
}

async function enter() {
  const ctx = await createGame(options());
  if (!ctx) throw new Error('no ctx');
  const fake = lastFake!;
  xr = installFakeXr();
  ctx.loop.start();
  await ctx.xr.enter();
  return { ctx, fake, xr };
}

describe('XR scene mode: TAA keeps one history per eye (ws/xr-taa)', () => {
  it('each eye’s TAA pass reads the history that eye wrote last frame', async () => {
    const { ctx, fake, xr } = await enter();
    xr.step(1000 / 72);
    xr.step(1000 / 72);
    const frame = watchTaa(fake);
    const frames: TaaIo[][] = [];
    for (let i = 0; i < 3; i++) frames.push(frame(() => xr.step(1000 / 72)));
    expect(ctx.post.taaActive).toBe(true);
    for (const f of frames) {
      expect(f).toHaveLength(2);
      const [left, right] = f as [TaaIo, TaaIo];
      // Each eye ping-pongs its own pair: it reads one and writes the other.
      expect(left.read).not.toBe(left.write);
      expect(right.read).not.toBe(right.write);
      // The eyes share no history texture.
      expect([right.read, right.write]).not.toContain(left.read);
      expect([right.read, right.write]).not.toContain(left.write);
    }
    // Next frame each eye reads what it wrote this frame.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]![0]!.read).toBe(frames[i - 1]![0]!.write);
      expect(frames[i]![1]!.read).toBe(frames[i - 1]![1]!.write);
    }
    // The first slot keeps the screen labels; the second eye's are tagged.
    expect(frames[0]![0]!.write).toMatch(/^post-taa-history-[01]$/);
    expect(frames[0]![1]!.write).toMatch(/^post-taa-history-[01]-v1$/);
    expect(fake.errors).toEqual([]);
    await ctx.xr.exit();
  });

  it('steady state makes no textures or bind groups, and each eye reset its history once', async () => {
    const { ctx, fake, xr } = await enter();
    xr.step(1000 / 72);
    xr.step(1000 / 72);
    xr.step(1000 / 72);
    const resets = ctx.post.historyResets;
    const textures = fake.textures.length;
    const groups = fake.bindGroups.length;
    for (let i = 0; i < 4; i++) xr.step(1000 / 72);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);
    expect(ctx.post.historyResets).toBe(resets);
    // Two eyes, two histories, each reset on its first resolve.
    expect(resets).toBe(2);
    const hist = fake.textures.filter((t) => (t.label ?? '').startsWith('post-taa-history'));
    expect(hist).toHaveLength(4);
    expect(fake.errors).toEqual([]);
    await ctx.xr.exit();
  });

  it('each eye’s TAA pass reads that eye’s uniform block at submit, not the last eye’s', async () => {
    const { ctx, fake, xr } = await enter();
    const session = xr.system.session as unknown as { opts: { ipd: number } };
    xr.step(1000 / 72);
    xr.step(1000 / 72);
    // Widen the eyes between frames: each eye moves its own way, so their reprojections differ.
    session.opts.ipd = 0.2;

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
    const taaBuffer = (): FakeBuffer => fake.buffers.find((b) => b.label === `${TAA}-uniforms`)!;
    const seen: Float32Array[] = [];
    fake.runPass = (p: FakePass) => {
      if (p.label !== TAA) return;
      seen.push(new Float32Array(taaBuffer().data.slice().buffer, 0, packed[0]!.length));
    };
    xr.step(1000 / 72);
    fake.runPass = null;

    expect(packed).toHaveLength(2);
    expect(Array.from(packed[0]!)).not.toEqual(Array.from(packed[1]!));
    expect(seen).toHaveLength(2);
    expect(Array.from(seen[0]!)).toEqual(Array.from(packed[0]!));
    expect(Array.from(seen[1]!)).toEqual(Array.from(packed[1]!));
    expect(fake.errors).toEqual([]);
    await ctx.xr.exit();
  });
});
