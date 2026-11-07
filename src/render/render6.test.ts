/**
 * ws/render-6: LOD for batches and lists (bucketed per level, level memory per view), alpha-
 * masked shadow casters, and the renderer's jitter hook. Fake GPU only; the pixels are checked
 * by `harness/render5?lod&instanced` and `?mask`.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import type { MeshLod } from './lod';
import type { MaterialDesc } from './material';
import { type Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
import { Renderer } from './renderer';
import { createStandardMaterial, type StandardMaterialDesc } from './standard';
import { Transform } from './transform';

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;
const OPAQUE: MaterialDesc = { label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' };

function mesh(r: Renderer, label: string): Mesh {
  return r.createMesh({
    vertices: new Float32Array(VERTEX3D_FLOATS * 3),
    indices: new Uint16Array([0, 1, 2]),
    layout: VERTEX_LAYOUT_3D,
    bounds: { center: [0, 0, 0], radius: 1 },
    label,
  });
}

function setup() {
  const fake = createFakeDevice({}, []);
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(1000, 1000);
  const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  cam.lookAt([0, 0, 0], [0, 0, -1]);
  cam.cull = false;
  r.camera = cam;
  // fovY 90°, viewport 1000 px: a unit sphere at distance d covers 1000 / d px.
  const lod: MeshLod = {
    meshes: [mesh(r, 'lod0'), mesh(r, 'lod1'), mesh(r, 'lod2')],
    thresholdsPx: [200, 50],
  };
  const a = r.createMaterial(OPAQUE);
  return { fake, r, cam, lod, a };
}

/** 3×4 row-major matrices translating to `z` (one per entry). */
function rows(zs: number[]): Float32Array {
  const m = new Float32Array(zs.length * 12);
  zs.forEach((z, i) => {
    m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, z], i * 12);
  });
  return m;
}

function pass(fake: FakeDevice, label: string) {
  return [...fake.passes].reverse().find((x) => x.label === label)!;
}

/** A pass's draws as `[mesh label, instances]`, read from the bound vertex buffer. */
function drawn(fake: FakeDevice, label = 'scene'): [string, number][] {
  const out: [string, number][] = [];
  let vb = '';
  for (const c of pass(fake, label).commands as PassCommand[]) {
    if (c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 0) {
      vb = ((c.buffer as { label?: string }).label ?? '').replace(/-vb$/, '');
    }
    if (c.op === 'drawIndexed') out.push([vb, c.instances]);
  }
  return out;
}

describe('LOD batches and lists (ws/render-6)', () => {
  it('frame.meshes with a MeshLod buckets instances: one draw per non-empty level', () => {
    const { fake, r, lod, a } = setup();
    // Interleaved near (500 px), mid (100 px), far (10 px), twice; plus two more mid.
    const matrices = rows([-2, -10, -100, -2, -10, -100, -10, -12]);
    const f = r.beginFrame(0, 0);
    f.meshes(lod, a, { count: 8, matrices });
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([2, 4, 2]);
    expect(r.stats.drawCalls).toBe(3);
    expect(drawn(fake)).toEqual([
      ['lod0', 2],
      ['lod1', 4],
      ['lod2', 2],
    ]);
    expect(fake.errors).toEqual([]);
    // All near: one level, one draw.
    const g = r.beginFrame(0, 0);
    g.meshes(lod, a, { count: 3, matrices: rows([-2, -2.5, -3]) });
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([3, 0, 0]);
    expect(drawn(fake)).toEqual([['lod0', 3]]);
  });

  it('an InstanceList with a MeshLod picks per instance and culls per instance', () => {
    const { fake, r, cam, lod, a } = setup();
    const list = r.createInstanceList(lod, a, 8);
    expect(list.mesh).toBe(lod.meshes[0]);
    expect(list.lod).toBe(lod);
    for (const z of [-2, -100, -10, -3]) list.set(list.count, new Transform({ z }));
    // One behind the camera: culled per instance once culling is on.
    list.set(list.count, new Transform({ z: 50 }));
    cam.cull = true;
    const f = r.beginFrame(0, 0);
    f.list(list);
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([2, 1, 1]);
    expect(drawn(fake)).toEqual([
      ['lod0', 2],
      ['lod1', 1],
      ['lod2', 1],
    ]);
    expect(fake.errors).toEqual([]);
    expect(() => r.createInstanceList({ meshes: [], thresholdsPx: [] }, a, 4)).toThrow();
  });

  it('keeps level memory per view: each camera holds its own hysteresis', () => {
    const { r, cam, lod, a } = setup();
    const other = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    other.lookAt([0, 0, 0], [0, 0, -1]);
    other.cull = false;
    const t = new Transform({ z: -4 }); // 250 px: level 0
    const batch = { count: 1, matrices: rows([-4]) };
    const view = (c: Camera, z: number) => {
      t.setPosition(0, 0, z);
      batch.matrices[11] = z;
      r.camera = c;
      const f = r.beginFrame(0, 0);
      f.mesh(lod, a, t);
      f.meshes(lod, a, batch);
      r.endFrame();
      // lodCounts keeps its length across frames (zeroed); drop the trailing zeros.
      const out = [...r.stats.lodCounts];
      while (out.length > 0 && out[out.length - 1] === 0) out.pop();
      return out;
    };
    expect(view(cam, -4)).toEqual([2]);
    // 192 px: the camera that drew level 0 holds it inside the band ...
    expect(view(cam, -5.2)).toEqual([2]);
    // ... while a camera seeing it first picks plainly (level 1).
    expect(view(other, -5.2)).toEqual([0, 2]);
    // And the first camera's memory is untouched by the second.
    expect(view(cam, -5.2)).toEqual([2]);
    expect(view(other, -4.9)).toEqual([0, 2]); // 204 px: inside the band above 200, holds 1
  });

  it('shadow casters draw the level the view picked, bucketed the same way', () => {
    const { fake, r, lod, a } = setup();
    const f = r.beginFrame(0, 0);
    f.lights.sun.dir = [-0.4, -1, -0.3];
    f.lights.sun.color = [1, 1, 1];
    f.lights.sun.shadow = { extent: 400 };
    f.meshes(lod, a, { count: 4, matrices: rows([-2, -10, -3, -100]) });
    r.endFrame();
    expect(drawn(fake)).toEqual([
      ['lod0', 2],
      ['lod1', 1],
      ['lod2', 1],
    ]);
    expect(drawn(fake, 'shadow')).toEqual([
      ['lod0', 2],
      ['lod1', 1],
      ['lod2', 1],
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('LOD batch frames do not allocate in steady state', () => {
    const { fake, r, lod, a } = setup();
    const zs = Array.from({ length: 64 }, (_, i) => -2 - i * 2);
    const batch = { count: 64, matrices: rows(zs) };
    const list = r.createInstanceList(lod, a, 64);
    for (const z of zs) list.set(list.count, new Transform({ x: 3, z }));
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.meshes(lod, a, batch);
      f.list(list);
      r.endFrame();
    };
    frame();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 3; i++) frame();
    expect(counts()).toEqual(before);
  });
});

describe('alpha-masked shadow casters (ws/render-6)', () => {
  function shadowPipes(desc: StandardMaterialDesc) {
    const fake = createFakeDevice({}, []);
    const r = new Renderer(fakeRendererGpu(fake));
    r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
    r.camera.lookAt([0, 0, 5], [0, 0, 0]);
    const m = createStandardMaterial(r, desc);
    const f = r.beginFrame(0, 0);
    f.lights.sun.dir = [-0.4, -1, -0.3];
    f.lights.sun.color = [1, 1, 1];
    f.lights.sun.shadow = { extent: 20 };
    f.mesh(mesh(r, 'quad'), m, new Transform());
    r.endFrame();
    const sp = fake.passes.filter((p) => p.label === 'shadow')[0]!;
    const pipes = sp.commands
      .filter((c): c is Extract<PassCommand, { op: 'setPipeline' }> => c.op === 'setPipeline')
      .map((c) => (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
    const groups = sp.commands.flatMap((c) => (c.op === 'setBindGroup' ? [c.index] : []));
    return { fake, pipes, groups, m };
  }

  it("alphaMode 'mask' casts through fs_shadow with the material bound", () => {
    const { fake, pipes, groups, m } = shadowPipes({ alphaMode: 'mask', alphaCutoff: 0.4 });
    expect(m.shadowFragment).toBe(true);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]!.fragment?.entryPoint).toBe('fs_shadow');
    expect([...(pipes[0]!.fragment?.targets ?? [])]).toEqual([]);
    expect(groups).toContain(1);
    expect(fake.errors).toEqual([]);
  });

  it('opaque and blend materials keep the depth-only fast path', () => {
    for (const alphaMode of ['opaque', undefined] as const) {
      const { pipes, groups, m } = shadowPipes(alphaMode ? { alphaMode } : {});
      expect(m.shadowFragment).toBe(false);
      expect(pipes[0]!.fragment).toBeUndefined();
      expect(groups).not.toContain(1);
    }
  });
});

describe('Renderer.setJitter (ws/render-6)', () => {
  const j = (c: Camera) => {
    const out: [number, number] = [0, 0];
    c.getJitter(out);
    return out;
  };

  it('jitters every view camera per frame, keeps history unjittered, clears on null', () => {
    const { r, cam } = setup();
    const eye = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    eye.lookAt([0, 0, 0], [0, 0, -1]);
    const plain = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    plain.lookAt([0, 0, 0], [0, 0, -1]);
    const seen: number[] = [];
    const tuple: [number, number] = [0, 0];
    r.setJitter((i) => {
      seen.push(i);
      tuple[0] = i === 0 ? 0.25 : -0.5;
      tuple[1] = 0.125;
      return tuple;
    });
    const f = r.beginFrame(0, 0);
    r.render(f, cam);
    r.render(f, eye);
    r.endFrame();
    expect(seen).toEqual([0]);
    expect(j(cam)).toEqual([0.25, 0.125]);
    expect(j(eye)).toEqual([0.25, 0.125]);
    // Jittered: viewProjection moved off the plain camera's by 2·0.25/1000 in clip x.
    const dx = eye.viewProjection[8]! - plain.viewProjection[8]!;
    expect(Math.abs(dx)).toBeCloseTo((2 * 0.25) / 1000, 6);
    const g = r.beginFrame(0, 0);
    r.render(g, cam);
    r.endFrame();
    expect(seen).toEqual([0, 1]);
    expect(j(cam)).toEqual([-0.5, 0.125]);
    // History is recorded before the jitter: the previous matrices carry none.
    const round = (m: Float32Array) => [...m].map((x) => Math.round(x * 1e6));
    expect(round(cam.previousViewProj)).toEqual(round(plain.viewProjection));
    r.setJitter(null);
    expect(cam.jitter).toEqual([0, 0]);
    expect(eye.jitter).toEqual([0, 0]);
    // Camera.setJitter is unchanged without a hook: stored, applied only for a jitter post.
    cam.setJitter(1, 1);
    r.beginFrame(0, 0);
    r.endFrame();
    expect(cam.jitter).toEqual([1, 1]);
    expect(j(cam)).toEqual([0, 0]);
  });
});
