import { describe, expect, it } from 'vitest';
import { VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import { GEOMETRY_FLOATS, type Geometry } from './geometry';
import { box, sphere } from './primitives';
import { extrude, lathe, polygon, tube } from './sweep';
import { computeTangents, TANGENT_FLOATS } from './tangents';

const F = GEOMETRY_FLOATS;
const T = TANGENT_FLOATS;

function star(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 1 : 0.45;
    const a = (i / 10) * Math.PI * 2;
    out.push(r * Math.cos(a), r * Math.sin(a));
  }
  return out;
}

/** Every tangent is unit, perpendicular to its normal, with handedness ±1. */
function expectFrames(t: Geometry): { plus: number; minus: number } {
  expect(t.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
  const v = t.vertices;
  let plus = 0;
  let minus = 0;
  for (let o = 0; o < v.length; o += T) {
    const nx = v[o + 3]!;
    const ny = v[o + 4]!;
    const nz = v[o + 5]!;
    const tx = v[o + 12]!;
    const ty = v[o + 13]!;
    const tz = v[o + 14]!;
    expect(Math.hypot(tx, ty, tz)).toBeCloseTo(1, 5);
    expect(Math.abs(nx * tx + ny * ty + nz * tz)).toBeLessThan(1e-5);
    const w = v[o + 15]!;
    expect(Math.abs(w)).toBe(1);
    if (w > 0) plus++;
    else minus++;
  }
  return { plus, minus };
}

describe('computeTangents', () => {
  it('returns a 16-float geometry whose first 12 floats, indices and bounds are the input', () => {
    const g = box();
    const t = computeTangents(g);
    expect(t.vertices.length).toBe((g.vertices.length / F) * T);
    for (let i = 0; i < g.vertices.length / F; i++) {
      for (let k = 0; k < F; k++) expect(t.vertices[i * T + k]).toBe(g.vertices[i * F + k]);
    }
    expect(t.indices).toBe(g.indices);
    expect(t.bounds).toEqual(g.bounds);
    expect(t.bounds).not.toBe(g.bounds);
    expectFrames(t);
  });

  it('tangents are unit, perpendicular to the normal, handedness ±1 on every builder', () => {
    for (const g of [box(), sphere({ segments: [12, 6] }), lathe([0.3, 0, 0.5, 1], {})]) {
      expectFrames(computeTangents(g));
    }
  });

  it('sweeps and polygons are right-handed throughout (w = +1 on every vertex)', () => {
    const path = new Float32Array([0, 0, 0, 0, 1, 0, 0.5, 2, 0, 1, 2.5, 0.5]);
    for (const g of [
      extrude(star(), { depth: 0.5, bevel: 0.05 }),
      tube(path, { radius: 0.2, segments: 8 }),
      lathe([0.2, 0, 0.5, 0.4, 0.3, 1], { segments: 10 }),
      polygon(star(), { doubleSided: true }),
    ]) {
      const { plus, minus } = expectFrames(computeTangents(g));
      expect(minus).toBe(0);
      expect(plus).toBe(g.vertices.length / F);
    }
  });

  it('the tangent follows +u: on the box front face it is +x', () => {
    const t = computeTangents(box());
    const v = t.vertices;
    for (let o = 0; o < v.length; o += T) {
      if (v[o + 5] === 1) {
        expect(v[o + 12]).toBeCloseTo(1, 5);
        expect(v[o + 13]).toBeCloseTo(0, 5);
      }
    }
  });

  it('mirroring the uvs flips the handedness', () => {
    const g = polygon(star());
    const a = computeTangents(g);
    const m = polygon(star());
    for (let o = 0; o < m.vertices.length; o += F) m.vertices[o + 6] = 1 - m.vertices[o + 6]!;
    const b = computeTangents(m);
    for (let o = 0; o < a.vertices.length; o += T) {
      expect(b.vertices[o + 15]).toBe(-a.vertices[o + 15]!);
      // The tangent itself reverses too (+u now runs the other way).
      expect(b.vertices[o + 12]).toBeCloseTo(-a.vertices[o + 12]!, 5);
    }
  });

  it('a vertex without uv area still gets a unit perpendicular tangent', () => {
    const g = box();
    for (let o = 0; o < g.vertices.length; o += F) {
      g.vertices[o + 6] = 0;
      g.vertices[o + 7] = 0;
    }
    const { plus } = expectFrames(computeTangents(g));
    expect(plus).toBe(24);
    expect(() => computeTangents(computeTangents(box()))).toThrow(/VERTEX_LAYOUT_3D/);
  });
});
