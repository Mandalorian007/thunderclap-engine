import { describe, expect, it } from 'vitest';
import { type AnimationClip, sampleClip } from './clip';
import { buildPoseFeatures, findBestFrame, rootSpacePositions } from './match';
import { POSE_NODE_FLOATS, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';

const f32 = (a: number[]) => new Float32Array(a);

/** A root and two children up the y axis; the root travels, node 1 swings about x. */
function rig(): Skeleton {
  const rest = new Float32Array(3 * POSE_NODE_FLOATS);
  for (let i = 0; i < 3; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  rest[1 * POSE_NODE_FLOATS + 1] = 1;
  rest[2 * POSE_NODE_FLOATS + 1] = 1;
  return { parents: new Int16Array([-1, 0, 1]), rest };
}

function clip(): AnimationClip {
  const n = 61;
  const times = new Float32Array(n);
  const root = new Float32Array(n * 3);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    times[i] = t * 2;
    root[i * 3 + 2] = t * 4; // four units of baked travel
    const a = Math.sin(t * Math.PI * 2) * 0.8;
    sw[i * 4] = Math.sin(a / 2);
    sw[i * 4 + 3] = Math.cos(a / 2);
  }
  return {
    name: 'walk',
    duration: 2,
    channels: [
      { node: 0, path: 'translation', interpolation: 'LINEAR', times, values: root },
      { node: 1, path: 'rotation', interpolation: 'LINEAR', times, values: sw },
    ],
  };
}

function worldAt(c: AnimationClip, sk: Skeleton, t: number): Float32Array {
  const pose = new Float32Array(sk.rest);
  sampleClip(c, t, pose, 1, 'override', new Uint32Array(c.channels.length));
  const w = new Float32Array(3 * WORLD_NODE_FLOATS);
  poseToWorld(sk, pose, w);
  return w;
}

describe('pose matching', () => {
  const sk = rig();
  const c = clip();
  const f = buildPoseFeatures(c, sk, { joints: [2], sampleRate: 30 });

  it('samples the clip at the rate in root space, with velocities', () => {
    expect(f.times.length).toBe(61);
    expect(f.times[60]).toBeCloseTo(2, 6);
    expect(f.stride).toBe(6);
    // Root travel drops out: node 2's root-space z at the half cycle equals its start.
    expect(Math.abs(f.data[2]!)).toBeLessThan(1e-6);
    expect(Math.abs(f.data[30 * 6 + 2]! - f.data[2]!)).toBeLessThan(1e-5);
    // The velocity is non-zero where the swing moves.
    expect(Math.abs(f.data[5 * 6 + 5]!)).toBeGreaterThan(0.1);
  });

  it('matching the same clip pose at t returns t within one sample', () => {
    const out = { time: 0, cost: 0 };
    for (const t of [0.07, 0.4, 0.95, 1.33, 1.8]) {
      const w = worldAt(c, sk, t);
      const w2 = worldAt(c, sk, t + 1e-3);
      const p1 = new Float32Array(3);
      const p2 = new Float32Array(3);
      rootSpacePositions(w, 0, [2], p1);
      rootSpacePositions(w2, 0, [2], p2);
      const v = f32([(p2[0]! - p1[0]!) / 1e-3, (p2[1]! - p1[1]!) / 1e-3, (p2[2]! - p1[2]!) / 1e-3]);
      const m = findBestFrame(f, w, v, undefined, out);
      expect(m).toBe(out);
      // The swing is symmetric in position; the velocity term picks the right half cycle.
      expect(Math.abs(m.time - t)).toBeLessThanOrEqual(1 / 30 + 1e-6);
      expect(m.cost).toBeLessThan(0.05);
    }
  });

  it('a position-only match lands on a frame with the same pose', () => {
    const w = worldAt(c, sk, 0.4);
    const m = findBestFrame(f, w, null);
    const w2 = worldAt(c, sk, m.time);
    const o = 2 * WORLD_NODE_FLOATS;
    expect(Math.abs(w2[o + 3]! - w[o + 3]!)).toBeLessThan(0.05);
  });

  it('rejects bad joints and rates', () => {
    expect(() => buildPoseFeatures(c, sk, { joints: [7] })).toThrow(/joint 7/);
    expect(() => buildPoseFeatures(c, sk, { joints: [1], sampleRate: 0 })).toThrow(/sampleRate/);
  });
});
