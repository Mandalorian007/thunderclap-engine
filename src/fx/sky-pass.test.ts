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
    expect(SKY_PASS_WGSL).toContain('o.clip = vec4f(x, y, fx_depth_far(), 1.0);');
  });
});

describe('SkyPass as a pass member (ws/fx-fit)', () => {
  const SHADE = /* wgsl */ `
fn sky_look(i: SkyInput) -> SkyShade {
  return sky_shade(i.dir, i.sun_dir, i.sun_color, i.fog);
}`;

  it('joins an existing pass after its sets: no pass of its own, one direct draw per view', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const order = [...core.passes.order];
    const pass = createSkyPass(core, null, { shade: SHADE, member: 'opaque', order: 50 });
    expect(core.passes.order).toEqual(order);
    expect(pass.pass.id).toBe('opaque');
    expect(pass.member).not.toBeNull();
    expect(pass.member!.pass).toBe('opaque');
    expect(pass.member!.order).toBe(50);
    expect(pass.member!.encoding).toBe('direct');
    expect(core.coreDrawables).toEqual([pass.member]);
    pass.prepare();
    draw(fake, core, [createRenderView(), createRenderView()]);
    const render = fake.passes.filter((p) => p.kind === 'render');
    // One render pass per view (the opaque pass, the sky in it), nothing else.
    expect(render.length).toBe(2);
    for (const p of render) {
      expect(p.commands.filter((c) => c.op === 'draw')).toEqual([
        { op: 'draw', vertices: 3, instances: 1, firstInstance: 0 },
      ]);
    }
    expect(pass.draws).toBe(2);
    // The opaque pass writes depth: the sky tests it without writing.
    const set = render[0]!.commands.find((c) => c.op === 'setPipeline') as unknown as {
      pipeline: { desc: GPURenderPipelineDescriptor };
    };
    const p = set.pipeline.desc;
    expect(p.depthStencil!.depthWriteEnabled).toBe(false);
    expect(p.depthStencil!.depthCompare).toBe('less-equal');
    pass.destroy();
    expect(core.coreDrawables).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it('writes velocity in a pass that declares none, unless told it writes nothing (ws/pass-actor-fit)', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice, {
      targets: ['emissive', 'velocity'],
    });
    core.definePass({ id: 'water', after: 'transparent', depth: 'read', writes: [] });
    core.definePass({ id: 'glass', after: 'water', depth: 'read', writes: [] });
    expect(core.passTargets('water')).toBe(0);
    const sky = createSkyPass(core, null, { shade: SHADE, member: 'water' });
    expect(sky.member!.writes).toEqual(['emissive', 'velocity']);
    expect(core.passTargets('water')).toBe(5);
    const narrow = createSkyPass(core, null, { shade: SHADE, member: 'glass', writes: [] });
    expect(core.passTargets('glass')).toBe(0);
    sky.prepare();
    narrow.prepare();
    draw(fake, core, [createRenderView()]);
    const pipes = fake.passes
      .filter((p) => p.kind === 'render')
      .flatMap((p) => p.commands.filter((c) => c.op === 'setPipeline'))
      .map(
        (c) => (c as unknown as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline.desc,
      );
    // Slots colour, emissive, rough-metal, velocity: water attaches the sky's two (rough-metal
    // a hole); glass, colour alone.
    const slots = pipes.map((p) => [...p.fragment!.targets].map((t) => (t ? t.format : null)));
    expect(slots).toEqual([['rgba16float', 'rgba16float', null, 'rg16float'], ['rgba16float']]);
    expect(fake.errors).toEqual([]);
  });

  it('waits for the game group, warming its pipeline meanwhile', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const pass = createSkyPass(core, null, {
      shade: `@group(2) @binding(0) var<uniform> tint: vec4f;\n${SHADE}`,
      member: 'opaque',
      groupLayout: (device) =>
        device.createBindGroupLayout({
          entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }],
        }),
    });
    expect(pass.member!.active).toBe(false);
    pass.prepare();
    draw(fake, core, [createRenderView()]);
    expect(pass.draws).toBe(0);
    const buf = fake.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    pass.gameGroup = fake.device.createBindGroup({
      layout: pass.gameLayout!,
      entries: [{ binding: 0, resource: { buffer: buf } }],
    });
    expect(pass.member!.active).toBe(true);
    draw(fake, core, [createRenderView()]);
    expect(pass.draws).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('a hook needs no SkyLook; no look and no hook is refused, as is a pass without depth', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const pass = createSkyPass(core, null, { shade: SHADE });
    expect(pass.sky.exposure).toBe(1);
    expect(Array.from(pass.sky.zenith)).toEqual([0, 0, 0]);
    pass.prepare();
    expect([...pass.horizon]).toEqual([0, 0, 0]);
    expect(() => createSkyPass(core, null, { id: 'sky2' })).toThrow(/shade/);
    core.definePass({ id: 'flat', depth: 'none' });
    expect(() => createSkyPass(core, null, { shade: SHADE, member: 'flat' })).toThrow(/depth/);
    expect(() => createSkyPass(core, null, { shade: SHADE, member: 'nope' })).toThrow(/nope/);
  });
});
