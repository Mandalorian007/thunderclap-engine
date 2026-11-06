import { describe, expect, it } from 'vitest';
import {
  VERTEX_LAYOUT_2D,
  VERTEX_LAYOUT_3D,
  VERTEX_LAYOUT_3D_TANGENT,
  type VertexLayout,
} from '../render/mesh';
import { Transform } from '../render/transform';
import {
  cloneGeometry,
  computeBounds,
  createIndices,
  GEOMETRY_FLOATS,
  type Geometry,
  GeometryWriter,
  mergeGeometry,
  transformGeometry,
  UINT16_MAX_VERTICES,
} from './geometry';
import { box, sphere } from './primitives';
import { computeTangents, TANGENT_FLOATS } from './tangents';

const F = GEOMETRY_FLOATS;

describe('GeometryWriter', () => {
  it('fills the reserved arrays and checks the counts', () => {
    const w = new GeometryWriter(3, 3, { color: [1, 0, 0, 1], uvScale: 2 });
    const a = w.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    const b = w.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    expect(() => w.finish()).toThrow(/wrote 2 of 3 vertices/);
    const c = w.vertex(0, 1, 0, 0, 0, 1, 0, 1);
    expect(() => w.finish()).toThrow(/wrote 0 of 3 indices/);
    w.tri(a, b, c);
    const g = w.finish();
    expect(g.layout).toBe(VERTEX_LAYOUT_3D);
    expect(Array.from(g.indices)).toEqual([0, 1, 2]);
    expect(Array.from(g.vertices.subarray(F + 6, F + 12))).toEqual([2, 0, 1, 0, 0, 1]);
    expect(g.bounds.center).toEqual([0.5, 0.5, 0]);
    expect(g.bounds.radius).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('picks the index type from the vertex count', () => {
    expect(createIndices(UINT16_MAX_VERTICES, 3)).toBeInstanceOf(Uint16Array);
    expect(createIndices(UINT16_MAX_VERTICES + 1, 3)).toBeInstanceOf(Uint32Array);
    expect(new GeometryWriter(70000, 0).indices).toBeInstanceOf(Uint32Array);
  });
});

describe('computeBounds', () => {
  it('is the box centre and the farthest vertex; empty is zero', () => {
    const v = new Float32Array(2 * F);
    v.set([-1, 0, 0], 0);
    v.set([3, 0, 0], F);
    expect(computeBounds(v)).toEqual({ center: [1, 0, 0], radius: 2 });
    expect(computeBounds(new Float32Array(0))).toEqual({ center: [0, 0, 0], radius: 0 });
  });
});

describe('mergeGeometry', () => {
  it('offsets the second part’s indices by the first part’s vertices and re-bounds', () => {
    const a = box();
    const b = transformGeometry(box(), new Transform({ x: 4 }).world);
    const m = mergeGeometry(a, b);
    expect(m.vertices.length).toBe(48 * F);
    expect(m.indices.length).toBe(72);
    expect(Array.from(m.indices.subarray(0, 36))).toEqual(Array.from(a.indices));
    expect(Array.from(m.indices.subarray(36))).toEqual(Array.from(b.indices, (i) => i + 24));
    expect(m.bounds.center).toEqual([2, 0, 0]);
    expect(m.bounds.radius).toBeCloseTo(Math.hypot(2.5, 0.5, 0.5), 5);
    expect(m.layout).toBe(VERTEX_LAYOUT_3D);
    // Inputs untouched (the last face's last triangle ends on its vertex 22).
    expect(a.indices[35]).toBe(22);
  });

  it('promotes to Uint32 when the total passes 65535 vertices', () => {
    const big = sphere({ segments: [255, 128] }); // 256 × 129 = 33024 vertices
    expect(big.indices).toBeInstanceOf(Uint16Array);
    const m = mergeGeometry(big, big, big);
    expect(m.vertices.length / F).toBe(99072);
    expect(m.indices).toBeInstanceOf(Uint32Array);
    expect(m.indices[m.indices.length - 1]).toBe(big.indices[big.indices.length - 1]! + 2 * 33024);
  });

  it('rejects mixed layouts and merges nothing to an empty geometry', () => {
    const two: Geometry = {
      vertices: new Float32Array(0),
      indices: new Uint16Array(0),
      bounds: { center: [0, 0, 0], radius: 0 },
      layout: VERTEX_LAYOUT_2D,
    };
    expect(() => mergeGeometry(box(), two)).toThrow(/mixes layouts/);
    const empty = mergeGeometry();
    expect(empty.vertices.length).toBe(0);
    expect(empty.layout).toBe(VERTEX_LAYOUT_3D);
  });
});

describe('transformGeometry', () => {
  it('moves positions by the matrix and keeps normals unit and perpendicular under scale', () => {
    const t = new Transform({ x: 1, y: 2, z: 3, scaleX: 2, scaleY: 1, scaleZ: 0.5 });
    t.setAxisAngle(0, 1, 0, Math.PI / 2);
    const g = transformGeometry(box(), t.world);
    expect(g.bounds.center[0]).toBeCloseTo(1, 5);
    expect(g.bounds.center[1]).toBeCloseTo(2, 5);
    expect(g.bounds.center[2]).toBeCloseTo(3, 5);
    // Rotated 90° about y: the x extent (2) now lies along z, the z extent (0.5) along x.
    expect(g.bounds.radius).toBeCloseTo(Math.hypot(0.25, 0.5, 1), 5);
    const v = g.vertices;
    for (let o = 0; o < v.length; o += F) {
      expect(Math.hypot(v[o + 3]!, v[o + 4]!, v[o + 5]!)).toBeCloseTo(1, 5);
      const px = v[o]! - 1;
      const py = v[o + 1]! - 2;
      const pz = v[o + 2]! - 3;
      // A box face normal still points away from the centre.
      expect(px * v[o + 3]! + py * v[o + 4]! + pz * v[o + 5]!).toBeGreaterThan(0);
      // And is axis-aligned: exactly one component is ±1.
      const axis = [v[o + 3]!, v[o + 4]!, v[o + 5]!].filter(
        (c) => Math.abs(Math.abs(c) - 1) < 1e-5,
      );
      expect(axis.length).toBe(1);
    }
  });

  it('uses the inverse transpose for a non-uniform scale', () => {
    // A slanted triangle, scaled 4× in x: the normal must stay perpendicular to the surface.
    const w = new GeometryWriter(3, 3);
    const n = Math.SQRT1_2;
    w.vertex(0, 0, 0, n, n, 0, 0, 0);
    w.vertex(1, -1, 0, n, n, 0, 1, 0);
    w.vertex(0, 0, 1, n, n, 0, 0, 1);
    w.tri(0, 1, 2);
    const g = transformGeometry(w.finish(), new Transform({ scaleX: 4 }).world);
    // Edge (4, -1, 0) must be perpendicular to the new normal.
    const nx = g.vertices[3]!;
    const ny = g.vertices[4]!;
    expect(4 * nx - ny).toBeCloseTo(0, 5);
    expect(Math.hypot(nx, ny, g.vertices[5]!)).toBeCloseTo(1, 6);
    expect(nx).toBeGreaterThan(0);
  });

  it('returns the same object, transformed in place', () => {
    const g = box();
    expect(transformGeometry(g, new Transform({ y: 5 }).world)).toBe(g);
    expect(g.bounds.center[1]).toBe(5);
  });
});

describe('tangent layout (ws/ergo-3d)', () => {
  it('mergeGeometry keeps VERTEX_LAYOUT_3D_TANGENT and bounds it', () => {
    const a = computeTangents(box());
    const b = computeTangents(box());
    const m = mergeGeometry(a, b);
    expect(m.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    expect(m.vertices.length).toBe(a.vertices.length + b.vertices.length);
    expect(m.indices.length).toBe(a.indices.length + b.indices.length);
    expect(m.bounds.radius).toBeCloseTo(a.bounds.radius, 6);
    expect(Number.isFinite(m.bounds.radius)).toBe(true);
  });

  it('transformGeometry rotates tangents, keeps them unit and perpendicular, flips w on a mirror', () => {
    const t = new Transform({ x: 3, scaleX: 2, scaleY: 1, scaleZ: 0.5 });
    t.setAxisAngle(0, 0, 1, Math.PI / 3);
    const g = transformGeometry(computeTangents(box()), t.world);
    expect(g.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    expect(g.bounds.center[0]).toBeCloseTo(3, 5);
    const v = g.vertices;
    const T = TANGENT_FLOATS;
    expect(v.length % T).toBe(0);
    for (let o = 0; o < v.length; o += T) {
      expect(Math.hypot(v[o + 12]!, v[o + 13]!, v[o + 14]!)).toBeCloseTo(1, 5);
      expect(Math.abs(v[o + 15]!)).toBe(1);
      // A box tangent lies in its face, so it stays perpendicular to the normal under an
      // axis-aligned scale followed by a rotation.
      const dot = v[o + 12]! * v[o + 3]! + v[o + 13]! * v[o + 4]! + v[o + 14]! * v[o + 5]!;
      expect(dot).toBeCloseTo(0, 5);
    }
    const before = computeTangents(box());
    const mirrored = transformGeometry(computeTangents(box()), new Transform({ scaleX: -1 }).world);
    for (let o = 0; o < mirrored.vertices.length; o += T) {
      expect(mirrored.vertices[o + 15]).toBe(-before.vertices[o + 15]!);
    }
  });
});

describe('cloneGeometry (ws/geom-3)', () => {
  it('copies every array and the bounds, sharing the layout', () => {
    const g = computeTangents(box());
    const c = cloneGeometry(g);
    expect(c.layout).toBe(g.layout);
    expect(c.vertices).toEqual(g.vertices);
    expect(c.vertices).not.toBe(g.vertices);
    expect(c.indices).toEqual(g.indices);
    expect(c.indices).not.toBe(g.indices);
    expect(c.indices.constructor).toBe(g.indices.constructor);
    expect(c.bounds).toEqual(g.bounds);
    expect(c.bounds.center).not.toBe(g.bounds.center);
    transformGeometry(c, new Transform({ x: 4 }).world);
    expect(g.bounds.center[0]).toBe(0);
    expect(g.vertices[0]).toBe(box().vertices[0]);
  });
});

describe('a custom layout with a tangent lane (ws/geom-3)', () => {
  // Position, tangent, normal, uv: the lanes in an order no built-in layout uses, found by their
  // shader locations.
  const CUSTOM: VertexLayout = {
    ...VERTEX_LAYOUT_3D_TANGENT,
    name: 'custom-tangent',
    buffer: {
      arrayStride: 64,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 13, offset: 12, format: 'float32x4' },
        { shaderLocation: 10, offset: 28, format: 'float32x3' },
        { shaderLocation: 1, offset: 40, format: 'float32x2' },
      ],
    },
  };
  /** One triangle in the xz plane: normal +y, tangent +x (w = 1). */
  const tri = (): Geometry => {
    const v = new Float32Array(3 * 16);
    const corners = [0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 3; i++) {
      v.set(corners.slice(i * 3, i * 3 + 3), i * 16);
      v.set([1, 0, 0, 1], i * 16 + 3); // tangent
      v.set([0, 1, 0], i * 16 + 7); // normal
      v.set([0.5, 0.25], i * 16 + 10); // uv
      v[i * 16 + 15] = 9; // an unused lane, left alone
    }
    return {
      vertices: v,
      indices: new Uint16Array([0, 2, 1]),
      bounds: computeBounds(v, 16),
      layout: CUSTOM,
    };
  };
  const round = (xs: (number | undefined)[]) => xs.map((x) => Math.round(x! * 1e6) / 1e6 + 0);

  it('transformGeometry rotates the tangent and normal lanes where the layout puts them', () => {
    const t = new Transform();
    t.setAxisAngle(0, 0, 1, Math.PI / 2); // +x to +y, +y to -x
    const g = transformGeometry(tri(), t.world);
    for (let o = 0; o < g.vertices.length; o += 16) {
      const v = g.vertices;
      expect(round([v[o + 3], v[o + 4], v[o + 5], v[o + 6]])).toEqual([0, 1, 0, 1]);
      expect(round([v[o + 7], v[o + 8], v[o + 9]])).toEqual([-1, 0, 0]);
      expect([v[o + 10], v[o + 11], v[o + 15]]).toEqual([0.5, 0.25, 9]);
    }
    const mirrored = transformGeometry(tri(), new Transform({ scaleZ: -1 }).world);
    expect(mirrored.vertices[6]).toBe(-1);
  });

  it('mergeGeometry keeps the layout and bounds it', () => {
    const b = transformGeometry(tri(), new Transform({ x: 10 }).world);
    const m = mergeGeometry(tri(), b);
    expect(m.layout).toBe(CUSTOM);
    expect(m.vertices.length).toBe(6 * 16);
    expect(Array.from(m.indices)).toEqual([0, 2, 1, 3, 5, 4]);
    expect(m.bounds.radius).toBeGreaterThan(5);
    expect(Number.isFinite(m.bounds.radius)).toBe(true);
  });

  it('a layout without a position at float 0 is refused by transform and unbounded by merge', () => {
    const g = { ...tri(), layout: VERTEX_LAYOUT_2D };
    expect(() => transformGeometry(g, new Transform().world)).toThrow(/xyz position at float 0/);
    expect(mergeGeometry(g).bounds.radius).toBe(Number.POSITIVE_INFINITY);
  });
});
