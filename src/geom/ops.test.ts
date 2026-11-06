import { describe, expect, it } from 'vitest';
import { VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { GEOMETRY_FLOATS, type Geometry, mergeGeometry } from './geometry';
import { fitBounds, flatShade, flipWinding, projectUv, recenter, weld } from './ops';
import { box, cylinder, icosphere, plane, sphere } from './primitives';
import { computeTangents } from './tangents';

const F = GEOMETRY_FLOATS;

function vertexCount(g: Geometry): number {
  return g.vertices.length / g.layout.floats;
}

function aabb(g: Geometry): [number, number, number, number, number, number] {
  const S = g.layout.floats;
  const v = g.vertices;
  const out: [number, number, number, number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let o = 0; o < v.length; o += S) {
    for (let k = 0; k < 3; k++) {
      out[k] = Math.min(out[k]!, v[o + k]!);
      out[3 + k] = Math.max(out[3 + k]!, v[o + k]!);
    }
  }
  return out;
}

describe('weld', () => {
  it('removes exactly the duplicated vertices and remaps the indices', () => {
    // Two identical boxes merged: every vertex appears twice.
    const g = mergeGeometry(box(), box());
    expect(vertexCount(g)).toBe(48);
    const w = weld(g);
    expect(vertexCount(w)).toBe(24);
    expect(w.indices.length).toBe(g.indices.length);
    expect(w.indices).toBeInstanceOf(Uint16Array);
    for (let t = 0; t < g.indices.length; t++) {
      const a = g.indices[t]! * F;
      const b = w.indices[t]! * F;
      for (let k = 0; k < F; k++) expect(w.vertices[b + k]).toBe(g.vertices[a + k]);
    }
    // A box's corners share positions but not normals: nothing more to weld.
    expect(vertexCount(weld(box()))).toBe(24);
  });

  it('welds within epsilon only', () => {
    const s = sphere({ segments: [8, 4] });
    // The seam column repeats positions and normals with u 1 instead of 0: kept apart. The pole
    // rows are 9 coincident vertices each with distinct u: kept apart too.
    expect(vertexCount(weld(s))).toBe(vertexCount(s));
    const dup = mergeGeometry(box(), box());
    // Nudge one vertex of a duplicated pair by less than epsilon, another by more.
    dup.vertices[0] = dup.vertices[0]! + 1e-7;
    dup.vertices[25 * F] = dup.vertices[25 * F]! + 1e-3;
    const w = weld(dup, 1e-5);
    expect(vertexCount(w)).toBe(25);
  });

  it('shrinks indices to 16-bit when the welded count fits', () => {
    const parts: Geometry[] = [];
    for (let i = 0; i < 3000; i++) parts.push(box());
    const g = mergeGeometry(...parts);
    expect(g.indices).toBeInstanceOf(Uint32Array);
    const w = weld(g);
    expect(vertexCount(w)).toBe(24);
    expect(w.indices).toBeInstanceOf(Uint16Array);
  });
});

describe('flatShade', () => {
  it('makes triangles × 3 vertices with face normals and sequential indices', () => {
    const g = icosphere({ subdivisions: 1 });
    const f = flatShade(g);
    expect(vertexCount(f)).toBe(g.indices.length);
    expect(f.indices.length).toBe(g.indices.length);
    for (let t = 0; t < f.indices.length; t++) expect(f.indices[t]).toBe(t);
    const v = f.vertices;
    for (let t = 0; t < f.indices.length; t += 3) {
      const a = t * F;
      const b = (t + 1) * F;
      const c = (t + 2) * F;
      // All three corners share one unit normal pointing away from the origin.
      expect(v[a + 3]).toBe(v[b + 3]);
      expect(v[a + 3]).toBe(v[c + 3]);
      expect(Math.hypot(v[a + 3]!, v[a + 4]!, v[a + 5]!)).toBeCloseTo(1, 5);
      expect(v[a]! * v[a + 3]! + v[a + 1]! * v[a + 4]! + v[a + 2]! * v[a + 5]!).toBeGreaterThan(0);
    }
    expect(f.bounds.radius).toBeCloseTo(g.bounds.radius, 5);
    // Works on the tangent layout too, copying the tangent.
    const ft = flatShade(computeTangents(g));
    expect(ft.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    expect(vertexCount(ft)).toBe(g.indices.length);
  });
});

describe('flipWinding', () => {
  it('reverses triangles, negates normals and keeps the bounds', () => {
    const g = box();
    const before = Array.from(g.indices);
    const normals = Array.from(g.vertices).filter((_, i) => i % F >= 3 && i % F < 6);
    const bounds = JSON.stringify(g.bounds);
    expect(flipWinding(g)).toBe(g);
    for (let t = 0; t < before.length; t += 3) {
      expect(g.indices[t]).toBe(before[t]);
      expect(g.indices[t + 1]).toBe(before[t + 2]);
      expect(g.indices[t + 2]).toBe(before[t + 1]);
    }
    const after = Array.from(g.vertices).filter((_, i) => i % F >= 3 && i % F < 6);
    for (let i = 0; i < normals.length; i++) expect(after[i]).toBe(-normals[i]!);
    expect(JSON.stringify(g.bounds)).toBe(bounds);
    expect(aabb(g)).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    // The tangent layout flips the handedness so the bitangent is unchanged.
    const t = computeTangents(box());
    const w0 = t.vertices[15]!;
    flipWinding(t);
    expect(t.vertices[15]).toBe(-w0);
  });
});

describe('projectUv', () => {
  function uvRange(g: Geometry): [number, number, number, number] {
    const S = g.layout.floats;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (let o = 0; o < g.vertices.length; o += S) {
      minU = Math.min(minU, g.vertices[o + 6]!);
      maxU = Math.max(maxU, g.vertices[o + 6]!);
      minV = Math.min(minV, g.vertices[o + 7]!);
      maxV = Math.max(maxV, g.vertices[o + 7]!);
    }
    return [minU, maxU, minV, maxV];
  }

  it('box and planar span 0..1 across the bounds, scaled by `scale`', () => {
    const g = projectUv(box({ size: [2, 1, 4] }), 'box');
    expect(uvRange(g)).toEqual([0, 1, 0, 1]);
    // On the +x face u follows z and v follows y.
    const v = g.vertices;
    for (let o = 0; o < v.length; o += F) {
      if (v[o + 3] === 1) {
        expect(v[o + 6]).toBeCloseTo((v[o + 2]! + 2) / 4, 6);
        expect(v[o + 7]).toBeCloseTo(v[o + 1]! + 0.5, 6);
      }
    }
    const p = projectUv(plane({ size: [4, 2], segments: 4 }), 'planar', { scale: [4, 2] });
    expect(uvRange(p)).toEqual([0, 4, 0, 2]);
    const px = projectUv(plane({ size: [4, 2] }), 'planar', { axis: 'x', scale: 3 });
    // Facing x the plane is flat in y: u spans z (0..3), v is constant.
    const [u0, u1, v0, v1] = uvRange(px);
    expect([u0, u1]).toEqual([0, 3]);
    expect(v0).toBe(v1);
  });

  it('cylindrical and spherical wrap u around +y and keep v within 0..1', () => {
    const c = projectUv(cylinder({ segments: [16, 2] }), 'cylindrical');
    const [u0, u1, v0, v1] = uvRange(c);
    expect(u0).toBeGreaterThanOrEqual(0);
    expect(u1).toBeLessThanOrEqual(1);
    expect(v0).toBeCloseTo(0, 6);
    expect(v1).toBeCloseTo(1, 6);
    // u = 0.5 at +z.
    const v = c.vertices;
    for (let o = 0; o < v.length; o += F) {
      if (Math.abs(v[o]!) < 1e-6 && v[o + 2]! > 0.4) expect(v[o + 6]).toBeCloseTo(0.5, 5);
    }
    const s = projectUv(sphere(), 'spherical');
    const r = uvRange(s);
    expect(r[0]).toBeGreaterThanOrEqual(0);
    expect(r[1]).toBeLessThanOrEqual(1);
    expect(r[2]).toBeCloseTo(0, 6);
    expect(r[3]).toBeCloseTo(1, 6);
    expect(projectUv(s, 'spherical')).toBe(s);
  });
});

describe('fitBounds and recenter', () => {
  it('fitBounds scales the longest side to `size` about the origin', () => {
    const g = box({ size: [1, 2, 4] });
    expect(fitBounds(g, 1)).toBe(g);
    const b = aabb(g);
    expect(b[5] - b[2]).toBeCloseTo(1, 6);
    expect(b[3] - b[0]).toBeCloseTo(0.25, 6);
    expect(b[4] - b[1]).toBeCloseTo(0.5, 6);
    expect(g.bounds.radius).toBeCloseTo(Math.hypot(0.125, 0.25, 0.5), 5);
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(Math.hypot(g.vertices[o + 3]!, g.vertices[o + 4]!, g.vertices[o + 5]!)).toBeCloseTo(
        1,
        6,
      );
    }
    // Off the origin, scaling about the origin moves the centre too.
    const off = box();
    for (let o = 0; o < off.vertices.length; o += F) off.vertices[o] = off.vertices[o]! + 1;
    fitBounds(off, 2);
    expect(aabb(off)[0]).toBeCloseTo(1, 6);
    expect(aabb(off)[3]).toBeCloseTo(3, 6);
  });

  it('recenter moves the box centre to the origin and updates the bounds', () => {
    const g = box();
    for (let o = 0; o < g.vertices.length; o += F) {
      g.vertices[o] = g.vertices[o]! + 3;
      g.vertices[o + 1] = g.vertices[o + 1]! - 2;
    }
    expect(recenter(g)).toBe(g);
    expect(aabb(g)).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    expect(g.bounds.center).toEqual([0, 0, 0]);
    expect(() => recenter({ ...g, layout: { ...g.layout, name: '2d' } })).toThrow(/3D/);
  });
});
