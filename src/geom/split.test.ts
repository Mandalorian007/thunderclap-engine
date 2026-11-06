import { describe, expect, it } from 'vitest';
import { VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { type Geometry, mergeGeometry, transformGeometry } from './geometry';
import { box, torus } from './primitives';
import { sliceGeometry, splitGeometry } from './split';
import { computeTangents } from './tangents';

const tris = (g: Geometry) => g.indices.length / 3;

const translate = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

/**
 * Closed and consistently wound: the triangles' area vectors sum to zero (the projected area
 * onto every axis cancels), and the volume about two different origins agrees. Tolerates the
 * T-junctions a cap leaves where `triangulate` drops a collinear cut point.
 */
function isClosed(g: Geometry): boolean {
  if (g.indices.length === 0) return false;
  const F = g.layout.floats;
  const v = g.vertices;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    const ux = v[b]! - v[a]!;
    const uy = v[b + 1]! - v[a + 1]!;
    const uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!;
    const wy = v[c + 1]! - v[a + 1]!;
    const wz = v[c + 2]! - v[a + 2]!;
    sx += uy * wz - uz * wy;
    sy += uz * wx - ux * wz;
    sz += ux * wy - uy * wx;
  }
  return Math.hypot(sx, sy, sz) < 1e-4;
}

/** Signed volume (divergence theorem); positive for an outward-wound closed mesh. */
function volume(g: Geometry): number {
  const F = g.layout.floats;
  const v = g.vertices;
  let s = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    s +=
      v[a]! * (v[b + 1]! * v[c + 2]! - v[b + 2]! * v[c + 1]!) -
      v[a + 1]! * (v[b]! * v[c + 2]! - v[b + 2]! * v[c]!) +
      v[a + 2]! * (v[b]! * v[c + 1]! - v[b + 1]! * v[c]!);
  }
  return s / 6;
}

/** Area of the triangles whose normal lane is ±n (the cap). */
function areaFacing(g: Geometry, nx: number, ny: number, nz: number): number {
  const F = g.layout.floats;
  const v = g.vertices;
  let s = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    if (v[a + 3]! * nx + v[a + 4]! * ny + v[a + 5]! * nz < 0.999) continue;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    const ux = v[b]! - v[a]!;
    const uy = v[b + 1]! - v[a + 1]!;
    const uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!;
    const wy = v[c + 1]! - v[a + 1]!;
    const wz = v[c + 2]! - v[a + 2]!;
    s += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  return s;
}

describe('splitGeometry', () => {
  it('two merged cubes split into two islands', () => {
    const g = mergeGeometry(box(), transformGeometry(box(), translate(3, 0, 0)));
    const parts = splitGeometry(g, 'island');
    expect(parts).toHaveLength(2);
    expect(parts.map(tris)).toEqual([12, 12]);
    expect(parts[0]!.bounds.center[0]).toBeCloseTo(0, 6);
    expect(parts[1]!.bounds.center[0]).toBeCloseTo(3, 6);
    expect(parts[0]!.vertices.length).toBe(24 * 12);
  });

  it('a seam does not split a mesh', () => {
    expect(splitGeometry(torus(), 'island')).toHaveLength(1);
  });

  it('a group function picks parts, ascending, negatives dropped', () => {
    const g = box();
    const parts = splitGeometry(g, (t) => (t < 2 ? 5 : t < 6 ? 1 : -1));
    expect(parts.map(tris)).toEqual([4, 2]);
  });
});

describe('sliceGeometry', () => {
  it('a sliced cube gives two closed halves with cap area equal to the cross-section', () => {
    const g = box({ size: 2 });
    const { above, below } = sliceGeometry(g, { nx: 0, ny: 1, nz: 0, d: 0.3 }, { cap: true });
    expect(isClosed(above)).toBe(true);
    expect(isClosed(below)).toBe(true);
    expect(volume(above)).toBeCloseTo(2 * 2 * 0.7, 5);
    expect(volume(below)).toBeCloseTo(2 * 2 * 1.3, 5);
    // The caps: below faces up, above faces down, each the 2 × 2 cross-section.
    expect(areaFacing(below, 0, 1, 0)).toBeCloseTo(4, 5);
    expect(areaFacing(above, 0, -1, 0)).toBeCloseTo(4, 5);
  });

  it('a tilted cut caps with the cross-section area', () => {
    const g = box({ size: 2 });
    const n = [1, 1, 0].map((x) => x / Math.SQRT2) as [number, number, number];
    const { above, below } = sliceGeometry(
      g,
      { nx: n[0], ny: n[1], nz: n[2], d: 0 },
      { cap: true },
    );
    expect(isClosed(above)).toBe(true);
    expect(isClosed(below)).toBe(true);
    // A diagonal through the cube's centre: a 2√2 × 2 rectangle.
    expect(areaFacing(below, n[0], n[1], n[2])).toBeCloseTo(4 * Math.SQRT2, 5);
    expect(volume(above) + volume(below)).toBeCloseTo(8, 5);
  });

  it('without caps the halves are open and the cut shared', () => {
    const { above, below } = sliceGeometry(box({ size: 2 }), { nx: 0, ny: 1, nz: 0, d: 0 });
    expect(isClosed(above)).toBe(false);
    expect(areaFacing(below, 0, 1, 0)).toBe(0);
    expect(tris(above) + tris(below)).toBeGreaterThan(12);
  });

  it('a plane missing every triangle leaves the original on one side', () => {
    const g = box();
    const hi = sliceGeometry(g, { nx: 0, ny: 1, nz: 0, d: 10 }, { cap: true });
    expect(tris(hi.below)).toBe(12);
    expect(hi.below.vertices).toEqual(g.vertices);
    expect(tris(hi.above)).toBe(0);
    expect(hi.above.vertices.length).toBe(0);
    const lo = sliceGeometry(g, { nx: 0, ny: 1, nz: 0, d: -10 }, { cap: true });
    expect(tris(lo.above)).toBe(12);
    expect(tris(lo.below)).toBe(0);
    // Exactly at the top face: everything below, no cap.
    const top = sliceGeometry(g, { nx: 0, ny: 1, nz: 0, d: 0.5 }, { cap: true });
    expect(tris(top.below)).toBe(12);
    expect(tris(top.above)).toBe(0);
  });

  it('keeps the tangent layout, unit tangents on the cut', () => {
    const g = computeTangents(box({ size: 2 }));
    const { above } = sliceGeometry(g, { nx: 1, ny: 2, nz: 3, d: 0.1 }, { cap: true });
    expect(above.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    for (let o = 0; o < above.vertices.length; o += 16) {
      const v = above.vertices;
      expect(Math.hypot(v[o + 12]!, v[o + 13]!, v[o + 14]!)).toBeCloseTo(1, 5);
    }
    expect(isClosed(above)).toBe(true);
  });
});
