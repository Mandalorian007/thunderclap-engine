/**
 * ws/render-7: stable LOD keys on `InstanceList` (level memory and velocity history follow a
 * key, not an index) and per-instance velocity for copied batches (LOD lists and
 * `frame.meshes` with `prevMatrices`) through the renderer's shared previous-matrix lane. Fake
 * GPU only; the pixels are checked by `harness/render7.html`.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import type { InstanceList } from './instance-list';
import type { MeshLod } from './lod';
import { INSTANCE_BUFFER_LAYOUT, type MaterialDesc } from './material';
import { type Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
import { Renderer } from './renderer';
import { createStandardMaterial } from './standard';
import { Transform } from './transform';
import { prevLaneBufferLayout } from './wgsl';

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

function setup(velocity = false) {
  const fake = createFakeDevice({}, []);
  const r = new Renderer(fakeRendererGpu(fake), velocity ? { aux: { velocity: true } } : {});
  r.resize(1000, 1000);
  const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  cam.lookAt([0, 0, 0], [0, 0, -1]);
  cam.cull = false;
  cam.depthTest = false;
  r.camera = cam;
  // fovY 90°, viewport 1000 px: a unit sphere at distance d covers 1000 / d px.
  const lod: MeshLod = {
    meshes: [mesh(r, 'lod0'), mesh(r, 'lod1'), mesh(r, 'lod2')],
    thresholdsPx: [200, 50],
  };
  return { fake, r, cam, lod };
}

/** Draw `list` for one frame; the levels' instance counts, trailing zeros dropped. */
function drawList(r: Renderer, list: InstanceList): number[] {
  const f = r.beginFrame(0, 0);
  f.list(list);
  r.endFrame();
  const out = [...r.stats.lodCounts];
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}

/**
 * Ten instances alternating A (even: drawn near first, level 0) and B (odd: far, level 2),
 * then all parked at 190 px, inside the band below 200: A holds level 0, B settles at 1.
 */
function parked(r: Renderer, lod: MeshLod, keys: boolean): InstanceList {
  const list = r.createInstanceList(lod, r.createMaterial(OPAQUE), 16);
  for (let i = 0; i < 10; i++) {
    list.set(i, new Transform({ x: i * 0.01, z: i % 2 === 0 ? -2 : -100 }));
    if (keys) list.setKey(i, 1000 + i);
  }
  expect(drawList(r, list)).toEqual([5, 0, 5]);
  const z = -1000 / 190;
  for (let i = 0; i < 10; i++) list.set(i, new Transform({ x: i * 0.01, z }));
  expect(drawList(r, list)).toEqual([5, 5]);
  return list;
}

function scenePass(fake: FakeDevice) {
  return [...fake.passes].reverse().find((x) => x.label === 'scene')!;
}

function pipelineDescs(cmds: PassCommand[]): GPURenderPipelineDescriptor[] {
  return cmds
    .filter((c): c is Extract<PassCommand, { op: 'setPipeline' }> => c.op === 'setPipeline')
    .map((c) => (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
}

/** The floats of the last write into the buffer labelled `label`. */
function lastWrite(fake: FakeDevice, label: string): Float32Array {
  for (let i = fake.writes.length - 1; i >= 0; i--) {
    const w = fake.writes[i]!;
    if (w.buffer.label !== label) continue;
    const d = fake.writeData[i]!;
    const buf = d.data instanceof ArrayBuffer ? d.data : d.data.buffer;
    return new Float32Array(buf, d.dataOffset, w.bytes / 4);
  }
  throw new Error(`no write to ${label}`);
}

describe('stable LOD keys (ws/render-7)', () => {
  it('without keys, removing instance 0 of 10 hands the moved instance its slot memory', () => {
    const { r, lod } = setup();
    const list = parked(r, lod, false);
    // B9 swaps into slot 0 and inherits A0's level 0: one B now draws at level 0.
    expect(list.remove(0)).toBe(9);
    expect(drawList(r, list)).toEqual([5, 4]);
  });

  it('with keys, removing instance 0 of 10 changes no other instance level', () => {
    const { r, lod } = setup();
    const list = parked(r, lod, true);
    expect(list.remove(0)).toBe(9);
    expect(list.keyOf(0)).toBe(1009);
    expect(drawList(r, list)).toEqual([4, 5]);
    expect(list.previousIndex![0]).toBe(9);
    expect(list.previousIndex![1]).toBe(1);
  });

  it('with keys, a clear and refill in another order keeps every level', () => {
    const { r, lod } = setup();
    const list = parked(r, lod, true);
    const z = -1000 / 190;
    list.clear();
    // Reversed, and A0 dropped: 4 A at level 0, 5 B at level 1.
    for (let k = 9; k >= 1; k--)
      list.set(list.count, new Transform({ x: k * 0.01, z })).setKey(list.count - 1, 1000 + k);
    expect(drawList(r, list)).toEqual([4, 5]);
    // A new key starts with no memory: at 190 px it picks plainly (level 1).
    list.set(list.count, new Transform({ z })).setKey(list.count - 1, 5000);
    expect(drawList(r, list)).toEqual([4, 6]);
  });

  it('keys stay with their slot through set, move with remove, and reject non-finite numbers', () => {
    const { r, lod } = setup();
    const list = r.createInstanceList(lod, r.createMaterial(OPAQUE), 4);
    expect(list.keyed).toBe(false);
    list.set(0, new Transform()).set(1, new Transform());
    list.setKey(0, 7);
    expect(list.keyed).toBe(true);
    list.set(0, new Transform({ x: 1 }));
    expect(list.keyOf(0)).toBe(7);
    expect(list.keyOf(1)).toBeNull();
    list.setKey(1, 8);
    list.remove(0);
    expect(list.keyOf(0)).toBe(8);
    expect(list.keyOf(1)).toBeNull();
    list.set(1, new Transform());
    expect(list.keyOf(1)).toBeNull(); // an appended slot starts without one
    expect(() => list.setKey(0, Number.NaN)).toThrow();
    expect(() => list.setKey(3, 1)).toThrow();
    list.setKey(0, null);
    expect(list.keyOf(0)).toBeNull();
  });
});

describe('per-instance velocity on copied batches (ws/render-7)', () => {
  it('a LOD list with velocity carries previous matrices in the shared lane, by key', () => {
    const { fake, r, lod } = setup(true);
    const m = createStandardMaterial(r, { label: 'std' });
    const list = r.createInstanceList(lod, m, 8, { velocity: true });
    list.set(0, new Transform({ x: 1, z: -3 })).setKey(0, 10);
    list.set(1, new Transform({ x: 2, z: -3 })).setKey(1, 11);
    drawList(r, list);
    // Move key 11, then swap-remove key 10: key 11 now sits in slot 0.
    list.set(1, new Transform({ x: 2.5, z: -3 }));
    list.remove(0);
    // A new instance (key 12) appears.
    list.set(1, new Transform({ x: 4, z: -3 })).setKey(1, 12);
    drawList(r, list);

    const lane = lastWrite(fake, 'instance-lane');
    expect(lane).toHaveLength(2 * 12);
    // Both instances draw level 0 (333 px); in the upload's order: key 11, then key 12.
    expect(lane[3]).toBe(2); // key 11's previous x
    expect(lane[12 + 3]).toBe(4); // key 12 is new: previous = current (zero motion)
    const inst = lastWrite(fake, 'instances');
    expect(inst[3]).toBe(2.5);
    expect(inst[28 + 3]).toBe(4);

    const cmds = scenePass(fake).commands;
    const desc = pipelineDescs(cmds)[0]!;
    const buffers = desc.vertex.buffers as GPUVertexBufferLayout[];
    expect(buffers).toHaveLength(3);
    expect(buffers[1]).toBe(INSTANCE_BUFFER_LAYOUT);
    expect(buffers[2]).toBe(prevLaneBufferLayout(VERTEX_LAYOUT_3D));
    expect(desc.label).toBe('material:std:3d:d0:aux2:p');
    const set = cmds.filter(
      (c): c is Extract<PassCommand, { op: 'other' }> =>
        c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 2,
    );
    expect(set).toHaveLength(1);
    expect((set[0]!.buffer as { label: string }).label).toBe('instance-lane');
    expect(set[0]!.offset).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('without keys the history goes by index, and a slot past last frame count is new', () => {
    const { fake, r, lod } = setup(true);
    const m = createStandardMaterial(r, { label: 'std' });
    const list = r.createInstanceList(lod, m, 8, { velocity: true });
    list.set(0, new Transform({ x: 1, z: -3 }));
    drawList(r, list);
    list.clear();
    list.set(0, new Transform({ x: 1.5, z: -3 }));
    list.set(1, new Transform({ x: 9, z: -3 }));
    drawList(r, list);
    const lane = lastWrite(fake, 'instance-lane');
    expect(lane[3]).toBe(1);
    expect(lane[12 + 3]).toBe(9);
    // A slot that died and is appended again later has no history either.
    list.remove(1);
    drawList(r, list);
    list.set(1, new Transform({ x: 20, z: -3 }));
    drawList(r, list);
    expect(lastWrite(fake, 'instance-lane')[12 + 3]).toBe(20);
  });

  it('frame.meshes with prevMatrices uses the lane; without a velocity target it does not', () => {
    for (const velocity of [true, false]) {
      const { fake, r, lod } = setup(velocity);
      const m = createStandardMaterial(r, { label: 'std' });
      const matrices = new Float32Array([1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, -3]);
      const prevMatrices = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -3]);
      const f = r.beginFrame(0, 0);
      f.meshes(lod, m, { count: 1, matrices, prevMatrices });
      f.meshes(lod.meshes[0]!, m, { count: 1, matrices, prevMatrices });
      r.endFrame();
      const descs = pipelineDescs(scenePass(fake).commands);
      for (const d of descs) {
        expect((d.vertex.buffers as unknown[]).length).toBe(velocity ? 3 : 2);
      }
      if (velocity) {
        const lane = lastWrite(fake, 'instance-lane');
        expect(lane[3]).toBe(0);
        expect(lane[12 + 3]).toBe(0);
      } else {
        expect(fake.buffers.some((b) => b.label === 'instance-lane')).toBe(false);
      }
      expect(fake.errors).toEqual([]);
      expect(() =>
        r.beginFrame(0, 0).meshes(lod, m, {
          count: 2,
          matrices: new Float32Array(24),
          prevMatrices,
        }),
      ).toThrow(/prevMatrices/);
      r.endFrame();
    }
  });

  it('a material without aux, or a list without velocity, keeps the two-buffer pipeline', () => {
    const { fake, r, lod } = setup(true);
    const plain = r.createMaterial(OPAQUE);
    const a = r.createInstanceList(lod, plain, 4, { velocity: true });
    a.set(0, new Transform({ z: -3 }));
    const b = r.createInstanceList(lod, createStandardMaterial(r, { label: 'std' }), 4);
    b.set(0, new Transform({ z: -3 }));
    const f = r.beginFrame(0, 0);
    f.list(a);
    f.list(b);
    r.endFrame();
    for (const d of pipelineDescs(scenePass(fake).commands)) {
      expect((d.vertex.buffers as unknown[]).length).toBe(2);
    }
    expect(fake.buffers.some((x) => x.label === 'instance-lane')).toBe(false);
  });

  it('a second view binds the lane at its own base', () => {
    const { fake, r, cam, lod } = setup(true);
    const m = createStandardMaterial(r, { label: 'std' });
    const list = r.createInstanceList(lod, m, 4, { velocity: true });
    list.set(0, new Transform({ z: -3 }));
    list.set(1, new Transform({ z: -4 }));
    const other = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
    other.lookAt([0, 0, 0], [0, 0, -1]);
    other.depthTest = false;
    const f = r.beginFrame(0, 0);
    f.list(list);
    r.render(f, cam);
    r.render(f, other);
    r.endFrame();
    const offsets = fake.passes
      .filter((p) => p.label === 'scene')
      .slice(-2)
      .map((p) =>
        (p.commands as PassCommand[]).find(
          (c) => c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 2,
        ),
      )
      .map((c) => (c as { offset?: number }).offset);
    expect(offsets).toEqual([0, 2 * 48]);
    expect(fake.errors).toEqual([]);
  });

  it('keyed velocity LOD frames do not allocate in steady state', () => {
    const { fake, r, lod } = setup(true);
    const m = createStandardMaterial(r, { label: 'std' });
    const list = r.createInstanceList(lod, m, 64, { velocity: true });
    const t = new Transform();
    let frame = 0;
    const step = () => {
      list.clear();
      for (let i = 0; i < 48; i++) {
        t.setPosition(i + frame * 0.1, 0, -2 - (i % 30) * 3);
        list.set(list.count, t).setKey(list.count - 1, (i * 7 + frame) % 48);
      }
      frame++;
      drawList(r, list);
    };
    step();
    step();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 4; i++) step();
    expect(counts()).toEqual(before);
  });
});
