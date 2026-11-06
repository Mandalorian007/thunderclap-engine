import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeDevice, type FakeTexture } from '../render/fake-gpu';
import type { Frame, ViewInfo } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { WGSL_GLOBALS, WGSL_LIGHTS } from '../render/wgsl';
import { ParticleSystem, type ParticleSystemOptions } from './particles';
import {
  PARTICLE_COMPUTE_WGSL,
  PARTICLE_RENDER_WGSL,
  PARTICLE_WORLD_RENDER_WGSL,
} from './particles-wgsl';

interface FakeTarget {
  depth: { view: unknown; width: number; height: number } | null;
}

function makeSystem(opts: ParticleSystemOptions = {}) {
  const fake = createFakeDevice();
  const target: FakeTarget = { depth: null };
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    target,
  } as unknown as Renderer;
  const ps = new ParticleSystem(renderer, { capacity: 256, ...opts });
  return { fake, ps, target };
}

function depthTexture(fake: FakeDevice, width: number, height: number) {
  const t = fake.device.createTexture({
    label: 'scene-depth',
    size: [width, height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return { texture: t, view: t.createView(), width, height };
}

const DEPTH_FRAME = { depthFormat: 'depth24plus' } as unknown as Frame;
const FLAT_FRAME = { depthFormat: null } as unknown as Frame;

/** The spawn staging array `prepare` uploads (read it before `prepare`). */
function spawnFloats(ps: ParticleSystem): Float32Array {
  return (ps as unknown as { spawnData: Float32Array }).spawnData;
}

function simFloats(ps: ParticleSystem): Float32Array {
  return (ps as unknown as { simData: Float32Array }).simData;
}

function lastPipeline(fake: FakeDevice) {
  const cmd = fake.passes.at(-1)!.commands.find((c) => c.op === 'setPipeline');
  return (cmd as { pipeline: { label: string; desc: GPURenderPipelineDescriptor } }).pipeline;
}

function lastBindGroup(fake: FakeDevice, index: number) {
  const cmd = fake.passes
    .at(-1)!
    .commands.find((c) => c.op === 'setBindGroup' && (c as { index: number }).index === index);
  return (cmd as { group: { label: string; entries: GPUBindGroupEntry[] } }).group;
}

function scenePass(fake: FakeDevice) {
  return fake.device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
}

/** FNV-1a, enough to pin a shader's text. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

describe('ParticleSystem 2D (E-008: pixel-identical)', () => {
  it('keeps the 2D shaders byte-for-byte', () => {
    expect(hash(PARTICLE_COMPUTE_WGSL)).toBe('8b94fc4d');
    expect(hash(PARTICLE_RENDER_WGSL.replace(WGSL_GLOBALS, ''))).toBe('f08a73e2');
  });

  it('compiles the 2D shaders and writes the 28-float spawn record as before', () => {
    const { fake, ps } = makeSystem();
    const modules = fake.passes; // no passes yet
    expect(modules).toHaveLength(0);
    expect(ps.space).toBe('2d');
    expect(fake.buffers.find((b) => b.label === 'particles')!.size).toBe(256 * 80);
    ps.emit(
      {
        x: 10,
        y: 20,
        shape: { kind: 'rect', width: 4, height: 5 },
        colorStart: [1, 0.5, 0.25, 1],
        gravity: [1, 2],
      },
      8,
    );
    const d = spawnFloats(ps);
    expect([...d.subarray(0, 8)]).toEqual([
      10,
      20,
      4,
      5,
      -Math.fround(Math.PI / 2),
      Math.fround(Math.PI * 2),
      80,
      300,
    ]);
    expect([...d.subarray(8, 12)]).toEqual([0.5, Math.fround(1.2), 6, 1]);
    expect([...d.subarray(12, 20)]).toEqual([1, 0.5, 0.25, 1, 1, 0.5, 0.25, 0]);
    expect([...d.subarray(20, 24)]).toEqual([1, 2, 1, 2]);
    expect([d[24], d[25], d[27]]).toEqual([0, 8, 1]);
  });

  it('maps box to rect and sphere to circle in 2D', () => {
    const { ps } = makeSystem();
    ps.emit(
      { x: 0, y: 0, shape: { kind: 'box', width: 3, height: 4, depth: 9 }, colorStart: [1, 1, 1] },
      1,
    );
    ps.emit({ x: 0, y: 0, shape: { kind: 'sphere', radius: 7 }, colorStart: [1, 1, 1] }, 1);
    const d = spawnFloats(ps);
    expect([d[2], d[3], d[23]]).toEqual([3, 4, 2]);
    expect([d[28 + 2], d[28 + 3], d[28 + 23]]).toEqual([7, 0, 1]);
  });

  it('builds no depth copy and no texture binding in 2D', () => {
    const { fake, ps, target } = makeSystem();
    target.depth = depthTexture(fake, 8, 8);
    const enc = fake.device.createCommandEncoder();
    ps.update(1 / 60);
    ps.prepare(enc, DEPTH_FRAME);
    expect(fake.passes.filter((p) => p.kind === 'render')).toHaveLength(0);
    expect(fake.textures.filter((t) => t.label?.startsWith('particles'))).toHaveLength(0);
    ps.draw(scenePass(fake), FLAT_FRAME);
    expect(lastBindGroup(fake, 1).entries).toHaveLength(2);
  });
});

describe('ParticleSystem world space', () => {
  it('uses the world shaders, the lighting block and a 112-byte particle', () => {
    const { fake, ps } = makeSystem({ space: 'world' });
    expect(ps.space).toBe('world');
    expect(fake.buffers.find((b) => b.label === 'particles')!.size).toBe(256 * 112);
    expect(PARTICLE_WORLD_RENDER_WGSL).toContain(WGSL_LIGHTS);
    ps.draw(scenePass(fake), FLAT_FRAME);
    const p = lastPipeline(fake);
    expect(p.label).toBe('particles-world');
    expect((p.desc.vertex.module as unknown as { code: string }).code).toBe(
      PARTICLE_WORLD_RENDER_WGSL,
    );
    ps.draw(scenePass(fake), DEPTH_FRAME);
    const d = lastPipeline(fake);
    expect(d.label).toBe('particles-world:depth24plus');
    expect(d.desc.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
  });

  it('writes position z, 3D shapes, vz, gravity xyz, wind and drag', () => {
    const { fake, ps } = makeSystem({ space: 'world' });
    ps.emit(
      {
        x: 1,
        y: 2,
        z: 3,
        shape: { kind: 'box', width: 4, height: 5, depth: 6 },
        angle: -Math.PI / 2,
        spread: 0.5,
        speed: [7, 8],
        vz: 9,
        life: [1, 2],
        size: [0.2, 0.1],
        colorStart: [1, 1, 1, 0.5],
        gravity: [0, -1, 0.5],
        wind: [2, 0, -1],
        drag: 0.3,
        emissive: 0.25,
      },
      16,
    );
    const d = spawnFloats(ps);
    expect([...d.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...d.subarray(4, 8)]).toEqual([4, 5, 6, 0.5]);
    expect([...d.subarray(8, 12)]).toEqual([-Math.fround(Math.PI / 2), 9, 7, 8]);
    expect([...d.subarray(12, 16)]).toEqual([1, 2, Math.fround(0.2), Math.fround(0.1)]);
    expect([...d.subarray(16, 24)]).toEqual([1, 1, 1, 0.5, 1, 1, 1, 0]);
    expect([...d.subarray(24, 28)]).toEqual([0, -1, 0.5, Math.fround(0.3)]);
    expect([...d.subarray(28, 32)]).toEqual([2, 0, -1, 0.25]);
    expect([d[32], d[33]]).toEqual([0, 16]);
    // Defaults: y-up gravity, sphere spread, up, world-sized.
    ps.emit({ x: 0, y: 0, shape: { kind: 'sphere', radius: 2 }, colorStart: [1, 1, 1] }, 1);
    const o = 36;
    expect(d[o + 3]).toBe(5);
    expect(d[o + 4]).toBe(2);
    expect(d[o + 8]).toBe(Math.fround(Math.PI / 2));
    expect([d[o + 10], d[o + 11]]).toEqual([0.5, 2]);
    expect([d[o + 14], d[o + 15]]).toEqual([Math.fround(0.1), Math.fround(0.02)]);
    expect([d[o + 24], d[o + 25], d[o + 26]]).toEqual([0, Math.fround(-9.8), 0]);
    expect([d[o + 28], d[o + 29], d[o + 30]]).toEqual([0, 0, 0]);
    // A 2D gravity pair has z 0.
    ps.emit({ x: 0, y: 0, colorStart: [1, 1, 1], gravity: [0, -2] }, 1);
    expect(d[72 + 26]).toBe(0);
    const enc = fake.device.createCommandEncoder();
    ps.prepare(enc);
    const spawn = fake.writes.find((w) => w.buffer.label === 'particle-spawns')!;
    expect(spawn.bytes).toBe(3 * 36 * 4);
    expect(fake.errors).toEqual([]);
  });

  it('uploads fade, softness and lit in the sim block', () => {
    const { fake, ps } = makeSystem({
      space: 'world',
      lit: true,
      fade: { near: 10, far: 30 },
      softness: 0.5,
    });
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    const s = simFloats(ps);
    expect(s).toHaveLength(16);
    expect([s[8], s[9], s[10], s[11], s[12]]).toEqual([10, 30, 0.5, 0, 1]);
    ps.lit = false;
    ps.fade = null;
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    expect([s[8], s[9], s[12]]).toEqual([0, 0, 0]);
    // The world floor defaults to none (far below).
    expect(s[1]).toBeLessThan(-1e8);
  });

  it('copies scene depth before the scene pass and samples the copy (soft particles)', () => {
    const { fake, ps, target } = makeSystem({ space: 'world' });
    // No depth texture yet (first frame): soft off, the 1×1 stand-in is bound.
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(fake.passes.filter((p) => p.kind === 'render')).toHaveLength(0);
    expect(simFloats(ps)[11]).toBe(0);
    ps.draw(scenePass(fake), DEPTH_FRAME);
    const none = lastBindGroup(fake, 1);
    expect(none.label).toBe('particles-world-render');
    expect((none.entries[2]!.resource as unknown as { texture: FakeTexture }).texture.label).toBe(
      'particles-depth-none',
    );

    target.depth = depthTexture(fake, 64, 32);
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    const copy = fake.passes.find((p) => p.label === 'particles-depth-copy')!;
    expect(copy.kind).toBe('render');
    expect(copy.commands.map((c) => c.op)).toEqual([
      'setPipeline',
      'setBindGroup',
      'draw',
      'other',
    ]);
    const copyTex = fake.textures.find((t) => t.label === 'particles-depth')!;
    expect([copyTex.width, copyTex.height, copyTex.format]).toEqual([64, 32, 'depth32float']);
    expect(copyTex.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
    expect(simFloats(ps)[11]).toBe(1);
    ps.draw(scenePass(fake), DEPTH_FRAME);
    const soft = lastBindGroup(fake, 1);
    expect(soft.label).toBe('particles-world-render-soft');
    expect((soft.entries[2]!.resource as unknown as { texture: FakeTexture }).texture).toBe(
      copyTex,
    );

    // Steady state: no new textures or bind groups.
    const textures = fake.textures.length;
    const groups = fake.bindGroups.length;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(fake.textures.length).toBe(textures);
    expect(fake.bindGroups.length).toBe(groups);

    // A resized target: the copy follows it.
    target.depth = depthTexture(fake, 128, 64);
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(copyTex.destroyed).toBe(true);
    const resized = fake.textures.filter((t) => t.label === 'particles-depth').at(-1)!;
    expect([resized.width, resized.height]).toEqual([128, 64]);

    // A flat frame (no depth camera) or softness 0 turns it off.
    const passes = fake.passes.length;
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    expect(simFloats(ps)[11]).toBe(0);
    ps.softness = 0;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(simFloats(ps)[11]).toBe(0);
    expect(fake.passes.slice(passes).filter((p) => p.kind === 'render')).toHaveLength(0);
    expect(fake.errors).toEqual([]);
  });

  it('readsDepth: no copy pass of its own; afterOpaque binds the renderer copy (ws/render-hooks)', () => {
    const { fake, ps, target } = makeSystem({ space: 'world', readsDepth: true });
    expect(ps.readsDepth).toBe(true);
    target.depth = depthTexture(fake, 64, 32);
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    // Own copy pass and texture are gone; the soft flag is off until the hook.
    expect(fake.passes.filter((p) => p.label === 'particles-depth-copy')).toHaveLength(0);
    expect(fake.textures.filter((t) => t.label === 'particles-depth')).toHaveLength(0);
    expect(simFloats(ps)[11]).toBe(0);
    ps.draw(scenePass(fake), DEPTH_FRAME);
    expect(lastBindGroup(fake, 1).label).toBe('particles-world-render');

    const copyTex = fake.device.createTexture({
      label: 'scene-depth-copy',
      size: [64, 32],
      format: 'depth24plus',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const view: ViewInfo = {
      camera: null as never,
      target: target as never,
      depthCopy: copyTex,
      depthView: copyTex.createView(),
      viewport: { x: 0, y: 0, width: 64, height: 32 },
    };
    const writes = fake.writes.length;
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    expect(simFloats(ps)[11]).toBe(1);
    expect(fake.writes.slice(writes)).toEqual([
      { buffer: fake.buffers.find((b) => b.label === 'particle-sim'), offset: 44, bytes: 4 },
    ]);
    ps.draw(scenePass(fake), DEPTH_FRAME);
    const hook = lastBindGroup(fake, 1);
    expect(hook.label).toBe('particles-world-render-hook');
    expect((hook.entries[2]!.resource as unknown as { texture: FakeTexture }).texture).toBe(
      copyTex,
    );

    // Steady state: same copy view, no new group; softness 0 ignores the hook.
    const groups = fake.bindGroups.length;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    expect(simFloats(ps)[11]).toBe(0);
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    expect(fake.bindGroups.length).toBe(groups);
    ps.softness = 0;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    expect(simFloats(ps)[11]).toBe(0);
    ps.draw(scenePass(fake), DEPTH_FRAME);
    expect(lastBindGroup(fake, 1).label).toBe('particles-world-render');
    expect(fake.errors).toEqual([]);
  });

  it('reads depth from depthTarget when given', () => {
    const { fake, ps, target } = makeSystem({ space: 'world' });
    target.depth = depthTexture(fake, 8, 8);
    const other = { depth: depthTexture(fake, 16, 4) };
    ps.depthTarget = other as never;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    const copy = fake.textures.find((t) => t.label === 'particles-depth')!;
    expect([copy.width, copy.height]).toEqual([16, 4]);
  });
});

describe('ParticleSystem.alive', () => {
  it('counts on the GPU and reads the count back a frame later', async () => {
    (globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1, WRITE: 2 };
    const { fake, ps } = makeSystem({ space: 'world', countAlive: true });
    const read = fake.buffers.find((b) => b.label === 'particles-alive-read')! as unknown as {
      mapAsync: (mode: number) => Promise<void>;
      getMappedRange: () => ArrayBuffer;
      unmap: () => void;
    };
    let maps = 0;
    let unmaps = 0;
    read.mapAsync = () => {
      maps++;
      return Promise.resolve();
    };
    read.getMappedRange = () => new Uint32Array([42]).buffer;
    read.unmap = () => {
      unmaps++;
    };
    expect(ps.alive).toBe(-1);
    const copies: string[] = [];
    const enc = () => {
      const e = fake.device.createCommandEncoder();
      e.copyBufferToBuffer = ((src: { label: string }) => copies.push(src.label)) as never;
      return e;
    };
    ps.update(1 / 60);
    ps.prepare(enc());
    // Frame 1: count + copy recorded, nothing mapped yet.
    expect(fake.passes.at(-1)!.commands.filter((c) => c.op === 'dispatch')).toHaveLength(2);
    expect(copies).toEqual(['particles-alive']);
    expect(maps).toBe(0);
    // Frame 2: map last frame's copy; record no new copy.
    ps.update(1 / 60);
    ps.prepare(enc());
    expect(maps).toBe(1);
    expect(copies).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(ps.alive).toBe(42);
    expect(unmaps).toBe(1);
    // Frame 3: counting again.
    ps.prepare(enc());
    expect(copies).toHaveLength(2);
    expect(fake.errors).toEqual([]);
  });

  it('is off by default', () => {
    const { fake } = makeSystem();
    expect(fake.buffers.some((b) => b.label === 'particles-alive')).toBe(false);
  });
});
