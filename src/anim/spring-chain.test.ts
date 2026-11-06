import { describe, expect, it } from 'vitest';
import { POSE_NODE_FLOATS, type Pose, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';
import { createSpringChain, type SpringChain, updateSpringChain } from './spring-chain';

/** A horizontal chain along +X: node i at (i, 1, 0), each under the one before. */
function chain(nodes = 4): Skeleton {
  const rest = new Float32Array(nodes * POSE_NODE_FLOATS);
  const parents = new Int16Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    parents[i] = i - 1;
    rest[o] = i === 0 ? 0 : 1;
    rest[o + 1] = i === 0 ? 1 : 0;
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
const at = (w: Float32Array, node: number) => [
  w[node * WORLD_NODE_FLOATS + 3]!,
  w[node * WORLD_NODE_FLOATS + 7]!,
  w[node * WORLD_NODE_FLOATS + 11]!,
];

/** Step `frames` frames from the rest pose; returns the last pose. */
function run(sk: Skeleton, c: SpringChain, frames: number, instance: Float32Array | null = null) {
  let pose = sk.rest.slice();
  for (let i = 0; i < frames; i++) {
    pose = sk.rest.slice();
    updateSpringChain(pose, sk, world(sk, pose), c, instance, 1 / 60);
  }
  return pose;
}

describe('spring chain', () => {
  const sk = chain();

  it('settles below the rest pose under gravity and writes matching rotations', () => {
    const c = createSpringChain(sk, { root: 0, tip: 3, stiffness: 40, damping: 5 });
    const pose = run(sk, c, 600);
    const tip = c.positions.subarray(9, 12);
    expect(tip[1]).toBeLessThan(0.85);
    expect(tip[0]).toBeLessThan(3);
    // Settled: the next frame barely moves it.
    const y = tip[1]!;
    run(sk, c, 1);
    expect(Math.abs(c.positions[10]! - y)).toBeLessThan(1e-5);
    // The pose's bones point at the simulated joints: the tip's world position matches.
    const w = world(sk, pose);
    for (let i = 1; i < 4; i++) {
      const p = at(w, i);
      expect(p[0]).toBeCloseTo(c.positions[i * 3]!, 4);
      expect(p[1]).toBeCloseTo(c.positions[i * 3 + 1]!, 4);
      expect(p[2]).toBeCloseTo(c.positions[i * 3 + 2]!, 4);
    }
    // Bone lengths are kept.
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      const len = Math.hypot(
        c.positions[o]! - c.positions[o - 3]!,
        c.positions[o + 1]! - c.positions[o - 2]!,
        c.positions[o + 2]! - c.positions[o - 1]!,
      );
      expect(len).toBeCloseTo(1, 5);
    }
    // No gravity, no motion: the chain stays on the animation.
    c.reset();
    c.gravity.fill(0);
    run(sk, c, 10);
    expect(Array.from(c.positions)).toEqual(Array.from(c.animated));
  });

  it('holds joints outside sphere and capsule colliders', () => {
    const sphere = { center: [2, 0, 0], radius: 0.8 };
    const c = createSpringChain(sk, {
      root: 0,
      tip: 3,
      stiffness: 10,
      damping: 4,
      radius: 0.05,
      collide: [sphere],
    });
    run(sk, c, 600);
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      const d = Math.hypot(c.positions[o]! - 2, c.positions[o + 1]!, c.positions[o + 2]!);
      expect(d).toBeGreaterThanOrEqual(0.85 - 1e-4);
    }
    expect(c.positions[10]).toBeLessThan(1);
    const capsule = { a: [0, 0, -1], b: [4, 0, 1], radius: 0.5 };
    const k = createSpringChain(sk, { root: 0, tip: 3, stiffness: 10, collide: [capsule] });
    run(sk, k, 600);
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      // Distance to the segment.
      const px = k.positions[o]!;
      const py = k.positions[o + 1]!;
      const pz = k.positions[o + 2]!;
      const t = Math.min(1, Math.max(0, ((px - 0) * 4 + (pz + 1) * 2) / 20));
      const d = Math.hypot(px - 4 * t, py, pz - (-1 + 2 * t));
      expect(d).toBeGreaterThanOrEqual(0.5 - 1e-4);
    }
  });

  it('limits the swing angle', () => {
    const c = createSpringChain(sk, { root: 0, tip: 3, stiffness: 1, limitAngle: 0.3 });
    run(sk, c, 300);
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      const dx = c.positions[o]! - c.positions[o - 3]!;
      const dy = c.positions[o + 1]! - c.positions[o - 2]!;
      expect(Math.atan2(-dy, dx)).toBeLessThanOrEqual(0.3 + 1e-4);
      expect(Math.atan2(-dy, dx)).toBeGreaterThan(0.29);
    }
  });

  it('teleports with the root without gaining velocity, and resets', () => {
    const c = createSpringChain(sk, { root: 0, tip: 3, stiffness: 40, damping: 5 });
    run(sk, c, 600);
    const rel = Array.from(c.positions, (v, i) => v - c.positions[i % 3]!);
    const far = new Float32Array([1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 50]);
    run(sk, c, 1, far);
    expect(c.positions[0]).toBe(100);
    expect(c.positions[2]).toBe(50);
    for (let i = 0; i < rel.length; i++)
      expect(c.positions[i]! - c.positions[i % 3]!).toBeCloseTo(rel[i]!, 3);
    run(sk, c, 30, far);
    for (let i = 0; i < rel.length; i++)
      expect(c.positions[i]! - c.positions[i % 3]!).toBeCloseTo(rel[i]!, 3);
    // A small move is not a teleport: the chain lags behind.
    const near = new Float32Array([1, 0, 0, 100.2, 0, 1, 0, 0, 0, 0, 1, 50]);
    run(sk, c, 1, near);
    expect(c.positions[9]! - c.positions[0]!).toBeLessThan(rel[9]! - 1e-3);
    c.gravity.fill(0);
    c.reset();
    run(sk, c, 1, near);
    expect(Array.from(c.positions)).toEqual(Array.from(c.animated));
  });

  it('accepts an explicit joint list and validates', () => {
    const c = createSpringChain(sk, { root: 1, joints: [1, 3] });
    expect(Array.from(c.joints)).toEqual([1, 3]);
    expect(Array.from(createSpringChain(sk, { root: 1, tip: 3 }).joints)).toEqual([1, 2, 3]);
    expect(() => createSpringChain(sk, { root: 0 })).toThrow(/tip or joints/);
    expect(() => createSpringChain(sk, { root: 2, tip: 1 })).toThrow(/descend/);
    expect(() => createSpringChain(sk, { root: 0, joints: [1, 2] })).toThrow(/start at root/);
  });
});
