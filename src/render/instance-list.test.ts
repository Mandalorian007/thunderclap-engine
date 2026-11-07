/**
 * ws/render-9: a LOD `InstanceList` uploads only what is drawn. Its instances reach the GPU in
 * the frame's per-level copy, so its own `buffer` is never written. Fake GPU only.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import type { MeshLod } from './lod';
import { INSTANCE_STRIDE, type MaterialDesc } from './material';
import { type Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
import { Renderer } from './renderer';

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
  const lod: MeshLod = {
    meshes: [mesh(r, 'lod0'), mesh(r, 'lod1'), mesh(r, 'lod2')],
    thresholdsPx: [200, 50],
  };
  return { fake, r, lod, a: r.createMaterial(OPAQUE) };
}

/** 3×4 row-major matrices translating to `z` (one per entry). */
function rows(zs: number[]): Float32Array {
  const m = new Float32Array(zs.length * 12);
  zs.forEach((z, i) => {
    m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, z], i * 12);
  });
  return m;
}

/** The last scene pass's draws as `[mesh label, instances, firstInstance]`. */
function drawn(fake: FakeDevice): [string, number, number][] {
  const p = [...fake.passes].reverse().find((x) => x.label === 'scene')!;
  const out: [string, number, number][] = [];
  let vb = '';
  for (const c of p.commands as PassCommand[]) {
    if (c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 0) {
      vb = ((c.buffer as { label?: string }).label ?? '').replace(/-vb$/, '');
    }
    if (c.op === 'drawIndexed') out.push([vb, c.instances, c.firstInstance]);
  }
  return out;
}

const bytesTo = (fake: FakeDevice, label: string, from = 0) =>
  fake.writes.slice(from).reduce((n, w) => n + (w.buffer.label === label ? w.bytes : 0), 0);
const allBytes = (fake: FakeDevice, from = 0) =>
  fake.writes.slice(from).reduce((n, w) => n + w.bytes, 0);

describe('LOD InstanceList uploads (ws/render-9)', () => {
  // Distances 2..100: each level gets instances (1000 / d px against thresholds 200, 50).
  const ZS = [-2, -3, -10, -12, -30, -60, -100, -4];

  it('writes N × INSTANCE_STRIDE fewer bytes than a list drawn from its buffer, and draws the same as frame.meshes', () => {
    // A: the LOD list. B: the same instances as a LOD frame.meshes batch (no list buffer).
    const A = setup();
    const list = A.r.createInstanceList(A.lod, A.a, 16);
    const m = rows(ZS);
    for (let i = 0; i < ZS.length; i++) list.set(i, m, {}, i * 12);
    const B = setup();
    const batch = { count: ZS.length, matrices: m };
    const fromA = A.fake.writes.length;
    const fromB = B.fake.writes.length;
    let f = A.r.beginFrame(0, 0);
    f.list(list);
    A.r.endFrame();
    f = B.r.beginFrame(0, 0);
    f.meshes(B.lod, B.a, batch);
    B.r.endFrame();

    // Before ws/render-9 the list also wrote its 8 instances into `instance-list`.
    expect(bytesTo(A.fake, 'instance-list', fromA)).toBe(0);
    expect(A.fake.writes.some((w) => w.buffer === (list.buffer as unknown))).toBe(false);
    expect(allBytes(A.fake, fromA)).toBe(allBytes(B.fake, fromB));
    expect(bytesTo(A.fake, 'instances', fromA)).toBeGreaterThanOrEqual(ZS.length * INSTANCE_STRIDE);
    expect(list.dirty).toBe(false);
    const levels = drawn(A.fake);
    expect(levels).toEqual(drawn(B.fake));
    expect(levels.map(([m]) => m)).toEqual(['lod0', 'lod1', 'lod2']);
    expect(levels.reduce((n, [, c]) => n + c, 0)).toBe(ZS.length);
    expect(A.fake.errors).toEqual([]);
  });

  it('a changed instance still reaches the draw; a plain list still uploads its range', () => {
    const { fake, r, lod, a } = setup();
    const list = r.createInstanceList(lod, a, 16);
    const plain = r.createInstanceList(mesh(r, 'plain'), a, 16);
    const m = rows(ZS);
    for (let i = 0; i < ZS.length; i++) {
      list.set(i, m, {}, i * 12);
      plain.set(i, m, {}, i * 12);
    }
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.list(list);
      f.list(plain);
      r.endFrame();
    };
    frame();
    const from = fake.writes.length;
    // Move the farthest instance (lod2) to the nearest band (lod0).
    list.set(6, rows([-2]));
    plain.set(6, rows([-2]));
    frame();
    expect(bytesTo(fake, 'instance-list', from)).toBe(INSTANCE_STRIDE);
    expect(fake.writes.slice(from).filter((w) => w.buffer.label === 'instance-list')).toHaveLength(
      1,
    );
    expect(fake.writes.slice(from).find((w) => w.buffer.label === 'instance-list')!.buffer).toBe(
      plain.buffer,
    );
    const draws = drawn(fake).filter(([m]) => m.startsWith('lod'));
    expect(draws.map(([m, c]) => [m, c])).toEqual([
      ['lod0', 4],
      ['lod1', 2],
      ['lod2', 2],
    ]);
    expect(fake.errors).toEqual([]);
  });
});
