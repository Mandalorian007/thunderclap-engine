import { describe, expect, it } from 'vitest';
import type { Geometry } from '../geom/geometry';
import { buildEmitSurface, sampleEmitSurface } from './emit-surface';
import { SURFACE_TRI_FLOATS } from './particles-wgsl';

/** A small deterministic generator (LCG), so the sampling test is fixed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Two triangles in the XY plane: area 1 (legs 2 × 1) and area 3 (legs 3 × 2).
const POSITIONS = [0, 0, 0, 2, 0, 0, 0, 1, 0, 10, 0, 0, 13, 0, 0, 10, 2, 0];

describe('buildEmitSurface', () => {
  it('builds a cumulative-area table with face normals', () => {
    const s = buildEmitSurface({ positions: POSITIONS });
    expect(s.kind).toBe('mesh');
    expect(s.triangles).toBe(2);
    expect(s.area).toBeCloseTo(4);
    expect(s.table).toHaveLength(2 * SURFACE_TRI_FLOATS);
    expect(s.table[3]).toBeCloseTo(0.25);
    expect(s.table[SURFACE_TRI_FLOATS + 3]).toBe(1);
    // Face normal +z on every corner of the first triangle.
    expect(Array.from(s.table.subarray(12, 15))).toEqual([0, 0, 1]);
    expect(Array.from(s.table.subarray(20, 23))).toEqual([0, 0, 1]);
    expect(s.alongNormal).toBeUndefined();
    expect(buildEmitSurface({ positions: POSITIONS }, { alongNormal: true }).alongNormal).toBe(
      true,
    );
  });

  it('reads vertex normals and indices, and a Geometry through its layout', () => {
    const s = buildEmitSurface({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 2, 0, 0, 2, 0, 0, 2, 0],
      indices: [0, 1, 2],
    });
    expect(Array.from(s.table.subarray(12, 15))).toEqual([0, 1, 0]);
    const floats = 12;
    const vertices = new Float32Array(3 * floats);
    for (let v = 0; v < 3; v++) {
      vertices.set([v === 1 ? 1 : 0, v === 2 ? 1 : 0, 0, 1, 0, 0], v * floats);
    }
    const geometry = {
      vertices,
      indices: new Uint16Array([0, 1, 2]),
      layout: { floats },
      bounds: { center: [0, 0, 0], radius: 1 },
    } as unknown as Geometry;
    const g = buildEmitSurface(geometry);
    expect(g.triangles).toBe(1);
    expect(g.area).toBeCloseTo(0.5);
    expect(Array.from(g.table.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(g.table.subarray(4, 7))).toEqual([1, 0, 0]);
    expect(Array.from(g.table.subarray(12, 15))).toEqual([1, 0, 0]);
  });

  it('samples triangles in proportion to their area (1:3 over 4000 draws, fixed seed)', () => {
    const s = buildEmitSurface({ positions: POSITIONS });
    const rand = lcg(12345);
    const out = new Float32Array(6);
    const counts = [0, 0];
    for (let i = 0; i < 4000; i++) {
      const t = sampleEmitSurface(s, rand(), rand(), rand(), out);
      counts[t]!++;
      // The point lies inside its triangle (x in range, y above the base, under the hypotenuse).
      if (t === 0) {
        expect(out[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(out[1]).toBeGreaterThanOrEqual(-1e-6);
        expect(out[0]! / 2 + out[1]!).toBeLessThanOrEqual(1 + 1e-6);
      } else {
        expect(out[0]).toBeGreaterThanOrEqual(10 - 1e-6);
        expect((out[0]! - 10) / 3 + out[1]! / 2).toBeLessThanOrEqual(1 + 1e-6);
      }
      expect(out[5]).toBe(1);
    }
    expect(counts[0]! + counts[1]!).toBe(4000);
    const ratio = counts[1]! / counts[0]!;
    expect(ratio).toBeGreaterThan(2.6);
    expect(ratio).toBeLessThan(3.4);
  });
});
