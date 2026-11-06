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
