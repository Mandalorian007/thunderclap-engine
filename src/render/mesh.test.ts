import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from './fake-gpu';
import {
  INSTANCE_BUFFER_LAYOUT,
  INSTANCE_FLOATS,
  INSTANCE_OFFSET,
  INSTANCE_STRIDE,
} from './material';
import {
  Mesh,
  quadGeometry,
  VERTEX_BUFFER_LAYOUT,
  VERTEX_LAYOUT_2D,
  VERTEX_LAYOUT_3D,
  VERTEX3D_BUFFER_LAYOUT,
} from './mesh';
import { Renderer } from './renderer';
import { materialPrelude } from './wgsl';

const FS = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = in.color; o.emissive = vec4f(0.0); return o; }`;

describe('vertex layouts', () => {
  it('2D stays 8 floats / 32 bytes and quadGeometry is unchanged', () => {
    expect(VERTEX_LAYOUT_2D.floats).toBe(8);
    expect(VERTEX_LAYOUT_2D.stride).toBe(32);
    expect(VERTEX_LAYOUT_2D.buffer).toBe(VERTEX_BUFFER_LAYOUT);
    const q = quadGeometry();
    expect(q.vertices.length).toBe(32);
    expect([...q.vertices.slice(0, 8)]).toEqual([-0.5, -0.5, 0, 0, 1, 1, 1, 1]);
    expect([...q.indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('3D is xyz, normal, uv, rgba = 12 floats / 48 bytes', () => {
    expect(VERTEX_LAYOUT_3D.floats).toBe(12);
    expect(VERTEX_LAYOUT_3D.stride).toBe(48);
    const attrs = [...VERTEX3D_BUFFER_LAYOUT.attributes].map((a) => [
      a.shaderLocation,
      a.offset,
      a.format,
    ]);
    expect(attrs).toEqual([
      [0, 0, 'float32x3'],
      [10, 12, 'float32x3'],
      [1, 24, 'float32x2'],
      [2, 32, 'float32x4'],
    ]);
    // Vertex and instance attribute locations must not collide.
    const inst = [...INSTANCE_BUFFER_LAYOUT.attributes].map((a) => a.shaderLocation);
    for (const [loc] of attrs) expect(inst).not.toContain(loc);
  });

  it('meshes size their buffers by layout and expose it', () => {
    const fake = createFakeDevice();
    const m2 = new Mesh(fake.device, { label: 'm2', vertices: new Float32Array(8 * 3) });
    const m3 = new Mesh(fake.device, {
      label: 'm3',
      layout: VERTEX_LAYOUT_3D,
      vertices: new Float32Array(12 * 3),
    });
    expect(m2.layout).toBe(VERTEX_LAYOUT_2D);
    expect(m2.vertexCount).toBe(3);
    expect(m3.vertexCount).toBe(3);
    expect(m3.vertexBufferLayout).toBe(VERTEX3D_BUFFER_LAYOUT);
    expect(fake.buffers.find((b) => b.label === 'm2-vb')!.size).toBe(96);
    expect(fake.buffers.find((b) => b.label === 'm3-vb')!.size).toBe(144);
    expect(fake.errors).toEqual([]);
  });

  it('the prelude declares the layout fields and the 28-float instance', () => {
    const p2 = materialPrelude(VERTEX_LAYOUT_2D);
    const p3 = materialPrelude(VERTEX_LAYOUT_3D);
    expect(p2).toContain('@location(0) pos: vec2f');
    expect(p3).toContain('@location(0) pos: vec3f');
    expect(p3).toContain('@location(10) normal: vec3f');
    for (const p of [p2, p3]) {
      expect(p).toContain('@location(3) m0: vec4f');
      expect(p).toContain('@location(9) misc: vec4f');
      expect(p).toContain('o.clip = camera.view_proj * vec4f(world3, 1.0);');
      expect(p).toContain('@location(7) normal: vec3f');
      expect(p).toContain('@location(8) worldPos: vec3f');
    }
  });

  it('instance format is 28 floats with documented offsets', () => {
    expect(INSTANCE_FLOATS).toBe(28);
    expect(INSTANCE_STRIDE).toBe(112);
    expect(INSTANCE_BUFFER_LAYOUT.arrayStride).toBe(112);
    expect(INSTANCE_OFFSET).toEqual({
      matrix: 0,
      uvRect: 12,
      tint: 16,
      params: 20,
      emissive: 24,
      flags: 25,
      size: 26,
    });
  });
});

describe('pipelines keyed by (material, layout, depth)', () => {
  it('builds the 2D pipeline at creation and others lazily, once each', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const m = r.createMaterial({ label: 'k', wgsl: FS });
    const p2 = m.pipelineFor(VERTEX_LAYOUT_2D, 0);
    expect(p2).toBe(m.pipeline);
    const p3 = m.pipelineFor(VERTEX_LAYOUT_3D, 0);
    expect(p3).not.toBe(p2);
    expect(m.pipelineFor(VERTEX_LAYOUT_3D, 0)).toBe(p3);
    const p3d = m.pipelineFor(VERTEX_LAYOUT_3D, 2);
    expect(p3d).not.toBe(p3);

    const desc = (p: unknown) => (p as { desc: GPURenderPipelineDescriptor }).desc;
    const bufs2 = desc(p2).vertex.buffers as GPUVertexBufferLayout[];
    const bufs3 = desc(p3).vertex.buffers as GPUVertexBufferLayout[];
    expect(bufs2[0]).toBe(VERTEX_BUFFER_LAYOUT);
    expect(bufs3[0]).toBe(VERTEX3D_BUFFER_LAYOUT);
    expect(bufs3[1]).toBe(INSTANCE_BUFFER_LAYOUT);
    expect(desc(p2).depthStencil).toBeUndefined();
    expect(desc(p3).depthStencil).toBeUndefined();
    expect(desc(p3d).depthStencil).toMatchObject({
      format: 'depth24plus',
      depthWriteEnabled: true,
    });
    expect(desc(m.pipelineFor(VERTEX_LAYOUT_2D, 1)).depthStencil).toMatchObject({
      depthWriteEnabled: false,
    });
    expect(desc(p2).label).toBe('material:k');
    expect(desc(p3d).label).toBe('material:k:3d:d2');

    // One shader module per layout, the 3D one with the 3D prelude.
    const code = (p: unknown) => (desc(p).vertex.module as unknown as { code: string }).code;
    expect(code(p2)).toContain('pos: vec2f');
    expect(code(p3)).toContain('pos: vec3f');
    expect(desc(p3).vertex.module).toBe(desc(p3d).vertex.module);
  });

  it('draws a 3D mesh with its layout pipeline', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const m = r.createMaterial({ label: 'mix', wgsl: FS });
    const cube = new Mesh(fake.device, {
      label: 'tri3',
      layout: VERTEX_LAYOUT_3D,
      vertices: new Float32Array(12 * 3),
    });
    const f = r.beginFrame(0, 0);
    f.sprite(m, { x: 0, y: 0 });
    f.mesh(cube, m, { x: 0, y: 0 });
    f.mesh(cube, m, { x: 1, y: 0 });
    r.endFrame();
    const scene = [...fake.passes].reverse().find((p) => p.label === 'scene')!;
    const pipes = scene.commands
      .filter((c) => c.op === 'setPipeline')
      .map((c) => (c as { pipeline: { label: string } }).pipeline.label);
    expect(pipes).toEqual(['material:mix', 'material:mix:3d:d0']);
    expect(r.stats.drawCalls).toBe(2);
    expect(fake.errors).toEqual([]);
  });
});

describe('Mesh capacity and update (ws/mesh-stream)', () => {
  const alive = (fake: ReturnType<typeof createFakeDevice>, label: string) =>
    fake.buffers.filter((b) => b.label === label && !b.destroyed);

  it('a capacity-only mesh starts empty with buffers sized by capacity', () => {
    const fake = createFakeDevice();
    const m = new Mesh(fake.device, {
      label: 'c',
      layout: VERTEX_LAYOUT_3D,
      capacity: { vertices: 100, indices: 150 },
    });
    expect(m.vertexCount).toBe(0);
    expect(m.indexCount).toBe(0);
    expect(m.capacity).toEqual({ vertices: 100, indices: 150 });
    expect(m.indexFormat).toBe('uint16');
    expect(alive(fake, 'c-vb')[0]!.size).toBe(100 * 48);
    expect(alive(fake, 'c-ib')[0]!.size).toBe(300);
    expect(fake.writes).toHaveLength(0);
    // A capacity beyond uint16 picks uint32; `indexFormat` overrides.
    const big = new Mesh(fake.device, { capacity: { vertices: 70_000, indices: 3 } });
    expect(big.indexFormat).toBe('uint32');
    const forced = new Mesh(fake.device, {
      capacity: { vertices: 70_000, indices: 3 },
      indexFormat: 'uint16',
    });
    expect(forced.indexFormat).toBe('uint16');
    expect(fake.errors).toEqual([]);
  });

  it('update within capacity writes from the view in place and keeps the buffers', () => {
    const fake = createFakeDevice();
    const m = new Mesh(fake.device, {
      label: 'u',
      layout: VERTEX_LAYOUT_3D,
      capacity: { vertices: 64, indices: 96 },
    });
    const vb = m.vertexBuffer;
    const ib = m.indexBuffer;
    // One transferred buffer: 20 vertices then 30 indices, as a Worker would pack it.
    const buf = new ArrayBuffer(20 * 48 + 30 * 2);
    const verts = new Float32Array(buf, 0, 20 * 12);
    const idx = new Uint16Array(buf, 20 * 48, 30);
    fake.writes.length = 0;
    expect(m.update({ vertices: verts, indices: idx })).toBe(false);
    expect(m.vertexBuffer).toBe(vb);
    expect(m.indexBuffer).toBe(ib);
    expect(m.vertexCount).toBe(20);
    expect(m.indexCount).toBe(30);
    expect(m.growths).toBe(0);
    expect(fake.writes.map((w) => [w.buffer.label, w.offset, w.bytes])).toEqual([
      ['u-vb', 0, 960],
      ['u-ib', 0, 60],
    ]);
    // A smaller upload, counted explicitly, moves the draw range without touching capacity.
    fake.writes.length = 0;
    m.update({ vertices: verts, indices: idx, vertexCount: 8, indexCount: 12 });
    expect(m.vertexCount).toBe(8);
    expect(m.indexCount).toBe(12);
    expect(fake.writes.map((w) => w.bytes)).toEqual([384, 24]);
    expect(m.capacity).toEqual({ vertices: 64, indices: 96 });
    // Counts alone (no views) only move the draw range.
    fake.writes.length = 0;
    m.update({ vertexCount: 0, indexCount: 0 });
    expect(m.vertexCount).toBe(0);
    expect(m.indexCount).toBe(0);
    expect(fake.writes).toHaveLength(0);
    expect(alive(fake, 'u-vb')).toHaveLength(1);
    expect(alive(fake, 'u-ib')).toHaveLength(1);
    expect(fake.errors).toEqual([]);
  });

  it('exceeding capacity grows 1.5x, destroys the old buffers and reports it', () => {
    const fake = createFakeDevice();
    const m = new Mesh(fake.device, { label: 'g', capacity: { vertices: 4, indices: 6 } });
    const vb = m.vertexBuffer as unknown as { destroyed: boolean };
    const ib = m.indexBuffer as unknown as { destroyed: boolean };
    const verts = new Float32Array(10 * 8);
    const idx = new Uint16Array(15);
    expect(m.update({ vertices: verts, indices: idx })).toBe(true);
    expect(m.growths).toBe(1);
    expect(vb.destroyed).toBe(true);
    expect(ib.destroyed).toBe(true);
    expect(m.vertexBuffer).not.toBe(vb);
    expect(m.capacity).toEqual({ vertices: 15, indices: 23 });
    expect(alive(fake, 'g-vb')[0]!.size).toBe(15 * 32);
    expect(alive(fake, 'g-ib')[0]!.size).toBe(Math.ceil((23 * 2) / 4) * 4);
    // Fits now: no further growth.
    expect(m.update({ vertices: verts, indices: idx })).toBe(false);
    expect(m.growths).toBe(1);
    // Only the index buffer grows when only the indices overflow.
    const vb2 = m.vertexBuffer;
    expect(m.update({ indices: new Uint16Array(40) })).toBe(true);
    expect(m.vertexBuffer).toBe(vb2);
    expect(m.capacity.indices).toBe(60);
    expect(m.growths).toBe(2);
    expect(fake.errors).toEqual([]);
  });

  it('switching to uint32 indices rebuilds the index buffer; other views keep the format', () => {
    const fake = createFakeDevice();
    const m = new Mesh(fake.device, { label: 'f', vertices: new Float32Array(8 * 3) });
    expect(m.indexBuffer).toBeNull();
    expect(m.update({ indices: new Uint32Array([0, 1, 2]) })).toBe(true);
    expect(m.indexFormat).toBe('uint32');
    expect(m.indexCount).toBe(3);
    const ib = m.indexBuffer;
    // A plain byte view of 12 bytes: 3 uint32 indices in the current format.
    m.update({ indices: new Uint8Array(12) });
    expect(m.indexCount).toBe(3);
    expect(m.indexBuffer).toBe(ib);
    expect(m.update({ indices: new Uint16Array([0, 1, 2]) })).toBe(true);
    expect(m.indexFormat).toBe('uint16');
    expect(fake.errors).toEqual([]);
  });

  it('an odd uint16 count at the end of its buffer uploads without a 4-byte violation', () => {
    const fake = createFakeDevice();
    const m = new Mesh(fake.device, {
      vertices: new Float32Array(8 * 3),
      capacity: { indices: 8 },
    });
    fake.writes.length = 0;
    m.update({ indices: new Uint16Array([0, 1, 2, 2, 1]) });
    expect(m.indexCount).toBe(5);
    expect(fake.writes.map((w) => [w.offset, w.bytes])).toEqual([
      [0, 8],
      [8, 4],
    ]);
    // With slack after the data the padding comes from the buffer itself: one write.
    fake.writes.length = 0;
    const buf = new ArrayBuffer(16);
    m.update({ indices: new Uint16Array(buf, 0, 7) });
    expect(fake.writes.map((w) => [w.offset, w.bytes])).toEqual([[0, 16]]);
    expect(fake.errors).toEqual([]);
  });

  it('createMesh takes initial 3D data, a capacity, or both; the quad is unchanged', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const data = new Mesh(fake.device, {
      layout: VERTEX_LAYOUT_3D,
      vertices: new Float32Array(24),
    });
    expect(data.vertexCount).toBe(2);
    expect(data.capacity).toEqual({ vertices: 2, indices: 0 });
    const both = r.createMesh({
      layout: VERTEX_LAYOUT_3D,
      vertices: new Float32Array(24),
      indices: new Uint16Array([0, 1, 1]),
      capacity: { vertices: 50, indices: 75 },
    });
    expect(both.vertexCount).toBe(2);
    expect(both.indexCount).toBe(3);
    expect(both.capacity).toEqual({ vertices: 50, indices: 75 });
    const q = r.createMesh(quadGeometry());
    expect(q.vertexCount).toBe(4);
    expect(q.indexCount).toBe(6);
    expect(q.capacity).toEqual({ vertices: 4, indices: 6 });
    expect(fake.errors).toEqual([]);
  });

  it('a mesh updated between frames draws its new indexCount', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const mat = r.createMaterial({ label: 's', wgsl: FS });
    const m = r.createMesh({ layout: VERTEX_LAYOUT_3D, capacity: { vertices: 64, indices: 96 } });
    const indexed = (): number[] => {
      const scene = [...fake.passes].reverse().find((p) => p.label === 'scene')!;
      return scene.commands
        .filter((c) => c.op === 'drawIndexed')
        .map((c) => (c as { indices: number }).indices);
    };
    m.update({ vertices: new Float32Array(12 * 24), indices: new Uint16Array(36) });
    let f = r.beginFrame(0, 0);
    f.mesh(m, mat, { x: 0, y: 0 });
    r.endFrame();
    expect(indexed()).toEqual([36]);
    m.update({ indexCount: 12 });
    f = r.beginFrame(0.016, 0.016);
    f.mesh(m, mat, { x: 0, y: 0 });
    r.endFrame();
    expect(indexed()).toEqual([12]);
    expect(fake.errors).toEqual([]);
  });

  it('an indexed mesh with indexCount 0 draws nothing', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const mat = r.createMaterial({ label: 's', wgsl: FS });
    const m = r.createMesh({ layout: VERTEX_LAYOUT_3D, capacity: { vertices: 8, indices: 12 } });
    m.update({ vertices: new Float32Array(4 * 24), indices: new Uint16Array(6) });
    m.update({ indexCount: 0 });
    const f = r.beginFrame(0, 0);
    f.mesh(m, mat, { x: 0, y: 0 });
    r.endFrame();
    const scene = [...fake.passes].reverse().find((p) => p.label === 'scene')!;
    expect(scene.commands.filter((c) => c.op === 'draw' || c.op === 'drawIndexed')).toEqual([]);
    expect(r.stats.drawCalls).toBe(0);
    expect(fake.errors).toEqual([]);
  });
});
