import { describe, expect, it } from 'vitest';
import { createIkChain, lookAt, twoBoneIk } from './ik';
import {
  copyPose,
  createPose,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  type Skeleton,
  WORLD_NODE_FLOATS,
} from './pose';
import { quatFromAxisAngle } from './quat';

/**
 * A chain along +X: node 0 at the origin, each next node one unit further along its parent's X.
 * `extra` nodes are appended as children of the last one (used as a head / look joint when
 * `extra` is given a parent of its own).
 */
function arm(nodes = 3, parents?: number[]): Skeleton {
  const rest = new Float32Array(nodes * POSE_NODE_FLOATS);
  const par = new Int16Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    par[i] = parents ? parents[i]! : i - 1;
    rest[o] = par[i]! < 0 ? 0 : 1;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents: par, rest };
}

function worldOf(skeleton: Skeleton, pose: Pose): Float32Array {
  const w = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, pose, w);
  return w;
}
const pos = (w: Float32Array, node: number): number[] => [
  w[node * WORLD_NODE_FLOATS + 3]!,
  w[node * WORLD_NODE_FLOATS + 7]!,
  w[node * WORLD_NODE_FLOATS + 11]!,
];
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Solve and resolve: returns the world matrices after IK. */
function solve(
  skeleton: Skeleton,
  pose: Pose,
  chain: { root: number; mid: number; tip: number },
  target: number[],
  pole: number[] | null,
  instance: Float32Array | null = null,
  opts?: { weight?: number; maxIterations?: number },
): Float32Array {
  const world = worldOf(skeleton, pose);
  twoBoneIk(pose, skeleton, world, chain, target, pole, instance, opts);
  return worldOf(skeleton, pose);
}

describe('twoBoneIk', () => {
  const chain = { root: 0, mid: 1, tip: 2 };

  it('reaches a reachable target within 1e-4', () => {
    const sk = arm();
    const pose = createPose(sk);
    const target = [1.2, 0.8, 0.3];
    const w = solve(sk, pose, chain, target, [0, 1, 0]);
    expect(dist(pos(w, 2), target)).toBeLessThan(1e-4);
    // Bone lengths are preserved.
    expect(dist(pos(w, 0), pos(w, 1))).toBeCloseTo(1, 5);
    expect(dist(pos(w, 1), pos(w, 2))).toBeCloseTo(1, 5);
    // Scale and translation untouched.
    expect(pose[1 * POSE_NODE_FLOATS]).toBe(1);
    expect(pose[1 * POSE_NODE_FLOATS + 7]).toBe(1);
  });

  it('points a straight chain at an unreachable target', () => {
    const sk = arm();
    const pose = createPose(sk);
    const w = solve(sk, pose, chain, [0, 5, 0], [0, 0, 1]);
    expect(dist(pos(w, 2), [0, 2, 0])).toBeLessThan(1e-3);
    expect(dist(pos(w, 1), [0, 1, 0])).toBeLessThan(1e-3);
  });

  it('the pole vector picks the bend side', () => {
    const sk = arm();
    const up = createPose(sk);
    const wUp = solve(sk, up, chain, [1.5, 0, 0], [0, 1, 0]);
    expect(pos(wUp, 1)[1]).toBeGreaterThan(0.3);
    expect(dist(pos(wUp, 2), [1.5, 0, 0])).toBeLessThan(1e-4);
    const down = createPose(sk);
    const wDown = solve(sk, down, chain, [1.5, 0, 0], [0, -1, 0]);
    expect(pos(wDown, 1)[1]).toBeLessThan(-0.3);
    expect(dist(pos(wDown, 2), [1.5, 0, 0])).toBeLessThan(1e-4);
    const side = createPose(sk);
    const wSide = solve(sk, side, chain, [1.5, 0, 0], [0, 0, 1]);
    expect(pos(wSide, 1)[2]).toBeGreaterThan(0.3);
  });

  it('without a pole the chain keeps its current bend plane', () => {
    const sk = arm();
    const pose = createPose(sk);
    // Bend the elbow 90° about +Z: tip goes to (1, 1, 0), bend plane XY, mid on +X side.
    quatFromAxisAngle(pose, POSE_NODE_FLOATS + 3, 0, 0, 1, Math.PI / 2);
    const w = solve(sk, pose, chain, [1.5, 0.5, 0], null);
    expect(dist(pos(w, 2), [1.5, 0.5, 0])).toBeLessThan(1e-4);
    expect(Math.abs(pos(w, 1)[2]!)).toBeLessThan(1e-4);
  });

  it('weight 0 leaves the pose; weight 0.5 goes half way', () => {
    const sk = arm();
    const pose = createPose(sk);
    const before = new Float32Array(pose);
    solve(sk, pose, chain, [1.2, 0.8, 0], [0, 1, 0], null, { weight: 0 });
    expect(Array.from(pose)).toEqual(Array.from(before));
    const half = createPose(sk);
    const w = solve(sk, half, chain, [1.2, 0.8, 0], [0, 1, 0], null, { weight: 0.5 });
    const err = dist(pos(w, 2), [1.2, 0.8, 0]);
    expect(err).toBeGreaterThan(0.05);
    expect(err).toBeLessThan(dist([2, 0, 0], [1.2, 0.8, 0]));
  });

  it('takes the target through the instance matrix', () => {
    const sk = arm();
    const pose = createPose(sk);
    // Instance: rotate 90° about Y then translate by (10, 0, 0) (3×4 row-major).
    const inst = new Float32Array([0, 0, 1, 10, 0, 1, 0, 0, -1, 0, 0, 0]);
    const skelTarget = [1.2, 0.8, 0.3];
    const worldTarget = [
      inst[0]! * skelTarget[0]! + inst[1]! * skelTarget[1]! + inst[2]! * skelTarget[2]! + inst[3]!,
      inst[4]! * skelTarget[0]! + inst[5]! * skelTarget[1]! + inst[6]! * skelTarget[2]! + inst[7]!,
      inst[8]! * skelTarget[0]! +
        inst[9]! * skelTarget[1]! +
        inst[10]! * skelTarget[2]! +
        inst[11]!,
    ];
    const w = solve(sk, pose, chain, worldTarget, [10, 1, 0], inst);
    expect(dist(pos(w, 2), skelTarget)).toBeLessThan(1e-4);
  });

  it('works under a moving parent and across an intermediate twist node', () => {
    // 0 pelvis (rotated, offset), 1 root, 2 twist, 3 mid, 4 tip.
    const sk = arm(5);
    const pose = createPose(sk);
    pose[0] = 0.5;
    pose[1] = 2;
    quatFromAxisAngle(pose, 3, 0, 1, 0, 0.7);
    const ikChain = createIkChain(sk, { root: 1, mid: 3, tip: 4 });
    expect(Array.from(ikChain.path)).toEqual([1, 2, 3, 4]);
    const world0 = worldOf(sk, pose);
    const root = pos(world0, 1);
    const target = [root[0]! + 0.9, root[1]! + 1.1, root[2]! - 0.6];
    const w = solve(sk, pose, ikChain, target, [root[0]!, root[1]! + 3, root[2]!]);
    expect(dist(pos(w, 4), target)).toBeLessThan(1e-4);
    // The twist node kept its local transform.
    expect(pose[2 * POSE_NODE_FLOATS + 6]).toBe(1);
  });

  it('a second iteration refines a non-uniformly scaled chain', () => {
    const sk = arm();
    const pose = createPose(sk);
    pose[7] = 1;
    pose[8] = 2;
    pose[9] = 0.5;
    const target = [1.0, 1.0, 0.2];
    const one = solve(sk, createPose(sk), chain, target, [0, 1, 0], null, { maxIterations: 1 });
    const oneScaled = solve(sk, pose, chain, target, [0, 1, 0], null, { maxIterations: 1 });
    expect(dist(pos(one, 2), target)).toBeLessThan(1e-4);
    const pose2 = createPose(sk);
    pose2[7] = 1;
    pose2[8] = 2;
    pose2[9] = 0.5;
    const two = solve(sk, pose2, chain, target, [0, 1, 0], null, { maxIterations: 4 });
    expect(dist(pos(two, 2), target)).toBeLessThanOrEqual(dist(pos(oneScaled, 2), target));
  });

  it('createIkChain rejects a chain that is not root → mid → tip', () => {
    const sk = arm(4, [-1, 0, 0, 2]);
    expect(() => createIkChain(sk, { root: 1, mid: 2, tip: 3 })).toThrow(/descend/);
    expect(() => createIkChain(sk, { root: 0, mid: 1, tip: 3 })).toThrow(/between/);
    expect(() => createIkChain(sk, { root: 0, mid: 2, tip: 9 })).toThrow(/in \[0, 4\)/);
  });

  it('caches a chain per plain description object and does not resize it', () => {
    const sk = arm();
    const desc = { root: 0, mid: 1, tip: 2 };
    const pose = createPose(sk);
    solve(sk, pose, desc, [1.2, 0.8, 0], [0, 1, 0]);
    copyPose(sk.rest, pose);
    solve(sk, pose, desc, [1.2, 0.8, 0], [0, 1, 0]);
    const w = worldOf(sk, pose);
    expect(dist(pos(w, 2), [1.2, 0.8, 0])).toBeLessThan(1e-4);
  });
});

describe('lookAt', () => {
  /** The joint's forward (+Z) in skeleton space. */
  function forward(w: Float32Array, node: number): number[] {
    const o = node * WORLD_NODE_FLOATS;
    return [w[o + 2]!, w[o + 6]!, w[o + 10]!];
  }
  const angleTo = (f: number[], t: number[]) => {
    const cx = f[1]! * t[2]! - f[2]! * t[1]!;
    const cy = f[2]! * t[0]! - f[0]! * t[2]!;
    const cz = f[0]! * t[1]! - f[1]! * t[0]!;
    return Math.atan2(Math.hypot(cx, cy, cz), f[0]! * t[0]! + f[1]! * t[1]! + f[2]! * t[2]!);
  };

  it('turns the forward axis onto the target', () => {
    const sk = arm(2);
    const pose = createPose(sk);
    const world = worldOf(sk, pose);
    const target = [3, 1, -2];
    lookAt(pose, sk, world, 1, target, null);
    const w = worldOf(sk, pose);
    const to = [target[0]! - 1, target[1]!, target[2]!];
    expect(angleTo(forward(w, 1), to)).toBeLessThan(1e-5);
    // Translation untouched.
    expect(pose[POSE_NODE_FLOATS]).toBe(1);
  });

  it('maxAngle clamps the turn', () => {
    const sk = arm(1);
    const pose = createPose(sk);
    const world = worldOf(sk, pose);
    lookAt(pose, sk, world, 0, [1, 0, 0], null, { maxAngle: Math.PI / 4 });
    const w = worldOf(sk, pose);
    expect(angleTo(forward(w, 0), [1, 0, 0])).toBeCloseTo(Math.PI / 4, 5);
    expect(angleTo(forward(w, 0), [0, 0, 1])).toBeCloseTo(Math.PI / 4, 5);
  });

  it('weight 0 leaves the pose, weight 0.5 turns half way', () => {
    const sk = arm(1);
    const pose = createPose(sk);
    const before = new Float32Array(pose);
    lookAt(pose, sk, worldOf(sk, pose), 0, [1, 0, 0], null, { weight: 0 });
    expect(Array.from(pose)).toEqual(Array.from(before));
    lookAt(pose, sk, worldOf(sk, pose), 0, [1, 0, 0], null, { weight: 0.5 });
    expect(angleTo(forward(worldOf(sk, pose), 0), [1, 0, 0])).toBeCloseTo(Math.PI / 4, 4);
  });

  it('a custom forward axis and a rotated parent', () => {
    const sk = arm(2);
    const pose = createPose(sk);
    quatFromAxisAngle(pose, 3, 0, 1, 0, 1.1);
    const world = worldOf(sk, pose);
    const target = [2, 2, 2];
    lookAt(pose, sk, world, 1, target, null, { forward: [1, 0, 0] });
    const w = worldOf(sk, pose);
    const o = WORLD_NODE_FLOATS;
    const fx = [w[o]!, w[o + 4]!, w[o + 8]!];
    const p = pos(w, 1);
    expect(angleTo(fx, [target[0]! - p[0]!, target[1]! - p[1]!, target[2]! - p[2]!])).toBeLessThan(
      1e-5,
    );
  });

  it('the up hint keeps the joint from rolling', () => {
    const sk = arm(1);
    // Look far to the side and up: without a hint the minimal rotation tilts the local Y.
    const a = createPose(sk);
    lookAt(a, sk, worldOf(sk, a), 0, [1, 0.6, -0.3], null);
    const b = createPose(sk);
    lookAt(b, sk, worldOf(sk, b), 0, [1, 0.6, -0.3], null, { up: [0, 1, 0] });
    const wa = worldOf(sk, a);
    const wb = worldOf(sk, b);
    // Both aim at the target.
    expect(angleTo(forward(wa, 0), [1, 0.6, -0.3])).toBeLessThan(1e-5);
    expect(angleTo(forward(wb, 0), [1, 0.6, -0.3])).toBeLessThan(1e-5);
    // The hinted one's local X stays level (no Y component).
    expect(Math.abs(wb[4]!)).toBeLessThan(1e-5);
    expect(Math.abs(wa[4]!)).toBeGreaterThan(0.05);
  });
});
