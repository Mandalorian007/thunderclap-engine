import { describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import { Mesh, type MeshDesc, VERTEX_LAYOUT_3D } from '../render/mesh';
import { GEOMETRY_FLOATS, type Geometry } from './geometry';
import { box, capsule, cylinder, icosphere, plane, sphere, torus } from './primitives';

const F = GEOMETRY_FLOATS;

function vertexCount(g: Geometry): number {
  return g.vertices.length / F;
}

/** Every normal is unit length. */
function expectUnitNormals(g: Geometry): void {
  const v = g.vertices;
  for (let o = 0; o < v.length; o += F) {
    expect(Math.hypot(v[o + 3]!, v[o + 4]!, v[o + 5]!)).toBeCloseTo(1, 5);
  }
}

/** Every normal points away from `centre` (dot with the position from the centre > 0). */
function expectOutward(g: Geometry, centre: [number, number, number] = [0, 0, 0]): void {
  const v = g.vertices;
  for (let o = 0; o < v.length; o += F) {
    const px = v[o]! - centre[0];
    const py = v[o + 1]! - centre[1];
    const pz = v[o + 2]! - centre[2];
    const d = px * v[o + 3]! + py * v[o + 4]! + pz * v[o + 5]!;
    expect(d).toBeGreaterThan(0);
  }
}

/**
 * Every non-degenerate triangle winds counter-clockwise around its vertices' normals (the
 * geometric face normal agrees with the shading normal) and uses in-range indices.
 */
function expectWinding(g: Geometry): { triangles: number; degenerate: number } {
  const v = g.vertices;
  const n = vertexCount(g);
  let degenerate = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    expect(g.indices[t]!).toBeLessThan(n);
    expect(g.indices[t + 1]!).toBeLessThan(n);
    expect(g.indices[t + 2]!).toBeLessThan(n);
    const abx = v[b]! - v[a]!;
    const aby = v[b + 1]! - v[a + 1]!;
    const abz = v[b + 2]! - v[a + 2]!;
    const acx = v[c]! - v[a]!;
    const acy = v[c + 1]! - v[a + 1]!;
    const acz = v[c + 2]! - v[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-9) {
      degenerate++;
      continue;
    }
    const sx = v[a + 3]! + v[b + 3]! + v[c + 3]!;
    const sy = v[a + 4]! + v[b + 4]! + v[c + 4]!;
    const sz = v[a + 5]! + v[b + 5]! + v[c + 5]!;
    expect(nx * sx + ny * sy + nz * sz).toBeGreaterThan(0);
  }
  return { triangles: g.indices.length / 3, degenerate };
}

/** The bounds are the positions' box centre and the farthest vertex. */
function expectTightBounds(g: Geometry, centre: [number, number, number], radius: number): void {
  expect(g.bounds.center[0]).toBeCloseTo(centre[0], 5);
  expect(g.bounds.center[1]).toBeCloseTo(centre[1], 5);
  expect(g.bounds.center[2]).toBeCloseTo(centre[2], 5);
  expect(g.bounds.radius).toBeCloseTo(radius, 5);
  const v = g.vertices;
  let max = 0;
  for (let o = 0; o < v.length; o += F) {
    const d = Math.hypot(v[o]! - centre[0], v[o + 1]! - centre[1], v[o + 2]! - centre[2]);
    expect(d).toBeLessThanOrEqual(g.bounds.radius + 1e-5);
    if (d > max) max = d;
  }
  expect(max).toBeCloseTo(g.bounds.radius, 5);
}

describe('box', () => {
  it('is 24 vertices and 12 flat-shaded triangles by default, in the 3D layout', () => {
    const g = box();
    expect(g.layout).toBe(VERTEX_LAYOUT_3D);
    expect(vertexCount(g)).toBe(24);
    expect(g.indices).toBeInstanceOf(Uint16Array);
    expect(g.indices.length).toBe(36);
    expectUnitNormals(g);
    expectOutward(g);
    expect(expectWinding(g)).toEqual({ triangles: 12, degenerate: 0 });
    expectTightBounds(g, [0, 0, 0], Math.sqrt(3) / 2);
  });

  it('takes a size per axis and segments per axis', () => {
    const g = box({ size: [2, 4, 6], segments: [1, 2, 3] });
    // ±z faces: (1+1)(2+1); ±x faces: (3+1)(2+1); ±y faces: (1+1)(3+1).
    expect(vertexCount(g)).toBe(2 * (2 * 3 + 4 * 3 + 2 * 4));
    expect(g.indices.length).toBe(2 * (1 * 2 + 3 * 2 + 1 * 3) * 6);
    expectWinding(g);
    expectTightBounds(g, [0, 0, 0], Math.hypot(1, 2, 3));
  });

  it('writes the colour and uv scale into every vertex', () => {
    const g = box({ color: [0.2, 0.4, 0.6, 0.8], uvScale: [2, 3] });
    let maxU = 0;
    let maxV = 0;
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(Array.from(g.vertices.subarray(o + 8, o + 12))).toEqual([
        Math.fround(0.2),
        Math.fround(0.4),
        Math.fround(0.6),
        Math.fround(0.8),
      ]);
      maxU = Math.max(maxU, g.vertices[o + 6]!);
      maxV = Math.max(maxV, g.vertices[o + 7]!);
    }
    expect(maxU).toBe(2);
    expect(maxV).toBe(3);
  });

  it('is a MeshDesc: createMesh takes it as-is', () => {
    const g = box();
    const desc: MeshDesc = g;
    const fake = createFakeDevice();
    const mesh = new Mesh(fake.device, desc);
    expect(mesh.vertexCount).toBe(24);
    expect(mesh.indexCount).toBe(36);
    expect(mesh.layout).toBe(VERTEX_LAYOUT_3D);
    expect(mesh.bounds.radius).toBeCloseTo(g.bounds.radius, 6);
  });
});

describe('plane', () => {
  it('faces +y with u along x and v along z', () => {
    const g = plane({ size: [4, 2], segments: [2, 1] });
    expect(vertexCount(g)).toBe(6);
    expect(g.indices.length).toBe(12);
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(g.vertices[o + 1]).toBe(0);
      expect(Array.from(g.vertices.subarray(o + 3, o + 6))).toEqual([0, 1, 0]);
      expect(g.vertices[o + 6]).toBeCloseTo((g.vertices[o]! + 2) / 4, 6);
      expect(g.vertices[o + 7]).toBeCloseTo((g.vertices[o + 2]! + 1) / 2, 6);
    }
    expect(expectWinding(g)).toEqual({ triangles: 4, degenerate: 0 });
    expectTightBounds(g, [0, 0, 0], Math.hypot(2, 1));
  });
});

describe('sphere', () => {
  it('has (w+1)(h+1) vertices, 2w(h-1) triangles, unit outward normals and tight bounds', () => {
    const g = sphere({ radius: 2, segments: [12, 6] });
    expect(vertexCount(g)).toBe(13 * 7);
    expect(g.indices.length).toBe(2 * 12 * 5 * 3);
    expectUnitNormals(g);
    expectOutward(g);
    expect(expectWinding(g)).toEqual({ triangles: 120, degenerate: 0 });
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(Math.hypot(g.vertices[o]!, g.vertices[o + 1]!, g.vertices[o + 2]!)).toBeCloseTo(2, 5);
      // The normal is the position over the radius.
      expect(g.vertices[o + 3]).toBeCloseTo(g.vertices[o]! / 2, 5);
    }
    expectTightBounds(g, [0, 0, 0], 2);
  });

  it('defaults to a unit diameter with 32×16 segments', () => {
    const g = sphere();
    expect(vertexCount(g)).toBe(33 * 17);
    expect(g.bounds.radius).toBeCloseTo(0.5, 6);
  });

  it('rejects too few segments', () => {
    expect(() => sphere({ segments: [2, 4] })).toThrow(/at least 3/);
    expect(() => sphere({ segments: [4, 1] })).toThrow(/at least 2/);
  });
});

describe('icosphere', () => {
  it('has 10·4ⁿ + 2 welded vertices and 20·4ⁿ triangles', () => {
    for (const n of [0, 1, 2, 3]) {
      const g = icosphere({ subdivisions: n, radius: 1 });
      expect(vertexCount(g)).toBe(10 * 4 ** n + 2);
      expect(g.indices.length).toBe(20 * 4 ** n * 3);
      expectUnitNormals(g);
      expectOutward(g);
      expect(expectWinding(g).degenerate).toBe(0);
      expectTightBounds(g, [0, 0, 0], 1);
    }
  });

  it('promotes its indices to Uint32 past 65535 vertices', () => {
    const g = icosphere({ subdivisions: 6 }); // 40962 vertices
    expect(g.indices).toBeInstanceOf(Uint16Array);
    const big = icosphere({ subdivisions: 7 }); // 163842 vertices
    expect(big.indices).toBeInstanceOf(Uint32Array);
    expect(vertexCount(big)).toBe(163842);
    expect(big.indices[big.indices.length - 1]).toBeLessThan(163842);
  });
});

describe('capsule', () => {
  it('spans the height with smooth outward normals', () => {
    const g = capsule({ radius: 0.5, height: 3, segments: [8, 4] });
    const rows = 2 * 5;
    expect(vertexCount(g)).toBe(9 * rows);
    expect(g.indices.length).toBe(8 * (3 + 3 + (rows - 3) * 6));
    expectUnitNormals(g);
    expect(expectWinding(g).degenerate).toBe(0);
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let o = 0; o < g.vertices.length; o += F) {
      minY = Math.min(minY, g.vertices[o + 1]!);
      maxY = Math.max(maxY, g.vertices[o + 1]!);
      // Radially the normal is the horizontal position over the radius.
      expect(g.vertices[o + 3]).toBeCloseTo(g.vertices[o]! / 0.5, 5);
      expect(g.vertices[o + 5]).toBeCloseTo(g.vertices[o + 2]! / 0.5, 5);
    }
    expect(minY).toBeCloseTo(-1.5, 6);
    expect(maxY).toBeCloseTo(1.5, 6);
    expectTightBounds(g, [0, 0, 0], 1.5);
    expectOutward(g);
  });

  it('is a sphere when the height is twice the radius', () => {
    const g = capsule({ radius: 1, height: 2, segments: [8, 4] });
    for (let o = 0; o < g.vertices.length; o += F) {
      expect(Math.hypot(g.vertices[o]!, g.vertices[o + 1]!, g.vertices[o + 2]!)).toBeCloseTo(1, 5);
    }
  });
});

describe('cylinder', () => {
  it('has a smooth side and two flat caps', () => {
    const g = cylinder({ radius: 1, height: 2, segments: [6, 2] });
    expect(vertexCount(g)).toBe(7 * 3 + 2 * 8);
    expect(g.indices.length).toBe(6 * 2 * 6 + 2 * 6 * 3);
    expectUnitNormals(g);
    expectOutward(g);
    expect(expectWinding(g)).toEqual({ triangles: 36, degenerate: 0 });
    expectTightBounds(g, [0, 0, 0], Math.SQRT2);
  });

  it('builds a cone from a zero top radius, with normals leaning up', () => {
    const g = cylinder({ radius: [0, 1], height: 2, segments: [6, 1] });
    expect(vertexCount(g)).toBe(7 * 2 + 8);
    expect(g.indices.length).toBe(6 * 3 + 6 * 3);
    expectUnitNormals(g);
    expect(expectWinding(g).degenerate).toBe(0);
    // The side normal of a cone with slope 1/2 has ny = 0.5 / hypot(1, 0.5).
    expect(g.vertices[4]).toBeCloseTo(0.5 / Math.hypot(1, 0.5), 6);
  });

  it('can be open', () => {
    const g = cylinder({ caps: false, segments: [5, 1] });
    expect(vertexCount(g)).toBe(6 * 2);
    expect(g.indices.length).toBe(5 * 6);
  });
});

describe('torus', () => {
  it('lies in the xz plane with normals pointing away from the tube centre', () => {
    const R = 2;
    const r = 0.5;
    const g = torus({ radius: R, tube: r, segments: [6, 10] });
    expect(vertexCount(g)).toBe(11 * 7);
    expect(g.indices.length).toBe(6 * 10 * 6);
    expectUnitNormals(g);
    expect(expectWinding(g)).toEqual({ triangles: 120, degenerate: 0 });
    for (let o = 0; o < g.vertices.length; o += F) {
      const x = g.vertices[o]!;
      const y = g.vertices[o + 1]!;
      const z = g.vertices[o + 2]!;
      const ring = Math.hypot(x, z);
      // Distance to the tube's centre circle is the tube radius.
      expect(Math.hypot(ring - R, y)).toBeCloseTo(r, 5);
      const cx = (x / ring) * R;
      const cz = (z / ring) * R;
      expect(g.vertices[o + 3]).toBeCloseTo((x - cx) / r, 5);
      expect(g.vertices[o + 4]).toBeCloseTo(y / r, 5);
      expect(g.vertices[o + 5]).toBeCloseTo((z - cz) / r, 5);
    }
    expectTightBounds(g, [0, 0, 0], R + r);
  });
});
