import { describe, expect, it } from 'vitest';
import {
  type AnimationChannel,
  type AnimationClip,
  channelComponents,
  clipDuration,
  createClipCursor,
  findKeyframe,
  type Interpolation,
  sampleChannel,
  sampleClip,
  sampleWeights,
} from './clip';
import { POSE_NODE_FLOATS } from './pose';
import { quatFromAxisAngle } from './quat';

const f32 = (a: number[]) => new Float32Array(a);
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
};
function restPose(nodes: number): Float32Array {
  const p = new Float32Array(nodes * POSE_NODE_FLOATS);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    p[o + 6] = 1;
    p[o + 7] = 1;
    p[o + 8] = 1;
    p[o + 9] = 1;
  }
  return p;
}
function channel(
  path: AnimationChannel['path'],
  interpolation: Interpolation,
  times: number[],
  values: number[],
  node = 0,
): AnimationChannel {
  return { node, path, interpolation, times: f32(times), values: f32(values) };
}
const sampleOne = (ch: AnimationChannel, t: number): number[] => {
  const out = new Float32Array(channelComponents(ch));
  sampleChannel(ch, t, out, 0);
  return [...out];
};

describe('channelComponents and clipDuration', () => {
  it('counts components by path, morph weights by data', () => {
    expect(channelComponents(channel('translation', 'LINEAR', [0], [0, 0, 0]))).toBe(3);
    expect(channelComponents(channel('rotation', 'STEP', [0], [0, 0, 0, 1]))).toBe(4);
    expect(channelComponents(channel('scale', 'LINEAR', [0], [1, 1, 1]))).toBe(3);
    expect(channelComponents(channel('weights', 'LINEAR', [0, 1], [0, 0, 1, 1]))).toBe(2);
    expect(
      channelComponents(channel('weights', 'CUBICSPLINE', [0, 1], new Array(12).fill(0))),
    ).toBe(2);
    expect(channelComponents(channel('weights', 'LINEAR', [], []))).toBe(0);
  });
  it('duration is the last key over channels', () => {
    expect(
      clipDuration([
        channel('translation', 'LINEAR', [0, 0.5], new Array(6).fill(0)),
        channel('scale', 'STEP', [0, 2.5], new Array(6).fill(1)),
        channel('weights', 'LINEAR', [], []),
      ]),
    ).toBe(2.5);
    expect(clipDuration([])).toBe(0);
  });
});

describe('findKeyframe', () => {
  const times = f32([0, 1, 2, 3, 4]);
  it('locates the segment for any hint and clamps the ends', () => {
    for (const hint of [0, 1, 2, 3, 4, 99]) {
      expect(findKeyframe(times, -1, hint)).toBe(0);
      expect(findKeyframe(times, 0, hint)).toBe(0);
      expect(findKeyframe(times, 0.5, hint)).toBe(0);
      expect(findKeyframe(times, 1, hint)).toBe(1);
      expect(findKeyframe(times, 2.9, hint)).toBe(2);
      expect(findKeyframe(times, 3.5, hint)).toBe(3);
      expect(findKeyframe(times, 4, hint)).toBe(3);
      expect(findKeyframe(times, 9, hint)).toBe(3);
    }
    expect(findKeyframe(f32([2]), 5, 0)).toBe(0);
    expect(findKeyframe(f32([]), 5, 0)).toBe(0);
  });
});

describe('sampleChannel golden table', () => {
  // One scalar "weights" channel, keys at 0, 1, 3 with values 0, 1, 0.
  const linear = channel('weights', 'LINEAR', [0, 1, 3], [0, 1, 0]);
  const step = channel('weights', 'STEP', [0, 1, 3], [0, 1, 0]);
  // Cubic: segment 0 has unit tangents (linear), segment 1 has zero tangents (smoothstep).
  // Per key: in-tangent, value, out-tangent.
  const cubic = channel('weights', 'CUBICSPLINE', [0, 1, 3], [0, 0, 1, 1, 1, 0, 0, 0, 0]);
  const smooth = (u: number) => 3 * u * u - 2 * u * u * u;
  const table: [number, number, number, number][] = [
    // t, STEP, LINEAR, CUBICSPLINE
    [-1, 0, 0, 0],
    [0, 0, 0, 0],
    [0.25, 0, 0.25, 0.25],
    [0.5, 0, 0.5, 0.5],
    [1, 1, 1, 1],
    [1.5, 1, 0.75, 1 - smooth(0.25)],
    [2, 1, 0.5, 1 - smooth(0.5)],
    [2.5, 1, 0.25, 1 - smooth(0.75)],
    [3, 0, 0, 0],
    [4, 0, 0, 0],
  ];
  it.each(table)('t=%s → STEP %s, LINEAR %s, CUBICSPLINE %s', (t, s, l, c) => {
    expect(sampleOne(step, t)[0]).toBeCloseTo(s, 6);
    expect(sampleOne(linear, t)[0]).toBeCloseTo(l, 6);
    expect(sampleOne(cubic, t)[0]).toBeCloseTo(c, 6);
  });

  it('cubic spline tangents scale by the segment length', () => {
    // One segment 0..2, values 0..0, out-tangent 1 at the start, in-tangent -1 at the end:
    // p(u) = td·(u³−2u²+u)·1 + td·(u³−u²)·(−1) = 2·(u − u²)... peak at u=0.5: 2·0.25 = 0.5.
    const ch = channel('weights', 'CUBICSPLINE', [0, 2], [0, 0, 1, -1, 0, 0]);
    expect(sampleOne(ch, 1)[0]).toBeCloseTo(0.5, 6);
    expect(sampleOne(ch, 0.5)[0]).toBeCloseTo(2 * (0.25 - 0.0625), 6);
  });

  it('multi-component vectors interpolate per component', () => {
    const ch = channel('translation', 'LINEAR', [0, 2], [0, 10, -4, 2, 20, 4]);
    close(sampleOne(ch, 0.5), [0.5, 12.5, -2]);
  });

  it('a single key holds everywhere', () => {
    const ch = channel('scale', 'LINEAR', [1], [2, 3, 4]);
    close(sampleOne(ch, 0), [2, 3, 4]);
    close(sampleOne(ch, 7), [2, 3, 4]);
  });

  it('LINEAR rotations slerp (constant angular speed) and CUBICSPLINE rotations are unit length', () => {
    const q0 = new Float32Array(4);
    const q1 = new Float32Array(4);
    quatFromAxisAngle(q0, 0, 0, 1, 0, 0);
    quatFromAxisAngle(q1, 0, 0, 1, 0, Math.PI);
    // 180° apart is ambiguous, use 160°.
    quatFromAxisAngle(q1, 0, 0, 1, 0, (160 * Math.PI) / 180);
    const ch = channel('rotation', 'LINEAR', [0, 1], [...q0, ...q1]);
    const r = sampleOne(ch, 0.25);
    expect(2 * Math.atan2(r[1]!, r[3]!)).toBeCloseTo((40 * Math.PI) / 180, 5);
    const zero = [0, 0, 0, 0];
    const cubic = channel(
      'rotation',
      'CUBICSPLINE',
      [0, 1],
      [...zero, ...q0, ...zero, ...zero, ...q1, ...zero],
    );
    const c = sampleOne(cubic, 0.5);
    expect(Math.hypot(c[0]!, c[1]!, c[2]!, c[3]!)).toBeCloseTo(1, 5);
  });

  it('a cursor speeds up forward playback and survives jumps', () => {
    const times: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < 100; i++) {
      times.push(i);
      values.push(i);
    }
    const ch = channel('weights', 'LINEAR', times, values);
    const cursor = new Uint32Array(1);
    const out = new Float32Array(1);
    for (let t = 0; t < 99; t += 0.3) {
      sampleChannel(ch, t, out, 0, cursor, 0);
      expect(out[0]).toBeCloseTo(t, 3);
      expect(cursor[0]).toBe(Math.min(98, Math.floor(t)));
    }
    sampleChannel(ch, 5.5, out, 0, cursor, 0);
    expect(out[0]).toBeCloseTo(5.5, 4);
    expect(cursor[0]).toBe(5);
  });
});

describe('sampleClip', () => {
  const rot = (a: number) => {
    const q = new Float32Array(4);
    quatFromAxisAngle(q, 0, 0, 0, 1, a);
    return [...q];
  };
  const clip: AnimationClip = {
    name: 'test',
    duration: 1,
    channels: [
      channel('translation', 'LINEAR', [0, 1], [0, 0, 0, 2, 4, 6], 0),
      channel('rotation', 'LINEAR', [0, 1], [...rot(0), ...rot(Math.PI / 2)], 1),
      channel('scale', 'STEP', [0, 1], [1, 1, 1, 3, 3, 3], 1),
      channel('weights', 'LINEAR', [0, 1], [0, 1], 0),
      channel('translation', 'LINEAR', [0, 1], [9, 9, 9, 9, 9, 9], 7), // out of range: skipped
    ],
  };

  it('override at weight 1 writes the values; other components stay', () => {
    const pose = restPose(2);
    pose[2] = 5; // node 0 z, animated: overwritten
    pose[POSE_NODE_FLOATS + 1] = 0.5; // node 1 translation y: not animated, stays
    sampleClip(clip, 0.5, pose);
    close(pose.subarray(0, 3), [1, 2, 3]);
    close(pose.subarray(13, 17), rot(Math.PI / 4));
    close(pose.subarray(17, 20), [1, 1, 1]);
    expect(pose[POSE_NODE_FLOATS + 1]).toBe(0.5);
    sampleClip(clip, 1, pose);
    close(pose.subarray(17, 20), [3, 3, 3]);
  });

  it('override at weight 0.5 blends halfway toward the sampled value', () => {
    const pose = restPose(2);
    sampleClip(clip, 1, pose, 0.5);
    close(pose.subarray(0, 3), [1, 2, 3]);
    close(pose.subarray(13, 17), rot(Math.PI / 4));
    close(pose.subarray(17, 20), [2, 2, 2]);
  });

  it('additive adds translation, multiplies scale and post-multiplies rotation', () => {
    const pose = restPose(2);
    pose[0] = 1;
    pose[17] = 2;
    quatFromAxisAngle(pose, 13, 0, 0, 1, 0.3);
    sampleClip(clip, 1, pose, 1, 'additive');
    close(pose.subarray(0, 3), [3, 4, 6]);
    close(pose.subarray(17, 20), [6, 3, 3]);
    close(pose.subarray(13, 17), rot(0.3 + Math.PI / 2));
    // Half weight: half the delta.
    const half = restPose(2);
    sampleClip(clip, 1, half, 0.5, 'additive');
    close(half.subarray(0, 3), [1, 2, 3]);
    close(half.subarray(17, 20), [2, 2, 2]);
    close(half.subarray(13, 17), rot(Math.PI / 4));
  });

  it('accepts an explicit cursor and does not allocate per call', () => {
    const pose = restPose(2);
    const cursor = createClipCursor(clip);
    expect(cursor.length).toBe(clip.channels.length);
    sampleClip(clip, 0.2, pose, 1, 'override', cursor);
    sampleClip(clip, 0.7, pose, 1, 'override', cursor);
    close(pose.subarray(0, 3), [1.4, 2.8, 4.2]);
  });
});

describe('sampleWeights', () => {
  const weightsClip = (interpolation: Interpolation, values: number[]): AnimationClip => ({
    name: 'w',
    duration: 2,
    channels: [
      channel('translation', 'LINEAR', [0, 2], [0, 0, 0, 1, 1, 1], 0),
      channel('weights', interpolation, [0, 1, 2], values, 3),
    ],
  });

  it("samples the node's weights channel: STEP, LINEAR, CUBICSPLINE, hold outside", () => {
    const out = new Float32Array(2);
    const step = weightsClip('STEP', [0, 1, 1, 0, 0.5, 0.5]);
    expect(sampleWeights(step, 3, 0.9, out)).toBe(true);
    close(out, [0, 1]);
    sampleWeights(step, 3, 1, out);
    close(out, [1, 0]);
    const linear = weightsClip('LINEAR', [0, 1, 1, 0, 0.5, 0.5]);
    sampleWeights(linear, 3, 0.25, out);
    close(out, [0.25, 0.75]);
    sampleWeights(linear, 3, 1.5, out);
    close(out, [0.75, 0.25]);
    sampleWeights(linear, 3, -1, out);
    close(out, [0, 1]);
    sampleWeights(linear, 3, 9, out);
    close(out, [0.5, 0.5]);
    // Cubic: zero tangents give a smoothstep between keys; the key values hold exactly.
    const cubic = weightsClip(
      'CUBICSPLINE',
      [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
    );
    sampleWeights(cubic, 3, 0.5, out);
    close(out, [0.5, 0.5]);
    sampleWeights(cubic, 3, 0.25, out);
    const s = 3 * 0.25 ** 2 - 2 * 0.25 ** 3;
    close(out, [s, 1 - s]);
    sampleWeights(cubic, 3, 2, out);
    close(out, [0, 0.5]);
  });

  it('writes only the channel width, reports a missing channel, refuses a short buffer', () => {
    const clip = weightsClip('LINEAR', [0, 1, 1, 0, 0.5, 0.5]);
    const out = new Float32Array([9, 9, 9]);
    expect(sampleWeights(clip, 3, 0, out)).toBe(true);
    close(out, [0, 1, 9]);
    expect(sampleWeights(clip, 0, 0.5, out)).toBe(false);
    close(out, [0, 1, 9]);
    expect(() => sampleWeights(clip, 3, 0, new Float32Array(1))).toThrow(RangeError);
    // An explicit cursor works like the shared one.
    const cursor = createClipCursor(clip);
    sampleWeights(clip, 3, 0.5, out, cursor);
    sampleWeights(clip, 3, 1.5, out, cursor);
    close(out.subarray(0, 2), [0.75, 0.25]);
    expect(cursor[1]).toBe(1);
  });
});
