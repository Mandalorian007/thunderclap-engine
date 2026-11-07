import { describe, expect, it } from 'vitest';
import {
  createFakeDevice,
  type FakeDevice,
  type FakeTexture,
  fakeSceneTargets,
} from '../render/fake-gpu';
import type { Frame, ViewInfo } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { WGSL_GLOBALS, WGSL_LIGHTS } from '../render/wgsl';
import { buildEmitSurface } from './emit-surface';
import {
  applyForces,
  type EmitParams,
  evaluateCurve,
  type ParticleForce,
  ParticleSystem,
  type ParticleSystemOptions,
} from './particles';
import {
  FX_PARTICLE_FLOATS,
  FX_SIM_FLOATS,
  FX_SPAWN_FLOATS,
  PARTICLE_COLLIDE_WGSL,
  PARTICLE_COMPUTE_WGSL,
  PARTICLE_EXT_COMPUTE_WGSL,
  PARTICLE_EXT_RENDER_WGSL,
  PARTICLE_RENDER_WGSL,
  PARTICLE_WORLD_COMPUTE_WGSL,
  PARTICLE_WORLD_RENDER_WGSL,
  SIZE_CURVE_FLOATS,
  SURFACE_TRI_FLOATS,
} from './particles-wgsl';

interface FakeTarget {
  depth: { view: unknown; width: number; height: number } | null;
  auxKey: number;
}

function makeSystem(opts: ParticleSystemOptions = {}) {
  const fake = createFakeDevice();
  const target: FakeTarget = { depth: null, auxKey: 0 };
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    sceneTargets: fakeSceneTargets,
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

const DEPTH_FRAME = { depthFormat: 'depth24plus', auxKey: 0 } as unknown as Frame;
const FLAT_FRAME = { depthFormat: null, auxKey: 0 } as unknown as Frame;

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
  it('uses the world shaders, the lighting block and a 160-byte particle', () => {
    const { fake, ps } = makeSystem({ space: 'world' });
    expect(ps.space).toBe('world');
    expect(fake.buffers.find((b) => b.label === 'particles')!.size).toBe(
      256 * FX_PARTICLE_FLOATS * 4,
    );
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
    const o = FX_SPAWN_FLOATS;
    expect(d[o + 3]).toBe(5);
    expect(d[o + 4]).toBe(2);
    expect(d[o + 8]).toBe(Math.fround(Math.PI / 2));
    expect([d[o + 10], d[o + 11]]).toEqual([0.5, 2]);
    expect([d[o + 14], d[o + 15]]).toEqual([Math.fround(0.1), Math.fround(0.02)]);
    expect([d[o + 24], d[o + 25], d[o + 26]]).toEqual([0, Math.fround(-9.8), 0]);
    expect([d[o + 28], d[o + 29], d[o + 30]]).toEqual([0, 0, 0]);
    // A 2D gravity pair has z 0.
    ps.emit({ x: 0, y: 0, colorStart: [1, 1, 1], gravity: [0, -2] }, 1);
    expect(d[2 * FX_SPAWN_FLOATS + 26]).toBe(0);
    const enc = fake.device.createCommandEncoder();
    ps.prepare(enc);
    const spawn = fake.writes.find((w) => w.buffer.label === 'particle-spawns')!;
    expect(spawn.bytes).toBe(3 * FX_SPAWN_FLOATS * 4);
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
    expect(s).toHaveLength(FX_SIM_FLOATS);
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
    const { fake, ps } = makeSystem({ space: 'world', countAlive: true });
    const count = fake.buffers.find((b) => b.label === 'particles-alive')!;
    const read = fake.buffers.find((b) => b.label === 'particles-alive-read')!;
    // The count kernel's result (ws/render-9: the fake runs the copy and the map for real).
    let counted = [42, 7];
    fake.runPass = (pass) => {
      if (pass.kind === 'compute') count.data.set(new Uint8Array(new Uint32Array(counted).buffer));
    };
    const frame = () => {
      const e = fake.device.createCommandEncoder();
      ps.prepare(e);
      fake.device.queue.submit([e.finish()]);
    };
    const copied = () => fake.bufferCopies.map((c) => `${c.src.label}→${c.dst.label}`);
    expect(ps.alive).toBe(-1);
    ps.update(1 / 60);
    frame();
    // Frame 1: advance + update + count dispatched, the copy recorded, nothing mapped yet.
    expect(fake.passes.at(-1)!.commands.filter((c) => c.op === 'dispatch')).toHaveLength(3);
    expect(copied()).toEqual(['particles-alive→particles-alive-read']);
    expect(read.mapState).toBe('unmapped');
    // Frame 2: map last frame's copy; record no new copy.
    counted = [1, 1];
    ps.update(1 / 60);
    frame();
    expect(read.mapState).toBe('pending');
    expect(copied()).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(ps.alive).toBe(42);
    expect(ps.below).toBe(7);
    expect(read.mapState).toBe('unmapped');
    // Frame 3: counting again.
    frame();
    expect(copied()).toHaveLength(2);
    expect(fake.errors).toEqual([]);
  });

  it('is off by default', () => {
    const { fake } = makeSystem();
    expect(fake.buffers.some((b) => b.label === 'particles-alive')).toBe(false);
  });
});

// ------------------------------------------------------------------ extended kernel (ws/fx-3)

function fxTables(ps: ParticleSystem) {
  return (
    ps as unknown as {
      fx: { curveData: Float32Array; subData: Float32Array; surfaceData: Float32Array };
    }
  ).fx;
}

function dispatches(fake: FakeDevice): number {
  return fake.passes.at(-1)!.commands.filter((c) => c.op === 'dispatch').length;
}

const BASE: EmitParams = { x: 10, y: 20, colorStart: [1, 1, 1, 1] };

describe('ParticleSystem extended kernel', () => {
  it('a plain 2D system keeps the legacy 80-byte particle; `extended` switches to 160 bytes', () => {
    const plain = makeSystem();
    expect(plain.fake.buffers.find((b) => b.label === 'particles')!.size).toBe(256 * 80);
    expect(plain.ps.extended).toBe(false);
    const ext = makeSystem({ extended: true });
    expect(ext.fake.buffers.find((b) => b.label === 'particles')!.size).toBe(
      256 * FX_PARTICLE_FLOATS * 4,
    );
    expect(ext.ps.extended).toBe(true);
    expect(ext.fake.errors).toEqual([]);
  });

  it('writes tile, tile rate, rotation, spin and the align flag into the 52-float record', () => {
    const { fake, ps } = makeSystem({ extended: true });
    ps.emit(
      {
        ...BASE,
        tile: [5, 15],
        tileRate: 2,
        rotation: [0.1, 0.2],
        spin: [-1, 1],
        alignToVelocity: false,
      },
      3,
    );
    const d = spawnFloats(ps);
    expect(Array.from(d.subarray(36, 44))).toEqual([5, 15, 2, 0, 0.1, 0.2, -1, 1].map(Math.fround));
    expect(Array.from(d.subarray(44, 48))).toEqual([-1, -1, -1, -1]);
    expect(d[33]).toBe(3);
    ps.emit({ ...BASE, tile: 7 }, 1);
    const o = FX_SPAWN_FLOATS;
    expect(Array.from(d.subarray(o + 36, o + 40))).toEqual([7, 7, 0, 1]);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    // Untextured: a 1×1 white sheet is bound and the textured flag is 0.
    const s = simFloats(ps);
    expect(s[13]).toBe(0);
    expect(fake.textures.some((t) => t.label === 'particles-sheet-none')).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('a sprite sheet sets the textured flag and the atlas grid, and binds the sheet', () => {
    const fake0 = createFakeDevice();
    const sheetTex = fake0.device.createTexture({
      label: 'sheet',
      size: [64, 64],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const { fake, ps } = makeSystem({
      texture: { view: sheetTex.createView(), width: 64, height: 64 },
      atlas: { columns: 4, rows: 4 },
    });
    expect(ps.extended).toBe(true);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    const s = simFloats(ps);
    expect([s[13], s[14], s[15]]).toEqual([1, 4, 4]);
    ps.draw(scenePass(fake), FLAT_FRAME);
    const group = lastBindGroup(fake, 1);
    expect(group.entries.some((e) => e.binding === 4)).toBe(true);
    expect(group.entries.some((e) => e.binding === 5)).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('interns size and colour curves into the table and the record; the CPU reference agrees', () => {
    const { fake, ps } = makeSystem({ extended: true, maxCurves: 4 });
    const sizeCurve = [1, 2, 3];
    const colorCurve = [
      [1, 0, 0, 1],
      [0, 1, 0, 0.5],
    ];
    ps.emit({ ...BASE, sizeCurve, colorCurve }, 1);
    const d = spawnFloats(ps);
    expect(d[44]).toBe(0);
    expect(d[45]).toBe(0);
    const t = fxTables(ps).curveData;
    expect(Array.from(t.subarray(0, 4))).toEqual([3, 1, 2, 3]);
    const colorBase = 4 * SIZE_CURVE_FLOATS;
    expect(simFloats(ps)[17]).toBe(colorBase);
    expect(t[colorBase]).toBe(2);
    expect(Array.from(t.subarray(colorBase + 4, colorBase + 12))).toEqual([
      1, 0, 0, 1, 0, 1, 0, 0.5,
    ]);
    // Same array identity: same slot; a new array: the next slot.
    ps.emit({ ...BASE, sizeCurve }, 1);
    expect(d[FX_SPAWN_FLOATS + 44]).toBe(0);
    ps.emit({ ...BASE, sizeCurve: [4, 5] }, 1);
    expect(d[2 * FX_SPAWN_FLOATS + 44]).toBe(1);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    expect(fake.writes.some((w) => w.buffer.label === 'particles-curves')).toBe(true);
    expect(() => ps.emit({ ...BASE, sizeCurve: [1] }, 1)).toThrow(/2\.\.8 stops/);
    expect(() => ps.emit({ ...BASE, sizeCurve: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 1)).toThrow(
      /2\.\.8 stops/,
    );

    const out = new Float32Array(4);
    expect(evaluateCurve(sizeCurve, 1, 0, out)[0]).toBe(1);
    expect(evaluateCurve(sizeCurve, 1, 0.5, out)[0]).toBe(2);
    expect(evaluateCurve(sizeCurve, 1, 1, out)[0]).toBe(3);
    expect(evaluateCurve([10, 0], 1, 0.5, out)[0]).toBe(5);
    const flat = [1, 0, 0, 1, 0, 1, 0, 0.5];
    expect(Array.from(evaluateCurve(flat, 4, 0, out))).toEqual([1, 0, 0, 1]);
    expect(Array.from(evaluateCurve(flat, 4, 0.5, out))).toEqual([0.5, 0.5, 0, 0.75]);
    expect(Array.from(evaluateCurve(flat, 4, 1, out))).toEqual([0, 1, 0, 0.5]);
    expect(fake.errors).toEqual([]);
  });

  it('uploads the live forces array into the sim block (max 8)', () => {
    const { fake, ps } = makeSystem({
      space: 'world',
      forces: [{ kind: 'attract', x: 1, y: 2, z: 3, strength: 4, radius: 5 }],
    });
    ps.forces.push({ kind: 'vortex', axis: [0, 1, 0], x: 0, y: 0, strength: 2 });
    ps.forces.push({ kind: 'turbulence', frequency: 0.5, strength: 3, seed: 9 });
    ps.forces.push({ kind: 'drag', amount: 0.7 });
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    const s = simFloats(ps);
    expect(s[16]).toBe(4);
    expect(Array.from(s.subarray(20, 26))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(s.subarray(32, 44))).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0]);
    expect(Array.from(s.subarray(44, 52))).toEqual([2, 0, 0, 0, 3, 0, 0.5, 9]);
    expect(s[56]).toBe(3);
    expect(s[67]).toBeCloseTo(0.7);
    for (let i = 0; i < 10; i++) ps.forces.push({ kind: 'drag', amount: 1 });
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    expect(s[16]).toBe(8);
    expect(fake.errors).toEqual([]);
  });

  it('applyForces: an attractor pulls a parked particle toward its point', () => {
    const pos = [10, 0, 0];
    const vel = new Float32Array(3);
    const forces = [{ kind: 'attract', x: 0, y: 0, z: 0, strength: 10 }] as const;
    applyForces(forces, pos, vel, 0.1);
    expect(vel[0]).toBeCloseTo(-1);
    expect(vel[1]).toBeCloseTo(0);
    for (let i = 0; i < 10; i++) {
      applyForces(forces, pos, vel, 0.1);
      pos[0]! += vel[0]! * 0.1;
    }
    expect(pos[0]).toBeLessThan(9);
    const spun = new Float32Array([0, 0, 0]);
    applyForces(
      [{ kind: 'vortex', axis: [0, 1, 0], x: 0, y: 0, z: 0, strength: 1 }],
      [1, 0, 0],
      spun,
      1,
    );
    expect(spun[1]).toBeCloseTo(0);
    expect(Math.abs(spun[2]!)).toBeCloseTo(1);
    const dragged = new Float32Array([2, 0, 0]);
    applyForces([{ kind: 'drag', amount: Math.LN2 }], [0, 0, 0], dragged, 1);
    expect(dragged[0]).toBeCloseTo(1);
  });

  it('applyForces: attract falloff and dead zone (constant is the default)', () => {
    const pull = (f: Partial<Extract<ParticleForce, { kind: 'attract' }>>, r: number) => {
      const vel = new Float32Array(3);
      applyForces([{ kind: 'attract', x: 0, y: 0, z: 0, strength: 2, ...f }], [r, 0, 0], vel, 1);
      return -vel[0]!;
    };
    expect(pull({}, 4)).toBeCloseTo(2);
    expect(pull({ falloff: 'constant' }, 4)).toBeCloseTo(2);
    expect(pull({ falloff: 'linear' }, 4)).toBeCloseTo(8);
    expect(pull({ falloff: 'inverse-square' }, 4)).toBeCloseTo(2 / 16);
    // The reach still fades on top of the falloff.
    expect(pull({ falloff: 'linear', radius: 8 }, 4)).toBeCloseTo(4);
    expect(pull({ deadZone: 0.5 }, 0.4)).toBeCloseTo(0);
    expect(pull({ falloff: 'inverse-square', deadZone: 0.5 }, 0.5)).toBeCloseTo(8);
    // Without a dead zone, inverse-square stays finite next to the point.
    expect(Number.isFinite(pull({ falloff: 'inverse-square' }, 1e-3))).toBe(true);
  });

  it('applyForces: a spring pull with drag gathers a shell; constant pull with light drag orbits through', () => {
    // The fx3?forces setup: a shell of radius 3 at rest, a weak vortex, 6 s at 60 Hz.
    const within = (
      attract: Partial<Extract<ParticleForce, { kind: 'attract' }>>,
      drag: number,
    ) => {
      const forces: ParticleForce[] = [
        { kind: 'attract', x: 0, y: 0, z: 0, strength: 4, ...attract },
        { kind: 'vortex', axis: [0, 1, 0], x: 0, y: 0, z: 0, strength: 0.35, radius: 6 },
        { kind: 'drag', amount: drag },
      ];
      const pos: number[][] = [];
      const vel: Float32Array[] = [];
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const b = ((i % 8) / 8 - 0.5) * Math.PI;
        pos.push([3 * Math.cos(a) * Math.cos(b), 3 * Math.sin(b), 3 * Math.sin(a) * Math.cos(b)]);
        vel.push(new Float32Array(3));
      }
      let near = 0;
      let samples = 0;
      for (let f = 0; f < 360; f++) {
        for (let i = 0; i < 64; i++) {
          const p = pos[i]!;
          const v = vel[i]!;
          applyForces(forces, p, v, 1 / 60);
          for (let k = 0; k < 3; k++) p[k]! += v[k]! / 60;
          if (f >= 120) {
            samples++;
            if (Math.hypot(p[0]!, p[1]!, p[2]!) < 0.3) near++;
          }
        }
      }
      return near / samples;
    };
    // Measured: constant at drag 0.4 is within 0.3 of the point 9% of the time from 2 s on.
    expect(within({}, 0.4)).toBeLessThan(0.2);
    // Linear at drag 3 is there 100% of the time from 2 s on.
    expect(within({ falloff: 'linear' }, 3)).toBeGreaterThan(0.95);
  });

  it('uploads attract falloff and dead zone into the force block', () => {
    const { fake, ps } = makeSystem({
      space: 'world',
      forces: [
        { kind: 'attract', x: 0, y: 0, strength: 1 },
        { kind: 'attract', x: 0, y: 0, strength: 1, falloff: 'linear', deadZone: 0.25 },
        { kind: 'attract', x: 0, y: 0, strength: 1, falloff: 'inverse-square' },
      ],
    });
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    const s = simFloats(ps);
    expect(Array.from(s.subarray(28, 30))).toEqual([0, 0]);
    expect(Array.from(s.subarray(40, 42))).toEqual([1, 0.25]);
    expect(Array.from(s.subarray(52, 54))).toEqual([2, 0]);
    expect(PARTICLE_WORLD_COMPUTE_WGSL).toContain('r >= f.c.y');
    expect(fake.errors).toEqual([]);
  });

  it('collide pushes out along the surface normal, not back along the view ray', () => {
    // A view-ray push moves a resting drop toward the camera every frame (ws/fx-5: drops born
    // 3 units from the fx3 slab's front edge crept off it in 1.8 s).
    expect(PARTICLE_COLLIDE_WGSL).toContain(
      'p.pos.xyz + n * (max(dot(hit - p.pos.xyz, n), 0.0) + 1e-3)',
    );
    expect(PARTICLE_COLLIDE_WGSL).not.toContain('hit - ray * 1e-3');
  });

  it('collide takes the surface normal from pixel centres, not from the sub-pixel hit', () => {
    // Differences from `hit` tilted a resting drop's normal by a fixed amount and slid it
    // 0.13 units/s across the fx3 slab (ws/fx-6, read back with debugReadback); 0.0008 after.
    expect(PARTICLE_COLLIDE_WGSL).not.toContain('dims) - hit');
    expect(PARTICLE_COLLIDE_WGSL).toContain('let c = scene_at(px, dims);');
    expect(PARTICLE_COLLIDE_WGSL).toContain('select(lx, rx, dot(rx, rx) < dot(lx, lx))');
  });

  it('pins the extended kernels: the world kernel carries the force step, the 2D legacy one does not', () => {
    for (const name of ['attract', 'vortex', 'curl', 'surface_tri', 'subspawn', 'advance']) {
      expect(PARTICLE_WORLD_COMPUTE_WGSL).toContain(name);
      expect(PARTICLE_EXT_COMPUTE_WGSL).toContain(name);
      expect(PARTICLE_COMPUTE_WGSL).not.toContain(name);
    }
    expect(PARTICLE_EXT_RENDER_WGSL).toContain('sheet');
    expect(PARTICLE_COLLIDE_WGSL).toContain('thickness');
    expect(hash(PARTICLE_WORLD_COMPUTE_WGSL)).toMatchInlineSnapshot(`"fb795e2c"`);
    expect(hash(PARTICLE_EXT_COMPUTE_WGSL)).toMatchInlineSnapshot(`"95490997"`);
    expect(hash(PARTICLE_COLLIDE_WGSL)).toMatchInlineSnapshot(`"825d24ed"`);
  });

  it('sub-emission: interns onDeath/onLife descriptors one level deep and dispatches subspawn', () => {
    const { fake, ps } = makeSystem({ extended: true, maxSubEmitters: 2 });
    const child: EmitParams = { x: 0, y: 0, colorStart: [0, 1, 0, 1], size: [2, 1] };
    const onDeath = { params: { ...child, onDeath: { params: child, count: 9 } }, count: 4 };
    const onLife = { params: child, rate: 30 };
    ps.emit({ ...BASE, onDeath, onLife, inherit: 0.5 }, 2);
    const d = spawnFloats(ps);
    expect(Array.from(d.subarray(46, 52))).toEqual([0, 1, 4, 30, 0, 0]);
    expect(d[35]).toBe(0.5);
    const subs = fxTables(ps).subData;
    expect(subs[14]).toBe(2); // the child's size0 in slot 0
    expect(subs[35]).toBe(0.5); // inherit
    expect(subs[46]).toBe(-1); // the grandchild is not interned: one level only
    expect(subs[FX_SPAWN_FLOATS + 35]).toBe(0.5);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), FLAT_FRAME);
    // spawn + advance + update + subspawn
    expect(dispatches(fake)).toBe(4);
    expect(fake.writes.some((w) => w.buffer.label === 'particles-subs')).toBe(true);
    const plain = makeSystem({ extended: true });
    plain.ps.update(1 / 60);
    plain.ps.prepare(plain.fake.device.createCommandEncoder(), FLAT_FRAME);
    expect(dispatches(plain.fake)).toBe(2); // advance + update, no subspawn
    expect(fake.errors).toEqual([]);
  });

  it('mesh emission: appends the surface table and records the triangle range', () => {
    const { fake, ps } = makeSystem({ space: 'world' });
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0];
    const surface = buildEmitSurface({ positions }, { alongNormal: true });
    ps.emit({ ...BASE, shape: surface }, 1);
    const d = spawnFloats(ps);
    expect(d[3]).toBe(6);
    expect(d[39]).toBe(3); // align | alongNormal
    expect(d[50]).toBe(0);
    expect(d[51]).toBe(2);
    ps.emit({ ...BASE, shape: { kind: 'mesh', positions: positions.slice(0, 9) } }, 1);
    expect(d[FX_SPAWN_FLOATS + 50]).toBe((2 * SURFACE_TRI_FLOATS) / 4);
    expect(d[FX_SPAWN_FLOATS + 51]).toBe(1);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    const buf = fake.buffers.filter((b) => b.label === 'particles-surface').at(-1)!;
    expect(buf.size).toBeGreaterThanOrEqual(3 * SURFACE_TRI_FLOATS * 4);
    expect(fake.writes.some((w) => w.buffer === buf)).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('collide: a depth-collision pass runs in afterOpaque against the renderer copy', () => {
    const { fake, ps, target } = makeSystem({
      space: 'world',
      readsDepth: true,
      collide: { bounce: 0.5, friction: 0.2 },
    });
    target.depth = depthTexture(fake, 64, 32);
    ps.update(1 / 60);
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    const copyTex = fake.device.createTexture({
      label: 'scene-depth-copy',
      size: [64, 32],
      format: 'depth24plus',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const camera = {
      viewProjection: new Float32Array(16).fill(1),
      invViewProj: new Float32Array(16).fill(2),
    };
    const view: ViewInfo = {
      camera: camera as never,
      target: target as never,
      depthCopy: copyTex,
      depthView: copyTex.createView(),
      viewport: { x: 0, y: 0, width: 64, height: 32 },
    };
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    const pass = fake.passes.at(-1)!;
    expect(pass.label).toBe('particles-collide');
    expect(pass.commands.filter((c) => c.op === 'dispatch')).toHaveLength(1);
    const uniform = fake.buffers.find((b) => b.label === 'particles-collide-params')!;
    expect(uniform.size).toBe(160);
    const data = (ps as unknown as { collider: { data: Float32Array } }).collider.data;
    expect(Array.from(data.subarray(32, 40))).toEqual([
      0,
      0,
      64,
      32,
      0.5,
      Math.fround(0.2),
      1,
      Math.fround(1 / 60),
    ]); // the last step dt rides in w for the swept test
    // Collision is independent of the soft fade.
    ps.softness = 0;
    const passes = fake.passes.length;
    ps.prepare(fake.device.createCommandEncoder(), DEPTH_FRAME);
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    expect(fake.passes.slice(passes).some((p) => p.label === 'particles-collide')).toBe(true);
    ps.collide = null;
    const count = fake.passes.length;
    ps.afterOpaque(fake.device.createCommandEncoder(), view);
    expect(fake.passes.length).toBe(count);
    expect(fake.errors).toEqual([]);
  });
});
