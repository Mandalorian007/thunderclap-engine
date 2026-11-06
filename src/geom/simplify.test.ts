import { describe, expect, it } from 'vitest';
import { VERTEX_LAYOUT_3D_TANGENT } from '../render/mesh';
import type { Geometry } from './geometry';
import { plane, sphere } from './primitives';
import { createLodChain, simplifyGeometry } from './simplify';
import { computeTangents } from './tangents';

const tris = (g: Geometry) => g.indices.length / 3;

/** A 100 × 51 UV sphere: exactly 10 000 triangles (the poles are fans). */
const bigSphere = () => sphere({ radius: 0.5, segments: [100, 51] });

describe('simplifyGeometry', () => {
  it('takes a 10k-triangle sphere to a quarter, close to the surface', () => {
    const g = bigSphere();
    expect(tris(g)).toBe(10000);
    const errorLimit = 0.01;
    const { geometry: s, error } = simplifyGeometry(g, { targetRatio: 0.25, errorLimit });
    expect(tris(s)).toBeLessThanOrEqual(0.25 * 10000 + 2);
    expect(tris(s)).toBeGreaterThan(0.2 * 10000);
    expect(error).toBeLessThanOrEqual(errorLimit);
    const F = s.layout.floats;
    const v = s.vertices;
    // Every kept vertex, and samples across every kept triangle, lie within the limit of the
    // original sphere (radius 0.5).
    for (let o = 0; o < v.length; o += F) {
      expect(Math.abs(Math.hypot(v[o]!, v[o + 1]!, v[o + 2]!) - 0.5)).toBeLessThan(1e-5);
    }
    let worst = 0;
    const idx = s.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * F;
      const b = idx[t + 1]! * F;
      const c = idx[t + 2]! * F;
      for (const [wa, wb, wc] of [
        [1 / 3, 1 / 3, 1 / 3],
        [0.5, 0.5, 0],
        [0, 0.5, 0.5],
        [0.5, 0, 0.5],
      ] as const) {
        const x = wa * v[a]! + wb * v[b]! + wc * v[c]!;
        const y = wa * v[a + 1]! + wb * v[b + 1]! + wc * v[c + 1]!;
        const z = wa * v[a + 2]! + wb * v[b + 2]! + wc * v[c + 2]!;
        worst = Math.max(worst, Math.abs(Math.hypot(x, y, z) - 0.5));
      }
    }
    expect(worst).toBeLessThan(errorLimit);
    // Still closed: every edge has two triangles.
    const r = (x: number) => (Math.abs(x) < 5e-6 ? 0 : x).toFixed(5);
    const pos = (i: number) => `${r(v[i * F]!)},${r(v[i * F + 1]!)},${r(v[i * F + 2]!)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const p = pos(idx[t + k]!);
        const q = pos(idx[t + ((k + 1) % 3)]!);
        const key = p < q ? `${p}|${q}` : `${q}|${p}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const n of edges.values()) expect(n).toBe(2);
  });

  it('two runs are byte-identical', () => {
    const a = simplifyGeometry(bigSphere(), { targetRatio: 0.3 }).geometry;
    const b = simplifyGeometry(bigSphere(), { targetRatio: 0.3 }).geometry;
    expect(Buffer.from(a.vertices.buffer).equals(Buffer.from(b.vertices.buffer))).toBe(true);
    expect(Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer))).toBe(true);
  });

  it('preserveBorders keeps every rim vertex of a plane', () => {
    const g = plane({ size: 2, segments: 16 });
    const rim = (x: number, z: number) =>
      Math.abs(Math.abs(x) - 1) < 1e-6 || Math.abs(Math.abs(z) - 1) < 1e-6;
    const rimOf = (s: Geometry) => {
      const out = new Set<string>();
      for (let o = 0; o < s.vertices.length; o += s.layout.floats) {
        const x = s.vertices[o]!;
        const z = s.vertices[o + 2]!;
        if (rim(x, z)) out.add(`${x},${z}`);
      }
      return out;
    };
    const before = rimOf(g);
    expect(before.size).toBe(64);
    const { geometry: s } = simplifyGeometry(g, { targetRatio: 0.1, preserveBorders: true });
    expect(tris(s)).toBeLessThan(tris(g));
    expect(rimOf(s)).toEqual(before);
    // Without it the flat rim is free to lose its collinear vertices.
    const loose = simplifyGeometry(g, { targetRatio: 0.1 }).geometry;
    expect(rimOf(loose).size).toBeLessThan(64);
    // A flat plane simplifies with no error.
    expect(simplifyGeometry(g, { targetRatio: 0.1 }).error).toBeLessThan(1e-6);
  });

  it('targetTriangles, errorLimit 0 and the tangent layout', () => {
    const g = bigSphere();
    expect(tris(simplifyGeometry(g, { targetTriangles: 500 }).geometry)).toBeLessThanOrEqual(500);
    // A curved surface cannot lose a vertex for free: an errorLimit of 0 keeps it whole.
    expect(tris(simplifyGeometry(g, { targetRatio: 0.1, errorLimit: 0 }).geometry)).toBe(10000);
    const t = simplifyGeometry(computeTangents(sphere()), { targetRatio: 0.5 }).geometry;
    expect(t.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    expect(t.vertices.length % 16).toBe(0);
  });

  it('preserveUvSeams keeps the seam column of a UV sphere', () => {
    const g = sphere({ segments: [24, 12] });
    const seam = (s: Geometry) => {
      let n = 0;
      for (let o = 0; o < s.vertices.length; o += s.layout.floats) {
        // The seam is the meridian at +z (x = 0, z > 0), u = 0 and u = 1 both.
        if (Math.abs(s.vertices[o]!) < 1e-6 && s.vertices[o + 2]! > 1e-6) n++;
      }
      return n;
    };
    const s = simplifyGeometry(g, { targetRatio: 0.3, preserveUvSeams: true }).geometry;
    expect(seam(s)).toBe(seam(g));
  });
});

describe('createLodChain', () => {
  it('level 0 is the input and each level is smaller', () => {
    const g = bigSphere();
    const chain = createLodChain(g, [0.5, 0.25, 0.1]);
    expect(chain).toHaveLength(4);
    expect(chain[0]).toBe(g);
    for (let i = 1; i < chain.length; i++)
      expect(tris(chain[i]!)).toBeLessThan(tris(chain[i - 1]!));
    expect(tris(chain[3]!)).toBeLessThanOrEqual(1002);
  });
});
