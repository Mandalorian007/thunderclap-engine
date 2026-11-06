import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { SKY_PARAMS_FLOATS, Sky, type SkyOptions, skyRay } from './sky';
import { SKY_WGSL } from './sky-wgsl';

function makeSky(opts: SkyOptions = {}) {
  const fake = createFakeDevice();
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
  } as unknown as Renderer;
  const sky = new Sky(renderer, opts);
  return { fake, sky };
}

const DEPTH_FRAME = { depthFormat: 'depth24plus' } as unknown as Frame;
const FLAT_FRAME = { depthFormat: null } as unknown as Frame;

function encoder(fake: FakeDevice) {
  return fake.device.createCommandEncoder();
}

function scenePass(fake: FakeDevice) {
  return encoder(fake).beginRenderPass({ colorAttachments: [] });
}

function params(sky: Sky): Float32Array {
  return (sky as unknown as { params: Float32Array }).params;
}

function lastPipeline(fake: FakeDevice) {
  const cmd = fake.passes.at(-1)!.commands.find((c) => c.op === 'setPipeline');
  return (cmd as { pipeline: { label: string; desc: GPURenderPipelineDescriptor } }).pipeline;
}

describe('Sky', () => {
  it('draws one fullscreen triangle with the params block at group 1', () => {
    const { fake, sky } = makeSky();
    sky.prepare(encoder(fake), DEPTH_FRAME);
    sky.draw(scenePass(fake), DEPTH_FRAME);
    const cmds = fake.passes.at(-1)!.commands;
    expect(cmds.filter((c) => c.op === 'draw')).toEqual([
      { op: 'draw', vertices: 3, instances: 1, firstInstance: 0 },
    ]);
    const bind = cmds.find((c) => c.op === 'setBindGroup') as { index: number };
    expect(bind.index).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('tests depth at the far plane without writing it, one pipeline per depth format', () => {
    const { fake, sky } = makeSky();
    sky.draw(scenePass(fake), DEPTH_FRAME);
    const depth = lastPipeline(fake);
    expect(depth.label).toBe('sky:depth24plus');
    expect(depth.desc.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
    // The triangle is emitted at clip z = 1 (the far plane).
    expect(SKY_WGSL).toContain('o.clip = vec4f(x, y, 1.0, 1.0);');
    sky.draw(scenePass(fake), FLAT_FRAME);
    const flat = lastPipeline(fake);
    expect(flat.label).toBe('sky');
    expect(flat.desc.depthStencil).toBeUndefined();
    // Both targets (colour and emissive) are written, unblended.
    expect(flat.desc.fragment?.targets).toEqual([
      { format: 'rgba16float' },
      { format: 'rgba16float' },
    ]);
    const before = fake.device.createRenderPipeline.length; // no-op; counts below
    void before;
    sky.draw(scenePass(fake), DEPTH_FRAME);
    sky.draw(scenePass(fake), DEPTH_FRAME);
    expect(lastPipeline(fake)).toBe(depth);
  });

  it('packs the live fields into the params block (golden layout)', () => {
    const { fake, sky } = makeSky({
      zenith: [0.1, 0.2, 0.3],
      horizon: [0.4, 0.5, 0.6],
      ground: [0.7, 0.8, 0.9],
      sunSize: 0.05,
      sunGlow: 2,
      exposure: 1.5,
      stars: { density: 32, seed: 7 },
    });
    sky.prepare(encoder(fake), DEPTH_FRAME);
    const p = params(sky);
    expect(p.length).toBe(SKY_PARAMS_FLOATS);
    expect(Array.from(p).map((x) => Math.round(x * 1000) / 1000)).toEqual([
      0.1, 0.2, 0.3, 1.5, 0.4, 0.5, 0.6, 0.05, 0.7, 0.8, 0.9, 2, 32, 7, 1, 0,
    ]);
    const write = fake.writes.at(-1)!;
    expect(write.buffer.label).toBe('sky-params');
    expect(write.bytes).toBe(64);
    // Live: mutate and the next prepare carries it.
    sky.zenith[2] = 0.9;
    sky.sunSize = 0.1;
    sky.stars = null;
    sky.prepare(encoder(fake), DEPTH_FRAME);
    expect(p[2]).toBeCloseTo(0.9);
    expect(p[7]).toBeCloseTo(0.1);
    expect(Array.from(p.subarray(12))).toEqual([0, 0, 0, 0]);
  });

  it('defaults: a blue zenith, no stars; `stars: true` takes the default field', () => {
    const { sky } = makeSky();
    expect(sky.zenith[2]).toBeGreaterThan(sky.zenith[0]!);
    expect(sky.stars).toBeNull();
    expect(sky.sunSize).toBe(0.03);
    expect(sky.sunGlow).toBe(1);
    expect(sky.exposure).toBe(1);
    const { sky: starry } = makeSky({ stars: true });
    expect(starry.stars).toEqual({ density: 24, seed: 0 });
    const { sky: seeded } = makeSky({ stars: { seed: 3 } });
    expect(seeded.stars).toEqual({ density: 24, seed: 3 });
  });

  it('allocates no GPU objects per frame after the first draw', () => {
    const { fake, sky } = makeSky({ stars: true });
    sky.prepare(encoder(fake), DEPTH_FRAME);
    sky.draw(scenePass(fake), DEPTH_FRAME);
    const buffers = fake.buffers.length;
    const groups = fake.bindGroups.length;
    const writes = fake.writes.length;
    const params0 = params(sky);
    for (let i = 0; i < 5; i++) {
      sky.exposure = 1 + i * 0.1;
      sky.prepare(encoder(fake), DEPTH_FRAME);
      sky.draw(scenePass(fake), DEPTH_FRAME);
    }
    expect(fake.buffers.length).toBe(buffers);
    expect(fake.bindGroups.length).toBe(groups);
    expect(fake.writes.length).toBe(writes + 5);
    expect(params(sky)).toBe(params0);
    expect(fake.errors).toEqual([]);
    sky.destroy();
    expect(fake.buffers.find((b) => b.label === 'sky-params')!.destroyed).toBe(true);
  });

  it('reads the sun and fog from the lights block, not from its own uniforms', () => {
    expect(SKY_WGSL).toContain('lights.sun_dir');
    expect(SKY_WGSL).toContain('lights.sun_color');
    expect(SKY_WGSL).toContain('lights.fog');
    expect(SKY_WGSL).toContain('@group(0) @binding(2) var<uniform> lights');
    expect(SKY_WGSL).toContain('@group(1) @binding(0) var<uniform> sky');
  });
});

describe('skyRay', () => {
  const out = new Float32Array(3);
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];

  /** The direction `Camera.screenToWorld` gives through screen point (sx, sy): far − near. */
  function pickRay(cam: Camera, sx: number, sy: number): number[] {
    const a = cam.screenToWorld(sx, sy, 0);
    const b = cam.screenToWorld(sx, sy, 1);
    const d = [b.x - a.x, b.y - a.y, b.z - a.z];
    const k = 1 / Math.hypot(d[0]!, d[1]!, d[2]!);
    return d.map((x) => x * k);
  }

  it('matches Camera.screenToWorld at the four corners of a perspective view', () => {
    const cam = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 200).lookAt([3, 2, 9], [0, 1, 0]);
    Object.assign(cam.screen, { x: 0, y: 0, width: 1920, height: 1080 });
    for (const [nx, ny] of corners) {
      skyRay(cam, nx, ny, out);
      const sx = ((nx + 1) / 2) * 1920;
      const sy = ((1 - ny) / 2) * 1080;
      const want = pickRay(cam, sx, sy);
      expect(out[0]).toBeCloseTo(want[0]!, 4);
      expect(out[1]).toBeCloseTo(want[1]!, 4);
      expect(out[2]).toBeCloseTo(want[2]!, 4);
    }
    // The centre looks from the eye to the target.
    skyRay(cam, 0, 0, out);
    const to = [-3, -1, -9];
    const k = 1 / Math.hypot(...to);
    expect(out[0]).toBeCloseTo(to[0]! * k, 5);
    expect(out[1]).toBeCloseTo(to[1]! * k, 5);
    expect(out[2]).toBeCloseTo(to[2]! * k, 5);
  });

  it('handles an off-centre projection (an XR eye)', () => {
    const cam = Camera.perspective(Math.PI / 3, 1, 0.1, 100).lookAt([0, 0, 5], [0, 0, 0]);
    // Shear the frustum: shift the projection's x and y centre.
    const p = Float32Array.from(cam.projection);
    p[8] = 0.3;
    p[9] = -0.2;
    cam.setProjection(p);
    Object.assign(cam.screen, { x: 0, y: 0, width: 100, height: 100 });
    for (const [nx, ny] of corners) {
      skyRay(cam, nx, ny, out);
      const want = pickRay(cam, ((nx + 1) / 2) * 100, ((1 - ny) / 2) * 100);
      expect(out[0]).toBeCloseTo(want[0]!, 4);
      expect(out[1]).toBeCloseTo(want[1]!, 4);
      expect(out[2]).toBeCloseTo(want[2]!, 4);
    }
  });

  it('gives the camera forward for every pixel of an orthographic view', () => {
    const cam = Camera.ortho2d(1920, 1080);
    for (const [nx, ny] of corners) {
      skyRay(cam, nx, ny, out);
      const want = pickRay(cam, ((nx + 1) / 2) * 1920, ((1 - ny) / 2) * 1080);
      expect(Array.from(out)).toEqual(want.map((x) => Math.fround(x)));
    }
  });
});
