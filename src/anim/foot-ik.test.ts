import { describe, expect, it } from 'vitest';
import { applyFootIk, createFootIk, type FootIk } from './foot-ik';
import { POSE_NODE_FLOATS, type Pose, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';

/**
 * Pelvis at (0, 1, 0) with two legs: hip ±0.2 on x, knee 0.5 down and 0.02 forward, ankle 0.5
 * down and 0.02 back. Feet rest on y = 0; the knees bend toward +z.
 */
function legs(): Skeleton {
  const nodes = [
    [-1, 0, 1, 0],
    [0, -0.2, 0, 0],
    [1, 0, -0.5, 0.02],
    [2, 0, -0.5, -0.02],
    [0, 0.2, 0, 0],
    [4, 0, -0.5, 0.02],
    [5, 0, -0.5, -0.02],
  ];
  const rest = new Float32Array(nodes.length * POSE_NODE_FLOATS);
  const parents = new Int16Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const o = i * POSE_NODE_FLOATS;
    parents[i] = nodes[i]![0]!;
    rest[o] = nodes[i]![1]!;
    rest[o + 1] = nodes[i]![2]!;
    rest[o + 2] = nodes[i]![3]!;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents, rest };
}
const FEET = [
  { root: 1, mid: 2, tip: 3 },
  { root: 4, mid: 5, tip: 6 },
];

function world(skeleton: Skeleton, pose: Pose): Float32Array {
  const w = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, pose, w);
  return w;
}
const at = (w: Float32Array, node: number) => [
  w[node * WORLD_NODE_FLOATS + 3]!,
  w[node * WORLD_NODE_FLOATS + 7]!,
  w[node * WORLD_NODE_FLOATS + 11]!,
];

/** Run `frames` frames from the rest pose, as a mixer would resample it; return the last pose. */
function run(sk: Skeleton, ik: FootIk, frames: number, instance: Float32Array | null = null) {
  let pose = sk.rest.slice();
  for (let i = 0; i < frames; i++) {
    pose = sk.rest.slice();
    applyFootIk(pose, sk, world(sk, pose), ik, instance, 1 / 60);
  }
  return pose;
}

describe('foot placement', () => {
  const sk = legs();

  it('leaves the pose untouched on flat ground at the floor', () => {
    let calls = 0;
    const ik = createFootIk(sk, {
      feet: FEET,
      pelvis: 0,
      probe: (_x, _z, out) => {
        calls++;
        out[0] = 0;
        out[1] = 0;
        out[2] = 1;
        out[3] = 0;
        return true;
      },
    });
    const pose = run(sk, ik, 3);
    expect(Array.from(pose)).toEqual(Array.from(sk.rest));
    expect(ik.pelvisOffset).toBe(0);
    expect(calls).toBe(6);
    // A probe that misses is a no-op too.
    const miss = createFootIk(sk, { feet: FEET, pelvis: 0, probe: () => false });
    expect(Array.from(run(sk, miss, 1))).toEqual(Array.from(sk.rest));
  });

  it('drops the pelvis to the lower foot, plants both feet and bends the knees forward', () => {
    const ik = createFootIk(sk, {
      feet: FEET,
      pelvis: 0,
      blend: 30,
      probe: (x, _z, out) => {
        out[0] = x < 0 ? -0.2 : 0;
        out[1] = 0;
        out[2] = 1;
        out[3] = 0;
        return true;
      },
    });
    const first = run(sk, ik, 1);
    // Smoothed: one frame moves only part of the way.
    expect(ik.pelvisOffset).toBeLessThan(0);
    expect(ik.pelvisOffset).toBeGreaterThan(-0.2);
    expect(at(world(sk, first), 0)[1]).toBeCloseTo(1 + ik.pelvisOffset, 5);

    const pose = run(sk, ik, 90);
    expect(ik.pelvisOffset).toBeCloseTo(-0.2, 3);
    expect(ik.lift[0]).toBeCloseTo(-0.2, 6);
    expect(ik.lift[1]).toBe(0);
    const w = world(sk, pose);
    expect(at(w, 0)[1]).toBeCloseTo(0.8, 3);
    expect(at(w, 3)[1]).toBeCloseTo(-0.2, 3);
    expect(at(w, 6)[1]).toBeCloseTo(0, 3);
    expect(at(w, 3)[0]).toBeCloseTo(-0.2, 3);
    expect(at(w, 6)[0]).toBeCloseTo(0.2, 3);
    // The right leg spans 0.8 with two 0.5 bones: the knee comes forward, the left stays.
    expect(at(w, 5)[2]).toBeGreaterThan(0.25);
    expect(at(w, 2)[2]).toBeCloseTo(0.02, 2);
  });

  it('clamps the drop and lift, tilts the foot onto the normal and reads instance space', () => {
    const ik = createFootIk(sk, {
      feet: FEET,
      pelvis: 0,
      maxDrop: 0.1,
      maxLift: 0.05,
      blend: 1000,
      probe: (x, _z, out) => {
        out[0] = x < 2 ? 0.5 : 1.3;
        out[1] = 0;
        out[2] = Math.SQRT1_2;
        out[3] = Math.SQRT1_2;
        return true;
      },
    });
    // The instance stands at (2, 1, 0): the floor is y = 1, the left foot probes x = 1.8.
    const instance = new Float32Array([1, 0, 0, 2, 0, 1, 0, 1, 0, 0, 1, 0]);
    const pose = run(sk, ik, 2);
    void pose;
    const p2 = run(sk, ik, 2, instance);
    expect(ik.lift[0]).toBeCloseTo(-0.1, 6);
    expect(ik.lift[1]).toBeCloseTo(0.05, 6);
    expect(ik.pelvisOffset).toBeCloseTo(-0.1, 4);
    const w = world(sk, p2);
    expect(at(w, 3)[1]).toBeCloseTo(-0.1, 3);
    expect(at(w, 6)[1]).toBeCloseTo(0.05, 3);
    // Ankle +y now follows the 45° normal.
    const o = 6 * WORLD_NODE_FLOATS;
    expect(w[o + 5]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(w[o + 9]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('validates', () => {
    expect(() => createFootIk(sk, { feet: [], pelvis: 0, probe: () => false })).toThrow(/foot/);
    expect(() => createFootIk(sk, { feet: FEET, pelvis: 9, probe: () => false })).toThrow(/pelvis/);
    expect(() =>
      createFootIk(sk, { feet: [{ ...FEET[0]!, bend: [0, 0, 0] }], pelvis: 0, probe: () => false }),
    ).toThrow(/bend/);
  });
});
