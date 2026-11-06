import { afterEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import type { MeshUpdate } from '../render/mesh';
import { VERTEX3D_FLOATS } from '../render/mesh';
import { Renderer } from '../render/renderer';
import { Trail, TrailBatch, type TrailOptions } from './trail';

/** A mesh stand-in that records every `update` (the object and the view it carries). */
class FakeMesh {
  updates: MeshUpdate[] = [];
  vertexCount = 0;
  indexCount = 0;
  destroyed = false;
  update(u: MeshUpdate): boolean {
    this.updates.push(u);
    if (u.vertexCount !== undefined) this.vertexCount = u.vertexCount;
    if (u.indexCount !== undefined) this.indexCount = u.indexCount;
    return false;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function fakeRenderer() {
  const meshes: FakeMesh[] = [];
  const materials: { label: string; textures?: number; blend?: string }[] = [];
  const renderer = {
    createMesh() {
      const m = new FakeMesh();
      meshes.push(m);
      return m;
    },
    createMaterial(desc: { label: string; textures?: number; blend?: string }) {
      materials.push(desc);
      return { label: desc.label, setTexture() {}, destroy() {} };
    },
  } as unknown as Renderer;
  return { renderer, meshes, materials };
}

function makeTrail(opts: TrailOptions = {}) {
  const f = fakeRenderer();
  const trail = new Trail(f.renderer, { lifetime: 1, minDistance: 0.5, ...opts });
  return { ...f, trail, mesh: f.meshes[0]! };
}

const P = { x: 0, y: 0, z: 0 };
const F = VERTEX3D_FLOATS;

/** Vertex `i` (x, y, z) of the last uploaded ribbon. */
function vertex(mesh: FakeMesh, i: number): [number, number, number] {
  const u = mesh.updates.at(-1)!;
  const v = u.vertices as Float32Array;
  return [v[i * F]!, v[i * F + 1]!, v[i * F + 2]!];
}

function vertexColor(mesh: FakeMesh, i: number): number[] {
  const v = (mesh.updates.at(-1)!.vertices as Float32Array).subarray(i * F + 8, i * F + 12);
  return [...v].map((c) => Math.round(c * 1000) / 1000);
}

describe('Trail ring buffer', () => {
  it('keeps the newest maxPoints and drops the oldest when full', () => {
    const { trail } = makeTrail({ maxPoints: 4 });
    for (let i = 0; i < 6; i++) expect(trail.push(i * 10, 0)).toBe(true);
    // The tip sits on the newest stored point, so it is not an extra point.
    expect(trail.count).toBe(4);
    expect(trail.pointAt(0, P)).toBe(true);
    expect(P.x).toBe(50);
    trail.pointAt(3, P);
    expect(P.x).toBe(20);
    expect(trail.pointAt(4, P)).toBe(false);
  });

  it('minDistance rejects a close push but moves the tip', () => {
    const { trail } = makeTrail({ minDistance: 2 });
    expect(trail.push(0, 0)).toBe(true);
    expect(trail.push(1, 0)).toBe(false);
    // One stored point plus the tip, apart from it.
    expect(trail.count).toBe(2);
    trail.pointAt(0, P);
    expect([P.x, P.y]).toEqual([1, 0]);
    expect(trail.push(3, 0)).toBe(true);
    expect(trail.count).toBe(2);
    // The tip moves on every push, even a rejected one, so a slow point still commits later.
    expect(trail.push(3.5, 0)).toBe(false);
    expect(trail.push(5.5, 0)).toBe(true);
    expect(trail.count).toBe(3);
  });

  it('expires points older than lifetime and uploads nothing below two points', () => {
    const { trail, mesh } = makeTrail({ lifetime: 1 });
    trail.push(0, 0);
    trail.update(0.5);
    trail.push(10, 0);
    trail.update(0.3);
    expect(trail.count).toBe(2);
    expect(mesh.vertexCount).toBe(4);
    trail.update(0.3); // the first point is 1.1 s old
    expect(trail.count).toBe(1);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
    trail.update(1);
    // The tip stays where the point was left; nothing draws from one point.
    expect(trail.count).toBe(1);
    trail.clear();
    expect(trail.count).toBe(0);
  });

  it('uploads two vertices per point and six indices per segment, oldest first', () => {
    const { trail, mesh } = makeTrail({ maxPoints: 8, width: 2 });
    trail.push(0, 0);
    trail.push(10, 0);
    trail.push(20, 0);
    trail.update(0.1);
    expect(mesh.vertexCount).toBe(6);
    expect(mesh.indexCount).toBe(12);
    // 2D, no camera: the ribbon lies in the XY plane, offset ±half width across the motion.
    expect(vertex(mesh, 0)).toEqual([0, -1, 0]);
    expect(vertex(mesh, 1)).toEqual([0, 1, 0]);
    expect(vertex(mesh, 4)).toEqual([20, -1, 0]);
    expect(vertex(mesh, 5)).toEqual([20, 1, 0]);
    // The static index buffer came with the mesh capacity: (maxPoints) quads.
    const first = mesh.updates[0]!;
    expect(first.indices).toBeUndefined();
  });
});

describe('Trail geometry', () => {
  it('stretches u 0 at the tip to 1 at the tail, tiles by width otherwise', () => {
    const a = makeTrail({ width: 5 });
    for (const x of [0, 5, 10, 20]) a.trail.push(x, 0);
    a.trail.update(0.1);
    const u = (m: FakeMesh, i: number) => (m.updates.at(-1)!.vertices as Float32Array)[i * F + 6];
    expect(u(a.mesh, 6)).toBe(0); // newest (last in the buffer)
    expect(u(a.mesh, 0)).toBe(1); // oldest
    expect(u(a.mesh, 2)).toBeCloseTo(2 / 3);
    const b = makeTrail({ width: 5, uvMode: 'tile' });
    for (const x of [0, 5, 10, 20]) b.trail.push(x, 0);
    b.trail.update(0.1);
    expect(u(b.mesh, 6)).toBe(0);
    expect(u(b.mesh, 4)).toBeCloseTo(2); // 10 units from the tip
    expect(u(b.mesh, 0)).toBeCloseTo(4);
  });

  it('fades alpha linearly over age by default and samples colour and width curves', () => {
    const { trail, mesh } = makeTrail({
      lifetime: 1,
      widthCurve: [4, 0],
      colorCurve: [1, 0, 0, 1, 0, 0, 1, 1],
    });
    trail.push(0, 0);
    trail.update(0.5);
    trail.push(10, 0);
    trail.update(0);
    // Oldest (vertices 0, 1): age 0.5 → mid colour, alpha 0.5, half the tip's width.
    expect(vertexColor(mesh, 0)).toEqual([0.5, 0, 0.5, 0.5]);
    expect(Math.abs(vertex(mesh, 0)[1])).toBeCloseTo(1);
    // Newest (vertices 2, 3): age 0 → red, alpha 1, full width 4 → ±2.
    expect(vertexColor(mesh, 2)).toEqual([1, 0, 0, 1]);
    expect(Math.abs(vertex(mesh, 2)[1])).toBeCloseTo(2);
    const plain = makeTrail({ color: [0, 1, 0, 0.5], fade: null });
    plain.trail.push(0, 0);
    plain.trail.update(0.9);
    plain.trail.push(10, 0);
    plain.trail.update(0);
    expect(vertexColor(plain.mesh, 0)).toEqual([0, 1, 0, 0.5]);
  });

  it('faces the camera in world space and a fixed axis otherwise', () => {
    const cam = Camera.perspective(1, 1, 0.1, 100);
    cam.lookAt([0, 0, 10], [0, 0, 0]);
    const w = makeTrail({ space: 'world', width: 2, minDistance: 0.1 });
    w.trail.push(0, 0, 0);
    w.trail.push(1, 0, 0);
    w.trail.update(0.1, cam);
    // Motion along x, eye along +z: the ribbon spans ±y.
    expect(vertex(w.mesh, 0).map((c) => Math.abs(Math.round(c * 1e6) / 1e6))).toEqual([0, 1, 0]);
    const up = makeTrail({ space: 'world', width: 2, minDistance: 0.1, facing: 'up' });
    up.trail.push(0, 0, 0);
    up.trail.push(1, 0, 0);
    up.trail.update(0.1, cam);
    // A flat ribbon: it spans ±z.
    expect(vertex(up.mesh, 0).map((c) => Math.abs(c))).toEqual([0, 0, 1]);
    const ax = makeTrail({ space: 'world', width: 2, minDistance: 0.1, facing: [1, 0, 0] });
    ax.trail.push(0, 0, 0);
    ax.trail.push(0, 1, 0);
    ax.trail.update(0.1, cam);
    expect(vertex(ax.mesh, 0).map((c) => Math.abs(c))).toEqual([0, 0, 1]);
  });
});

describe('Trail allocation', () => {
  const Orig = globalThis.Float32Array;
  afterEach(() => {
    globalThis.Float32Array = Orig;
  });

  it('update and draw allocate no typed arrays and reuse one update object after warm-up', () => {
    const { trail, mesh } = makeTrail({ maxPoints: 16 });
    const cam = Camera.perspective(1, 1, 0.1, 100);
    const frame = { mesh() {} } as never;
    for (let i = 0; i < 20; i++) {
      trail.push(Math.cos(i * 0.3) * 10, Math.sin(i * 0.3) * 10, i);
      trail.update(0.016, cam);
      trail.draw(frame);
    }
    let allocs = 0;
    globalThis.Float32Array = class extends Orig {
      constructor(...a: unknown[]) {
        super(...(a as [number]));
        allocs++;
      }
    } as unknown as Float32ArrayConstructor;
    const before = mesh.updates.length;
    const firstUpdate = mesh.updates.at(-1)!;
    for (let i = 20; i < 40; i++) {
      trail.push(Math.cos(i * 0.3) * 10, Math.sin(i * 0.3) * 10, i);
      trail.update(0.016, cam);
      trail.draw(frame);
    }
    expect(allocs).toBe(0);
    expect(mesh.updates.length).toBe(before + 20);
    for (const u of mesh.updates.slice(before)) {
      expect(u).toBe(firstUpdate);
      expect(u.vertices).toBe(firstUpdate.vertices);
    }
  });
});

describe('Trail on the renderer', () => {
  it('creates a 3D mesh with a static index buffer and a shared unlit material per blend', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const a = new Trail(r, { maxPoints: 8 });
    const b = new Trail(r, { maxPoints: 8 });
    const c = new Trail(r, { maxPoints: 8, blend: 'alpha' });
    expect(a.material).toBe(b.material);
    expect(c.material).not.toBe(a.material);
    expect(a.material.label).toBe('trail-additive');
    expect(c.material.blend).toBe('alpha');
    expect(a.mesh.capacity).toEqual({ vertices: 18, indices: 48 });
    expect(a.mesh.indexFormat).toBe('uint16');
    const vb = fake.buffers.find((x) => x.label === 'trail-vb')!;
    expect(vb.size).toBe(18 * 48);
    const writes = fake.writes.length;
    a.push(0, 0);
    a.push(50, 0);
    a.push(100, 10);
    a.update(0.016);
    // One vertex upload per frame, the index buffer untouched.
    expect(fake.writes.length).toBe(writes + 1);
    expect(fake.writes.at(-1)!.bytes).toBe(6 * 48);
    expect(a.mesh.vertexCount).toBe(6);
    expect(a.mesh.indexCount).toBe(12);
    const f = r.beginFrame(0, 0.016);
    a.draw(f);
    r.endFrame();
    expect(fake.errors).toEqual([]);
    a.destroy();
    expect(vb.destroyed).toBe(true);
  });

  it('binds a texture to its own material', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const tex = r.createTexture({ width: 2, height: 2 });
    const t = new Trail(r, { texture: tex, uvMode: 'tile' });
    expect(t.material.label).toBe('trail-textured');
    expect(t.material.bindings).not.toBeNull();
    t.destroy();
    expect(fake.errors).toEqual([]);
  });
});

describe('TrailBatch', () => {
  it('packs every ribbon into one vertex range and rebuilds the indices with offsets', () => {
    const f = fakeRenderer();
    const batch = new TrailBatch(f.renderer, 3, { maxPoints: 4, lifetime: 1, minDistance: 0.5 });
    const mesh = f.meshes[0]!;
    batch.push(0, 0, 0);
    batch.push(0, 10, 0);
    batch.push(0, 20, 0);
    batch.push(2, 100, 0);
    batch.push(2, 110, 0);
    batch.push(1, 50, 0); // one point: not drawn
    batch.update(0.1);
    expect(batch.count(0)).toBe(3);
    expect(batch.count(1)).toBe(1);
    expect(batch.count(2)).toBe(2);
    expect(mesh.vertexCount).toBe(6 + 4);
    expect(mesh.indexCount).toBe(12 + 6);
    const idx = mesh.updates.find((u) => u.indices && u.indexCount === 18)!;
    expect([...(idx.indices as Uint16Array).subarray(0, 18)]).toEqual([
      0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 6, 7, 8, 7, 9, 8,
    ]);
    // Ribbon 2 starts at vertex 6.
    expect(vertex(mesh, 6)[0]).toBe(100);
    batch.clear(0);
    batch.update(0);
    expect(mesh.vertexCount).toBe(4);
    batch.clear();
    expect(mesh.vertexCount).toBe(0);
    expect(batch.count(2)).toBe(0);
  });

  it('allocates nothing per frame after warm-up', () => {
    const f = fakeRenderer();
    const batch = new TrailBatch(f.renderer, 4, { maxPoints: 8, lifetime: 1, minDistance: 0.5 });
    const run = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        for (let k = 0; k < 4; k++) batch.push(k, i * 2, k * 10);
        batch.update(0.016);
        batch.draw({ mesh() {} } as never);
      }
    };
    run(0, 20);
    const Orig = globalThis.Float32Array;
    let allocs = 0;
    globalThis.Float32Array = class extends Orig {
      constructor(...a: unknown[]) {
        super(...(a as [number]));
        allocs++;
      }
    } as unknown as Float32ArrayConstructor;
    try {
      run(20, 40);
    } finally {
      globalThis.Float32Array = Orig;
    }
    expect(allocs).toBe(0);
  });
});
