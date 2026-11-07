/**
 * ws/render-11: billboards and world-space particles write their own motion into a velocity
 * attachment instead of masking it. Fake GPU: the pipeline a velocity view binds is the motion
 * build (velocity entry written and blended, the shader that writes it at the attachment's
 * location), the billboard previous-anchor buffer holds last frame's drawn anchors, and views
 * without velocity keep the masked pipelines. The pixels are `harness/render10.html?blur`.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import {
  createFakeDevice,
  type FakeBuffer,
  type FakeDevice,
  fakeRendererGpu,
} from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import { Renderer } from '../render/renderer';
import { createBillboards } from './billboard';
import { BILLBOARD_WGSL, billboardWgsl } from './billboard-wgsl';
import { ParticleSystem } from './particles';
import {
  fxRenderWgsl,
  PARTICLE_EXT_RENDER_WGSL,
  PARTICLE_WORLD_RENDER_WGSL,
} from './particles-wgsl';
import type { AtlasCanvas, AtlasContext2D } from './text-atlas';

function stubCanvas(size: number): AtlasCanvas {
  const ctx: AtlasContext2D = {
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    measureText: (t) => ({ width: t.length * 10 }),
    fillText: () => {},
    strokeText: () => {},
    clearRect: () => {},
  };
  return { width: size, height: size, getContext: () => ctx };
}

interface Bound {
  label: string;
  desc: GPURenderPipelineDescriptor;
}

function lastPipelines(fake: FakeDevice): Bound[] {
  const out: Bound[] = [];
  for (const c of fake.passes.at(-1)!.commands) {
    if (c.op === 'setPipeline') out.push(c.pipeline as Bound);
  }
  return out;
}

function code(desc: GPURenderPipelineDescriptor, stage: 'vertex' | 'fragment'): string {
  return (desc[stage]!.module as unknown as { code: string }).code;
}

function frameOf(aux: number): Frame {
  return { depthFormat: 'depth24plus', auxKey: aux } as Frame;
}

function draw(
  fake: FakeDevice,
  d: {
    prepare(e: GPUCommandEncoder, f?: Frame): void;
    draw(p: GPURenderPassEncoder, f?: Frame): void;
  },
  aux: number,
) {
  const frame = frameOf(aux);
  const enc = fake.device.createCommandEncoder();
  d.prepare(enc, frame);
  const pass = enc.beginRenderPass({ colorAttachments: [] });
  d.draw(pass, frame);
  pass.end();
  return lastPipelines(fake);
}

function prevBuffer(fake: FakeDevice): FakeBuffer {
  const all = (fake.buffers as FakeBuffer[]).filter(
    (b) => b.label === 'billboards-prev' && !b.destroyed,
  );
  return all.at(-1)!;
}

function prevAt(fake: FakeDevice, i: number): number[] {
  const f = new Float32Array(prevBuffer(fake).data.buffer, i * 16, 4);
  return [...f];
}

function billboards() {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const bb = createBillboards(renderer, {
    capacity: 16,
    atlas: { size: 64, canvas: stubCanvas(64) },
  });
  const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
  cam.lookAt([0, 0, 10], [0, 0, 0]);
  return { fake, renderer, bb, cam };
}

describe('ws/render-11: billboards write their own motion', () => {
  for (const [aux, at] of [
    [2, 2],
    [3, 3],
  ] as const) {
    it(`aux ${aux}: the velocity view binds the motion build, velocity at location ${at}`, () => {
      const { fake, renderer, bb, cam } = billboards();
      bb.add({ position: [0, 0, 0], size: [1, 1] });
      bb.add({ position: [1, 0, 0], size: [1, 1], depth: 'always' });
      bb.update(1 / 60, cam);
      const bound = draw(fake, bb, aux);
      expect(bound).toHaveLength(2);
      const masked = renderer.sceneTargets(undefined, aux);
      for (const p of bound) {
        expect(p.label.endsWith(':motion')).toBe(true);
        const t = p.desc.fragment!.targets as GPUColorTargetState[];
        expect(t.map((x) => x.format)).toEqual(masked.map((x) => x.format));
        // Velocity written (default mask) and blended by coverage; rough-metal stays masked.
        expect(t[at]!.writeMask).toBeUndefined();
        expect(t[at]!.blend!.color.srcFactor).toBe('src-alpha');
        if (aux & 1) expect(t[2]!.writeMask).toBe(0);
        const fs = code(p.desc, 'fragment');
        expect(fs).toBe(billboardWgsl(at));
        expect(fs).toContain(`@location(${at}) velocity: vec4f`);
        expect(fs).toContain('camera.prev_view_proj');
        expect(code(p.desc, 'vertex')).toBe(fs);
      }
    });
  }

  it('without a velocity attachment it keeps the masked pipeline and writes no prev buffer', () => {
    const { fake, bb, cam } = billboards();
    bb.add({ position: [0, 0, 0], size: [1, 1], velocity: [1, 0, 0] });
    bb.update(1 / 60, cam);
    for (const aux of [0, 1]) {
      const bound = draw(fake, bb, aux);
      for (const p of bound) {
        expect(p.label.endsWith(':motion')).toBe(false);
        expect(code(p.desc, 'fragment')).toBe(BILLBOARD_WGSL);
      }
    }
    expect(fake.writes.some((w) => (w.buffer as FakeBuffer).label === 'billboards-prev')).toBe(
      false,
    );
  });

  it('the prev buffer holds where each drawn quad was last frame, in draw order', () => {
    const { fake, bb, cam } = billboards();
    bb.add({ position: [0, 0, 0], size: [1, 1], velocity: [2, 0, 0] });
    const still = bb.add({ position: [0, 3, 0], size: [1, 1] });
    bb.update(0, cam);
    draw(fake, bb, 2);
    // First frame: unknown history reads as the current anchor (no motion).
    const up = new Float32Array(fake.buffers.find((b) => b.label === 'billboards')!.data.buffer);
    const order = (n: number) => [up[n * 20]!, up[n * 20 + 1]!, up[n * 20 + 2]!];
    for (let i = 0; i < 2; i++) expect(prevAt(fake, i)).toEqual([...order(i), 1]);
    bb.update(0.5, cam);
    draw(fake, bb, 2);
    const mover = order(0)[1] === 0 ? 0 : 1;
    expect(order(mover)[0]).toBeCloseTo(1);
    expect(prevAt(fake, mover)).toEqual([0, 0, 0, 1]);
    expect(prevAt(fake, 1 - mover)).toEqual([0, 3, 0, 1]);
    // A frame without an update: current equals previous (the motion was last frame's).
    draw(fake, bb, 2);
    expect(prevAt(fake, mover)[0]).toBeCloseTo(1);
    // Swap-remove keeps the moved slot's history; a new quad in a reused slot starts fresh.
    bb.remove(still);
    bb.update(0.5, cam);
    draw(fake, bb, 2);
    expect(prevAt(fake, 0)[0]).toBeCloseTo(1);
    bb.add({ position: [5, 5, 5], size: [1, 1] });
    bb.update(0, cam);
    draw(fake, bb, 2);
    const fresh = order(0)[0] === 5 ? 0 : 1;
    expect(prevAt(fake, fresh)).toEqual([5, 5, 5, 1]);
    expect(fake.errors).toEqual([]);
  });

  it('grows the prev buffer with the batch and keeps the drawn anchors', () => {
    const { fake, bb, cam } = billboards();
    for (let i = 0; i < 16; i++) bb.add({ position: [i, 0, 0], size: [1, 1] });
    bb.update(0, cam);
    draw(fake, bb, 2);
    bb.add({ position: [99, 0, 0], size: [1, 1] });
    bb.update(0, cam);
    draw(fake, bb, 2);
    expect(prevBuffer(fake).size).toBe(32 * 16);
    expect(fake.errors).toEqual([]);
  });
});

describe('ws/render-11: world particles write their own motion', () => {
  function particles(space: '2d' | 'world') {
    const fake = createFakeDevice();
    const renderer = new Renderer(fakeRendererGpu(fake));
    const ps = new ParticleSystem(renderer, { capacity: 16, space });
    ps.emit({ x: 0, y: 0, colorStart: [1, 1, 1, 1] }, 4);
    ps.update(1 / 60);
    return { fake, renderer, ps };
  }

  it('the exported shaders are unchanged; the motion build steps back by sim.dt', () => {
    expect(fxRenderWgsl(true)).toBe(PARTICLE_WORLD_RENDER_WGSL);
    expect(fxRenderWgsl(false)).toBe(PARTICLE_EXT_RENDER_WGSL);
    expect(fxRenderWgsl(false, 2)).toBe(PARTICLE_EXT_RENDER_WGSL);
    const m = fxRenderWgsl(true, 3);
    expect(m).toContain('camera.prev_view_proj * vec4f(world - vel * sim.dt, 1.0)');
    expect(m).toContain('@location(3) velocity: vec4f');
    expect(m).toContain('engine_motion(in.clip, in.prev_clip)');
  });

  for (const aux of [2, 3]) {
    it(`aux ${aux}: world space binds the motion build`, () => {
      const { fake, ps } = particles('world');
      const bound = draw(fake, ps, aux).filter((p) => p.label.startsWith('particles-world'));
      expect(bound).toHaveLength(1);
      const p = bound[0]!;
      expect(p.label.endsWith(':motion')).toBe(true);
      const at = aux & 1 ? 3 : 2;
      const t = p.desc.fragment!.targets as GPUColorTargetState[];
      expect(t).toHaveLength(2 + (aux & 1) + 1);
      expect(t[at]!.writeMask).toBeUndefined();
      expect(code(p.desc, 'fragment')).toBe(fxRenderWgsl(true, at));
      expect(fake.errors).toEqual([]);
    });
  }

  it('2D particles and plain views keep velocity masked', () => {
    const a = particles('2d');
    for (const p of draw(a.fake, a.ps, 2)) {
      expect(p.label.endsWith(':motion')).toBe(false);
      const t = p.desc.fragment!.targets as GPUColorTargetState[];
      expect(t[2]!.writeMask).toBe(0);
    }
    const b = particles('world');
    for (const p of draw(b.fake, b.ps, 0)) {
      expect(p.label.endsWith(':motion')).toBe(false);
      expect(code(p.desc, 'fragment')).toBe(PARTICLE_WORLD_RENDER_WGSL);
    }
  });
});
