/**
 * ws/render-8: per-object velocity for single `frame.mesh` draws (each Transform's previous
 * world matrix, kept per view, through the shared previous-matrix lane), no `prevBuffer`
 * upload for velocity LOD lists, and the `renderer.jitter` getter. Fake GPU only; the pixels
 * are checked by `harness/render7.html?single-velocity`.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import type { MeshLod } from './lod';
import type { MaterialDesc } from './material';
import { type Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
import type { JitterFn } from './renderer';
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

function perspective(): Camera {
  const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  cam.lookAt([0, 0, 0], [0, 0, -1]);
  return cam;
}

function setup(velocity = true) {
  const fake = createFakeDevice({}, []);
  const r = new Renderer(fakeRendererGpu(fake), velocity ? { aux: { velocity: true } } : {});
  r.resize(1000, 1000);
  const cam = perspective();
  r.camera = cam;
  const cube = mesh(r, 'cube');
  const std = createStandardMaterial(r, { label: 'std' });
  return { fake, r, cam, cube, std };
}

function scenePasses(fake: FakeDevice) {
  return fake.passes.filter((x) => x.label === 'scene');
}

function pipelineDescs(cmds: PassCommand[]): GPURenderPipelineDescriptor[] {
  return cmds
    .filter((c): c is Extract<PassCommand, { op: 'setPipeline' }> => c.op === 'setPipeline')
    .map((c) => (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
}

function laneBinds(cmds: PassCommand[]) {
  return cmds.filter(
    (c): c is Extract<PassCommand, { op: 'other' }> =>
      c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 2,
  );
}

/**
 * Snapshot every write into buffers labelled `label` at the time it is made (the renderer
 * reuses its staging arrays, so `fake.writeData` shows only their latest content).
 */
function capture(fake: FakeDevice, label: string): Float32Array[] {
  const out: Float32Array[] = [];
  const queue = fake.device.queue as unknown as {
    writeBuffer: (
      b: { label: string },
      o: number,
      d: ArrayBuffer,
      off?: number,
      n?: number,
    ) => void;
  };
  const write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (b, o, d, off = 0, n) => {
    if (b.label === label)
      out.push(new Float32Array(d.slice(off, off + (n ?? d.byteLength - off))));
    write(b, o, d, off, n);
  };
  return out;
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

/** Per drawn instance, sorted by current x: [current x, previous x]. */
function motionRows(fake: FakeDevice, n: number): number[][] {
  const lane = lastWrite(fake, 'instance-lane');
  const inst = lastWrite(fake, 'instances');
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push([inst[i * 28 + 3]!, lane[i * 12 + 3]!]);
  return rows.sort((a, b) => a[0]! - b[0]!);
}

describe('single-draw velocity (ws/render-8)', () => {
  it("frame.mesh writes its Transform's previous world matrix into the lane", () => {
    const { fake, r, cube, std } = setup();
    const t = new Transform({ x: 1, z: -5 });
    const draw = () => {
      const f = r.beginFrame(0, 0);
      f.mesh(cube, std, t);
      r.endFrame();
    };
    draw();
    // First seen: previous = current, zero motion.
    expect(lastWrite(fake, 'instance-lane')[3]).toBe(1);
    t.setPosition(1.5, 0, -5);
    draw();
    const lane = lastWrite(fake, 'instance-lane');
    expect(lane).toHaveLength(12);
    expect(lane[3]).toBe(1); // last frame's x reaches the draw
    expect(lane[11]).toBe(-5);
    expect(lastWrite(fake, 'instances')[3]).toBe(1.5);
    t.setPosition(2, 0, -5);
    draw();
    expect(lastWrite(fake, 'instance-lane')[3]).toBe(1.5);

    const cmds = scenePasses(fake).at(-1)!.commands as PassCommand[];
    const desc = pipelineDescs(cmds)[0]!;
    const buffers = desc.vertex.buffers as GPUVertexBufferLayout[];
    expect(buffers).toHaveLength(3);
    expect(buffers[2]).toBe(prevLaneBufferLayout(VERTEX_LAYOUT_3D));
    expect(desc.label).toBe('material:std:3d:d2:aux2:p');
    const set = laneBinds(cmds);
    expect(set).toHaveLength(1);
    expect((set[0]!.buffer as { label: string }).label).toBe('instance-lane');
    expect(fake.errors).toEqual([]);
  });

  it('several single draws merge into one instanced call, each with its own history', () => {
    const { fake, r, cube, std } = setup();
    const ts = [0, 1, 2].map((i) => new Transform({ x: i, z: -5 }));
    const draw = () => {
      const f = r.beginFrame(0, 0);
      for (const t of ts) f.mesh(cube, std, t);
      r.endFrame();
    };
    draw();
    ts[1]!.setPosition(1.5, 0, -5);
    draw();
    expect(motionRows(fake, 3)).toEqual([
      [0, 0],
      [1.5, 1],
      [2, 2],
    ]);
    expect(r.stats.drawCalls).toBe(1);
  });

  it('history is kept per view: a second camera keeps its own', () => {
    const { fake, r, cam, cube, std } = setup();
    const lanes = capture(fake, 'instance-lane');
    const other = perspective();
    const t = new Transform({ x: 1, z: -5 });
    const draw = (both: boolean) => {
      const f = r.beginFrame(0, 0);
      f.mesh(cube, std, t);
      r.render(f, cam);
      if (both) r.render(f, other);
      r.endFrame();
    };
    draw(true);
    t.setPosition(2, 0, -5);
    draw(true);
    expect(lanes.slice(-2).map((l) => l[3])).toEqual([1, 1]);
    // `other` sits a frame out: like its camera history, its previous is its own last view.
    t.setPosition(3, 0, -5);
    draw(false);
    t.setPosition(4, 0, -5);
    draw(true);
    expect(lanes.slice(-2).map((l) => l[3])).toEqual([3, 2]);
    expect(Array.from(other.previousViewProj)).toEqual(Array.from(cam.previousViewProj));
    expect(fake.errors).toEqual([]);
  });

  it('a transform drawn twice with one matrix keeps its motion; a scratch one reports none', () => {
    const { fake, r, cube, std } = setup();
    const same = new Transform({ x: 1, z: -5 });
    const scratch = new Transform();
    const draw = (x: number) => {
      const f = r.beginFrame(0, 0);
      same.setPosition(x, 0, -5);
      f.mesh(cube, std, same);
      f.mesh(cube, std, same, { tint: [1, 0, 0, 1] });
      for (let i = 0; i < 2; i++) {
        scratch.setPosition(-1 - i - x / 4, 0, -5);
        f.mesh(cube, std, scratch);
      }
      r.endFrame();
    };
    draw(1);
    draw(2);
    draw(3);
    expect(motionRows(fake, 4)).toEqual([
      [-2.75, -2.75],
      [-1.75, -1.75],
      [3, 2],
      [3, 2],
    ]);
  });

  it('a transform culled last frame starts again with zero motion', () => {
    const { fake, r, cam, cube, std } = setup();
    cam.cull = true;
    const t = new Transform({ x: 0, z: -5 });
    const draw = () => {
      const f = r.beginFrame(0, 0);
      f.mesh(cube, std, t);
      r.endFrame();
    };
    draw();
    t.setPosition(0, 0, 50); // behind the camera
    draw();
    expect(r.stats.culled).toBe(1);
    t.setPosition(0.5, 0, -5);
    draw();
    expect(lastWrite(fake, 'instance-lane')[3]).toBe(0.5);
  });

  it('unchanged when off: no velocity target, a plain material, or DrawParams', () => {
    for (const velocity of [true, false]) {
      const { fake, r, cube, std } = setup(velocity);
      const plain = r.createMaterial(OPAQUE);
      const t = new Transform({ z: -5 });
      for (let i = 0; i < 3; i++) {
        t.setPosition(i, 0, -5);
        const f = r.beginFrame(0, 0);
        if (!velocity) f.mesh(cube, std, t);
        f.mesh(cube, plain, t);
        f.mesh(cube, std, { x: i, y: 0 });
        r.endFrame();
      }
      for (const p of scenePasses(fake)) {
        const cmds = p.commands as PassCommand[];
        for (const d of pipelineDescs(cmds)) {
          expect((d.vertex.buffers as unknown[]).length).toBe(2);
        }
        expect(laneBinds(cmds)).toHaveLength(0);
      }
      expect(fake.buffers.some((b) => b.label === 'instance-lane')).toBe(false);
      expect(fake.errors).toEqual([]);
    }
  });

  it('steady single-draw velocity frames create no GPU objects', () => {
    const { fake, r, cube, std } = setup();
    const ts = Array.from({ length: 40 }, (_, i) => new Transform({ x: i, z: -5 }));
    let frame = 0;
    const step = () => {
      const f = r.beginFrame(0, 0);
      for (const t of ts) {
        t.setPosition(t.position.x + 0.1, 0, -5 - (frame % 3));
        f.mesh(cube, std, t);
      }
      r.endFrame();
      frame++;
    };
    step();
    step();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 4; i++) step();
    expect(counts()).toEqual(before);
  });
});

describe('velocity LOD lists upload no prevBuffer (ws/render-8)', () => {
  it('a LOD list has no prevBuffer and writes none; a plain velocity list still does', () => {
    const { fake, r, std } = setup();
    const lod: MeshLod = { meshes: [mesh(r, 'l0'), mesh(r, 'l1')], thresholdsPx: [100] };
    const lodList = r.createInstanceList(lod, std, 8, { velocity: true });
    const plainList = r.createInstanceList(mesh(r, 'p'), std, 8, { velocity: true });
    expect(lodList.prevBuffer).toBeNull();
    expect(lodList.prevMatrices).not.toBeNull();
    expect(plainList.prevBuffer?.label).toBe('instance-list-prev');
    const before = fake.buffers.filter((b) => b.label === 'instance-list-prev').length;
    expect(before).toBe(1);
    for (let frame = 0; frame < 4; frame++) {
      for (let i = 0; i < 4; i++) {
        lodList.set(i, new Transform({ x: i + frame, z: -5 }));
        plainList.set(i, new Transform({ x: i + frame, z: -5 }));
      }
      const f = r.beginFrame(0, 0);
      f.list(lodList);
      f.list(plainList);
      r.endFrame();
    }
    const prevWrites = fake.writes.filter((w) => w.buffer.label === 'instance-list-prev');
    expect(prevWrites.length).toBe(4);
    expect(prevWrites.every((w) => (w.buffer as unknown) === plainList.prevBuffer)).toBe(true);
    // The LOD list's motion still reaches the lane: x moved by 1 per frame.
    const lane = lastWrite(fake, 'instance-lane');
    const inst = lastWrite(fake, 'instances');
    expect(inst[3]! - lane[3]!).toBe(1);
    expect(fake.errors).toEqual([]);
  });
});

describe('renderer.jitter (ws/render-8)', () => {
  it('returns the installed hook or null', () => {
    const { r } = setup(false);
    expect(r.jitter).toBeNull();
    const xy: [number, number] = [0.25, -0.25];
    const fn: JitterFn = () => xy;
    r.setJitter(fn);
    expect(r.jitter).toBe(fn);
    r.setJitter(null);
    expect(r.jitter).toBeNull();
  });
});
