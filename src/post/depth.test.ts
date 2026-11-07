/**
 * The depth passes (ws/post-depth) on the fake GPU: off by default and absent without depth, so
 * every frame the 2D path records is unchanged; with a depth camera and the setting on, AO adds
 * two half-res passes and DoF one, allocated on the first frame that needs them only.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { easeLinear, PostBlender } from './blend';
import { PostStack } from './post-stack';
import {
  cinematicPostSettings,
  defaultPostQuality,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(800, 450);
  const post = new PostStack(r);
  r.post = post;
  return { fake, r, post };
}

function labels(fake: FakeDevice, from: number): string[] {
  return fake.passes.slice(from).map((p) => p.label ?? '');
}

function count(list: string[], label: string): number {
  return list.filter((l) => l === `pass:${label}`).length;
}

function flat(r: Renderer): void {
  r.beginFrame(0, 1 / 60);
  r.endFrame();
}

function deep(r: Renderer, cam = Camera.perspective(1, 16 / 9, 0.1, 100)): void {
  const f = r.beginFrame(0, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  r.render(f, cam);
  r.endFrame();
}

describe('AO and DoF settings', () => {
  it('default to off with the brief values; quality gains the sample counts', () => {
    const s = cinematicPostSettings();
    expect(s.ao).toEqual({ enabled: false, radius: 0.5, intensity: 1, bias: 0.02, power: 1.5 });
    expect(s.dof).toEqual({
      enabled: false,
      focusDistance: 10,
      focusRange: 6,
      maxBlur: 8,
      nearBlur: true,
    });
    expect(defaultPostQuality()).toMatchObject({ aoSamples: 12, dofTaps: 24 });
  });

  it('blend: numbers ease, enabled and nearBlur switch at the end', () => {
    const s = cinematicPostSettings();
    s.ao.enabled = true;
    s.dof.enabled = true;
    const b = new PostBlender();
    b.blendTo(
      s,
      {
        ao: { enabled: false, intensity: 0, radius: 1.5 },
        dof: { enabled: false, maxBlur: 0, nearBlur: false },
      },
      1,
      easeLinear,
    );
    b.advance(s, 0.5);
    expect(s.ao.enabled).toBe(true);
    expect(s.ao.intensity).toBeCloseTo(0.5);
    expect(s.ao.radius).toBeCloseTo(1);
    expect(s.dof.enabled).toBe(true);
    expect(s.dof.nearBlur).toBe(true);
    expect(s.dof.maxBlur).toBeCloseTo(4);
    b.advance(s, 0.5);
    expect(s.ao).toMatchObject({ enabled: false, intensity: 0, radius: 1.5 });
    expect(s.dof).toMatchObject({ enabled: false, maxBlur: 0, nearBlur: false });
    expect(b.active).toBe(false);
  });

  it('packs the passes off without depth even when enabled, on with it', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = cinematicPostSettings();
    s.ao.enabled = true;
    s.dof.enabled = true;
    const q = defaultPostQuality();
    packPostUniforms(out, s, 0, 100, 100, 100, 100, q, null);
    expect([out[72], out[80]]).toEqual([0, 0]);
    expect(Array.from(out.subarray(88, 104))).toEqual(new Array(16).fill(0));
    const invProj = new Float32Array(16).map((_, i) => i + 1);
    packPostUniforms(out, s, 0, 100, 100, 100, 100, q, {
      near: 0.1,
      far: 50,
      invProj,
      projX: 2,
      projY: 3,
      outputWidth: 200,
    });
    expect(Array.from(out.subarray(72, 76))).toEqual([1, 0.5, 1, Math.fround(0.02)]);
    expect(Array.from(out.subarray(76, 80))).toEqual([1.5, 12, 2, 3]);
    expect(Array.from(out.subarray(80, 84))).toEqual([1, 10, 6, Math.fround(8 / 200)]);
    expect(Array.from(out.subarray(84, 88))).toEqual([1, 24, Math.fround(0.1), 50]);
    expect(Array.from(out.subarray(88, 104))).toEqual(Array.from(invProj));
  });
});

describe('PostStack depth passes', () => {
  it('a frame without depth records the same passes whether or not they are enabled', () => {
    const { fake, r, post } = setup();
    let from = fake.passes.length;
    flat(r);
    const before = labels(fake, from);
    expect(count(before, 'post-composite')).toBe(1);
    post.set({ ao: { enabled: true }, dof: { enabled: true } });
    from = fake.passes.length;
    flat(r);
    expect(labels(fake, from)).toEqual(before);
    expect(fake.textures.some((t) => t.label?.startsWith('post-ao'))).toBe(false);
    expect(fake.textures.some((t) => t.label === 'post-dof')).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  it('a depth frame adds the AO passes with ao.enabled and the DoF pass with dof.enabled', () => {
    const { fake, r, post } = setup();
    let from = fake.passes.length;
    deep(r);
    const plain = labels(fake, from);
    expect(count(plain, 'post-ao')).toBe(0);
    expect(count(plain, 'post-dof')).toBe(0);

    post.set({ ao: { enabled: true } });
    from = fake.passes.length;
    deep(r);
    let l = labels(fake, from);
    expect(count(l, 'post-ao')).toBe(1);
    expect(count(l, 'post-ao-blur')).toBe(1);
    expect(count(l, 'post-dof')).toBe(0);
    expect(l.length).toBe(plain.length + 2);
    // AO runs before the composite, on its own half-res targets.
    expect(l.indexOf('pass:post-ao-blur')).toBeLessThan(l.indexOf('pass:post-composite'));
    const ao = fake.textures.filter((t) => t.label === 'post-ao');
    expect(ao.length).toBe(1);
    expect([ao[0]!.width, ao[0]!.height]).toEqual([400, 225]);

    post.set({ dof: { enabled: true } });
    from = fake.passes.length;
    deep(r);
    l = labels(fake, from);
    expect(count(l, 'post-dof')).toBe(1);
    expect(l.length).toBe(plain.length + 3);
    expect(fake.textures.filter((t) => t.label === 'post-dof').length).toBe(1);

    // Steady state allocates nothing.
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    deep(r);
    const n = counts();
    deep(r);
    deep(r);
    expect(counts()).toEqual(n);

    // Off again: the passes go, the composite stays.
    post.set({ ao: { enabled: false }, dof: { enabled: false } });
    from = fake.passes.length;
    deep(r);
    expect(labels(fake, from)).toEqual(plain);
    expect(fake.errors).toEqual([]);
  });

  it('resize reallocates the depth targets only when a pass needs them', () => {
    const { fake, r, post } = setup();
    deep(r);
    r.resize(400, 300);
    deep(r);
    expect(fake.textures.filter((t) => t.label === 'post-ao').length).toBe(0);

    post.set({ ao: { enabled: true } });
    deep(r);
    const ao = () => fake.textures.filter((t) => t.label === 'post-ao');
    expect(ao().length).toBe(1);
    expect([ao()[0]!.width, ao()[0]!.height]).toEqual([200, 150]);
    r.resize(1000, 500);
    deep(r);
    expect(ao().length).toBe(2);
    expect(ao()[0]!.destroyed).toBe(true);
    expect([ao()[1]!.width, ao()[1]!.height]).toEqual([500, 250]);
    // DoF was never on: never allocated through the resizes.
    expect(fake.textures.filter((t) => t.label === 'post-dof').length).toBe(0);

    // Off, then resize: nothing new.
    post.set({ ao: { enabled: false } });
    r.resize(600, 300);
    deep(r);
    deep(r);
    expect(ao().length).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('binds the depth as a depth texture and rebinds when the depth view changes', () => {
    const { fake, r, post } = setup();
    post.set({ ao: { enabled: true }, dof: { enabled: true } });
    deep(r);
    const groups = fake.bindGroups.filter((g) => g.label === 'pass:post-ao');
    expect(groups.length).toBe(1);
    const depthEntry = groups[0]!.layout.entries.find((e) => e.binding === 3);
    expect(depthEntry?.texture?.sampleType).toBe('depth');
    const n = fake.bindGroups.length;
    deep(r);
    expect(fake.bindGroups.length).toBe(n);
    r.resize(640, 360);
    deep(r);
    expect(fake.bindGroups.filter((g) => g.label === 'pass:post-dof').length).toBe(2);
    expect(fake.errors).toEqual([]);
  });
});
