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
