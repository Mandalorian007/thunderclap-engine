import { describe, expect, it } from 'vitest';
import { MATRIX3X4_FLOATS, multiplyMatrix3x4, Transform, writeMatrix2d } from './transform';

/** Apply a 3×4 row-major matrix to a point. */
function apply(m: ArrayLike<number>, x: number, y: number, z = 0): number[] {
  return [0, 1, 2].map(
    (r) => m[r * 4]! * x + m[r * 4 + 1]! * y + m[r * 4 + 2]! * z + m[r * 4 + 3]!,
  );
}

/** The pre-matrix vertex shader: `xy + rotate(pos * wh)`, rotation clockwise with y down. */
function oldPlacement(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = px * w;
  const ly = py * h;
  return [x + c * lx - s * ly, y + s * lx + c * ly];
}

describe('writeMatrix2d', () => {
  it('matches the old 2D placement formula', () => {
    const m = new Float32Array(MATRIX3X4_FLOATS);
    for (const [x, y, w, h, rot] of [
      [10, 20, 32, 16, 0],
      [-5, 7, -24, 8, 0.7],
      [100, 50, 3, -9, -2.1],
    ] as const) {
      writeMatrix2d(m, 0, x, y, w, h, rot);
      for (const [px, py] of [
        [-0.5, -0.5],
        [0.5, 0.25],
        [0.1, 0.5],
      ] as const) {
        const got = apply(m, px, py);
        const want = oldPlacement(px, py, x, y, w, h, rot);
        expect(got[0]).toBeCloseTo(want[0]!, 4);
        expect(got[1]).toBeCloseTo(want[1]!, 4);
        expect(got[2]).toBe(0);
      }
    }
  });

  it('is exact at rotation 0 and writes at an offset', () => {
    const d = new Float32Array(20).fill(7);
    writeMatrix2d(d, 4, 3, 4, 5, 6, 0);
    expect([...d]).toEqual([7, 7, 7, 7, 5, -0, 0, 3, 0, 6, 0, 4, 0, 0, 1, 0, 7, 7, 7, 7]);
  });
});

describe('Transform', () => {
  it('builds T·R·S and its 2D form equals writeMatrix2d', () => {
    const t = new Transform({ x: 3, y: 4, rotation: 0.5, scaleX: 2, scaleY: 3 });
    const m = new Float32Array(MATRIX3X4_FLOATS);
    writeMatrix2d(m, 0, 3, 4, 2, 3, 0.5);
    expect([...t.world]).toEqual([...m]);
    expect(t.rotation).toBe(0.5);
  });

  it('a quaternion about Z agrees with the 2D rotation', () => {
    const a = new Transform({ rotation: 1.1, scaleX: 2, scaleY: 5 });
    const b = new Transform({ scaleX: 2, scaleY: 5 }).setAxisAngle(0, 0, 3, 1.1);
    const wa = a.world;
    const wb = b.world;
    for (let i = 0; i < 12; i++) expect(wb[i]).toBeCloseTo(wa[i]!, 5);
    expect(b.rotation).toBeCloseTo(1.1, 6);
  });

  it('rotates in 3D (90° about +Y maps +X to -Z)', () => {
    const t = new Transform().setAxisAngle(0, 1, 0, Math.PI / 2);
    const p = apply(t.world, 1, 0, 0);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(-1, 6);
    expect(Math.hypot(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w)).toBeCloseTo(
      1,
      6,
    );
  });

  it('composes with its parent and caches until something changes', () => {
    const root = new Transform({ x: 100, y: 0, rotation: Math.PI / 2 });
    const child = new Transform({ x: 10, y: 0, parent: root });
    const p = apply(child.world, 0, 0);
    expect(p[0]).toBeCloseTo(100, 4);
    expect(p[1]).toBeCloseTo(10, 4);

    const w = child.world;
    const snapshot = [...w];
    expect(child.world).toBe(w); // same array, no realloc
    expect([...child.world]).toEqual(snapshot);

    root.setPosition(0, 50);
    const q = apply(child.world, 0, 0);
    expect(q[0]).toBeCloseTo(0, 4);
    expect(q[1]).toBeCloseTo(60, 4);

    child.parent = null;
    expect(apply(child.world, 0, 0)).toEqual([10, 0, 0]);
  });

  it('propagates through grandparents', () => {
    const a = new Transform({ x: 1 });
    const b = new Transform({ x: 2, parent: a });
    const c = new Transform({ x: 3, parent: b });
    expect(c.world[3]).toBe(6);
    a.setPosition(10, 0);
    expect(c.world[3]).toBe(15);
    b.setScale(2);
    expect(c.world[3]).toBe(18);
  });

  it('rejects parent cycles', () => {
    const a = new Transform();
    const b = new Transform({ parent: a });
    expect(() => {
      a.parent = b;
    }).toThrow(/cycle/);
  });
});

describe('multiplyMatrix3x4', () => {
  it('treats the implicit fourth row as 0 0 0 1', () => {
    const a = new Float32Array([2, 0, 0, 1, 0, 3, 0, 2, 0, 0, 4, 3]);
    const b = new Float32Array([1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7]);
    const out = new Float32Array(12);
    multiplyMatrix3x4(out, a, b);
    expect([...out]).toEqual([2, 0, 0, 11, 0, 3, 0, 20, 0, 0, 4, 31]);
  });
});
