import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeDevice, type FakeTexture } from '../render/fake-gpu';
import type { Frame, ViewInfo } from '../render/frame';
import { Mesh, type MeshDesc } from '../render/mesh';
import type { Renderer } from '../render/renderer';
import { WATER_PARAMS_FLOATS, Water, type WaterOptions, waterHeight } from './water';
import { WATER_MAX_WAVES, WATER_WGSL } from './water-wgsl';

function makeWater(opts: WaterOptions = {}, depth = true) {
  const fake = createFakeDevice();
  const device = fake.device;
  const depthTex = depth
    ? device.createTexture({
        label: 'scene-depth',
        size: [320, 180],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    : null;
  const target = {
    depth: depthTex
      ? { view: depthTex.createView(), width: 320, height: 180, texture: depthTex }
      : null,
  };
  const renderer = {
    device,
    globalsLayout: device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    target,
    createMesh: (desc: MeshDesc) => new Mesh(device, desc),
  } as unknown as Renderer;
  const water = new Water(renderer, opts);
  return { fake, water, target };
}

const DEPTH_FRAME = { depthFormat: 'depth24plus' } as unknown as Frame;
const FLAT_FRAME = { depthFormat: null } as unknown as Frame;

function encoder(fake: FakeDevice) {
  return fake.device.createCommandEncoder();
}

function scenePass(fake: FakeDevice) {
  return encoder(fake).beginRenderPass({ colorAttachments: [] });
}

function params(water: Water): Float32Array {
  return (water as unknown as { params: Float32Array }).params;
}

function lastPipeline(fake: FakeDevice) {
  const cmd = fake.passes.at(-1)!.commands.find((c) => c.op === 'setPipeline');
  return (cmd as { pipeline: { label: string; desc: GPURenderPipelineDescriptor } }).pipeline;
}

/** The group 1 bind of the last pass. */
function lastGroup(fake: FakeDevice): unknown {
  const cmd = fake.passes
    .at(-1)!
    .commands.find((c) => c.op === 'setBindGroup' && (c as { index: number }).index === 1);
  return (cmd as { group: unknown }).group;
}

describe('Water', () => {
  it('draws the plane with the params block and depth copy at group 1', () => {
    const { fake, water } = makeWater({ segments: 2 });
    water.prepare(encoder(fake), DEPTH_FRAME);
    water.draw(scenePass(fake), DEPTH_FRAME);
    const cmds = fake.passes.at(-1)!.commands;
    // 2×2 segments: 8 triangles, 24 indices.
    expect(cmds.filter((c) => c.op === 'drawIndexed')).toEqual([
      { op: 'drawIndexed', indices: 24, instances: 1, firstInstance: 0 },
    ]);
    const bind = cmds.find((c) => c.op === 'setBindGroup') as { index: number; group: unknown };
    expect(bind.index).toBe(1);
    expect((bind.group as { label: string }).label).toBe('water-soft');
    expect(fake.errors).toEqual([]);
  });

  it('writes depth under a depth camera, one pipeline per depth format, none without', () => {
    const { fake, water } = makeWater();
    water.draw(scenePass(fake), DEPTH_FRAME);
    const depth = lastPipeline(fake);
    expect(depth.label).toBe('water:depth24plus');
    expect(depth.desc.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    });
    water.draw(scenePass(fake), FLAT_FRAME);
    const flat = lastPipeline(fake);
    expect(flat.label).toBe('water');
    expect(flat.desc.depthStencil).toBeUndefined();
    expect(flat.desc.fragment?.targets.map((t) => t?.format)).toEqual([
      'rgba16float',
      'rgba16float',
    ]);
    expect(flat.desc.vertex.buffers).toHaveLength(1);
    water.draw(scenePass(fake), { depthFormat: 'depth32float' } as unknown as Frame);
    expect(lastPipeline(fake).label).toBe('water:depth32float');
    water.draw(scenePass(fake), DEPTH_FRAME);
    expect(lastPipeline(fake)).toBe(depth);
  });

  it('copies the scene depth in prepare and binds the dummy without a depth frame', () => {
    const { fake, water } = makeWater();
    const copies = () => fake.passes.filter((p) => p.label === 'water-depth-copy');
    water.prepare(encoder(fake), FLAT_FRAME);
    expect(copies()).toHaveLength(0);
    expect(params(water)[18]).toBe(0);
    water.draw(scenePass(fake), FLAT_FRAME);
    let bind = fake.passes.at(-1)!.commands.find((c) => c.op === 'setBindGroup') as {
      group: { label: string };
    };
    expect(bind.group.label).toBe('water');

    water.prepare(encoder(fake), DEPTH_FRAME);
    expect(copies()).toHaveLength(1);
    expect(copies()[0]!.commands).toEqual([
      { op: 'setPipeline', pipeline: expect.objectContaining({ label: 'water-depth-copy' }) },
      { op: 'setBindGroup', index: 0, group: expect.anything(), offsets: [] },
      { op: 'draw', vertices: 3, instances: 1, firstInstance: 0 },
      { op: 'other', name: 'end' },
    ]);
    const copy = fake.textures.find((t) => t.label === 'water-depth') as FakeTexture;
    expect([copy.width, copy.height, copy.format]).toEqual([320, 180, 'depth32float']);
    expect(params(water)[18]).toBe(1);
    water.draw(scenePass(fake), DEPTH_FRAME);
    bind = fake.passes.at(-1)!.commands.find((c) => c.op === 'setBindGroup') as {
      group: { label: string };
    };
    expect(bind.group.label).toBe('water-soft');
    expect(fake.errors).toEqual([]);
  });

  it('skips the copy when the target has no depth texture', () => {
    const { fake, water } = makeWater({}, false);
    water.prepare(encoder(fake), DEPTH_FRAME);
    expect(fake.passes.filter((p) => p.label === 'water-depth-copy')).toHaveLength(0);
    expect(params(water)[18]).toBe(0);
  });

  it('packs the live fields into the params block (golden layout)', () => {
    const { fake, water } = makeWater({
      shallowColor: [0.1, 0.2, 0.3],
      deepColor: [0.4, 0.5, 0.6],
      opacity: 0.7,
      depthFade: 3,
      fresnel: 0.5,
      roughness: 0.1,
      displace: 0.2,
      level: 1.5,
      foam: { width: 0.3, color: [0.9, 0.8, 0.7] },
      waves: [{ scale: 0.5, speed: 2, amplitude: 0.25, direction: [0, 1] }],
    });
    water.update(0.5);
    water.update(0.25);
    water.prepare(encoder(fake), FLAT_FRAME);
    const p = params(water);
    expect(p.length).toBe(WATER_PARAMS_FLOATS);
    expect(WATER_PARAMS_FLOATS).toBe(20 + WATER_MAX_WAVES * 4);
    const r = (x: number) => Math.round(x * 1000) / 1000;
    expect(Array.from(p.subarray(0, 24)).map(r)).toEqual([
      0.1,
      0.2,
      0.3,
      0.7,
      0.4,
      0.5,
      0.6,
      3,
      0.5,
      0.1,
      0.2,
      1.5,
      0.9,
      0.8,
      0.7,
      0.3,
      0.75,
      1,
      0,
      0,
      0.5,
      2,
      0.25,
      r(Math.PI / 2),
    ]);
    expect(Array.from(p.subarray(24))).toEqual(new Array(12).fill(0));
    const write = fake.writes.at(-1)!;
    expect(write.buffer.label).toBe('water-params');
    expect(write.bytes).toBe(WATER_PARAMS_FLOATS * 4);
    // Live: mutate and the next prepare carries it.
    water.deepColor[0] = 0.9;
    water.foam = null;
    water.waves.push({ scale: 1, speed: 1, amplitude: 0.1, direction: [1, 0] });
    water.prepare(encoder(fake), FLAT_FRAME);
    expect(p[4]).toBeCloseTo(0.9);
    expect(Array.from(p.subarray(12, 16))).toEqual([0, 0, 0, 0]);
    expect(p[17]).toBe(2);
    expect(Array.from(p.subarray(24, 28))).toEqual([1, 1, Math.fround(0.1), 0]);
  });

  it('defaults: two wave layers, foam on, flat mesh, 100-unit plane', () => {
    const { water } = makeWater();
    expect(water.waves).toHaveLength(2);
    expect(water.foam).toEqual({ width: 0.4, color: [0.9, 0.95, 0.97] });
    expect(water.displace).toBe(0);
    expect(water.level).toBe(0);
    expect(water.opacity).toBe(0.85);
    expect(water.fresnel).toBe(0.6);
    expect(water.roughness).toBe(0.08);
    expect(water.depthFade).toBe(4);
    expect(water.mesh.indexCount).toBe(6);
    expect(water.mesh.bounds.radius).toBeCloseTo(Math.SQRT2 * 50, 3);
    const { water: noFoam } = makeWater({ foam: null });
    expect(noFoam.foam).toBeNull();
    const { water: wide } = makeWater({ size: [20, 10], segments: [4, 2] });
    expect(wide.mesh.indexCount).toBe(4 * 2 * 6);
  });

  it('allocates no GPU objects per frame after the first depth frame', () => {
    const { fake, water } = makeWater();
    water.prepare(encoder(fake), DEPTH_FRAME);
    water.draw(scenePass(fake), DEPTH_FRAME);
    const buffers = fake.buffers.length;
    const textures = fake.textures.length;
    const groups = fake.bindGroups.length;
    const writes = fake.writes.length;
    const params0 = params(water);
    for (let i = 0; i < 5; i++) {
      water.update(1 / 60);
      water.level = i * 0.1;
      water.prepare(encoder(fake), DEPTH_FRAME);
      water.draw(scenePass(fake), DEPTH_FRAME);
    }
    expect(fake.buffers.length).toBe(buffers);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);
    expect(fake.writes.length).toBe(writes + 5);
    expect(params(water)).toBe(params0);
    expect(fake.errors).toEqual([]);
    water.destroy();
    expect(fake.buffers.find((b) => b.label === 'water-params')!.destroyed).toBe(true);
    expect(fake.textures.find((t) => t.label === 'water-depth')!.destroyed).toBe(true);
  });

  it('re-sizes the depth copy when the target changes size', () => {
    const { fake, water, target } = makeWater();
    water.prepare(encoder(fake), DEPTH_FRAME);
    const groups = fake.bindGroups.length;
    const tex = fake.device.createTexture({
      label: 'scene-depth-2',
      size: [640, 360],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    target.depth = { view: tex.createView(), width: 640, height: 360, texture: tex };
    water.prepare(encoder(fake), DEPTH_FRAME);
    const copies = fake.textures.filter((t) => t.label === 'water-depth');
    expect(copies).toHaveLength(2);
    expect(copies[0]!.destroyed).toBe(true);
    expect([copies[1]!.width, copies[1]!.height]).toEqual([640, 360]);
    // One group for the new copy, one for the new source.
    expect(fake.bindGroups.length).toBe(groups + 2);
  });

  it('reads the sun, fog and camera from the engine blocks and reuses the PBR terms', () => {
    expect(WATER_WGSL).toContain('lights.sun_dir');
    expect(WATER_WGSL).toContain('lights.sun_color');
    expect(WATER_WGSL).toContain('lights.fog');
    expect(WATER_WGSL).toContain('engine_d_ggx');
    expect(WATER_WGSL).toContain('engine_f_schlick');
    expect(WATER_WGSL).toContain('@group(1) @binding(0) var<uniform> water');
    expect(WATER_WGSL).toContain('@group(1) @binding(1) var scene_depth: texture_depth_2d');
    expect(WATER_WGSL).toContain(`array<vec4f, ${WATER_MAX_WAVES}>`);
  });
});

describe('Water depth hook (ws/render-hooks)', () => {
  it('readsDepth: no copy pass of its own; afterOpaque binds the renderer copy and flips the flag', () => {
    const { fake, water, target } = makeWater({ readsDepth: true });
    expect(water.readsDepth).toBe(true);
    water.prepare(encoder(fake), DEPTH_FRAME);
    // The own copy pass (`water-depth-copy`) and texture are gone; the flag is off.
    expect(fake.passes.filter((p) => p.label === 'water-depth-copy')).toHaveLength(0);
    expect(fake.textures.filter((t) => t.label === 'water-depth')).toHaveLength(0);
    expect(params(water)[18]).toBe(0);
    water.draw(scenePass(fake), DEPTH_FRAME);
    expect((lastGroup(fake) as { label: string }).label).toBe('water');

    // The renderer's hook: the copy it made is bound and the 4-byte flag write lands.
    const copyTex = fake.device.createTexture({
      label: 'scene-depth-copy',
      size: [320, 180],
      format: 'depth24plus',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const view: ViewInfo = {
      camera: null as never,
      target: target as never,
      depthCopy: copyTex,
      depthView: copyTex.createView(),
      viewport: { x: 0, y: 0, width: 320, height: 180 },
    };
    const writes = fake.writes.length;
    water.afterOpaque(encoder(fake), view);
    expect(params(water)[18]).toBe(1);
    expect(fake.writes.slice(writes)).toEqual([
      { buffer: fake.buffers.find((b) => b.label === 'water-params'), offset: 72, bytes: 4 },
    ]);
    water.draw(scenePass(fake), DEPTH_FRAME);
    const hook = lastGroup(fake) as { label: string; entries: GPUBindGroupEntry[] };
    expect(hook.label).toBe('water-hook');
    expect((hook.entries[1]!.resource as unknown as { texture: FakeTexture }).texture).toBe(
      copyTex,
    );

    // Steady state: the same copy view makes no new group; the next prepare resets the flag.
    const groups = fake.bindGroups.length;
    water.prepare(encoder(fake), DEPTH_FRAME);
    expect(params(water)[18]).toBe(0);
    water.afterOpaque(encoder(fake), view);
    expect(fake.bindGroups.length).toBe(groups);
    expect(fake.passes.filter((p) => p.label === 'water-depth-copy')).toHaveLength(0);
    expect(fake.errors).toEqual([]);
  });
});

describe('waterHeight', () => {
  /** The shader's `water_wave` value term, written out from the WGSL text's formula. */
  function wgslWave(px: number, py: number): number {
    const a = px + 0.6 * Math.sin(1.3 * py);
    const b = 0.8 * py + 0.5 * Math.sin(0.9 * px);
    return Math.sin(a) * Math.cos(b);
  }

  it('matches the WGSL formula on three samples', () => {
    const { water } = makeWater({
      level: 2,
      displace: 0.5,
      waves: [
        { scale: 0.4, speed: 0.7, amplitude: 0.3, direction: [1, 0] },
        { scale: 1.1, speed: 1.3, amplitude: 0.15, direction: [0, -1] },
        { scale: 0.25, speed: 0.2, amplitude: 0.5, direction: [3, 4] },
      ],
    });
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [3.5, -2.25, 1.7],
      [-12.1, 40.4, 9.9],
    ];
    for (const [x, z, t] of samples) {
      // Layer 1 scrolls along +x, layer 2 along -z, layer 3 along (0.6, 0.8).
      const sum =
        0.3 * wgslWave(x * 0.4 + t * 0.7, z * 0.4) +
        0.15 * wgslWave(x * 1.1, z * 1.1 - t * 1.3) +
        0.5 * wgslWave(x * 0.25 + 0.6 * t * 0.2, z * 0.25 + 0.8 * t * 0.2);
      expect(waterHeight(water, x, z, t)).toBeCloseTo(2 + 0.5 * sum, 9);
    }
    expect(WATER_WGSL).toContain('let a = p.x + 0.6 * sin(1.3 * p.y);');
    expect(WATER_WGSL).toContain('let b = 0.8 * p.y + 0.5 * sin(0.9 * p.x);');
    expect(WATER_WGSL).toContain('water.surface.w + water.surface.z * f.x');
  });

  it('is the level with no displacement, defaults to the water clock and moves over time', () => {
    const { water } = makeWater({ level: 1 });
    expect(waterHeight(water, 5, 5)).toBe(1);
    water.displace = 0.3;
    water.update(0.4);
    expect(waterHeight(water, 5, 5)).toBe(waterHeight(water, 5, 5, 0.4));
    expect(waterHeight(water, 5, 5, 0)).not.toBe(waterHeight(water, 5, 5, 0.4));
    expect(Math.abs(waterHeight(water, 5, 5) - 1)).toBeLessThanOrEqual(0.3 * 0.37 + 1e-9);
  });
});
