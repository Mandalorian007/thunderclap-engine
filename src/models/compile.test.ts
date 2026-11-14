import { describe, expect, it } from 'vitest';
import { box as geomBox, sphere } from '../geom/primitives';
import { MODEL_VERTEX_FLOATS, ModelBuilder } from './builder';
import {
  channelOf,
  compileModel,
  evaluateUnit,
  MOTION_KIND,
  materialCode,
  materialConstName,
} from './compile';
import type { MaterialCodeTable, PartModel } from './spec';
import { materialConstantsWgsl, modelShaderWgsl } from './wgsl';

const MATS: MaterialCodeTable = {
  stone: { color: [0.5, 0.5, 0.5] },
  wood: { color: [0.6, 0.4, 0.2] },
  'hot metal': { color: [0.8, 0.3, 0.1], emissive: [4, 1.5, 0.2] },
};

type Tri = { c: number[]; n: number[]; w: number[] };

/** Every triangle of packed vertices: centroid, stored normal (vertex 0) and winding normal. */
function triangles(v: Float32Array): Tri[] {
  const out: Tri[] = [];
  const F = MODEL_VERTEX_FLOATS;
  for (let i = 0; i < v.length; i += 3 * F) {
    const p = [0, 1, 2].map((k) => [v[i + k * F]!, v[i + k * F + 1]!, v[i + k * F + 2]!]);
    const c = [0, 1, 2].map((a) => (p[0]![a]! + p[1]![a]! + p[2]![a]!) / 3);
    const u = [0, 1, 2].map((a) => p[1]![a]! - p[0]![a]!);
    const t = [0, 1, 2].map((a) => p[2]![a]! - p[0]![a]!);
    const w = [
      u[1]! * t[2]! - u[2]! * t[1]!,
      u[2]! * t[0]! - u[0]! * t[2]!,
      u[0]! * t[1]! - u[1]! * t[0]!,
    ];
    out.push({ c, n: [v[i + 4]!, v[i + 5]!, v[i + 6]!], w });
  }
  return out;
}

const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

/** Each triangle faces away from `center`: its stored normal and its winding (counter-clockwise from outside). */
function facesOutward(v: Float32Array, center: number[]): void {
  const tris = triangles(v);
  expect(tris.length).toBeGreaterThan(0);
  for (const t of tris) {
    const out = sub(t.c, center);
    expect(dot(t.n, out)).toBeGreaterThan(0);
    expect(dot(t.w, out)).toBeGreaterThan(0);
  }
}

describe('ModelBuilder shapes', () => {
  it('boxes, cylinders, gears, prisms, frustums and wedges face outward', () => {
    const b = new ModelBuilder();
    b.box([-1, -1, -1], [1, 2, 1], 0);
    facesOutward(b.done(), [0, 0.5, 0]);
    for (const axis of [0, 1, 2] as const) {
      b.cylinder([0, 0, 0], axis, 1, 1, 12, 0);
      facesOutward(b.done(), [0, 0, 0]);
      b.cylinder([0, 0, 0], axis, 1, 1, 5, 0);
      facesOutward(b.done(), [0, 0, 0]);
      b.gear([0, 0, 0], axis, 1, 0.8, 8, 0.2, 0);
      facesOutward(b.done(), [0, 0, 0]);
      b.extrude([0, 0, 0], axis, [1, 0.5, 1, 0.5, 1, 0.5], 0.3, 0);
      facesOutward(b.done(), [0, 0, 0]);
    }
    b.frustum(0, 0, 0, 2, 2, 1, 0);
    facesOutward(b.done(), [0, 1, 0]);
    b.wedge([-1, 0, -1], [1, 1, 1], 0);
    facesOutward(b.done(), [0, 0.3, 0]);
    for (const g of [geomBox({ size: 1 }), sphere({ radius: 1 })]) {
      b.mesh(g.vertices, g.indices, g.layout.floats, 0);
      facesOutward(b.done(), [0, 0, 0]);
    }
  });

  it('a ring faces away from its middle on the outside and toward its axis inside', () => {
    const b = new ModelBuilder();
    b.ring([0, 0, 0], 1, 0.5, 1, 0.1, 16, 0);
    for (const t of triangles(b.done())) {
      expect(Math.hypot(t.w[0]!, t.w[1]!, t.w[2]!)).toBeGreaterThan(0);
      const radial = Math.hypot(t.c[0]!, t.c[2]!);
      if (Math.abs(t.n[1]!) > 0.9) {
        expect(Math.sign(t.n[1]!)).toBe(Math.sign(t.c[1]!));
      } else if (radial > 0.75) {
        expect(dot(t.n, [t.c[0]!, 0, t.c[2]!])).toBeGreaterThan(0);
      } else {
        expect(dot(t.n, [t.c[0]!, 0, t.c[2]!])).toBeLessThan(0);
      }
      expect(dot(t.n, t.w)).toBeGreaterThan(0);
    }
  });

  it('turns about a pivot and moves under the stack', () => {
    const b = new ModelBuilder();
    b.rotated(1, Math.PI / 2, [1, 0, 0], () =>
      b.moved([0, 0, 1], () => b.box([0, 0, 0], [0.001, 0.001, 0.001], 0)),
    );
    const v = b.done();
    // (0,0,1) about y through (1,0,0) by 90°: (1,0,0) + R((-1,0,1)) = (1,0,0) + (1,0,1) = (2,0,1).
    expect(v[0]).toBeCloseTo(2, 2);
    expect(v[2]).toBeCloseTo(1, 2);
  });
});

const MILL: PartModel = {
  name: 'mill',
  channels: [{ name: 'spin', wrap: Math.PI * 2 }, 'heat'],
  parts: [
    {
      name: 'tower',
      material: 'stone',
      shape: { type: 'frustum', center: [0, 0, 0], bottom: 1, top: 0.6, height: 2 },
    },
    {
      name: 'roof',
      material: 'wood',
      shape: { type: 'wedge', from: [-0.4, 2, -0.4], to: [0.4, 2.5, 0.4] },
    },
    {
      name: 'sails',
      material: 'wood',
      motion: { type: 'spin', axis: 'z', pivot: [0, 2, 0.5], channel: 'spin' },
      parts: [
        { shape: { type: 'cylinder', center: [0, 2, 0.5], axis: 'z', radius: 0.08, length: 0.2 } },
        {
          shape: { type: 'box', from: [-0.05, 2, 0.55], to: [0.05, 3.2, 0.6] },
          repeat: { count: 4, turn: { axis: 'z', angle: Math.PI / 2, pivot: [0, 2, 0.5] } },
        },
      ],
    },
    {
      name: 'lamp',
      material: 'hot metal',
      glow: { channel: 'heat', scale: 2, max: 1.5 },
      shape: { type: 'box', from: [-0.1, 1, 0.5], to: [0.1, 1.2, 0.6] },
    },
    {
      material: 'stone',
      color: 'instance',
      shape: { type: 'geometry', geometry: geomBox({ size: 0.2 }) },
      move: [0.6, 0.1, 0],
    },
  ],
};

describe('compileModel', () => {
  it('packs a static unit, then one per moving or glowing part', () => {
    const m = compileModel(MILL, MATS);
    expect(m.units.map((u) => u.name)).toEqual(['mill/static', 'mill/sails', 'mill/lamp']);
    let next = 0;
    for (const u of m.units) {
      expect(u.owner).toBe(m);
      expect(u.count % 3).toBe(0);
      expect(u.count).toBeGreaterThan(0);
      expect(u.first).toBe(next);
      next += u.count;
    }
    expect(m.verts.length).toBe(next * MODEL_VERTEX_FLOATS);
    for (const x of m.verts) expect(Number.isFinite(x)).toBe(true);
    // The tallest sail reaches y 3.2 when up; its unit's radius holds it turned any way.
    expect(m.units[1]!.radius).toBeGreaterThan(3.2);
    expect(m.radius).toBe(Math.max(...m.units.map((u) => u.radius)));
  });

  it('is a pure function of the spec and the table', () => {
    const a = compileModel(MILL, MATS);
    const b = compileModel(MILL, MATS);
    expect(Array.from(b.verts)).toEqual(Array.from(a.verts));
    expect(b.units.map((u) => Array.from(u.row))).toEqual(a.units.map((u) => Array.from(u.row)));
  });

  it('codes materials by declaration order and inherits them down the tree', () => {
    const m = compileModel(MILL, MATS);
    expect(materialCode(MATS, 'wood')).toBe(1);
    const sails = m.units[1]!;
    for (let i = sails.first; i < sails.first + sails.count; i++) {
      expect(m.verts[i * MODEL_VERTEX_FLOATS + 3]).toBe(1);
    }
    // The instance-coloured geometry part: colour mode 2.
    const modes = new Set<number>();
    const st = m.units[0]!;
    for (let i = st.first; i < st.first + st.count; i++)
      modes.add(m.verts[i * MODEL_VERTEX_FLOATS + 11]!);
    expect([...modes].sort()).toEqual([0, 2]);
    expect(materialConstName('hot metal')).toBe('MODEL_MAT_HOT_METAL');
    expect(materialConstantsWgsl(MATS)).toContain('const MODEL_MAT_HOT_METAL: u32 = 2u;');
  });

  it('every unit radius bounds its vertices at every pose', () => {
    const m = compileModel(MILL, MATS);
    for (const u of m.units) {
      for (let k = 0; k < 16; k++) {
        const pose = evaluateUnit(u, [k * 0.4, k * 0.1]);
        const r = u.row;
        const axis = r[1]!;
        const piv = [r[4]!, r[5]!, r[6]!];
        for (let i = u.first; i < u.first + u.count; i++) {
          const o = i * MODEL_VERTEX_FLOATS;
          const p = [m.verts[o]! - piv[0]!, m.verts[o + 1]! - piv[1]!, m.verts[o + 2]! - piv[2]!];
          const c = Math.cos(pose.angle);
          const s = Math.sin(pose.angle);
          const a = (axis + 1) % 3;
          const b = (axis + 2) % 3;
          const q = [...p];
          q[a] = c * p[a]! - s * p[b]!;
          q[b] = s * p[a]! + c * p[b]!;
          q[axis] = q[axis]! + pose.offset;
          const d = Math.hypot(q[0]! + piv[0]!, q[1]! + piv[1]!, q[2]! + piv[2]!);
          expect(d).toBeLessThanOrEqual(u.radius + 1e-5);
        }
      }
    }
  });

  it('evaluates motions and glows as the shader does', () => {
    const spec: PartModel = {
      name: 'm',
      channels: [{ name: 'a', wrap: 10 }, 'b'],
      parts: [
        {
          name: 'spin',
          motion: { type: 'spin', axis: 'y', channel: 'a', ratio: 2 },
          shape: { type: 'box', from: [0, 0, 0], to: [1, 1, 1] },
        },
        {
          name: 'swing',
          motion: { type: 'swing', axis: 'x', channel: 'b', amplitude: 0.5, phase: 1 },
          shape: { type: 'box', from: [0, 0, 0], to: [1, 1, 1] },
        },
        {
          name: 'hinge',
          motion: { type: 'hinge', axis: 'z', channel: 'b', from: 0, to: 2 },
          shape: { type: 'box', from: [0, 0, 0], to: [1, 1, 1] },
        },
        {
          name: 'slide',
          motion: { type: 'slide', axis: 'y', channel: 'b', from: -1, to: 1 },
          shape: { type: 'box', from: [0, 0, 0], to: [1, 1, 1] },
        },
        {
          name: 'bob',
          motion: { type: 'bob', axis: 'y', channel: 'b', amplitude: 0.25 },
          glow: 0.7,
          shape: { type: 'box', from: [0, 0, 0], to: [1, 1, 1] },
        },
      ],
    };
    const m = compileModel(spec, MATS);
    const [spin, swing, hinge, slide, bob] = m.units;
    expect(spin!.row[0]).toBe(MOTION_KIND.SPIN);
    expect(evaluateUnit(spin!, [13, 0]).angle).toBeCloseTo(6); // 13 wraps to 3, × ratio 2
    expect(evaluateUnit(swing!, [0, 0.5]).angle).toBeCloseTo(0.5 * Math.sin(1.5));
    expect(evaluateUnit(hinge!, [0, 2]).angle).toBe(2); // clamped
    expect(evaluateUnit(slide!, [0, 0.25]).offset).toBeCloseTo(-0.5);
    const p = evaluateUnit(bob!, [0, Math.PI / 2]);
    expect(p.offset).toBeCloseTo(0.25);
    expect(p.glow).toBeCloseTo(0.7);
    expect(evaluateUnit(spin!, [0, 0]).glow).toBe(0);
    expect(channelOf(m, 'b')).toBe(1);
    const lamp = compileModel(MILL, MATS).units[2]!;
    expect(evaluateUnit(lamp, [0, 0.5]).glow).toBe(1);
    expect(evaluateUnit(lamp, [0, 5]).glow).toBe(1.5);
  });

  it('rejects unknown materials and channels, nested motion and too many channels', () => {
    const box = { type: 'box', from: [0, 0, 0], to: [1, 1, 1] } as const;
    expect(() =>
      compileModel({ name: 'x', parts: [{ material: 'gold', shape: box }] }, MATS),
    ).toThrow(/unknown material 'gold'/);
    expect(() =>
      compileModel(
        {
          name: 'x',
          parts: [{ motion: { type: 'spin', axis: 'y', channel: 'nope' }, shape: box }],
        },
        MATS,
      ),
    ).toThrow(/unknown channel 'nope'/);
    expect(() =>
      compileModel(
        {
          name: 'x',
          channels: ['a'],
          parts: [{ parts: [{ motion: { type: 'spin', axis: 'y', channel: 'a' }, shape: box }] }],
        },
        MATS,
      ),
    ).toThrow(/top-level parts only/);
    expect(() =>
      compileModel({ name: 'x', channels: ['a', 'b', 'c', 'd', 'e'], parts: [] }, MATS),
    ).toThrow(/at most 4/);
    expect(() => compileModel({ name: 'x', parts: [] }, {})).toThrow(/empty/);
  });

  it('builds one shader with the game shade function and material constants', () => {
    const code = modelShaderWgsl(
      MATS,
      'fn model_shade(s: ModelSurface) -> ModelShaded { return ModelShaded(s.base, vec3f(0.0)); }',
    );
    expect(code).toContain('MODEL_MAT_WOOD');
    expect(code).toContain('fn vs(');
    expect(code).not.toMatch(/\boverride\b/);
    expect(code.match(/fn model_shade/g)?.length).toBe(1);
  });
});
