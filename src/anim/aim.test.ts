import { describe, expect, it } from 'vitest';
import { applyAimOffset, createAimOffset } from './aim';
import { POSE_NODE_FLOATS, type Pose, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';

/** A spine along +Y: node i at (0, i, 0) under node i-1; forward is +Z. */
function spine(nodes = 3): Skeleton {
  const rest = new Float32Array(nodes * POSE_NODE_FLOATS);
  const parents = new Int16Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    parents[i] = i - 1;
    rest[o + 1] = i === 0 ? 0 : 1;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents, rest };
}

function world(skeleton: Skeleton, pose: Pose): Float32Array {
  const w = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, pose, w);
  return w;
}

/** The world +Z of `node`. */
function forwardOf(w: Float32Array, node: number): number[] {
  const o = node * WORLD_NODE_FLOATS;
  return [w[o + 2]!, w[o + 6]!, w[o + 10]!];
}

/** Angle (radians) of the local rotation of `node` in `pose`. */
function localAngle(pose: Pose, node: number): number {
  const o = node * POSE_NODE_FLOATS + 3;
  return 2 * Math.acos(Math.min(1, Math.abs(pose[o + 3]!)));
}

const angleTo = (f: number[], t: number[]) => {
  const len = Math.hypot(t[0]!, t[1]!, t[2]!);
  const dot = (f[0]! * t[0]! + f[1]! * t[1]! + f[2]! * t[2]!) / len;
  return Math.acos(Math.min(1, Math.max(-1, dot)));
};

describe('aim offset', () => {
  const sk = spine();

  it('turns the chain so the head forward reaches a target inside the clamps', () => {
    const pose = sk.rest.slice();
    const w = world(sk, pose);
    const aim = createAimOffset(sk, { joints: [0, 1, 2], maxYaw: Math.PI / 2, maxPitch: 1 });
    applyAimOffset(pose, sk, w, aim, [1000, 2 + 500, 1000], null);
    expect(aim.yaw).toBeCloseTo(Math.PI / 4, 5);
    expect(aim.pitch).toBeCloseTo(Math.atan2(500, Math.SQRT2 * 1000), 5);
    const after = world(sk, pose);
    const head = after.subarray(2 * WORLD_NODE_FLOATS);
    const to = [1000 - head[3]!, 502 - head[7]!, 1000 - head[11]!];
    expect(angleTo(forwardOf(after, 2), to)).toBeLessThan(0.01);
    // Every joint turned by a third, and the spine base kept its position.
    for (let j = 0; j < 3; j++) expect(localAngle(pose, j)).toBeCloseTo(localAngle(pose, 0), 4);
    expect(after[3]).toBe(0);
  });

  it('clamps yaw and pitch and reports the clamped values', () => {
    const pose = sk.rest.slice();
    const aim = createAimOffset(sk, { joints: [0, 1, 2], maxYaw: 0.5, maxPitch: 0.4 });
    applyAimOffset(pose, sk, world(sk, pose), aim, [0, 2, -1000], null);
    expect(Math.abs(aim.yaw)).toBeCloseTo(0.5, 6);
    expect(aim.pitch).toBeCloseTo(0, 6);
    const yawed = forwardOf(world(sk, pose), 2);
    expect(angleTo(yawed, [0, 0, 1])).toBeCloseTo(0.5, 4);
    const pose2 = sk.rest.slice();
    applyAimOffset(pose2, sk, world(sk, pose2), aim, [0, 1000, 2], null);
    expect(aim.pitch).toBeCloseTo(0.4, 6);
    const pitched = forwardOf(world(sk, pose2), 2);
    expect(pitched[1]).toBeCloseTo(Math.sin(0.4), 4);
    expect(pitched[0]).toBeCloseTo(0, 5);
  });

  it('distributes the turn by weight, blends by `weight` and reads world targets', () => {
    const pose = sk.rest.slice();
    const aim = createAimOffset(sk, { joints: [0, 2], weights: [1, 3] });
    applyAimOffset(pose, sk, world(sk, pose), aim, [1000, 2, 1000], null);
    expect(localAngle(pose, 0)).toBeCloseTo(Math.PI / 16, 4);
    expect(localAngle(pose, 1)).toBe(0);
    expect(localAngle(pose, 2)).toBeCloseTo((3 * Math.PI) / 16, 4);
    expect(angleTo(forwardOf(world(sk, pose), 2), [1, 0, 1])).toBeLessThan(0.01);

    const half = sk.rest.slice();
    applyAimOffset(half, sk, world(sk, half), aim, [1000, 2, 1000], null, { weight: 0.5 });
    expect(localAngle(half, 2)).toBeCloseTo((3 * Math.PI) / 32, 4);

    // The instance sits at x = 5 turned 90° about y: a world target at +x is straight ahead.
    const instance = new Float32Array([0, 0, 1, 5, 0, 1, 0, 0, -1, 0, 0, 0]);
    const inst = sk.rest.slice();
    applyAimOffset(inst, sk, world(sk, inst), aim, [1005, 2, 0], instance);
    expect(aim.yaw).toBeCloseTo(0, 5);
    expect(aim.pitch).toBeCloseTo(0, 5);
    expect(Array.from(inst)).toEqual(Array.from(sk.rest));
  });

  it('validates the chain', () => {
    expect(() => createAimOffset(sk, { joints: [] })).toThrow(/at least one/);
    expect(() => createAimOffset(sk, { joints: [2, 0] })).toThrow(/descend/);
    expect(() => createAimOffset(sk, { joints: [0, 1], weights: [0, 0] })).toThrow(/sum/);
    expect(() => createAimOffset(sk, { joints: [5] })).toThrow(/joint 5/);
  });
});
