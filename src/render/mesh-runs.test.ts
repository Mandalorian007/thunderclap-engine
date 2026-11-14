import { describe, expect, it } from 'vitest';
import { createWorkMeter } from '../testing/budget';
import { Camera } from './camera';
import { MULTI_DRAW_FEATURE } from './core/core';
import { createFakeDevice, type FakePass, fakeCanvasContext } from './fake-gpu';
import { type Mesh, VERTEX_LAYOUT_3D } from './mesh';
import { MeshPool, runCapacity } from './mesh-runs';
import { Renderer } from './renderer';
import { Transform } from './transform';

const WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = in.color;
  o.emissive = vec4f(0.0);
  return o;
}`;

/** A one-triangle 3D mesh whose vertices are offset by `k` (so each is distinct). */
function tri(r: Renderer, k: number): Mesh {
  const v = new Float32Array(3 * 12);
  for (let i = 0; i < 3; i++) {
    v[i * 12] = i === 1 ? 1 + k : k;
    v[i * 12 + 1] = i === 2 ? 1 : 0;
    v[i * 12 + 5] = 1;
  }
  return r.createMesh({
    layout: VERTEX_LAYOUT_3D,
    vertices: v,
    indices: new Uint16Array([0, 1, 2]),
    label: `t${k}`,
  });
}

function setup(features: string[], meshes = 8) {
  const fake = createFakeDevice({}, features);
  const meter = createWorkMeter(fake.device);
  const r = new Renderer({
    device: meter.device,
    context: fakeCanvasContext(fake),
    format: 'bgra8unorm',
  });
  r.resize(320, 180);
  const mat = r.createMaterial({ label: 'flat', blend: 'opaque', wgsl: WGSL });
  const list = Array.from({ length: meshes }, (_, k) => tri(r, k));
  const xs = list.map(
    (_, k) => new Transform({ x: (k % 8) * 0.5 - 2, y: Math.floor(k / 8) * 0.5 - 1, z: -10 }),
  );
  const cam = Camera.perspective(1.2, 16 / 9, 0.1, 100);
  const draw = (only?: number) => {
    const f = r.beginFrame(0, 1 / 60);
    f.clear(0, 0, 0);
    for (let k = 0; k < (only ?? list.length); k++) f.mesh(list[k]!, mat, xs[k]!);
    r.render(f, cam);
    r.endFrame();
  };
  return { fake, meter, r, list, draw };
}

/** The scene pass's commands of the last frame. */
function scenePass(passes: readonly FakePass[]): FakePass {
  return passes.filter((p) => p.label === 'scene').at(-1)!;
}

describe('merged mesh runs (ws/core-immediate)', () => {
  it('draws distinct meshes as one cached bundle of indirect draws with indirect-first-instance', () => {
    const { fake, meter, draw } = setup(['indirect-first-instance']);
    draw();
    const pass = scenePass(fake.passes);
    const ops = pass.commands.map((c) => c.op);
    expect(ops.filter((o) => o === 'executeBundles')).toHaveLength(1);
    expect(ops).not.toContain('drawIndexed');
    const bundle = fake.bundles.at(-1)!;
    const indirect = bundle.commands.filter((c) => c.op === 'drawIndexedIndirect');
    expect(indirect).toHaveLength(runCapacity(8, 0));

    // The arguments, in command order: 3 indices, one instance, distinct base vertices.
    const args = fake.buffers.find((b) => b.label === 'mesh-run-args')!;
    const u = new Uint32Array(args.data.buffer, 0, 16 * 5);
    const bases = new Set<number>();
    for (let k = 0; k < 8; k++) {
      expect(u[k * 5]).toBe(3);
      expect(u[k * 5 + 1]).toBe(1);
      bases.add(u[k * 5 + 3]!);
      expect(u[k * 5 + 4]).toBe(k);
    }
    expect(bases.size).toBe(8);
    for (let k = 8; k < 16; k++) expect(u[k * 5]).toBe(0);
    expect(fake.errors).toEqual([]);

    // The next frames reuse the bundle and copy nothing.
    const report = meter.run(() => draw(), { frames: 3 });
    expect(report.gpu.copies).toBe(0);
    expect(report.gpu.createOther).toBe(1); // the command encoder only
    expect(report.gpu.executeBundles).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('keeps the calls flat as more meshes are drawn', () => {
    const small = setup(['indirect-first-instance'], 8);
    const large = setup(['indirect-first-instance'], 40);
    small.draw();
    large.draw();
    const a = small.meter.run(() => small.draw(), { frames: 2 });
    const b = large.meter.run(() => large.draw(), { frames: 2 });
    expect(b.gpu.commands).toBe(a.gpu.commands);
  });

  it('uses one multiDrawIndexedIndirect with the multi-draw feature', () => {
    const { fake, draw } = setup(['indirect-first-instance', MULTI_DRAW_FEATURE]);
    draw();
    const cmds = scenePass(fake.passes).commands;
    const multi = cmds.filter((c) => c.op === 'multiDrawIndexedIndirect');
    expect(multi).toHaveLength(1);
    expect((multi[0] as { maxDrawCount: number }).maxDrawCount).toBe(8);
    expect(cmds.some((c) => c.op === 'executeBundles' || c.op === 'drawIndexed')).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  it('falls back to direct draws from the pool without indirect-first-instance', () => {
    const { fake, draw } = setup([]);
    draw();
    const cmds = scenePass(fake.passes).commands;
    expect(cmds.filter((c) => c.op === 'drawIndexed')).toHaveLength(8);
    // One vertex, one instance buffer for the whole run.
    const vb = cmds.filter((c) => c.op === 'other' && c.name === 'setVertexBuffer');
    expect(vb).toHaveLength(2);
    expect(fake.errors).toEqual([]);
  });

  it('leaves short stretches on the per-mesh path', () => {
    const { fake, draw } = setup(['indirect-first-instance'], 3);
    draw();
    const cmds = scenePass(fake.passes).commands;
    expect(cmds.filter((c) => c.op === 'drawIndexed')).toHaveLength(3);
    expect(fake.bundles).toHaveLength(0);
  });

  it('copies a mesh again after update(), and only then', () => {
    const { meter, list, draw } = setup(['indirect-first-instance']);
    draw();
    expect(meter.run(() => draw(), { frames: 1 }).gpu.copies).toBe(0);
    const before = list[2]!.revision;
    list[2]!.update({ indexCount: 3 });
    expect(list[2]!.revision).toBe(before + 1);
    expect(meter.run(() => draw(), { frames: 1, warmup: 0 }).gpu.copies).toBe(2);
    expect(meter.run(() => draw(), { frames: 1 }).gpu.copies).toBe(0);
  });
});

describe('MeshPool', () => {
  it('takes small indexed meshes only', () => {
    const { r, list } = setup([]);
    expect(MeshPool.fits(list[0]!)).toBe(true);
    const plain = r.createMesh({ layout: VERTEX_LAYOUT_3D, vertices: new Float32Array(36) });
    expect(MeshPool.fits(plain)).toBe(false);
  });

  it('keeps a bundle capacity while it fits without much waste', () => {
    expect(runCapacity(8, 0)).toBe(16);
    expect(runCapacity(17, 16)).toBe(32);
    expect(runCapacity(20, 32)).toBe(32);
    expect(runCapacity(20, 64)).toBe(64);
    expect(runCapacity(5, 128)).toBe(16);
  });
});
