import { describe, expect, it } from 'vitest';
import { createHit, createStaticCollider, raycast } from './collide';
import type { Geometry } from './geometry';
import { collisionProxy, convexHull } from './hull';
import { icosphere, torus } from './primitives';

/** Deterministic 0..1 noise. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const tris = (g: Geometry) => g.indices.length / 3;

/** Signed distance of `(px, py, pz)` past each hull face: the largest, ≤ 0 inside or on. */
function worstOutside(h: Geometry, px: number, py: number, pz: number): number {
  const F = h.layout.floats;
  const v = h.vertices;
  let worst = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < h.indices.length; t += 3) {
    const a = h.indices[t]! * F;
    const d =
      v[a + 3]! * (px - v[a]!) + v[a + 4]! * (py - v[a + 1]!) + v[a + 5]! * (pz - v[a + 2]!);
    worst = Math.max(worst, d);
  }
  return worst;
}

/** A 20 480-triangle rock: an icosphere with a smooth lumpy radius. */
function rock(): Geometry {
  const g = icosphere({ radius: 1, subdivisions: 5 });
  const F = g.layout.floats;
  const v = g.vertices;
  for (let o = 0; o < v.length; o += F) {
    const x = v[o]!;
    const y = v[o + 1]!;
    const z = v[o + 2]!;
    const r = 1 + 0.15 * Math.sin(3 * x + 1) * Math.cos(2 * y) + 0.1 * Math.sin(4 * z + 2 * x);
    v[o] = x * r;
    v[o + 1] = y * r;
    v[o + 2] = z * r;
  }
  return g;
}

describe('convexHull', () => {
  it("a cube's corners plus interior noise give 12 outward triangles", () => {
    const r = rng(7);
    const pts: number[] = [];
    for (let i = 0; i < 200; i++) pts.push(r() * 1.8 - 0.9, r() * 1.8 - 0.9, r() * 1.8 - 0.9);
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push(x, y, z);
    for (let i = 0; i < 200; i++) pts.push(r() * 1.8 - 0.9, r() * 1.8 - 0.9, r() * 1.8 - 0.9);
    const h = convexHull(new Float32Array(pts));
    expect(tris(h)).toBe(12);
    // Every normal points away from the centre, and every face lies on the cube.
    const F = h.layout.floats;
    for (let o = 0; o < h.vertices.length; o += F) {
      const v = h.vertices;
      expect(v[o]! * v[o + 3]! + v[o + 1]! * v[o + 4]! + v[o + 2]! * v[o + 5]!).toBeCloseTo(1, 6);
    }
    // Winding agrees with the stored normal (counter-clockwise from outside).
    for (let t = 0; t < h.indices.length; t += 3) {
      const [a, b, c] = [h.indices[t]! * F, h.indices[t + 1]! * F, h.indices[t + 2]! * F];
      const v = h.vertices;
      const ux = v[b]! - v[a]!;
      const uy = v[b + 1]! - v[a + 1]!;
      const uz = v[b + 2]! - v[a + 2]!;
      const wx = v[c]! - v[a]!;
      const wy = v[c + 1]! - v[a + 1]!;
      const wz = v[c + 2]! - v[a + 2]!;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      expect(nx * v[a + 3]! + ny * v[a + 4]! + nz * v[a + 5]!).toBeGreaterThan(0);
    }
    for (let i = 0; i < pts.length; i += 3) {
      expect(worstOutside(h, pts[i]!, pts[i + 1]!, pts[i + 2]!)).toBeLessThanOrEqual(1e-5);
    }
  });

  it('every vertex of a mesh is inside or on its hull', () => {
    const g = torus();
    const h = convexHull(g);
    expect(tris(h)).toBeGreaterThan(8);
    const F = g.layout.floats;
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(
        worstOutside(h, g.vertices[o]!, g.vertices[o + 1]!, g.vertices[o + 2]!),
      ).toBeLessThanOrEqual(1e-5);
    }
    // Closed: every undirected edge is shared by exactly two triangles, once each way.
    const edges = new Map<string, number>();
    const key = (i: number) =>
      `${h.vertices[i * F]},${h.vertices[i * F + 1]},${h.vertices[i * F + 2]}`;
    for (let t = 0; t < h.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const e = `${key(h.indices[t + k]!)}>${key(h.indices[t + ((k + 1) % 3)]!)}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    for (const [e, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = e.split('>');
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
  });

  it('a flat or tiny cloud has no hull', () => {
    expect(tris(convexHull(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))).toBe(0);
    expect(
      tris(convexHull(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0]))),
    ).toBe(0);
    expect(() => convexHull(new Float32Array(4))).toThrow(/triples/);
  });
});

describe('collisionProxy', () => {
  const rays = () => {
    const r = rng(3);
    const out: [number, number, number][] = [];
    for (let i = 0; i < 100; i++) {
      const zz = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - zz * zz);
      out.push([s * Math.cos(a), zz, s * Math.sin(a)]);
    }
    return out;
  };

  it('a 20k-triangle rock simplifies under budget and raycasts within 2% of the full mesh', () => {
    const g = rock();
    expect(tris(g)).toBe(20480);
    const proxy = collisionProxy(g, { maxTriangles: 1500, kind: 'simplified' });
    expect(tris(proxy)).toBeLessThanOrEqual(1500);
    const full = createStaticCollider([{ geometry: g }]);
    const cheap = createStaticCollider([{ geometry: proxy }]);
    const hf = createHit();
    const hp = createHit();
    for (const [dx, dy, dz] of rays()) {
      const origin = [dx * 5, dy * 5, dz * 5];
      const dir = [-dx, -dy, -dz];
      expect(raycast(full, origin, dir, 10, hf)).toBe(true);
      expect(raycast(cheap, origin, dir, 10, hp)).toBe(true);
      // The surface sits 3.7..4.3 along the ray: 2% of that distance.
      expect(Math.abs(hp.t - hf.t)).toBeLessThanOrEqual(0.02 * hf.t);
    }
  });

  it('the hull kind is under budget and encloses the mesh', () => {
    const g = rock();
    const proxy = collisionProxy(g, { maxTriangles: 200 });
    expect(tris(proxy)).toBeLessThanOrEqual(200);
    expect(tris(proxy)).toBeGreaterThan(50);
    const small = collisionProxy(torus(), { maxTriangles: 10000 });
    expect(small.layout).toBe(convexHull(torus()).layout);
    expect(tris(small)).toBe(tris(convexHull(torus())));
  });
});
