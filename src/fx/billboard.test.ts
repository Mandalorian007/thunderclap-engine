import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import { Renderer } from '../render/renderer';
import { type Billboards, createBillboards, pxToWorld } from './billboard';
import {
  BB_FLAG_BAR,
  BB_FLAG_PX,
  BB_FLAG_TEXTURED,
  BB_FLAG_YAW,
  BILLBOARD_BYTES,
  BILLBOARD_FLOATS,
} from './billboard-wgsl';
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

function make(capacity = 16): { fake: FakeDevice; bb: Billboards; renderer: Renderer } {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const bb = createBillboards(renderer, {
    capacity,
    atlas: { size: 256, canvas: stubCanvas(256) },
  });
  return { fake, bb, renderer };
}

function uploaded(bb: Billboards): Float32Array {
  return (bb as unknown as { upload: Float32Array }).upload;
}

function drawFrame(
  fake: FakeDevice,
  bb: Billboards,
  depth: GPUTextureFormat | null = 'depth24plus',
) {
  const frame = { depthFormat: depth } as Frame;
  const enc = fake.device.createCommandEncoder();
  bb.prepare(enc, frame);
  const pass = enc.beginRenderPass({ colorAttachments: [] });
  bb.draw(pass, frame);
  pass.end();
  return fake.passes.at(-1)!;
}

describe('Billboards buffers', () => {
  it('creates a STORAGE|COPY_DST instance buffer of capacity * stride', () => {
    const { fake, bb } = make(16);
    const buf = fake.buffers.find((b) => b.label === 'billboards')!;
    expect(buf.usage & GPUBufferUsage.STORAGE).toBeTruthy();
    expect(buf.usage & GPUBufferUsage.COPY_DST).toBeTruthy();
    expect(buf.size).toBe(16 * BILLBOARD_BYTES);
    expect(bb.atlasTexture.width).toBe(256);
    expect(fake.errors).toEqual([]);
  });

  it('grows by doubling when add finds the batch full, keeping every billboard', () => {
    const { fake, bb } = make(16);
    const handles = [];
    for (let i = 0; i < 17; i++) handles.push(bb.add({ position: [i, 0, 0], size: [1, 1] }));
    expect(bb.count).toBe(17);
    const live = fake.buffers.filter((b) => b.label === 'billboards' && !b.destroyed);
    expect(live).toHaveLength(1);
    expect(live[0]!.size).toBe(32 * BILLBOARD_BYTES);
    bb.update(0);
    const u = uploaded(bb);
    const xs = [];
    for (let i = 0; i < 17; i++) xs.push(u[i * BILLBOARD_FLOATS]);
    expect(xs.sort((a, b) => a! - b!)).toEqual(handles.map((_, i) => i));
    drawFrame(fake, bb);
    expect(fake.writes.at(-1)!.bytes).toBe(17 * BILLBOARD_BYTES);
    expect(fake.errors).toEqual([]);
  });
});

describe('Billboards add/remove/life', () => {
  it('remove swaps the last slot in and kills the handle', () => {
    const { bb } = make();
    const a = bb.add({ position: [1, 0, 0], size: [1, 1] });
    const b = bb.add({ position: [2, 0, 0], size: [1, 1] });
    const c = bb.add({ position: [3, 0, 0], size: [1, 1] });
    bb.remove(a);
    expect(a.alive).toBe(false);
    expect(b.alive && c.alive).toBe(true);
    expect(bb.count).toBe(2);
    bb.remove(a);
    expect(bb.count).toBe(2);
    bb.update(0);
    const u = uploaded(bb);
    expect([u[0], u[BILLBOARD_FLOATS]].sort()).toEqual([2, 3]);
    c.position = [9, 0, 0];
    bb.update(0);
    expect(
      Array.from(uploaded(bb).subarray(0, 2 * BILLBOARD_FLOATS))
        .filter((_, i) => i % BILLBOARD_FLOATS === 0)
        .sort(),
    ).toEqual([2, 9]);
  });

  it('follows a Float32Array position live and adds the offset', () => {
    const { bb } = make();
    const p = new Float32Array([0, 0, 0]);
    bb.add({ position: p, offset: [0, 2, 0], size: [1, 1] });
    p[0] = 5;
    bb.update(0);
    const u = uploaded(bb);
    expect([u[0], u[1], u[2]]).toEqual([5, 2, 0]);
  });

  it('ages, drifts, fades over the second half and removes itself after life', () => {
    const { bb } = make();
    const h = bb.add({
      position: [0, 0, 0],
      size: [1, 1],
      life: 1,
      velocity: [0, 2, 0],
      color: [1, 1, 1, 0.8],
    });
    bb.update(0.25);
    let u = uploaded(bb);
    expect(u[1]).toBeCloseTo(0.5);
    expect(u[15]).toBeCloseTo(0.8);
    bb.update(0.5);
    u = uploaded(bb);
    expect(u[1]).toBeCloseTo(1.5);
    expect(u[15]).toBeCloseTo(0.8 * 0.5);
    expect(h.alive).toBe(true);
    bb.update(0.25);
    expect(h.alive).toBe(false);
    expect(bb.count).toBe(0);
  });

  it('expires several in one update without skipping a slot', () => {
    const { bb } = make();
    const keep = bb.add({ position: [0, 0, 0], size: [1, 1] });
    for (let i = 0; i < 5; i++) bb.add({ position: [i, 0, 0], size: [1, 1], life: 0.1 });
    bb.add({ position: [7, 0, 0], size: [1, 1], life: 10 });
    bb.update(0.2);
    expect(bb.count).toBe(2);
    expect(keep.alive).toBe(true);
  });

  it('clear removes everything', () => {
    const { bb } = make();
    const a = bb.add({ position: [0, 0, 0], size: [1, 1] });
    bb.clear();
    expect(bb.count).toBe(0);
    expect(a.alive).toBe(false);
  });
});

describe('Billboards instance data', () => {
  it('encodes px sizes with the PX flag, world sizes without', () => {
    const { bb } = make();
    const w = bb.add({ position: [0, 0, 0], size: [2, 0.5] });
    const p = bb.add({ position: [0, 0, 0], size: { px: [120, 30] } });
    const y = bb.add({ position: [0, 0, 0], size: [1, 1], facing: 'cameraY' });
    bb.update(0);
    const inst = (bb as unknown as { inst: Float32Array }).inst;
    const slot = (h: { slot: number }) => h.slot * BILLBOARD_FLOATS;
    expect(inst[slot(w) + 3]! & BB_FLAG_PX).toBe(0);
    expect([inst[slot(w) + 4], inst[slot(w) + 5]]).toEqual([2, 0.5]);
    expect(inst[slot(p) + 3]! & BB_FLAG_PX).toBe(BB_FLAG_PX);
    expect([inst[slot(p) + 4], inst[slot(p) + 5]]).toEqual([120, 30]);
    expect(inst[slot(y) + 3]! & BB_FLAG_YAW).toBe(BB_FLAG_YAW);
    p.size = [3, 3];
    expect(inst[slot(p) + 3]! & BB_FLAG_PX).toBe(0);
    expect(inst[slot(p) + 3]! & BB_FLAG_YAW).toBe(0);
  });

  it('pxToWorld matches the shader ratio: px / viewport * 2 * distance / proj[5]', () => {
    const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
    // fov 90 deg: proj[5] = 1, so the viewport height spans 2 * distance world units.
    expect(pxToWorld(360, 10, cam.projection, 720)).toBeCloseTo(10);
    expect(pxToWorld(72, 5, cam.projection, 720)).toBeCloseTo(1);
    // Orthographic (proj[11] = 0): no distance scaling.
    const ortho = new Float32Array(16);
    ortho[0] = 1;
    ortho[5] = 2 / 100;
    ortho[15] = 1;
    expect(pxToWorld(100, 50, ortho, 200)).toBeCloseTo(50);
  });

  it('text regions set the TEXTURED flag and uv; bar() fills one quad with two colours', () => {
    const { bb } = make();
    const r = bb.text('hp', { size: 16, padding: 0 });
    const t = bb.add({ position: [0, 0, 0], size: [1, 1], region: r });
    const b = bb.add({
      position: [0, 0, 0],
      ...bb.bar(0.25, [1, 0.1], [0, 1, 0, 1], [0.2, 0, 0, 1]),
    });
    const inst = (bb as unknown as { inst: Float32Array }).inst;
    const ts = t.slot * BILLBOARD_FLOATS;
    expect(inst[ts + 3]! & BB_FLAG_TEXTURED).toBe(BB_FLAG_TEXTURED);
    expect([inst[ts + 8], inst[ts + 9], inst[ts + 10], inst[ts + 11]]).toEqual([
      r.u0,
      r.v0,
      r.u1,
      r.v1,
    ]);
    const bs = b.slot * BILLBOARD_FLOATS;
    expect(inst[bs + 3]! & BB_FLAG_BAR).toBe(BB_FLAG_BAR);
    expect(inst[bs + 3]! & BB_FLAG_TEXTURED).toBe(0);
    expect(inst[bs + 6]).toBe(0.25);
    expect(inst.subarray(bs + 16, bs + 20)).toEqual(new Float32Array([0.2, 0, 0, 1]));
    b.fraction = 0.5;
    expect(inst[bs + 6]).toBe(0.5);
    t.region = null;
    expect(inst[ts + 3]! & BB_FLAG_TEXTURED).toBe(0);
    expect(bb.atlas.count).toBe(1);
    expect(bb.text('hp', { size: 16, padding: 0 })).toBe(r);
    expect(() => bb.text('x'.repeat(100))).toThrow();
  });
});

describe('Billboards sorting and drawing', () => {
  it('sorts back to front for the camera, test quads before always quads', () => {
    const { bb } = make();
    const cam = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 0, 10], [0, 0, 0]);
    bb.add({ position: [0, 0, 5], size: [1, 1] }); // near
    bb.add({ position: [0, 0, -5], size: [1, 1] }); // far
    bb.add({ position: [0, 0, 0], size: [1, 1] }); // mid
    bb.add({ position: [0, 0, 8], size: [1, 1], depth: 'always' }); // nearest, drawn last
    bb.update(0, cam);
    const u = uploaded(bb);
    const zs = [0, 1, 2, 3].map((i) => u[i * BILLBOARD_FLOATS + 2]);
    expect(zs).toEqual([-5, 0, 5, 8]);
  });

  it('issues one draw per depth mode, with firstInstance after the test quads', () => {
    const { fake, bb } = make();
    bb.add({ position: [0, 0, 0], size: [1, 1] });
    bb.add({ position: [0, 0, 1], size: [1, 1] });
    bb.add({ position: [0, 0, 2], size: [1, 1], depth: 'always' });
    bb.update(0);
    const pass = drawFrame(fake, bb);
    const draws = pass.commands.filter((c) => c.op === 'draw');
    expect(draws).toEqual([
      { op: 'draw', vertices: 6, instances: 2, firstInstance: 0 },
      { op: 'draw', vertices: 6, instances: 1, firstInstance: 2 },
    ]);
    expect(bb.draws).toBe(2);
    expect(pass.commands.filter((c) => c.op === 'setPipeline')).toHaveLength(2);
    expect(fake.errors).toEqual([]);
  });

  it('draws nothing when empty and one call without a depth attachment', () => {
    const { fake, bb } = make();
    let pass = drawFrame(fake, bb);
    expect(pass.commands.filter((c) => c.op === 'draw')).toHaveLength(0);
    expect(bb.draws).toBe(0);
    bb.add({ position: [0, 0, 0], size: [1, 1], depth: 'always' });
    bb.add({ position: [0, 0, 0], size: [1, 1] });
    bb.update(0);
    pass = drawFrame(fake, bb, null);
    expect(pass.commands.filter((c) => c.op === 'draw')).toEqual([
      { op: 'draw', vertices: 6, instances: 2, firstInstance: 0 },
    ]);
    expect(bb.draws).toBe(1);
  });

  it('uploads instances only after update and the atlas only when dirty', () => {
    const { fake, bb } = make();
    bb.add({ position: [0, 0, 0], size: [1, 1], region: bb.text('a') });
    expect(bb.atlas.dirty).toBe(true);
    bb.update(0);
    drawFrame(fake, bb);
    const writes = fake.writes.filter((w) => w.buffer.label === 'billboards').length;
    expect(writes).toBe(1);
    expect(bb.atlas.dirty).toBe(false);
    drawFrame(fake, bb);
    expect(fake.writes.filter((w) => w.buffer.label === 'billboards')).toHaveLength(writes);
    expect(fake.errors).toEqual([]);
  });
});
