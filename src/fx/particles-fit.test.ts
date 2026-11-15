/**
 * ws/fx-fit: core particles fitted to a 3D game's renderer (fake GPU). A configurable pass, an
 * indirect draw of the live window only (the bundle kept while it moves), idle with no compute
 * while nothing is alive (the core warms the pipeline then), and the emit options a game's
 * debris needs: a 3D axis, colour jitter, flutter and flat boxes. Box light carries fog.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type CoreTarget, createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { LiveWindow, ParticleSystem } from './particles';
import type { ParticleBoxLight } from './particles-core';
import {
  FX_SPAWN_FLOATS,
  PARTICLE_BOX_LIGHT_FLOATS,
  PARTICLE_CORE_BOX_WGSL,
  PARTICLE_CORE_RENDER_WGSL,
  PARTICLE_WORLD_COMPUTE_WGSL,
} from './particles-wgsl';

interface Rig {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  eye: RenderView;
  target: CoreTarget;
}

function rig(): Rig {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device);
  const c = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
  c.lookAt([0, 2, 10], [0, 0, 0]);
  const texture = device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: texture.createView(),
    texture,
    format: 'rgba8unorm',
    width: 64,
    height: 64,
  };
  return { fake, device, core, eye: setViewFromCamera(createRenderView(), c), target };
}

function frame(r: Rig): void {
  const enc = r.device.createCommandEncoder();
  r.core.prepare(enc, [r.eye]);
  r.core.draw(enc, 0, r.target);
  r.device.queue.submit([enc.finish()]);
}

const spawnFloats = (ps: ParticleSystem) =>
  (ps as unknown as { spawnData: Float32Array }).spawnData;
const simFloats = (ps: ParticleSystem) => (ps as unknown as { simData: Float32Array }).simData;
const bufferU32 = (r: Rig, label: string) => {
  const b = r.fake.buffers.find((x) => x.label === label)!;
  return new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.byteLength / 4);
};
const bufferF32 = (r: Rig, label: string) => {
  const b = r.fake.buffers.find((x) => x.label === label)!;
  return new Float32Array(b.data.buffer, b.data.byteOffset, b.data.byteLength / 4);
};
const computes = (r: Rig) => r.fake.passes.filter((p) => p.kind === 'compute').length;
const bundleDraws = (r: Rig) =>
  r.fake.bundles.flatMap((b) => b.commands).filter((c) => c.op.startsWith('draw'));

const burst = {
  x: 0,
  y: 1,
  z: 0,
  life: [0.5, 1] as [number, number],
  colorStart: [1, 0.6, 0.2, 1],
};

describe('core particles fitted (ws/fx-fit)', () => {
  it('joins the pass and order it is given', () => {
    const r = rig();
    r.core.definePass({ id: 'water', after: 'transparent', depth: 'read' });
    const ps = new ParticleSystem(r.core, { capacity: 64, pass: 'water', order: 5 });
    expect(ps.coreDrawable!.pass).toBe('water');
    expect(ps.coreDrawable!.order).toBe(5);
    const plain = new ParticleSystem(r.core, { capacity: 64 });
    expect(plain.coreDrawable!.pass).toBe('transparent');
    expect(plain.coreDrawable!.order).toBe(0);
    expect(() => new ParticleSystem(r.core, { pass: 'nowhere' })).toThrow(/nowhere/);
  });

  it('idle while nothing is alive: no compute, no draw, its pipeline warmed', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 256, shape: 'box', blend: 'alpha' });
    ps.update(1 / 60);
    frame(r);
    expect(ps.coreDrawable!.active).toBe(false);
    expect(ps.drawCount).toBe(0);
    expect(computes(r)).toBe(0);
    expect(bundleDraws(r)).toEqual([]);
    // The core gives an inactive drawable's pipeline its empty first draw.
    expect(r.core.stats.warmed).toBeGreaterThan(0);
    const renderWarm = r.fake.warmPasses.find((p) => p.kind === 'render')!;
    const ops = renderWarm.commands.map((c) => c.op);
    expect(ops).toContain('setPipeline');
    expect(renderWarm.commands.find((c) => c.op === 'draw')).toMatchObject({ vertices: 0 });
    // And its compute passes their empty first dispatches (ws/forge-asks-fit): spawn, advance,
    // update and sub-emission, each bound to the compute group.
    const computeWarm = r.fake.warmPasses.filter((p) => p.kind === 'compute');
    expect(computeWarm.length).toBe(1);
    const dispatches = computeWarm[0]!.commands.filter((c) => c.op === 'dispatch');
    expect(dispatches.length).toBe(4);
    expect(dispatches.every((c) => (c as { x: number }).x === 0)).toBe(true);
    ps.emit(burst, 10);
    ps.update(1 / 60);
    frame(r);
    expect(ps.coreDrawable!.active).toBe(true);
    expect(computes(r)).toBe(1);
    expect(r.fake.errors).toEqual([]);
  });

  it('warms no compute pipeline when the core does not warm (ws/forge-asks-fit)', () => {
    const r = rig();
    r.core.warmer.enabled = false;
    new ParticleSystem(r.core, { capacity: 64, countAlive: true });
    frame(r);
    expect(r.fake.warmPasses).toEqual([]);
    r.core.warmer.enabled = true;
    const ps = new ParticleSystem(r.core, { capacity: 64, countAlive: true });
    ps.destroy();
    frame(r);
    // A system destroyed before the next frame drops its queued warms.
    const computeWarm = r.fake.warmPasses.filter((p) => p.kind === 'compute');
    expect(computeWarm.flatMap((p) => p.commands).filter((c) => c.op === 'dispatch')).toEqual([]);
    expect(r.fake.errors).toEqual([]);
  });

  it('a counted system warms its counter too (ws/forge-asks-fit)', () => {
    const r = rig();
    new ParticleSystem(r.core, { capacity: 64, countAlive: true });
    frame(r);
    const cw = r.fake.warmPasses.filter((p) => p.kind === 'compute');
    expect(cw.flatMap((p) => p.commands).filter((c) => c.op === 'dispatch').length).toBe(5);
    expect(r.fake.errors).toEqual([]);
  });

  it('draws the live window indirectly; the bundle is kept while the count moves', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 256 });
    ps.emit(burst, 10);
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(10);
    expect(simFloats(ps)[19]).toBe(0);
    expect([...bufferU32(r, 'particles-core-draw')]).toEqual([6, 10, 0, 0]);
    ps.emit(burst, 20);
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(30);
    expect(simFloats(ps)[19]).toBe(0);
    expect(bufferU32(r, 'particles-core-draw')[1]).toBe(30);
    expect(r.core.stats.bundleBuilds).toBe(1);
    const draws = bundleDraws(r);
    expect(draws.map((c) => c.op)).toEqual(['drawIndirect']);
    // A second later the first emits are all dead: nothing to draw, idle again.
    for (let i = 0; i < 70; i++) {
      ps.update(1 / 60);
      frame(r);
    }
    expect(ps.drawCount).toBe(0);
    expect(ps.coreDrawable!.active).toBe(false);
    expect(bufferU32(r, 'particles-core-draw')[1]).toBe(0);
    // The next burst starts after the old ones in the ring.
    ps.emit(burst, 5);
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(5);
    expect(simFloats(ps)[19]).toBe(30);
    expect(r.core.stats.bundleBuilds).toBe(1);
    expect(r.fake.errors).toEqual([]);
  });

  it('the whole ring while sub-emitters claim slots on the GPU, or the window wraps', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 64 });
    ps.emit(burst, 50);
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(50);
    ps.emit(burst, 30);
    ps.update(1 / 60);
    frame(r);
    // 80 newest over a 64-slot ring: wraps, so the ring in slot order.
    expect(ps.drawCount).toBe(64);
    expect(simFloats(ps)[19]).toBe(0);
    const subs = new ParticleSystem(r.core, { capacity: 64 });
    subs.emit({ ...burst, onDeath: { params: burst, count: 2 } }, 4);
    subs.update(1 / 60);
    frame(r);
    expect(subs.drawCount).toBe(64);
  });

  it('clear() empties the window', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 64 });
    ps.emit(burst, 10);
    ps.update(1 / 60);
    frame(r);
    ps.clear();
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(0);
    ps.emit(burst, 3);
    ps.update(1 / 60);
    frame(r);
    expect(ps.drawCount).toBe(3);
    expect(simFloats(ps)[19]).toBe(0);
  });

  it('the shaders read the slot from drawBase and sway by the flutter', () => {
    for (const w of [PARTICLE_CORE_RENDER_WGSL, PARTICLE_CORE_BOX_WGSL]) {
      expect(w).toContain('let slot = core_particle_slot(ii);');
      expect(w).toContain('flutter_at(p, slot)');
    }
    expect(PARTICLE_CORE_BOX_WGSL).toContain('local * p.tile.xyz');
    expect(PARTICLE_CORE_BOX_WGSL).toContain('box_fog(lit, eye)');
    expect(PARTICLE_WORLD_COMPUTE_WGSL).toContain('if (cmd.l.w > 0.5) { axis = cmd.l.xyz; }');
    // The jitter's draw comes after every other draw, and only when asked for.
    const make = PARTICLE_WORLD_COMPUTE_WGSL.slice(
      PARTICLE_WORLD_COMPUTE_WGSL.indexOf('fn make('),
      PARTICLE_WORLD_COMPUTE_WGSL.indexOf('particles[idx] = p;'),
    );
    expect(make.lastIndexOf('rnd(st)')).toBeGreaterThan(make.indexOf('if (cmd.m.x > 0.0)'));
  });

  it('packs the axis, colour jitter, flutter and box scale into the spawn record', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 64, shape: 'box' });
    ps.emit(
      { ...burst, axis: [0, 0, 2], colorJitter: 0.2, flutter: 0.35, boxScale: [1, 0.25, 1] },
      4,
    );
    ps.emit(burst, 4);
    const d = spawnFloats(ps);
    expect([...d.subarray(36, 40)]).toEqual([1, 0.25, 1, 1]);
    expect([...d.subarray(52, 56)]).toEqual([0, 0, 2, 1]);
    expect([...d.subarray(56, 60)]).toEqual([Math.fround(0.2), Math.fround(0.35), 0, 0]);
    // Defaults: a cube, `angle`, no jitter or flutter.
    const o = FX_SPAWN_FLOATS;
    expect([...d.subarray(o + 36, o + 39)]).toEqual([1, 1, 1]);
    expect([...d.subarray(o + 52, o + 60)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // A quad system keeps its tiles there.
    const q = new ParticleSystem(r.core, { capacity: 64 });
    q.emit({ ...burst, tile: [2, 5], tileRate: 3 }, 1);
    expect([...spawnFloats(q).subarray(36, 39)]).toEqual([2, 5, 3]);
  });

  it('box light: a public type with fog, packed with the sun and ambient', () => {
    const r = rig();
    const ps = new ParticleSystem(r.core, { capacity: 64, shape: 'box' });
    const light: ParticleBoxLight = ps.coreDrawable!.boxLight;
    light.sunDir.set([0, -1, 0]);
    light.fog.color.set([0.5, 0.6, 0.7]);
    light.fog.density = 0.8;
    light.fog.near = 10;
    light.fog.far = 40;
    ps.emit(burst, 1);
    ps.update(1 / 60);
    frame(r);
    const d = bufferF32(r, 'particles-core-box-light');
    expect(d.length).toBe(PARTICLE_BOX_LIGHT_FLOATS);
    expect([...d.subarray(0, 3)]).toEqual([0, -1, 0]);
    expect([...d.subarray(12, 18)]).toEqual([
      0.5,
      Math.fround(0.6),
      Math.fround(0.7),
      Math.fround(0.8),
      10,
      40,
    ]);
  });
});

describe('LiveWindow', () => {
  it('drops frames once dead, oldest first, and folds when full', () => {
    const w = new LiveWindow();
    w.emitted(1);
    w.frame(0.1, 10, 1000, false);
    w.emitted(5);
    w.frame(0.2, 20, 1000, false);
    expect([w.count, w.base]).toEqual([30, 0]);
    w.frame(1.2, 0, 1000, false);
    expect([w.count, w.base]).toEqual([20, 10]);
    // A long-lived frame keeps later ones behind it (conservative).
    const v = new LiveWindow();
    v.emitted(10);
    v.frame(0, 4, 1000, false);
    v.emitted(0.5);
    v.frame(0.1, 6, 1000, false);
    v.frame(2, 0, 1000, false);
    expect(v.count).toBe(10);
    // More frames than it keeps: the oldest fold together, nothing is lost.
    const f = new LiveWindow();
    for (let i = 0; i < 100; i++) {
      f.emitted(i + 500);
      f.frame(i, 1, 1000, false);
    }
    expect([f.count, f.base]).toEqual([100, 0]);
  });
});
