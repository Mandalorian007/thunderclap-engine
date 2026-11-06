import { describe, expect, it } from 'vitest';
import { VERTEX_LAYOUT_3D } from '../render/mesh';
import { GEOMETRY_FLOATS, type Geometry } from './geometry';
import { arch, stairs } from './shapes';
import { extrude, lathe, polygon, sweep, tube } from './sweep';
import { profileArea2 } from './triangulate';

const F = GEOMETRY_FLOATS;
const TAU = Math.PI * 2;

function vertexCount(g: Geometry): number {
  return g.vertices.length / F;
}

function expectUnitNormals(g: Geometry): void {
  const v = g.vertices;
  for (let o = 0; o < v.length; o += F) {
    expect(Math.hypot(v[o + 3]!, v[o + 4]!, v[o + 5]!)).toBeCloseTo(1, 5);
  }
}

/** Non-degenerate triangles wind counter-clockwise around their vertices' normals. */
function expectWinding(g: Geometry): void {
  const v = g.vertices;
  const n = vertexCount(g);
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    expect(Math.max(g.indices[t]!, g.indices[t + 1]!, g.indices[t + 2]!)).toBeLessThan(n);
    const abx = v[b]! - v[a]!;
    const aby = v[b + 1]! - v[a + 1]!;
    const abz = v[b + 2]! - v[a + 2]!;
    const acx = v[c]! - v[a]!;
    const acy = v[c + 1]! - v[a + 1]!;
    const acz = v[c + 2]! - v[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    const sx = v[a + 3]! + v[b + 3]! + v[c + 3]!;
    const sy = v[a + 4]! + v[b + 4]! + v[c + 4]!;
    const sz = v[a + 5]! + v[b + 5]! + v[c + 5]!;
    expect(nx * sx + ny * sy + nz * sz).toBeGreaterThan(0);
  }
}

/** Sum of the areas of the triangles whose three normals all equal `n`. */
function areaFacing(g: Geometry, n: [number, number, number]): number {
  const v = g.vertices;
  let area = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const i = [g.indices[t]! * F, g.indices[t + 1]! * F, g.indices[t + 2]! * F];
    if (!i.every((o) => v[o + 3] === n[0] && v[o + 4] === n[1] && v[o + 5] === n[2])) continue;
    const [a, b, c] = i as [number, number, number];
    const abx = v[b]! - v[a]!;
    const aby = v[b + 1]! - v[a + 1]!;
    const abz = v[b + 2]! - v[a + 2]!;
    const acx = v[c]! - v[a]!;
    const acy = v[c + 1]! - v[a + 1]!;
    const acz = v[c + 2]! - v[a + 2]!;
    area += Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
  }
  return area;
}

function star(points = 5, outer = 1, inner = 0.45): number[] {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * TAU;
    out.push(r * Math.cos(a), r * Math.sin(a));
  }
  return out;
}

const SQUARE = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];

describe('extrude', () => {
  it('builds flat sides and two caps with the expected counts', () => {
    const g = extrude(SQUARE, { depth: 2 });
    expect(g.layout).toBe(VERTEX_LAYOUT_3D);
    // 4 edges × 2 × 2 rows + 2 caps × 4 points.
    expect(vertexCount(g)).toBe(4 * 2 * 2 + 8);
    // 4 side quads + 2 caps of 2 triangles.
    expect(g.indices.length).toBe(4 * 6 + 2 * 2 * 3);
    expectUnitNormals(g);
    expectWinding(g);
    expect(g.bounds.center).toEqual([0, 0, 0]);
    expect(g.bounds.radius).toBeCloseTo(Math.hypot(0.5, 0.5, 1), 5);
  });

  it('caps face ±z and a concave cap covers exactly the polygon area', () => {
    const profile = star();
    const g = extrude(profile, { depth: 0.5 });
    const area = profileArea2(profile) / 2;
    expect(areaFacing(g, [0, 0, 1])).toBeCloseTo(area, 5);
    expect(areaFacing(g, [0, 0, -1])).toBeCloseTo(area, 5);
    expectWinding(g);
    // Side normals are flat: no z component.
    const v = g.vertices;
    let sides = 0;
    for (let o = 0; o < v.length; o += F) if (v[o + 5] === 0) sides++;
    expect(sides).toBe(10 * 2 * 2); // 10 edges × 2 vertices × 2 rows
  });

  it('accepts a clockwise outline, segments, no caps and a bevel', () => {
    const cwPts: number[] = [];
    for (let i = SQUARE.length - 2; i >= 0; i -= 2) cwPts.push(SQUARE[i]!, SQUARE[i + 1]!);
    expect(profileArea2(cwPts)).toBeLessThan(0);
    const a = extrude(cwPts, { depth: 1, segments: 3 });
    expectWinding(a);
    expect(vertexCount(a)).toBe(4 * 2 * 4 + 8);
    const open = extrude(SQUARE, { caps: false, segments: 2 });
    expect(vertexCount(open)).toBe(4 * 2 * 3);
    expect(open.indices.length).toBe(4 * 2 * 6);
    const bev = extrude(SQUARE, { depth: 1, bevel: 0.1 });
    expectUnitNormals(bev);
    expectWinding(bev);
    // The caps are inset: their x, y extents are 0.4, the sides' still 0.5; z stays ±0.5.
    const v = bev.vertices;
    let capMax = 0;
    let zMax = 0;
    for (let o = 0; o < v.length; o += F) {
      if (v[o + 5] === 1) capMax = Math.max(capMax, Math.abs(v[o]!), Math.abs(v[o + 1]!));
      zMax = Math.max(zMax, Math.abs(v[o + 2]!));
    }
    expect(capMax).toBeCloseTo(0.4, 5);
    expect(zMax).toBeCloseTo(0.5, 5);
    expect(areaFacing(bev, [0, 0, 1])).toBeCloseTo(0.8 * 0.8, 5);
  });

  it('throws on too few points or zero segments', () => {
    expect(() => extrude([0, 0, 1, 0])).toThrow(/at least 3/);
    expect(() => extrude(SQUARE, { segments: 0 })).toThrow(/segments/);
  });
});

describe('lathe', () => {
  it('revolves a profile into rings with smooth outward normals', () => {
    const profile = [0.2, 0, 0.5, 0.3, 0.3, 0.8, 0.4, 1];
    const g = lathe(profile, { segments: 16 });
    expect(vertexCount(g)).toBe(4 * 17);
    expect(g.indices.length).toBe(3 * 16 * 6);
    expectUnitNormals(g);
    expectWinding(g);
    // Every normal points away from the axis (positive radial component).
    const v = g.vertices;
    for (let o = 0; o < v.length; o += F) {
      expect(v[o]! * v[o + 3]! + v[o + 2]! * v[o + 5]!).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(g.bounds.center[1]).toBeCloseTo(0.5, 5);
  });

  it('sweeps a partial angle and matches cylinder orientation (u = 0 at +z)', () => {
    const g = lathe([0.5, 0, 0.5, 1], { segments: 8, angle: Math.PI });
    const v = g.vertices;
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[2]).toBeCloseTo(0.5, 6);
    // The last column is half a turn on: -z.
    const last = 8 * F;
    expect(v[last + 2]).toBeCloseTo(-0.5, 6);
    expect(() => lathe([0, 0], {})).toThrow(/at least 2/);
    expect(() => lathe([0, 0, 1, 1], { segments: 2 })).toThrow(/segments/);
  });
});

describe('sweep and tube', () => {
  function helix(turns: number, points: number, radius: number, rise: number): Float32Array {
    const path = new Float32Array(points * 3);
    for (let i = 0; i < points; i++) {
      const a = (i / (points - 1)) * turns * TAU;
      path[i * 3] = radius * Math.cos(a);
      path[i * 3 + 1] = (i / (points - 1)) * rise;
      path[i * 3 + 2] = radius * Math.sin(a);
    }
    return path;
  }

  it('carries the profile along an open path with the expected counts and no twist jumps', () => {
    const path = helix(2, 40, 0.5, 1);
    const g = tube(path, { radius: 0.1, segments: 8 });
    expect(vertexCount(g)).toBe(40 * 9);
    expect(g.indices.length).toBe(39 * 8 * 6);
    expectUnitNormals(g);
    expectWinding(g);
    // Every ring's vertices lie `radius` from the path point.
    const v = g.vertices;
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i <= 8; i++) {
        const o = (j * 9 + i) * F;
        const d = Math.hypot(
          v[o]! - path[j * 3]!,
          v[o + 1]! - path[j * 3 + 1]!,
          v[o + 2]! - path[j * 3 + 2]!,
        );
        expect(d).toBeCloseTo(0.1, 5);
      }
    }
    // Rotation-minimising: the first vertex of consecutive rings never jumps far.
    for (let j = 1; j < 40; j++) {
      const a = (j - 1) * 9 * F;
      const b = j * 9 * F;
      const dx = v[b]! - v[a]! - (path[j * 3]! - path[(j - 1) * 3]!);
      const dy = v[b + 1]! - v[a + 1]! - (path[j * 3 + 1]! - path[(j - 1) * 3 + 1]!);
      const dz = v[b + 2]! - v[a + 2]! - (path[j * 3 + 2]! - path[(j - 1) * 3 + 2]!);
      expect(Math.hypot(dx, dy, dz)).toBeLessThan(0.1);
    }
  });

  it('closes a loop: the last ring stitches to the first and the seam has no gap', () => {
    const m = 24;
    const path = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const a = (i / m) * TAU;
      path[i * 3] = Math.cos(a);
      path[i * 3 + 2] = Math.sin(a);
    }
    const g = tube(path, { radius: 0.2, segments: 6, closed: true });
    expect(vertexCount(g)).toBe(m * 7);
    expect(g.indices.length).toBe(m * 6 * 6);
    expectWinding(g);
    // The last span's indices reach ring 0.
    const lastSpan = g.indices.subarray((m - 1) * 6 * 6);
    expect(Math.min(...lastSpan)).toBeLessThan(7);
    // Ring m-1 is a quarter step from ring 0 around the circle; frame twist stays small.
    const v = g.vertices;
    const o0 = 0;
    const o1 = (m - 1) * 7 * F;
    const r0 = [v[o0]! - path[0]!, v[o0 + 1]!, v[o0 + 2]! - path[2]!];
    const r1 = [v[o1]! - path[(m - 1) * 3]!, v[o1 + 1]!, v[o1 + 2]! - path[(m - 1) * 3 + 2]!];
    // Both radial offsets are 0.2 long; their angle about the path tangent is near zero, which
    // for a planar circle means equal y components.
    expect(r0[1]).toBeCloseTo(r1[1]!, 2);
    expect(Math.hypot(r0[0]!, r0[1]!, r0[2]!)).toBeCloseTo(0.2, 5);
  });

  it('frenet frames follow the curvature of a planar circle', () => {
    const m = 16;
    const path = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const a = (i / m) * TAU;
      path[i * 3] = Math.cos(a);
      path[i * 3 + 2] = Math.sin(a);
    }
    const g = sweep([0.1, 0, 0, 0.1, -0.1, 0, 0, -0.1], path, { closed: true, frames: 'frenet' });
    expectWinding(g);
    expectUnitNormals(g);
    expect(vertexCount(g)).toBe(m * 5);
    expect(() => sweep(SQUARE, [0, 0, 0])).toThrow(/path/);
    expect(() => tube(path, { segments: 2 })).toThrow(/segments/);
  });
});

describe('polygon', () => {
  it('lays a counter-clockwise outline flat facing +y, optionally double sided', () => {
    const g = polygon(star(), { y: 0.5 });
    expect(vertexCount(g)).toBe(10);
    expect(g.indices.length).toBe(8 * 3);
    expectWinding(g);
    const v = g.vertices;
    for (let o = 0; o < v.length; o += F) {
      expect(v[o + 1]).toBe(0.5);
      expect(v[o + 4]).toBe(1);
      expect(v[o + 6]).toBeGreaterThanOrEqual(0);
      expect(v[o + 6]).toBeLessThanOrEqual(1);
    }
    const two = polygon(star(), { doubleSided: true });
    expect(vertexCount(two)).toBe(20);
    expect(two.indices.length).toBe(16 * 3);
    expectWinding(two);
    expect(areaFacing(two, [0, 1, 0])).toBeCloseTo(profileArea2(star()) / 2, 5);
    expect(areaFacing(two, [0, -1, 0])).toBeCloseTo(profileArea2(star()) / 2, 5);
  });
});

describe('stairs and arch', () => {
  it('stairs: a centred solid with one top face per step', () => {
    const g = stairs({ steps: 3, width: 1, rise: 0.2, run: 0.3 });
    expectUnitNormals(g);
    expectWinding(g);
    expect(g.bounds.center[0]).toBeCloseTo(0, 5);
    expect(g.bounds.center[1]).toBeCloseTo(0, 5);
    expect(g.bounds.center[2]).toBeCloseTo(0, 5);
    // Three treads of width × run face +y; the back and bottom face ±z / -y.
    expect(areaFacing(g, [0, 1, 0])).toBeCloseTo(3 * 0.3, 5);
    expect(areaFacing(g, [0, -1, 0])).toBeCloseTo(0.9, 5);
    expect(areaFacing(g, [0, 0, 1])).toBeCloseTo(0.6, 5); // the back wall
    const open = stairs({ steps: 2, sides: false });
    expect(vertexCount(open)).toBeLessThan(vertexCount(stairs({ steps: 2 })));
    expect(() => stairs({ steps: 0 })).toThrow(/steps/);
  });

  it('arch: legs plus a lintel with a semicircular underside, centred', () => {
    const g = arch({ width: 1, height: 1, depth: 0.25, thickness: 0.15, segments: 8 });
    expectUnitNormals(g);
    expectWinding(g);
    expect(g.bounds.center[0]).toBeCloseTo(0, 5);
    expect(g.bounds.center[1]).toBeCloseTo(0, 5);
    // The two faces of the lintel each cover width × (height - spring) minus the half disc.
    const ri = 0.35;
    const spring = 1 - 0.15 - ri;
    const lintelFace = 1 * (1 - spring) - (Math.PI * ri * ri) / 2;
    // The polygonal arc has a little less area than the true half disc: within 5 %.
    const front = areaFacing(g, [0, 0, 1]);
    expect(front).toBeGreaterThan(lintelFace + 2 * 0.15 * spring);
    expect(front).toBeLessThan((lintelFace + 2 * 0.15 * spring) * 1.05);
    const noLegs = arch({ width: 1, height: 0.65, thickness: 0.15 });
    expectWinding(noLegs);
    expect(() => arch({ thickness: 0.6 })).toThrow(/thickness/);
    expect(() => arch({ height: 0.4 })).toThrow(/height/);
    expect(() => arch({ segments: 1 })).toThrow(/segments/);
  });
});
