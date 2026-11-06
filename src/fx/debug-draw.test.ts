import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeDevice, type FakePass } from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { Transform } from '../render/transform';
import { createDebugDraw, DEBUG_VERTEX_FLOATS, type DebugDrawOptions } from './debug-draw';

const SF = DEBUG_VERTEX_FLOATS * 2;

function make(opts: DebugDrawOptions = {}) {
  const fake = createFakeDevice();
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
  } as unknown as Renderer;
  return { fake, dd: createDebugDraw(renderer, opts) };
}

function pass(fake: FakeDevice): { pass: GPURenderPassEncoder; rec: () => FakePass } {
  const enc = fake.device.createCommandEncoder();
  const p = enc.beginRenderPass({ colorAttachments: [] });
  return { pass: p, rec: () => fake.passes[fake.passes.length - 1]! };
}

function frame(depthFormat: GPUTextureFormat | null): Frame {
  return { depthFormat } as Frame;
}

describe('DebugDraw shapes', () => {
  it('counts segments per shape', () => {
    const { dd } = make();
    dd.line([0, 0, 0], [1, 0, 0], 0xff0000ff);
    expect(dd.count).toBe(1);
    dd.ray([0, 0, 0], [0, 2, 0], 3, [0, 1, 0, 1]);
    expect(dd.count).toBe(2);
    dd.arrow([0, 0, 0], [0, 0, 1], 0xffffffff);
    expect(dd.count).toBe(7);
    dd.box([0, 0, 0], [1, 1, 1], 0xffffffff);
    expect(dd.count).toBe(19);
    dd.wireSphere([0, 0, 0], 1, 0xffffffff);
    expect(dd.count).toBe(19 + 72);
    dd.wireSphere([0, 0, 0], 1, 0xffffffff, 4);
    expect(dd.count).toBe(19 + 72 + 24);
    dd.axes(new Transform(), 1);
    expect(dd.count).toBe(19 + 72 + 24 + 3);
    dd.grid([0, 0, 0], 10, 1, 0xffffffff);
    expect(dd.count).toBe(19 + 72 + 24 + 3 + 22);
    dd.circle([0, 0, 0], [0, 1, 0], 1, 0xffffffff);
    expect(dd.count).toBe(19 + 72 + 24 + 3 + 22 + 32);
    dd.circle([0, 0, 0], [0, 1, 0], 1, 0xffffffff, 8);
    expect(dd.count).toBe(19 + 72 + 24 + 3 + 22 + 32 + 8);
    dd.path([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], 0xffffffff);
    expect(dd.count).toBe(19 + 72 + 24 + 3 + 22 + 32 + 8 + 3);
    dd.frustum([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0xffffffff);
    expect(dd.count).toBe(19 + 72 + 24 + 3 + 22 + 32 + 8 + 3 + 12);
    dd.clear();
    expect(dd.count).toBe(0);
  });

  it('writes xyz + rgba vertices and unpacks 0xRRGGBBAA', () => {
    const { dd } = make();
    dd.line([1, 2, 3], { x: 4, y: 5, z: 6 }, 0xff008040);
    const v = (dd as unknown as { verts: Float32Array }).verts;
    expect(Array.from(v.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(v.subarray(7, 10))).toEqual([4, 5, 6]);
    expect(v[3]).toBeCloseTo(1);
    expect(v[4]).toBeCloseTo(0);
    expect(v[5]).toBeCloseTo(128 / 255);
    expect(v[6]).toBeCloseTo(64 / 255);
    dd.line([0, 0, 0], [0, 0, 0], [0.5, 0.25, 0.125]);
    expect(Array.from(v.subarray(SF + 3, SF + 7))).toEqual([0.5, 0.25, 0.125, 1]);
  });

  it('ray normalises the direction; path honours stride, offset and count', () => {
    const { dd } = make();
    dd.ray([1, 0, 0], [0, 0, 5], 2, 0xffffffff);
    const v = (dd as unknown as { verts: Float32Array }).verts;
    expect(Array.from(v.subarray(7, 10))).toEqual([1, 0, 2]);
    dd.clear();
    const pts = new Float32Array([9, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
    dd.path(pts, 0xffffffff, 4, 4, 2);
    expect(dd.count).toBe(1);
    expect(Array.from(v.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(v.subarray(7, 10))).toEqual([2, 0, 0]);
  });

  it('box rotates its half extents; axes read a 3×4 matrix with colours per axis', () => {
    const { dd } = make();
    // 90° about y: the +x half extent lands on -z.
    const s = Math.SQRT1_2;
    dd.box([0, 0, 0], [2, 1, 1], 0xffffffff, [0, s, 0, s]);
    const v = (dd as unknown as { verts: Float32Array }).verts;
    let minZ = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 24; i++) {
      minZ = Math.min(minZ, v[i * 7 + 2]!);
      maxX = Math.max(maxX, v[i * 7]!);
    }
    expect(minZ).toBeCloseTo(-2);
    expect(maxX).toBeCloseTo(1);
    dd.clear();
    dd.axes([2, 0, 0, 5, 0, 2, 0, 6, 0, 0, 2, 7], 1.5);
    expect(dd.count).toBe(3);
    expect(Array.from(v.subarray(0, 7))).toEqual([5, 6, 7, 1, 0, 0, 1]);
    expect(Array.from(v.subarray(7, 10))).toEqual([6.5, 6, 7]);
    expect(Array.from(v.subarray(SF + 7, SF + 14))).toEqual([5, 7.5, 7, 0, 1, 0, 1]);
    expect(Array.from(v.subarray(2 * SF + 7, 2 * SF + 14))).toEqual([5, 6, 8.5, 0, 0, 1, 1]);
  });

  it('frustum unprojects the WebGPU clip cube through the inverse matrix', () => {
    const { dd } = make();
    // Scale by 2 in x: corners span -2..2 in x, -1..1 in y, 0..1 in z.
    dd.frustum([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0xffffffff);
    const v = (dd as unknown as { verts: Float32Array }).verts;
    const xs = new Set<number>();
    const zs = new Set<number>();
    for (let i = 0; i < 24; i++) {
      xs.add(v[i * 7]!);
      zs.add(v[i * 7 + 2]!);
    }
    expect([...xs].sort()).toEqual([-2, 2]);
    expect([...zs].sort()).toEqual([0, 1]);
  });
});

describe('DebugDraw growth', () => {
  it('grows the array by 1.5× when full and keeps every segment', () => {
    const { dd } = make({ capacity: 4 });
    expect(dd.capacity).toBe(4);
    for (let i = 0; i < 5; i++) dd.line([i, 0, 0], [i, 1, 0], 0xffffffff);
    expect(dd.capacity).toBe(6);
    expect(dd.count).toBe(5);
    const v = (dd as unknown as { verts: Float32Array }).verts;
    expect(v.length).toBe(6 * SF);
    expect(v[4 * SF]).toBe(4);
    dd.box([0, 0, 0], [1, 1, 1], 0xffffffff);
    expect(dd.count).toBe(17);
    expect(dd.capacity).toBeGreaterThanOrEqual(17);
  });

  it('recreates the GPU buffer on draw after growth and never overflows it', () => {
    const { fake, dd } = make({ capacity: 2 });
    const f = frame(null);
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, f);
    const first = fake.buffers.filter((b) => b.label === 'debug-draw');
    expect(first).toHaveLength(1);
    expect(first[0]!.size).toBe(2 * SF * 4);
    for (let i = 0; i < 3; i++) dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, f);
    const all = fake.buffers.filter((b) => b.label === 'debug-draw');
    expect(all).toHaveLength(2);
    expect(first[0]!.destroyed).toBe(true);
    expect(all[1]!.size).toBe(3 * SF * 4);
    expect(fake.errors).toEqual([]);
  });
});

describe('DebugDraw.draw', () => {
  it('uploads only the used range and issues one line-list draw of two vertices per segment', () => {
    const { fake, dd } = make({ capacity: 100 });
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.box([0, 0, 0], [1, 1, 1], 0xffffffff);
    const { pass: p, rec } = pass(fake);
    dd.draw(p, frame(null));
    expect(fake.writes).toHaveLength(1);
    // The fake records the `size` argument as given: floats here (the used range, not the array).
    expect(fake.writes[0]!.bytes).toBe(13 * SF);
    expect(fake.writes[0]!.buffer.size).toBe(100 * SF * 4);
    const cmds = rec().commands;
    expect(cmds.map((c) => c.op)).toEqual(['setPipeline', 'other', 'draw']);
    expect(cmds[2]).toEqual({ op: 'draw', vertices: 26, instances: 1, firstInstance: 0 });
    expect(dd.uploads).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('clears after draw by default, retains with opts.retain, and records nothing when empty', () => {
    const { fake, dd } = make();
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame(null));
    expect(dd.count).toBe(0);
    const { pass: p, rec } = pass(fake);
    dd.draw(p, frame(null));
    expect(rec().commands).toEqual([]);
    expect(fake.writes).toHaveLength(1);

    const kept = make({ retain: true });
    kept.dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    kept.dd.draw(pass(kept.fake).pass, frame(null));
    expect(kept.dd.count).toBe(1);
    kept.dd.draw(pass(kept.fake).pass, frame(null));
    expect(kept.fake.writes).toHaveLength(2);
    kept.dd.clear();
    expect(kept.dd.count).toBe(0);
  });

  it('builds one pipeline per depth format, test or always, none without depth', () => {
    const { fake, dd } = make();
    const pipelines = () =>
      fake.passes
        .flatMap((p) => p.commands)
        .filter((c) => c.op === 'setPipeline')
        .map((c) => (c as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline);
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame('depth24plus'));
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame('depth24plus'));
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame('depth32float'));
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame(null));
    const ps = pipelines();
    expect(ps).toHaveLength(4);
    expect(ps[0]).toBe(ps[1]);
    expect(ps[2]).not.toBe(ps[0]);
    expect(ps[3]).not.toBe(ps[0]);
    expect(ps[0]!.desc.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
    expect(ps[2]!.desc.depthStencil?.format).toBe('depth32float');
    expect(ps[3]!.desc.depthStencil).toBeUndefined();
    expect(ps[0]!.desc.primitive?.topology).toBe('line-list');
    expect(ps[0]!.desc.fragment?.targets).toHaveLength(2);

    const always = make({ depth: 'always' });
    always.dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    const { pass: p, rec } = pass(always.fake);
    always.dd.draw(p, frame('depth24plus'));
    const ap = (rec().commands[0] as { pipeline: { desc: GPURenderPipelineDescriptor } }).pipeline;
    expect(ap.desc.depthStencil).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'always',
    });
  });

  it('destroy frees the buffer', () => {
    const { fake, dd } = make();
    dd.line([0, 0, 0], [1, 0, 0], 0xffffffff);
    dd.draw(pass(fake).pass, frame(null));
    dd.destroy();
    expect(fake.buffers.find((b) => b.label === 'debug-draw')!.destroyed).toBe(true);
    expect(dd.count).toBe(0);
  });
});
