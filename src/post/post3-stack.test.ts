/**
 * `PostStack` post 3 (ws/post-3) on the fake GPU: every new pass is off by default and free
 * while off (a 2D frame records the same passes and allocates nothing), each runs in the
 * documented order with depth, TAA ping-pongs its history without new groups once warm,
 * motion blur replaces the composite's scene colour, auto-exposure adds the compute passes,
 * and a null dirt texture leaves the composite's group alone.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import {
  createFakeDevice,
  type FakeDevice,
  type FakePass,
  fakeRendererGpu,
} from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { createLensDirtTexture } from './lens-dirt';
import { PostStack } from './post-stack';

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(800, 450);
  const post = new PostStack(r);
  r.post = post;
  return { fake, r, post };
}

const labels = (fake: FakeDevice, from: number) =>
  fake.passes.slice(from).map((p) => (p.label ?? '').replace(/^pass:/, ''));
const count = (list: string[], label: string) => list.filter((l) => l === label).length;
const flat = (r: Renderer, t = 0) => {
  r.beginFrame(t, 1 / 60);
  r.endFrame();
};
const deep = (r: Renderer, t = 0) => {
  const f = r.beginFrame(t, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  r.render(f, Camera.perspective(1, 16 / 9, 0.1, 100));
  r.endFrame();
};
const attachment = (p: FakePass) =>
  ((p.desc as GPURenderPassDescriptor).colorAttachments as GPURenderPassColorAttachment[])[0]!;
const targetLabel = (p: FakePass) =>
  (attachment(p).view as unknown as { texture: { label: string } }).texture.label;
const groupViews = (fake: FakeDevice, p: FakePass): string[] => {
  const set = p.commands.find((c) => c.op === 'setBindGroup') as { group: unknown } | undefined;
  const g = fake.bindGroups.find((b) => b === set?.group) as
    | { entries: { resource: unknown }[] }
    | undefined;
  return (g?.entries ?? [])
    .map((e) => (e.resource as { texture?: { label: string } }).texture?.label ?? '')
    .filter((l) => l !== '');
};

describe('PostStack post 3 (ws/post-3)', () => {
  it('every new section is off by default and free while off, on a 2D frame and a 3D one', () => {
    const { fake, r, post } = setup();
    flat(r);
    flat(r);
    let from = fake.passes.length;
    flat(r);
    const flatBefore = labels(fake, from);
    let textures = fake.textures.length;
    let groups = fake.bindGroups.length;
    // Sections that do nothing until enabled, plus white balance which is in the composite,
    // plus the depth-only passes, which a 2D frame cannot run.
    post.set({
      whiteBalance: { temperature: 3200, tint: 0.2 },
      exposure: { keyValue: 0.3 },
      taa: { enabled: true },
      ssr: { enabled: true },
      motionBlur: { enabled: true },
    });
    from = fake.passes.length;
    flat(r);
    expect(labels(fake, from)).toEqual(flatBefore);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);
    expect(post.taaActive).toBe(false);
    expect(post.ssrActive).toBe(false);
    expect(post.historyResets).toBe(0);
    expect(post.exposure).toBe(0);
    // On a depth frame, with every post-3 section off: the same passes as before, no allocs.
    post.set({ taa: { enabled: false }, ssr: { enabled: false }, motionBlur: { enabled: false } });
    deep(r);
    deep(r);
    from = fake.passes.length;
    deep(r);
    const deepBefore = labels(fake, from);
    textures = fake.textures.length;
    groups = fake.bindGroups.length;
    from = fake.passes.length;
    deep(r);
    expect(labels(fake, from)).toEqual(deepBefore);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);
    expect(post.taaActive).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  it('runs the passes in the documented order on a depth frame', () => {
    const { fake, r, post } = setup();
    post.set({
      ao: { enabled: true },
      dof: { enabled: true },
      outline: { enabled: true },
      taa: { enabled: true },
      ssr: { enabled: true },
      motionBlur: { enabled: true },
      exposure: { mode: 'auto' },
      godRays: { enabled: true },
      fxaa: { enabled: true },
    });
    deep(r);
    const from = fake.passes.length;
    deep(r, 1 / 60);
    const list = labels(fake, from).filter((l) => l.startsWith('post-'));
    const order = [
      'post-outline',
      'post-ao',
      'post-ao-blur',
      'post-taa',
      'post-motion-blur',
      'post-dof',
      'post-ssr',
      'post-exposure-histogram',
      'post-exposure-average',
      'post-bloom-prefilter',
      'post-bloom-down',
      'post-bloom-up',
      'post-godrays',
      'post-composite',
    ];
    let at = -1;
    for (const label of order) {
      const i = list.indexOf(label);
      expect(i, label).toBeGreaterThan(at);
      at = i;
    }
    // TAA replaces FXAA.
    expect(count(list, 'post-fxaa')).toBe(0);
    expect(post.taaActive).toBe(true);
    expect(post.ssrActive).toBe(true);
    expect(post.motionBlurActive).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('TAA: two histories, ping-pong without new groups once warm, reset on first frame and resize', () => {
    const { fake, r, post } = setup();
    post.set({ taa: { enabled: true } });
    let from = fake.passes.length;
    deep(r);
    expect(post.historyResets).toBe(1);
    const first = fake.passes.slice(from).find((p) => p.label === 'pass:post-taa')!;
    expect(targetLabel(first)).toBe('post-taa-history-1');
    expect(fake.textures.filter((t) => (t.label ?? '').startsWith('post-taa-history')).length).toBe(
      2,
    );
    // The composite reads the resolve, not the raw colour.
    const comp = fake.passes.slice(from).find((p) => p.label === 'pass:post-composite')!;
    expect(groupViews(fake, comp)[0]).toBe('post-taa-history-1');
    // (The pass descriptor is reused per encode, so read each frame's target right away.)
    const taaPass = (at: number) => fake.passes.slice(at).find((p) => p.label === 'pass:post-taa')!;
    from = fake.passes.length;
    deep(r, 1 / 60);
    expect(targetLabel(taaPass(from))).toBe('post-taa-history-0');
    expect(groupViews(fake, taaPass(from))).toContain('post-taa-history-1');
    from = fake.passes.length;
    deep(r, 2 / 60);
    expect(targetLabel(taaPass(from))).toBe('post-taa-history-1');
    expect(groupViews(fake, taaPass(from))).toContain('post-taa-history-0');
    expect(post.historyResets).toBe(1);
    // Warm: no new groups or textures over a cycle.
    const groups = fake.bindGroups.length;
    const textures = fake.textures.length;
    for (let i = 3; i < 8; i++) deep(r, i / 60);
    expect(fake.bindGroups.length).toBe(groups);
    expect(fake.textures.length).toBe(textures);
    // A resize resets the history.
    r.resize(640, 360);
    deep(r, 9 / 60);
    expect(post.historyResets).toBe(2);
    // Turning it off brings FXAA back and resets on re-enable.
    post.set({ taa: { enabled: false }, fxaa: { enabled: true } });
    from = fake.passes.length;
    deep(r, 10 / 60);
    expect(count(labels(fake, from), 'post-fxaa')).toBe(1);
    expect(count(labels(fake, from), 'post-taa')).toBe(0);
    post.set({ taa: { enabled: true } });
    from = fake.passes.length;
    deep(r, 11 / 60);
    expect(count(labels(fake, from), 'post-fxaa')).toBe(0);
    expect(post.historyResets).toBe(3);
    expect(fake.errors).toEqual([]);
  });

  it('motion blur and SSR allocate once; SSR is half-res and the composite binds it', () => {
    const { fake, r, post } = setup();
    post.set({ ssr: { enabled: true }, motionBlur: { enabled: true } });
    deep(r);
    const ssr = fake.textures.filter((t) => t.label === 'post-ssr');
    expect(ssr.length).toBe(1);
    expect([ssr[0]!.width, ssr[0]!.height]).toEqual([400, 225]);
    const mb = fake.textures.filter((t) => t.label === 'post-motion-blur');
    expect(mb.length).toBe(1);
    expect([mb[0]!.width, mb[0]!.height]).toEqual([800, 450]);
    deep(r, 1 / 60);
    const from = fake.passes.length;
    const textures = fake.textures.length;
    const groups = fake.bindGroups.length;
    deep(r, 2 / 60);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);
    const comp = fake.passes.slice(from).find((p) => p.label === 'pass:post-composite')!;
    const views = groupViews(fake, comp);
    expect(views[0]).toBe('post-motion-blur');
    expect(views).toContain('post-ssr');
    // The low tier turns both off again.
    post.setQuality({ ssr: false, motionBlur: false });
    const after = fake.passes.length;
    deep(r, 3 / 60);
    expect(count(labels(fake, after), 'post-ssr')).toBe(0);
    expect(count(labels(fake, after), 'post-motion-blur')).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('auto exposure adds the compute passes on any frame and reports the EV', () => {
    const { fake, r, post } = setup();
    post.set({ grade: { exposure: 2 } });
    flat(r);
    expect(post.exposure).toBe(1);
    post.set({ exposure: { mode: 'auto' } });
    let from = fake.passes.length;
    flat(r, 1 / 60);
    const list = labels(fake, from);
    expect(count(list, 'post-exposure-histogram')).toBe(1);
    expect(count(list, 'post-exposure-average')).toBe(1);
    expect(list.indexOf('post-exposure-average')).toBeLessThan(
      list.indexOf('post-bloom-prefilter'),
    );
    // No readback lands on the fake device: the EV holds at its last value.
    flat(r, 2 / 60);
    expect(post.exposure).toBe(1);
    post.setQuality({ autoExposure: false });
    from = fake.passes.length;
    flat(r, 3 / 60);
    expect(count(labels(fake, from), 'post-exposure-histogram')).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('lens dirt: a null texture leaves the composite group alone; a texture rebinds it once', () => {
    const { fake, r, post } = setup();
    flat(r);
    flat(r);
    const groups = fake.bindGroups.length;
    post.set({ bloom: { dirt: { texture: null, intensity: 1 } } });
    flat(r);
    expect(fake.bindGroups.length).toBe(groups);
    const dirt = createLensDirtTexture(fake.device, 16, 1);
    post.settings.bloom.dirt = { texture: dirt, intensity: 1 };
    const from = fake.passes.length;
    flat(r);
    expect(fake.bindGroups.length).toBeGreaterThan(groups);
    const comp = fake.passes.slice(from).find((p) => p.label === 'pass:post-composite')!;
    expect(groupViews(fake, comp)).toContain('post-lens-dirt');
    const after = fake.bindGroups.length;
    flat(r);
    expect(fake.bindGroups.length).toBe(after);
    expect(fake.errors).toEqual([]);
  });
});
