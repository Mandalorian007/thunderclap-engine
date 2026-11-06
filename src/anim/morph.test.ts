import { describe, expect, it } from 'vitest';
import { createMorphBlender, type MorphTarget } from './morph';

const FLOATS = 12; // x y z nx ny nz u v r g b a
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
};

/** A unit quad in the 3D layout: normals +z, uv = xy, colour (1, 0.5, 0.25, 1). */
function quad(): Float32Array {
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const out = new Float32Array(4 * FLOATS);
  for (let v = 0; v < 4; v++) {
    const o = v * FLOATS;
    out.set([pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!, 0, 0, 1], o);
    out.set([pos[v * 3]!, pos[v * 3 + 1]!, 1, 0.5, 0.25, 1], o + 6);
  }
  return out;
}

/** Target 0 lifts every vertex by 1 in z and tilts normals toward +x; target 1 pushes vertex 2 out in x. */
const targets: MorphTarget[] = [
  {
    position: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    normal: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
  },
  { position: new Float32Array([0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0]), normal: null },
];

describe('createMorphBlender', () => {
  it('writes base + Σ weight × delta into the position and normal lanes only', () => {
    const base = quad();
    const b = createMorphBlender(base, targets, { floats: FLOATS });
    expect(b.targetCount).toBe(2);
    expect(b.vertexCount).toBe(4);
    const out = new Float32Array(base.length);
    b.weights[0] = 0.5;
    b.weights[1] = 1;
    expect(b.apply(out)).toBe(true);
    // Vertex 2: (1, 1, 0) + 0.5·(0, 0, 1) + 1·(2, 0, 0) = (3, 1, 0.5).
    close(out.subarray(24, 27), [3, 1, 0.5]);
    // Normal: (0, 0, 1) + 0.5·(1, 0, 0), renormalised.
    const l = Math.hypot(0.5, 0, 1);
    close(out.subarray(27, 30), [0.5 / l, 0, 1 / l]);
    // uv and colour lanes are the base's.
    close(out.subarray(30, 36), [1, 1, 1, 0.5, 0.25, 1]);
    // Vertex 0 moved only by target 0.
    close(out.subarray(0, 3), [0, 0, 0.5]);
    // The base is untouched.
    expect(base[26]).toBe(0);
  });

  it('skips when no weight changed, writes again on a change or a new buffer', () => {
    const base = quad();
    const b = createMorphBlender(base, targets, { floats: FLOATS });
    const out = new Float32Array(base.length);
    expect(b.apply(out)).toBe(true); // first call copies the base even at zero weights
    close(out, base);
    expect(b.apply(out)).toBe(false);
    b.weights[1] = 0.25;
    expect(b.apply(out)).toBe(true);
    close(out.subarray(24, 27), [1.5, 1, 0]);
    expect(b.apply(out)).toBe(false);
    // Back to zero: a change, and the positions return to the base.
    b.weights[1] = 0;
    expect(b.apply(out)).toBe(true);
    close(out, base);
    // A different buffer gets the base copied and the current blend written.
    const other = new Float32Array(base.length);
    b.weights[0] = 1;
    expect(b.apply(other)).toBe(true);
    close(other.subarray(0, 6), [0, 0, 1, Math.SQRT1_2, 0, Math.SQRT1_2]);
    close(other.subarray(6, 12), [0, 0, 1, 0.5, 0.25, 1]);
    expect(b.apply(other)).toBe(false);
    // Returning to the first buffer writes it again (it holds a stale blend).
    expect(b.apply(out)).toBe(true);
  });

  it('shares a given weights array, honours lane offsets and a layout without normals', () => {
    const base = quad();
    const weights = new Float32Array([1, 0]);
    const b = createMorphBlender(base, targets, { floats: FLOATS }, weights);
    expect(b.weights).toBe(weights);
    const out = new Float32Array(base.length);
    b.apply(out);
    close(out.subarray(0, 3), [0, 0, 1]);
    // Positions at lane 6 (the uv/colour lanes here, for the test), no normals.
    const b2 = createMorphBlender(
      base,
      targets,
      { floats: FLOATS, positionOffset: 6, normalOffset: null },
      weights,
    );
    const out2 = new Float32Array(base.length);
    b2.apply(out2);
    close(out2.subarray(6, 9), [0, 0, 2]); // (0, 0, 1) + (0, 0, 1)
    close(out2.subarray(3, 6), [0, 0, 1]); // the normal lane is the base's
    close(out2.subarray(0, 3), [0, 0, 0]);
  });

  it('refuses short targets or weights', () => {
    const base = quad();
    expect(() =>
      createMorphBlender(base, [{ position: new Float32Array(9), normal: null }], {
        floats: FLOATS,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createMorphBlender(base, targets, { floats: FLOATS }, new Float32Array(1)),
    ).toThrow(RangeError);
    // A zero-length normal stays zero rather than NaN.
    const t: MorphTarget[] = [
      { position: null, normal: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]) },
    ];
    const b = createMorphBlender(base, t, { floats: FLOATS }, new Float32Array([1]));
    const out = new Float32Array(base.length);
    b.apply(out);
    close(out.subarray(3, 6), [0, 0, 0]);
  });
});
