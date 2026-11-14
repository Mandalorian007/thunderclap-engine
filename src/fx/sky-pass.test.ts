/**
 * The sky as a core pass (ws/core-passes): a pass with its own `encode`, drawn per view, its
 * depth read after the opaque sets, rebuilt on a device restore.
 */
import { describe, expect, it } from 'vitest';
import { createRenderCore } from '../render/core/core';
import { createRenderView, type RenderView } from '../render/core/view';
import { createFakeDevice, type FakeDevice, fakeSceneTargets } from '../render/fake-gpu';
import type { Renderer } from '../render/renderer';
import { Sky } from './sky';
import { createSkyPass, SKY_PASS_WGSL } from './sky-pass';
import { SKY_WGSL } from './sky-wgsl';

function setup() {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    sceneTargets: fakeSceneTargets,
    target: { auxKey: 0 },
  } as unknown as Renderer;
  const sky = new Sky(renderer, { stars: true });
  const core = createRenderCore(device);
  const pass = createSkyPass(core, sky);
  return { fake, core, sky, pass };
}

function target(fake: FakeDevice) {
  const tex = fake.device.createTexture({
    size: [64, 32],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'rgba16float' as GPUTextureFormat,
    width: 64,
    height: 32,
  };
}

function draw(
  fake: FakeDevice,
  core: ReturnType<typeof createRenderCore>,
  views: RenderView[],
  t = target(fake),
) {
  const enc = fake.device.createCommandEncoder();
  core.prepare(enc as unknown as GPUCommandEncoder, views);
  for (let i = 0; i < views.length; i++) core.draw(enc as unknown as GPUCommandEncoder, i, t);
  fake.device.queue.submit([enc.finish()]);
}

describe('SkyPass (ws/core-passes)', () => {
  it('joins the pass list after cutout and draws one triangle per view', () => {
    const { fake, core, pass } = setup();
    expect(core.passes.order).toEqual([
      'depthPre',
      'opaque',
      'cutout',
      'sky',
      'transparent',
      'overlay',
    ]);
    pass.prepare();
    const before = fake.passes.length;
    draw(fake, core, [createRenderView(), createRenderView()]);
    const render = fake.passes.slice(before).filter((p) => p.kind === 'render');
    // No set joined any pass: only the sky's, once per view.
    expect(render.length).toBe(2);
    for (const p of render) {
      const draws = p.commands.filter((c) => c.op === 'draw');
      expect(draws).toEqual([{ op: 'draw', vertices: 3, instances: 1, firstInstance: 0 }]);
      const binds = p.commands.filter((c) => c.op === 'setBindGroup') as { index: number }[];
      expect(binds.map((b) => b.index)).toEqual([0, 1]);
    }
    expect(pass.draws).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('tests depth at the far plane without writing it; nothing written before clears it', () => {
    const { fake, core } = setup();
    draw(fake, core, [createRenderView()]);
    const p = fake.passes.filter((x) => x.kind === 'render').at(-1)!;
    const desc = p.desc as GPURenderPassDescriptor;
    // The sky's pass is the view's first depth pass: it clears depth rather than read nothing.
    expect(desc.depthStencilAttachment?.depthLoadOp).toBe('clear');
    expect(desc.depthStencilAttachment?.depthReadOnly).toBe(false);
    const set = p.commands.find((c) => c.op === 'setPipeline') as {
      pipeline: { desc: GPURenderPipelineDescriptor };
    };
    expect(set.pipeline.desc.depthStencil).toEqual({
      format: core.depthFormat,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
    expect(set.pipeline.desc.fragment?.targets).toEqual([{ format: 'rgba16float' }]);
  });

  it('packs the sky, the sun and the fog into its two blocks', () => {
    const { fake, sky, pass } = setup();
    sky.exposure = 2;
    pass.sunDir.set([0, -1, 0]);
    pass.sunColor.set([1, 0.5, 0.25]);
    pass.fog.set([0.1, 0.2, 0.3, 0.4]);
    pass.prepare();
    const writes = fake.writes.slice(-2);
    expect(writes.map((w) => w.buffer.label)).toEqual(['sky pass params', 'sky pass light']);
    const light = new Float32Array(writes[1]!.buffer.data.slice().buffer);
    expect(Array.from(light)).toEqual([
      0,
      -1,
      0,
      0,
      1,
      0.5,
      0.25,
      0,
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
    ]);
    expect(new Float32Array(writes[0]!.buffer.data.slice().buffer)[3]).toBe(2);
  });

  it('rebuilds on a device restore and draws on the new device', async () => {
    const { fake, core, pass } = setup();
    draw(fake, core, [createRenderView()]);
    fake.loseDevice('unknown', 'forced');
    await fake.lost;
    const next = createFakeDevice();
    core.restore(next.device as unknown as GPUDevice);
    expect(next.buffers.some((b) => b.label === 'sky pass params')).toBe(true);
    pass.prepare();
    draw(next, core, [createRenderView()]);
    const p = next.passes.filter((x) => x.kind === 'render').at(-1)!;
    expect(p.commands.filter((c) => c.op === 'draw').length).toBe(1);
    expect(next.errors).toEqual([]);
  });

  it('shades the dome with the same sky_shade as the renderer sky', () => {
    expect(SKY_PASS_WGSL).toContain('fn sky_shade(');
    expect(SKY_WGSL).toContain('fn sky_shade(');
    expect(SKY_PASS_WGSL).toContain('o.clip = vec4f(x, y, 1.0, 1.0);');
  });
});
