/**
 * `PostStack` on the fake GPU: the composite into the swapchain is unchanged, `renderer.resolve`
 * runs the stack into another view at a viewport (ws/xr-post) and the stack sizes itself to the
 * inputs it is given, allocating nothing once warm.
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
import { PostStack } from './post-stack';

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(800, 450);
  const post = new PostStack(r);
  r.post = post;
  return { fake, r, post };
}

function composites(fake: FakeDevice, from = 0): FakePass[] {
  return fake.passes.slice(from).filter((p) => p.label === 'pass:post-composite');
}

function attachment(p: FakePass): GPURenderPassColorAttachment {
  const d = p.desc as GPURenderPassDescriptor;
  return (d.colorAttachments as GPURenderPassColorAttachment[])[0]!;
}

function viewportOf(p: FakePass): number[] | undefined {
  const c = p.commands.find((c) => c.op === 'other' && c.name === 'setViewport');
  return (c as { args?: number[] } | undefined)?.args;
}

function bloomSize(fake: FakeDevice): number[] {
  const t = fake.textures.filter((t) => t.label === 'post-bloom').at(-1)!;
  return [t.width, t.height];
}

describe('PostStack through renderer.resolve', () => {
  it('presents to the swapchain with a clear and no viewport, as before', () => {
    const { fake, r } = setup();
    r.beginFrame(0, 1 / 60);
    r.endFrame();
    const [c] = composites(fake);
    expect(c).toBeDefined();
    expect(attachment(c!).loadOp).toBe('clear');
    expect(viewportOf(c!)).toBeUndefined();
    expect(fake.errors).toEqual([]);
  });

  it('the screen path writes each pass’s uniforms directly; no staging ring (ws/render-12)', () => {
    const { fake, r } = setup();
    for (let i = 0; i < 3; i++) {
      r.beginFrame(i / 60, 1 / 60);
      r.endFrame();
    }
    expect(fake.buffers.some((b) => b.label === 'post-eye-uniforms')).toBe(false);
    expect(fake.bufferCopies.filter((c) => c.dst.label?.startsWith('pass:post-'))).toEqual([]);
    expect(fake.writes.some((w) => w.buffer.label === 'pass:post-composite-uniforms')).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('runs once per eye into the layer at the eye viewport, loading the rest', () => {
    const { fake, r, post } = setup();
    post.set({ godRays: { enabled: true } });
    const eye = r.createSceneTarget({ width: 64, height: 32, label: 'eye' });
    const layer = fake.device.createTexture({
      label: 'layer',
      size: [128, 32],
      format: 'bgra8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const out = layer.createView();
    const cam = Camera.perspective(1, 2, 0.1, 10);
    const left = { x: 0, y: 0, width: 64, height: 32 };
    const right = { x: 64, y: 0, width: 64, height: 32 };
    const frame = () => {
      const f = r.beginFrame(0, 1 / 72);
      f.sprite(null, { x: 1, y: 1 });
      r.render(f, cam, eye);
      r.resolve(eye, out, left);
      r.render(f, cam, eye);
      r.resolve(eye, out, right);
      r.endFrame({ present: false });
    };
    const before = fake.passes.length;
    frame();
    expect(fake.errors).toEqual([]);
    const cs = composites(fake, before);
    expect(cs.length).toBe(2);
    expect(cs.map(viewportOf)).toEqual([
      [0, 0, 64, 32, 0, 1],
      [64, 0, 64, 32, 0, 1],
    ]);
    for (const c of cs) {
      expect(attachment(c).loadOp).toBe('load');
      const view = attachment(c).view as unknown as { texture: { label: string } };
      expect(view.texture.label).toBe('layer');
    }
    // Settings are honoured per eye: god rays and the bloom chain ran twice.
    const labels = fake.passes.slice(before).map((p) => p.label);
    expect(labels.filter((l) => l === 'pass:post-godrays').length).toBe(2);
    expect(labels.filter((l) => l === 'pass:post-bloom-prefilter').length).toBe(2);
    // The stack sized itself to the eye: half-res bloom at 32 × 16.
    expect(bloomSize(fake)).toEqual([32, 16]);
    expect(fake.passes.some((p) => p.label === 'pass:present-basic')).toBe(false);

    // Steady state allocates nothing.
    frame();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const n = counts();
    frame();
    frame();
    expect(counts()).toEqual(n);

    // Back on the screen the stack resizes to the renderer's target once, then holds.
    r.beginFrame(0, 1 / 60);
    r.endFrame();
    expect(bloomSize(fake)).toEqual([400, 225]);
    const m = counts();
    r.beginFrame(0, 1 / 60);
    r.endFrame();
    expect(counts()).toEqual(m);
    expect(fake.errors).toEqual([]);
  });
});

describe('PostStack finishing passes (ws/post-2)', () => {
  const labels = (fake: FakeDevice, from: number) =>
    fake.passes.slice(from).map((p) => p.label ?? '');
  const count = (list: string[], label: string) => list.filter((l) => l === `pass:${label}`).length;
  const flat = (r: Renderer) => {
    r.beginFrame(0, 1 / 60);
    r.endFrame();
  };
  const deep = (r: Renderer) => {
    const f = r.beginFrame(0, 1 / 60);
    f.sprite(null, { x: 1, y: 1 });
    r.render(f, Camera.perspective(1, 16 / 9, 0.1, 100));
    r.endFrame();
  };
  const targetLabel = (p: FakePass) =>
    (attachment(p).view as unknown as { texture: { label: string } }).texture.label;

  it('the in-composite sections add no passes and allocate nothing', () => {
    const { fake, r, post } = setup();
    flat(r); // warm-up: the first frame also builds default-texture mips once
    const start = fake.passes.length;
    flat(r);
    const before = labels(fake, start);
    const n = fake.textures.length;
    post.set({
      grain: { intensity: 0.2 },
      aberration: { intensity: 2 },
      sharpen: { amount: 1 },
    });
    const from = fake.passes.length;
    flat(r);
    expect(labels(fake, from)).toEqual(before);
    expect(fake.textures.length).toBe(n);
    expect(fake.errors).toEqual([]);
  });

  it('FXAA adds one output-size pass after the composite, allocated only when enabled', () => {
    const { fake, r, post } = setup();
    flat(r);
    expect(fake.textures.some((t) => t.label === 'post-fxaa')).toBe(false);
    post.set({ fxaa: { enabled: true } });
    let from = fake.passes.length;
    flat(r);
    const list = labels(fake, from);
    expect(count(list, 'post-fxaa')).toBe(1);
    expect(list.indexOf('pass:post-fxaa')).toBeGreaterThan(list.indexOf('pass:post-composite'));
    const tex = fake.textures.filter((t) => t.label === 'post-fxaa');
    expect(tex.length).toBe(1);
    expect([tex[0]!.width, tex[0]!.height]).toEqual([800, 450]);
    // The composite now lands in that texture; FXAA presents with the clear.
    expect(targetLabel(composites(fake, from)[0]!)).toBe('post-fxaa');
    const fx = fake.passes.slice(from).find((p) => p.label === 'pass:post-fxaa')!;
    expect(attachment(fx).loadOp).toBe('clear');
    // Steady state: nothing more.
    const n = fake.textures.length;
    flat(r);
    expect(fake.textures.length).toBe(n);
    // The low tier caps it off again.
    post.setQuality({ fxaa: false });
    from = fake.passes.length;
    flat(r);
    expect(count(labels(fake, from), 'post-fxaa')).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('outline runs before the composite with depth, warns once without it', () => {
    const { fake, r, post } = setup();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      post.set({ outline: { enabled: true } });
      let from = fake.passes.length;
      flat(r);
      flat(r);
      expect(count(labels(fake, from), 'post-outline')).toBe(0);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/outline/);
      from = fake.passes.length;
      deep(r);
      const list = labels(fake, from);
      expect(count(list, 'post-outline')).toBe(1);
      expect(list.indexOf('pass:post-outline')).toBeLessThan(list.indexOf('pass:post-composite'));
      expect(fake.textures.filter((t) => t.label === 'post-outline').length).toBe(1);
      post.setQuality({ outline: false });
      from = fake.passes.length;
      deep(r);
      expect(count(labels(fake, from), 'post-outline')).toBe(0);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = warn;
    }
    expect(fake.errors).toEqual([]);
  });

  it('binds the LUT when set, rebuilding the composite group once per change', () => {
    const { fake, r, post } = setup();
    flat(r);
    flat(r);
    const groups = fake.bindGroups.length;
    const lut = fake.device.createTexture({
      label: 'lut',
      size: [16, 16, 16],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    post.set({ lut: { texture: lut, size: 16 } });
    flat(r);
    expect(fake.bindGroups.length).toBeGreaterThan(groups);
    const after = fake.bindGroups.length;
    flat(r);
    expect(fake.bindGroups.length).toBe(after);
    post.set({ lut: { texture: null } });
    flat(r);
    expect(fake.bindGroups.length).toBeGreaterThan(after);
    expect(fake.errors).toEqual([]);
  });
});
