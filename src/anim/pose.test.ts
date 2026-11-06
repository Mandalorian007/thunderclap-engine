import { describe, expect, it } from 'vitest';
import {
  blendPose,
  copyPose,
  createPose,
  inverseBindFromRest,
  invertAffine,
  jointCount,
  multiplyAffine,
  nodeCount,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  type Skeleton,
  skinMatrices,
  validateSkeleton,
  WORLD_NODE_FLOATS,
  writeNodeMatrix,
} from './pose';
import { quatFromAxisAngle } from './quat';

/** Apply a 3×4 row-major matrix at offset `o` to a point. */
function apply(m: ArrayLike<number>, o: number, x: number, y: number, z: number): number[] {
  return [0, 1, 2].map(
    (r) => m[o + r * 4]! * x + m[o + r * 4 + 1]! * y + m[o + r * 4 + 2]! * z + m[o + r * 4 + 3]!,
  );
}
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Root at origin, child one unit up, grandchild another unit up; identity rotations. */
function chain(): Skeleton {
  const rest = new Float32Array(3 * POSE_NODE_FLOATS);
  for (let i = 0; i < 3; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 1] = i === 0 ? 0 : 1;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents: new Int16Array([-1, 0, 1]), rest };
}
function setRotation(pose: Pose, node: number, ax: number, ay: number, az: number, a: number) {
  quatFromAxisAngle(pose, node * POSE_NODE_FLOATS + 3, ax, ay, az, a);
}

describe('skeleton and pose basics', () => {
  it('counts nodes and joints', () => {
    const sk = chain();
    expect(nodeCount(sk)).toBe(3);
    expect(jointCount(sk)).toBe(3);
    sk.joints = new Uint16Array([2, 1]);
    expect(jointCount(sk)).toBe(2);
  });

  it('createPose copies the rest, copyPose copies values', () => {
    const sk = chain();
    const p = createPose(sk);
    expect(p).not.toBe(sk.rest);
    expect([...p]).toEqual([...sk.rest]);
    p[1] = 5;
    const q = createPose(sk);
    copyPose(p, q);
    expect(q[1]).toBe(5);
  });

  it('validateSkeleton accepts the chain and rejects bad shapes', () => {
    const sk = chain();
    expect(() => validateSkeleton(sk)).not.toThrow();
    expect(() => validateSkeleton({ parents: new Int16Array([-1, 2, 0]), rest: sk.rest })).toThrow(
      /parents\[1\]/,
    );
    expect(() => validateSkeleton({ parents: sk.parents, rest: new Float32Array(5) })).toThrow(
      /rest has 5/,
    );
    expect(() => validateSkeleton({ ...sk, joints: new Uint16Array([7]) })).toThrow(/joints\[0\]/);
    expect(() => validateSkeleton({ ...sk, inverseBind: new Float32Array(7) })).toThrow(
      /inverseBind has 7/,
    );
    expect(() => validateSkeleton({ ...sk, inverseBind: new Float32Array(3 * 16) })).not.toThrow();
  });
});

describe('blendPose', () => {
  it('lerps translation and scale, slerps rotation, and may alias', () => {
    const sk = chain();
    const a = createPose(sk);
    const b = createPose(sk);
    b[0] = 2;
    b[7] = 3;
    setRotation(b, 0, 0, 0, 1, Math.PI / 2);
    const out = createPose(sk);
    blendPose(a, b, 0.5, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[7]).toBeCloseTo(2);
    const mid = new Float32Array(4);
    quatFromAxisAngle(mid, 0, 0, 0, 1, Math.PI / 4);
    close(out.subarray(3, 7), mid);
    // Untouched nodes stay as they were.
    close(out.subarray(POSE_NODE_FLOATS), a.subarray(POSE_NODE_FLOATS));
    blendPose(a, b, 0.5, a);
    close(a, out);
  });
});

describe('matrices', () => {
  it('writeNodeMatrix builds T·R·S matching render/transform conventions', () => {
    const pose = new Float32Array([1, 2, 3, 0, 0, 0, 1, 2, 2, 2]);
    quatFromAxisAngle(pose, 3, 0, 0, 1, Math.PI / 2);
    const m = new Float32Array(12);
    writeNodeMatrix(m, 0, pose, 0);
    // (1,0,0) → scale → (2,0,0) → rotate 90° about Z → (0,2,0) → translate → (1,4,3)
    close(apply(m, 0, 1, 0, 0), [1, 4, 3], 4);
  });

  it('invertAffine inverts and multiplyAffine composes', () => {
    const pose = new Float32Array([1, -2, 3, 0, 0, 0, 1, 2, 0.5, 4]);
    quatFromAxisAngle(pose, 3, 1, 1, 0, 0.9);
    const m = new Float32Array(12);
    writeNodeMatrix(m, 0, pose, 0);
    const inv = new Float32Array(12);
    invertAffine(inv, 0, m, 0);
    const id = new Float32Array(12);
    multiplyAffine(id, 0, m, 0, inv, 0);
    close(id, IDENTITY, 4);
    const singular = new Float32Array(12);
    invertAffine(singular, 0, new Float32Array(12), 0);
    close(singular, IDENTITY);
  });
});

describe('poseToWorld', () => {
  it('rest chain stacks translations', () => {
    const sk = chain();
    const world = new Float32Array(3 * WORLD_NODE_FLOATS);
    poseToWorld(sk, sk.rest, world);
    close(apply(world, 0, 0, 0, 0), [0, 0, 0]);
    close(apply(world, 12, 0, 0, 0), [0, 1, 0]);
    close(apply(world, 24, 0, 0, 0), [0, 2, 0]);
  });

  it('a rotated parent swings its children', () => {
    const sk = chain();
    const pose = createPose(sk);
    setRotation(pose, 0, 0, 0, 1, -Math.PI / 2); // +Y → +X
    const world = new Float32Array(3 * WORLD_NODE_FLOATS);
    poseToWorld(sk, pose, world);
    close(apply(world, 12, 0, 0, 0), [1, 0, 0], 4);
    close(apply(world, 24, 0, 0, 0), [2, 0, 0], 4);
    // A rotation on the middle joint bends only the tip.
    setRotation(pose, 1, 0, 0, 1, Math.PI / 2);
    poseToWorld(sk, pose, world);
    close(apply(world, 12, 0, 0, 0), [1, 0, 0], 4);
    close(apply(world, 24, 0, 0, 0), [1, 1, 0], 4);
  });
});

describe('skinMatrices', () => {
  it('is the identity for the rest pose with inverseBindFromRest (12-float layout)', () => {
    const sk = chain();
    sk.inverseBind = inverseBindFromRest(sk);
    expect(sk.inverseBind.length).toBe(3 * 12);
    const world = new Float32Array(3 * WORLD_NODE_FLOATS);
    poseToWorld(sk, sk.rest, world);
    const skin = new Float32Array(3 * WORLD_NODE_FLOATS);
    skinMatrices(sk, world, skin);
    for (let j = 0; j < 3; j++) close(skin.subarray(j * 12, j * 12 + 12), IDENTITY, 4);
  });

  it('accepts glTF column-major 16-float inverse bind matrices and a joint map', () => {
    const sk = chain();
    const ib12 = inverseBindFromRest(sk);
    sk.joints = new Uint16Array([2, 0]);
    const ib16 = new Float32Array(2 * 16);
    for (let j = 0; j < 2; j++) {
      const node = sk.joints[j]!;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) ib16[j * 16 + c * 4 + r] = ib12[node * 12 + r * 4 + c]!;
      }
      ib16[j * 16 + 15] = 1;
    }
    sk.inverseBind = ib16;
    const world = new Float32Array(3 * WORLD_NODE_FLOATS);
    poseToWorld(sk, sk.rest, world);
    const skin = new Float32Array(2 * WORLD_NODE_FLOATS);
    skinMatrices(sk, world, skin);
    close(skin.subarray(0, 12), IDENTITY, 4);
    close(skin.subarray(12, 24), IDENTITY, 4);
    // A bent tip moves a vertex bound to the tip joint (joint 0 = node 2) by its world delta.
    const pose = createPose(sk);
    setRotation(pose, 1, 0, 0, 1, Math.PI / 2);
    poseToWorld(sk, pose, world);
    skinMatrices(sk, world, skin);
    // The tip's bind position is (0, 2, 0); after the bend node 2 sits at (-1, 1, 0).
    close(apply(skin, 0, 0, 2, 0), [-1, 1, 0], 4);
    // Joint 1 = root, unchanged.
    close(skin.subarray(12, 24), IDENTITY, 4);
  });

  it('without inverseBind copies the world matrices', () => {
    const sk = chain();
    const world = new Float32Array(3 * WORLD_NODE_FLOATS);
    poseToWorld(sk, sk.rest, world);
    const skin = new Float32Array(3 * WORLD_NODE_FLOATS);
    skinMatrices(sk, world, skin);
    close(skin, world);
  });
});
