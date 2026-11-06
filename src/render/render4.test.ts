/**
 * ws/render-4: camera jitter and history, aux targets (rough/metal, velocity), the
 * previous-matrix lane, index sub-range draws, lazy 2D pipelines, the tangent prelude, the
 * standard material's per-slot maps, and the `loadTextureArray` filter rename.
 */
import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import { INSTANCE_BUFFER_LAYOUT, type MaterialDesc } from './material';
import {
  type Mesh,
  quadGeometry,
  VERTEX_BUFFER_LAYOUT,
  VERTEX_LAYOUT_2D,
  VERTEX_LAYOUT_3D,
  VERTEX_LAYOUT_3D_TANGENT,
  VERTEX_LAYOUT_3D_UV2,
  VERTEX_LAYOUT_SKINNED,
  VERTEX3D_BUFFER_LAYOUT,
  VERTEX3D_FLOATS,
  VERTEX3D_UV2_FLOATS,
  VERTEX3D_UV2_STRIDE,
} from './mesh';
import { type PostInputs, type PostProcessor, Renderer } from './renderer';
import { ROUGH_METAL_FORMAT, SceneTarget, VELOCITY_FORMAT } from './scene-target';
import { JOINT_FLOATS, SkinPalette } from './skin';
import { createStandardMaterial } from './standard';
import { loadTextureArray } from './texture';
import { Transform } from './transform';
import { materialPrelude, prevLaneBufferLayout, prevLaneLocations } from './wgsl';

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;
const OPAQUE: MaterialDesc = { label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' };

function setup(aux?: { roughMetal?: boolean; velocity?: boolean }) {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake), aux ? { aux } : {});
  r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  r.camera.depthTest = false;
  return { fake, r };
}

function scenePass(fake: FakeDevice) {
  return [...fake.passes].reverse().find((x) => x.label === 'scene')!;
}

function draws(cmds: PassCommand[]) {
  return cmds.filter(
    (c): c is Extract<PassCommand, { op: 'drawIndexed' }> => c.op === 'drawIndexed',
  );
}

function pipelineDescs(cmds: PassCommand[]): GPURenderPipelineDescriptor[] {
  return cmds
    .filter((c): c is Extract<PassCommand, { op: 'setPipeline' }> => c.op === 'setPipeline')
    .map((c) => (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
}

function cube3d(r: Renderer): Mesh {
  return r.createMesh({
    vertices: new Float32Array(VERTEX3D_FLOATS * 3),
    layout: VERTEX_LAYOUT_3D,
    bounds: { center: [0, 0, 0], radius: 1 },
  });
}

/** A post processor that records the inputs it was given. */
function recordingPost(
  wantsJitter: boolean,
): PostProcessor & { seen: PostInputs['view'][]; aux: [unknown, unknown] } {
  const seen: PostInputs['view'][] = [];
  const self = {
    wantsJitter,
    seen,
    aux: [null, null] as [unknown, unknown],
    resize() {},
    encode(_e: GPUCommandEncoder, inputs: PostInputs) {
      self.aux = [inputs.roughMetal, inputs.velocity];
      seen.push(
        inputs.view && {
          viewProj: new Float32Array(inputs.view.viewProj),
          invViewProj: new Float32Array(inputs.view.invViewProj),
          previousViewProj: new Float32Array(inputs.view.previousViewProj),
          previousView: new Float32Array(inputs.view.previousView),
          jitter: [inputs.view.jitter[0], inputs.view.jitter[1]],
        },
      );
    },
  };
  return self;
}

describe('Camera jitter (ws/render-4)', () => {
  it('shifts a projected point by the pixel amount, against the target size', () => {
    const c = Camera.perspective(1, 16 / 9, 0.1, 100).lookAt([0, 0, 5], [0, 0, 0]);
    const p = [0, 0, 0];
    mat4.transformPoint(p, c.viewProjection, 0.3, -0.2, 0);
    c.setJitterTarget(640, 360);
    c.setJitter(1, -2);
    const q = [0, 0, 0];
    mat4.transformPoint(q, c.viewProjection, 0.3, -0.2, 0);
    // NDC → pixels: x by width / 2 (+x right), y by -height / 2 (+y down).
    expect(((q[0]! - p[0]!) * 640) / 2).toBeCloseTo(1, 5);
    expect(((q[1]! - p[1]!) * -360) / 2).toBeCloseTo(-2, 5);
    expect(c.jitter).toEqual([1, -2]);
    const clip: [number, number] = [0, 0];
    c.jitterClip(clip);
    expect(clip[0]).toBeCloseTo(2 / 640);
    expect(clip[1]).toBeCloseTo(4 / 360);
    // The inverse follows the jittered matrix.
    const back = [0, 0, 0];
    mat4.transformPoint(back, c.invViewProj, q[0]!, q[1]!, q[2]!);
    expect(back[0]).toBeCloseTo(0.3, 4);
    expect(back[1]).toBeCloseTo(-0.2, 4);
    c.clearJitter();
    mat4.transformPoint(q, c.viewProjection, 0.3, -0.2, 0);
    expect(q[0]).toBeCloseTo(p[0]!, 6);
  });

  it('does nothing without a target size, and never through ortho2d', () => {
    const c = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 0, 5], [0, 0, 0]);
    const before = new Float32Array(c.viewProjection);
    c.setJitter(3, 3);
    expect([...c.viewProjection]).toEqual([...before]);
    const got: [number, number] = [9, 9];
    c.getJitter(got);
    expect(got).toEqual([0, 0]);
    const o = Camera.ortho2d(320, 180);
    const b2 = new Float32Array(o.viewProjection);
    o.setJitterTarget(320, 180);
    o.setJitter(1, 1);
    expect([...o.viewProjection]).toEqual([...b2]);
    o.getJitter(got);
    expect(got).toEqual([0, 0]);
  });

  it('the renderer jitters only when the post processor wants it; the 2D camera never', () => {
    const { fake, r } = setup();
    r.camera.setJitter(2, 0);
    r.camera.lookAt([0, 0, 5], [0, 0, 0]);
    const off = recordingPost(false);
    r.post = off;
    const f = r.beginFrame(0, 0);
    f.mesh(cube3d(r), r.createMaterial(OPAQUE), new Transform());
    r.endFrame();
    expect(off.seen[0]!.jitter).toEqual([0, 0]);
    const steady = new Float32Array(off.seen[0]!.viewProj);

    const on = recordingPost(true);
    r.post = on;
    r.beginFrame(0, 0);
    r.endFrame();
    expect(on.seen[0]!.jitter).toEqual([2, 0]);
    expect([...on.seen[0]!.viewProj]).not.toEqual([...steady]);
    // Previous matrices never carry the jitter.
    expect([...on.seen[0]!.previousViewProj]).toEqual([...steady]);

    const r2 = new Renderer(fakeRendererGpu(createFakeDevice()));
    const p2 = recordingPost(true);
    r2.post = p2;
    r2.camera.setJitter(2, 0);
    r2.beginFrame(0, 0);
    r2.endFrame();
    expect(p2.seen[0]!.jitter).toEqual([0, 0]);
    expect(fake.errors).toEqual([]);
  });

  it('previous matrices lag one frame; the first view reads no motion', () => {
    const { fake, r } = setup();
    const post = recordingPost(false);
    r.post = post;
    r.camera.lookAt([0, 0, 5], [0, 0, 0]);
    r.beginFrame(0, 0);
    r.endFrame();
    const v0 = post.seen[0]!;
    expect([...v0.previousViewProj]).toEqual([...v0.viewProj]);
    expect([...v0.previousView]).toEqual([...r.camera.view]);
    r.camera.lookAt([1, 0, 5], [0, 0, 0]);
    r.beginFrame(0, 0);
    r.endFrame();
    const v1 = post.seen[1]!;
    expect([...v1.previousViewProj]).toEqual([...v0.viewProj]);
    expect([...v1.viewProj]).not.toEqual([...v0.viewProj]);
    r.beginFrame(0, 0);
    r.endFrame();
    expect([...post.seen[2]!.previousViewProj]).toEqual([...v1.viewProj]);
    expect(fake.errors).toEqual([]);
  });
});

describe('aux targets (ws/render-4)', () => {
  it('a target without aux has two colour attachments and no extra textures', () => {
    const fake = createFakeDevice();
    const t = new SceneTarget(fake.device, { width: 8, height: 8 });
    expect(t.roughMetal).toBeNull();
    expect(t.velocity).toBeNull();
    expect(t.auxKey).toBe(0);
    expect(t.passDesc.colorAttachments).toHaveLength(2);
    expect(fake.textures.map((x) => x.label)).toEqual(['scene-color', 'scene-emissive']);
  });

  it('aux adds rg8unorm and rg16float attachments that resize and destroy with the target', () => {
    const fake = createFakeDevice();
    const t = new SceneTarget(fake.device, {
      width: 8,
      height: 4,
      aux: { roughMetal: true, velocity: true },
    });
    expect(t.auxKey).toBe(3);
    expect(t.roughMetal?.format).toBe(ROUGH_METAL_FORMAT);
    expect(t.velocity?.format).toBe(VELOCITY_FORMAT);
    expect(t.passDesc.colorAttachments).toHaveLength(4);
    expect(t.resize(16, 16)).toBe(true);
    expect(t.roughMetal?.width).toBe(16);
    expect(t.velocity?.height).toBe(16);
    const live = () => fake.textures.filter((x) => !x.destroyed).map((x) => x.label);
    expect(live()).toContain('scene-rough-metal');
    expect(live()).toContain('scene-velocity');
    t.destroy();
    expect(live()).toEqual([]);
    const only = new SceneTarget(fake.device, { width: 8, height: 4, aux: { velocity: true } });
    expect(only.auxKey).toBe(2);
    expect(only.roughMetal).toBeNull();
    expect(only.passDesc.colorAttachments).toHaveLength(3);
  });

  it('a renderer without aux draws with two targets; with aux every pipeline carries four', () => {
    const plain = setup();
    const plainPost = recordingPost(false);
    plain.r.post = plainPost;
    const f = plain.r.beginFrame(0, 0);
    f.mesh(cube3d(plain.r), plain.r.createMaterial(OPAQUE), new Transform());
    plain.r.endFrame();
    const p0 = pipelineDescs(scenePass(plain.fake).commands)[0]!;
    expect((p0.fragment!.targets as GPUColorTargetState[]).length).toBe(2);
    expect(scenePass(plain.fake).desc).toMatchObject({ colorAttachments: expect.any(Array) });
    expect((scenePass(plain.fake).desc as GPURenderPassDescriptor).colorAttachments).toHaveLength(
      2,
    );
    expect(plainPost.aux).toEqual([null, null]);

    const aux = setup({ roughMetal: true, velocity: true });
    const auxPost = recordingPost(false);
    aux.r.post = auxPost;
    const g = aux.r.beginFrame(0, 0);
    const m = aux.r.createMaterial(OPAQUE);
    g.mesh(cube3d(aux.r), m, new Transform());
    aux.r.endFrame();
    const p1 = pipelineDescs(scenePass(aux.fake).commands)[0]!;
    const targets = p1.fragment!.targets as GPUColorTargetState[];
    expect(targets.map((t) => t.format)).toEqual([
      'rgba16float',
      'rgba16float',
      ROUGH_METAL_FORMAT,
      VELOCITY_FORMAT,
    ]);
    // A plain material leaves the aux attachments alone.
    expect(targets[2]!.writeMask).toBe(0);
    expect(targets[3]!.writeMask).toBe(0);
    expect((scenePass(aux.fake).desc as GPURenderPassDescriptor).colorAttachments).toHaveLength(4);
    expect(auxPost.aux).toEqual([aux.r.target.roughMetal, aux.r.target.velocity]);
    expect(aux.r.target.roughMetal).not.toBeNull();
    expect(aux.fake.errors).toEqual([]);
  });

  it('the standard material writes both aux outputs with their write masks on', () => {
    const { fake, r } = setup({ roughMetal: true, velocity: true });
    const m = createStandardMaterial(r, { label: 'std' });
    const f = r.beginFrame(0, 0);
    f.mesh(cube3d(r), m, new Transform());
    r.endFrame();
    const desc = pipelineDescs(scenePass(fake).commands)[0]!;
    const targets = desc.fragment!.targets as GPUColorTargetState[];
    expect(targets[2]!.writeMask).toBe(0xf);
    expect(targets[3]!.writeMask).toBe(0xf);
    const code = (desc.fragment!.module as unknown as { code: string }).code;
    expect(code).toContain('@location(2) rough_metal: vec2f');
    expect(code).toContain('@location(3) velocity: vec2f');
    expect(code).toContain('engine_write_aux(&o, vec2f(roughness, metallic), engine_velocity(in))');
    expect(fake.errors).toEqual([]);
  });
});

describe('velocity lane (ws/render-4)', () => {
  it('an InstanceList with velocity keeps previous matrices and a third vertex buffer', () => {
    const { fake, r } = setup({ velocity: true });
    const m = createStandardMaterial(r, { label: 'std' });
    const cube = cube3d(r);
    const list = r.createInstanceList(cube, m, 4, { velocity: true });
    expect(list.velocity).toBe(true);
    expect(list.prevMatrices).toHaveLength(4 * 12);
    expect(list.prevBuffer?.label).toBe('instance-list-prev');
    list.set(0, new Transform({ x: 1, z: -5 }));
    list.set(1, new Transform({ x: 2, z: -5 }));
    let f = r.beginFrame(0, 0);
    f.list(list); // the frame flushes the list
    r.endFrame();
    // First flush: previous = current (no motion).
    expect(list.prevMatrices![3]).toBe(1);
    expect(list.prevMatrices![12 + 3]).toBe(2);
    // Move one; the other settles.
    list.set(0, new Transform({ x: 1.5, z: -5 }));
    f = r.beginFrame(0, 0);
    f.list(list); // the frame flushes the list
    r.endFrame();
    expect(list.prevMatrices![3]).toBe(1);
    expect(list.matrices[3]).toBe(1.5);
    expect(list.prevMatrices![12 + 3]).toBe(2);
    // Next frame, untouched: previous catches up.
    f = r.beginFrame(0, 0);
    f.list(list); // the frame flushes the list
    r.endFrame();
    expect(list.prevMatrices![3]).toBe(1.5);
    const prevWrites = fake.writes.filter((w) => w.buffer.label === 'instance-list-prev');
    expect(prevWrites.length).toBeGreaterThanOrEqual(2);

    const cmds = scenePass(fake).commands;
    const desc = pipelineDescs(cmds)[0]!;
    const buffers = desc.vertex.buffers as GPUVertexBufferLayout[];
    expect(buffers).toHaveLength(3);
    expect(buffers[0]).toBe(VERTEX3D_BUFFER_LAYOUT);
    expect(buffers[1]).toBe(INSTANCE_BUFFER_LAYOUT);
    expect(buffers[2]).toBe(prevLaneBufferLayout(VERTEX_LAYOUT_3D));
    expect(buffers[2]!.arrayStride).toBe(48);
    expect(buffers[2]!.stepMode).toBe('instance');
    expect(desc.label).toBe('material:std:3d:d0:aux2:p');
    const code = (desc.vertex.module as unknown as { code: string }).code;
    expect(code).toContain('fn engine_previous_world_position');
    expect(code).toContain('v.p0');
    const set = cmds.filter(
      (c): c is Extract<PassCommand, { op: 'other' }> =>
        c.op === 'other' && c.name === 'setVertexBuffer',
    );
    expect(set.some((c) => c.slot === 2 && c.buffer === list.prevBuffer)).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it('a list without velocity, or a target without one, uses the two-buffer pipeline', () => {
    const { fake, r } = setup({ velocity: true });
    const m = createStandardMaterial(r, { label: 'std' });
    const cube = cube3d(r);
    const list = r.createInstanceList(cube, m, 2);
    expect(list.prevBuffer).toBeNull();
    list.set(0, new Transform({ z: -5 }));
    const f = r.beginFrame(0, 0);
    f.list(list);
    f.mesh(cube, m, new Transform({ x: 3, z: -5 }));
    list.flush(fake.device.queue);
    r.endFrame();
    for (const d of pipelineDescs(scenePass(fake).commands)) {
      expect((d.vertex.buffers as unknown[]).length).toBe(2);
      // Without a lane the previous position comes from the instance matrix: zero motion.
      const code = (d.vertex.module as unknown as { code: string }).code;
      expect(code).toContain('v.m0');
      expect(code).not.toContain('v.p0');
    }
    expect(fake.errors).toEqual([]);
  });

  it('prevLaneLocations takes the free locations of each layout', () => {
    expect(prevLaneLocations(VERTEX_LAYOUT_3D)).toEqual([11, 12, 13]);
    expect(prevLaneLocations(VERTEX_LAYOUT_3D_TANGENT)).toEqual([11, 12, 14]);
    expect(prevLaneLocations(VERTEX_LAYOUT_SKINNED)).toEqual([13, 14, 15]);
    expect(prevLaneLocations(VERTEX_LAYOUT_3D_UV2)).toEqual([11, 12, 13]);
    const lane = prevLaneBufferLayout(VERTEX_LAYOUT_3D);
    expect(prevLaneBufferLayout(VERTEX_LAYOUT_3D)).toBe(lane);
    expect([...lane.attributes].map((a) => a.shaderLocation)).toEqual([11, 12, 13]);
  });

  it('a skin palette with history keeps the previous block and the prelude reads it', () => {
    const fake = createFakeDevice();
    const p = new SkinPalette(fake.device, { joints: 1, instances: 2, history: true });
    expect(p.history).toBe(true);
    expect(fake.buffers[0]!.size).toBe((4 + 2 * 2 * JOINT_FLOATS) * 4);
    expect(p.previousOffsetOf(1)).toBe(4 + 3 * JOINT_FLOATS);
    expect(new SkinPalette(fake.device, { joints: 1 }).previousOffsetOf(0)).toBe(-1);
    p.flush();
    p.flush(); // settles the identity palette's previous block
    fake.writes.length = 0;
    const mats = new Float32Array(JOINT_FLOATS).map((_, i) => i + 10);
    p.set(0, mats);
    p.flush();
    // Current and previous blocks of slot 0 go up; previous still holds the identity.
    expect(fake.writes).toEqual([
      { buffer: fake.buffers[0], offset: p.offsetOf(0) * 4, bytes: JOINT_FLOATS * 4 },
      { buffer: fake.buffers[0], offset: p.previousOffsetOf(0) * 4, bytes: JOINT_FLOATS * 4 },
    ]);
    fake.writes.length = 0;
    // Untouched next frame: previous settles to current, uploaded once more.
    p.flush();
    expect(fake.writes).toHaveLength(2);
    fake.writes.length = 0;
    p.flush();
    expect(fake.writes).toEqual([]);
    const code = materialPrelude(VERTEX_LAYOUT_SKINNED, { velocity: true });
    expect(code).toContain('fn engine_skin_previous(');
    expect(code).toContain('engine_skin_previous(v, v.pos)');
  });
});

describe('index ranges (ws/render-4)', () => {
  it('two ranges of one mesh give two draw calls with their firstIndex and count', () => {
    const { fake, r } = setup();
    const m = r.createMaterial(OPAQUE);
    const mesh = r.createMesh({
      ...quadGeometry(),
      bounds: { center: [0, 0, 0], radius: 1 },
      ranges: { a: { first: 0, count: 3 }, b: { first: 3, count: 3 } },
    });
    expect(mesh.ranges?.a).toEqual({ first: 0, count: 3 });
    const f = r.beginFrame(0, 0);
    f.mesh(mesh, m, new Transform({ z: -5 }), { range: mesh.ranges!.b });
    f.mesh(mesh, m, new Transform({ x: -1, z: -5 }), { range: mesh.ranges!.b });
    f.mesh(mesh, m, new Transform({ x: 1, z: -5 }), { range: mesh.ranges!.a });
    f.mesh(mesh, m, new Transform({ x: 2, z: -5 }));
    r.endFrame();
    const d = draws(scenePass(fake).commands).map((c) => [
      c.indices,
      c.instances,
      c.firstIndex ?? 0,
    ]);
    // Adjacent draws of one (mesh, material, range) merge; a range change splits the batch.
    expect(d).toEqual([
      [3, 2, 3],
      [3, 1, 0],
      [6, 1, 0],
    ]);
    expect(r.stats.drawCalls).toBe(3);
    expect(fake.errors).toEqual([]);
  });
});

describe('lazy pipelines and the tangent prelude (ws/render-4)', () => {
  it('a material builds no pipeline until it is used; 3D first never makes the 2D one', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const m = r.createMaterial({ wgsl: WGSL, uniformBytes: 16, name: 'late' });
    expect(m.name).toBe('late');
    expect(m.label).toBe('late');
    expect(m.depthTest).toBe(true);
    const p3 = m.pipelineFor(VERTEX_LAYOUT_3D, 2) as unknown as {
      desc: GPURenderPipelineDescriptor;
    };
    expect(p3.desc.label).toBe('material:late:3d:d2');
    const p2 = m.pipeline as unknown as { desc: GPURenderPipelineDescriptor };
    expect(p2.desc.label).toBe('material:late');
    expect((p2.desc.vertex.buffers as unknown[])[0]).toBe(VERTEX_BUFFER_LAYOUT);
    expect(m.pipelineFor(VERTEX_LAYOUT_2D, 0)).toBe(m.pipeline);
    expect(fake.errors).toEqual([]);
  });

  it('depthTest false draws with no depth compare and no depth write', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const m = r.createMaterial({ label: 'ov', wgsl: WGSL, uniformBytes: 16, depthTest: false });
    const d = (
      m.pipelineFor(VERTEX_LAYOUT_3D, 2) as unknown as { desc: GPURenderPipelineDescriptor }
    ).desc;
    expect(d.depthStencil).toMatchObject({ depthCompare: 'always', depthWriteEnabled: false });
    const s = createStandardMaterial(r, { label: 'sov', depthTest: false });
    expect(s.depthTest).toBe(false);
  });

  it('engine_local_tangent reads the layout tangent or zero; the standard material compiles it', () => {
    const tan = materialPrelude(VERTEX_LAYOUT_3D_TANGENT);
    expect(tan).toContain('fn engine_local_tangent(v: VertexIn) -> vec4f');
    expect(tan).toContain('return v.tangent;');
    expect(tan).toContain('@location(10) tangent: vec4f');
    const plain = materialPrelude(VERTEX_LAYOUT_3D);
    expect(plain).toContain(
      'fn engine_local_tangent(v: VertexIn) -> vec4f {\n  return vec4f(0.0);',
    );
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const m = createStandardMaterial(r, { label: 't' });
    m.pipelineFor(VERTEX_LAYOUT_3D_TANGENT, 2);
    expect(fake.errors).toEqual([]);
  });

  it('VERTEX_LAYOUT_3D_UV2 carries uv1 at location 14 and the prelude maps it', () => {
    expect(VERTEX3D_UV2_FLOATS).toBe(14);
    expect(VERTEX3D_UV2_STRIDE).toBe(56);
    const locs = [...VERTEX_LAYOUT_3D_UV2.buffer.attributes].map((a) => a.shaderLocation);
    expect(locs).toContain(14);
    const code = materialPrelude(VERTEX_LAYOUT_3D_UV2);
    expect(code).toContain('@location(14) uv1: vec2f');
    expect(code).toContain('@location(12) uv1: vec2f');
    expect(code).toContain('v.uv1');
    expect(materialPrelude(VERTEX_LAYOUT_3D)).toContain(
      'o.uv1 = mix(v.uvRect.xy, v.uvRect.zw, v.uv);',
    );
  });
});

describe('loadTextureArray filter (ws/render-4)', () => {
  function pixels(w: number, h: number) {
    return { width: w, height: h, data: new Uint8Array(new ArrayBuffer(w * h * 4)) };
  }

  it('takes `filter`, and the deprecated `mipFilter`, the same way', () => {
    const fake = createFakeDevice();
    loadTextureArray(fake.device, [pixels(4, 4)], { filter: 'nearest', label: 'a' });
    loadTextureArray(fake.device, [pixels(4, 4)], { mipFilter: 'nearest', label: 'b' });
    const mips = fake.passes.filter((p) => p.label?.startsWith('mipmap:'));
    expect(mips.length).toBe(4);
    for (const p of mips) {
      const pipe = p.commands.find((c) => c.op === 'setPipeline') as {
        pipeline: { label: string };
      };
      expect(pipe.pipeline.label).toBe('mipmap:rgba8unorm-srgb:nearest');
    }
    expect(fake.errors).toEqual([]);
  });
});
