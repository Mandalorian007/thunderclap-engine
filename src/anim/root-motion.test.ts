import { describe, expect, it } from 'vitest';
import { type AnimationChannel, type AnimationClip, sampleChannel, sampleClip } from './clip';
import { POSE_NODE_FLOATS } from './pose';
import { quatFromAxisAngle, quatMultiply, quatNormalize } from './quat';
import { applyRootMotionDelta, extractRootMotion } from './root-motion';

const times = new Float32Array([0, 0.5, 1, 1.5, 2]);

/** Root 0 walks along +X while bobbing in Y and turning about +Y, with a tilt about Z; node 1 waves. */
function walk(): AnimationClip {
  const tr = new Float32Array(times.length * 3);
  const rot = new Float32Array(times.length * 4);
  const tilt = new Float32Array(4);
  for (let k = 0; k < times.length; k++) {
    const t = times[k]!;
    tr[k * 3] = 0.25 + t * 1.5;
    tr[k * 3 + 1] = 1 + 0.1 * Math.sin(t * Math.PI);
    tr[k * 3 + 2] = -0.4 + t * 0.2;
    // yaw(t) · tilt: yaw grows with t, the tilt is a fixed 0.3 rad about Z.
    quatFromAxisAngle(rot, k * 4, 0, 1, 0, 0.2 + t * 0.6);
    quatFromAxisAngle(tilt, 0, 0, 0, 1, 0.3);
    quatMultiply(rot, k * 4, rot, k * 4, tilt, 0);
  }
  const wave = new Float32Array(times.length * 4);
  for (let k = 0; k < times.length; k++) quatFromAxisAngle(wave, k * 4, 1, 0, 0, times[k]! * 0.5);
  return {
    name: 'walk',
    duration: 2,
    channels: [
      { node: 0, path: 'translation', interpolation: 'LINEAR', times, values: tr },
      { node: 0, path: 'rotation', interpolation: 'LINEAR', times, values: rot },
      { node: 1, path: 'rotation', interpolation: 'LINEAR', times, values: wave },
    ],
    events: [{ time: 0.5, name: 'step' }],
  };
}

const find = (clip: AnimationClip, node: number, path: AnimationChannel['path']) =>
  clip.channels.find((c) => c.node === node && c.path === path);

describe('extractRootMotion', () => {
  it('splits translation and yaw; motion + in-place round-trips at every keyframe', () => {
    const src = walk();
    const { clip, motion } = extractRootMotion(src, 0);
    expect(clip.channels).toHaveLength(3);
    expect(motion.channels).toHaveLength(2);
    expect(motion.name).toBe('walk.motion');
    expect(motion.duration).toBe(2);
    expect(clip.events).toEqual([{ time: 0.5, name: 'step' }]);
    expect(clip.events).not.toBe(src.events);
    const sTr = find(clip, 0, 'translation')!;
    const mTr = find(motion, 0, 'translation')!;
    const sRot = find(clip, 0, 'rotation')!;
    const mRot = find(motion, 0, 'rotation')!;
    const oTr = find(src, 0, 'translation')!;
    const oRot = find(src, 0, 'rotation')!;
    // Copies, not aliases, with the same times.
    expect(sTr.times).not.toBe(oTr.times);
    expect(mTr.times).not.toBe(sTr.times);
    expect(Array.from(mTr.times)).toEqual(Array.from(times));
    const q = new Float32Array(4);
    for (let k = 0; k < times.length; k++) {
      for (let i = 0; i < 3; i++) {
        expect(sTr.values[k * 3 + i]! + mTr.values[k * 3 + i]!).toBeCloseTo(
          oTr.values[k * 3 + i]!,
          5,
        );
        // The in-place clip holds the first-frame translation.
        expect(sTr.values[k * 3 + i]).toBeCloseTo(oTr.values[i]!, 6);
      }
      quatMultiply(q, 0, mRot.values, k * 4, sRot.values, k * 4);
      quatNormalize(q, 0);
      // Equal up to sign.
      const sign = q[3]! * oRot.values[k * 4 + 3]! < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) expect(sign * q[i]!).toBeCloseTo(oRot.values[k * 4 + i]!, 5);
      // The motion rotation is a pure yaw, identity at the first key.
      expect(mRot.values[k * 4]).toBeCloseTo(0, 6);
      expect(mRot.values[k * 4 + 2]).toBeCloseTo(0, 6);
    }
    expect(mRot.values[3]).toBeCloseTo(1, 6);
    expect(Array.from(mTr.values.subarray(0, 3))).toEqual([0, 0, 0]);
    // Other nodes are copied untouched.
    const wave = find(clip, 1, 'rotation')!;
    expect(Array.from(wave.values)).toEqual(Array.from(find(src, 1, 'rotation')!.values));
    expect(wave.values).not.toBe(find(src, 1, 'rotation')!.values);
  });

  it('planar keeps height and rotation in the clip', () => {
    const src = walk();
    const { clip, motion } = extractRootMotion(src, 0, { planar: true });
    expect(motion.channels).toHaveLength(1);
    const mTr = motion.channels[0]!;
    const sTr = find(clip, 0, 'translation')!;
    const oTr = find(src, 0, 'translation')!;
    for (let k = 0; k < times.length; k++) {
      expect(mTr.values[k * 3 + 1]).toBe(0);
      expect(sTr.values[k * 3 + 1]).toBe(oTr.values[k * 3 + 1]);
      expect(sTr.values[k * 3]! + mTr.values[k * 3]!).toBeCloseTo(oTr.values[k * 3]!, 5);
    }
    expect(Array.from(find(clip, 0, 'rotation')!.values)).toEqual(
      Array.from(find(src, 0, 'rotation')!.values),
    );
  });

  it('CUBICSPLINE translation keeps tangents; cubic rotation becomes LINEAR', () => {
    const ts = new Float32Array([0, 1]);
    // in-tangent, value, out-tangent per key.
    const tr = new Float32Array([0, 0, 0, 1, 2, 3, 1, 0, 0, 1, 0, 0, 4, 2, 3, 0, 0, 0]);
    const rot = new Float32Array(2 * 12);
    quatFromAxisAngle(rot, 4, 0, 1, 0, 0);
    quatFromAxisAngle(rot, 16, 0, 1, 0, 1);
    const src: AnimationClip = {
      name: 'c',
      duration: 1,
      channels: [
        { node: 0, path: 'translation', interpolation: 'CUBICSPLINE', times: ts, values: tr },
        { node: 0, path: 'rotation', interpolation: 'CUBICSPLINE', times: ts, values: rot },
      ],
    };
    const { clip, motion } = extractRootMotion(src, 0);
    const mTr = find(motion, 0, 'translation')!;
    const sTr = find(clip, 0, 'translation')!;
    expect(mTr.interpolation).toBe('CUBICSPLINE');
    expect(Array.from(mTr.values)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0, 0]);
    expect(Array.from(sTr.values)).toEqual([0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 2, 3, 0, 0, 0]);
    const mRot = find(motion, 0, 'rotation')!;
    expect(mRot.interpolation).toBe('LINEAR');
    expect(mRot.values).toHaveLength(8);
    expect(2 * Math.atan2(mRot.values[5]!, mRot.values[7]!)).toBeCloseTo(1, 5);
    expect(find(clip, 0, 'rotation')!.interpolation).toBe('LINEAR');
  });

  it('a clip without root channels yields an empty motion', () => {
    const src = walk();
    const { clip, motion } = extractRootMotion(src, 7);
    expect(motion.channels).toEqual([]);
    expect(clip.channels).toHaveLength(3);
  });

  it('the in-place clip samples with the root held still', () => {
    const { clip } = extractRootMotion(walk(), 0);
    const pose = new Float32Array(2 * POSE_NODE_FLOATS);
    sampleClip(clip, 0, pose);
    const at0 = Array.from(pose.subarray(0, 3));
    sampleClip(clip, 1.3, pose);
    expect(Array.from(pose.subarray(0, 3))).toEqual(at0);
  });
});

describe('applyRootMotionDelta', () => {
  const out = new Float32Array(4);

  it('is the position delta in the heading frame at t0 and the yaw delta', () => {
    const src = walk();
    const { motion } = extractRootMotion(src, 0);
    applyRootMotionDelta(motion, 0.5, 1.5, out);
    // World delta (1.5, 0, 0.2) rotated by minus the motion's yaw at 0.5: yaw(0.5) - yaw(0) = 0.3.
    const dx = 1.5;
    const dz = 0.2;
    const c = Math.cos(-0.3);
    const s = Math.sin(-0.3);
    expect(out[0]).toBeCloseTo(dx * c + dz * s, 5);
    expect(out[1]).toBeCloseTo(0.1 * Math.sin(1.5 * Math.PI) - 0.1 * Math.sin(0.5 * Math.PI), 5);
    expect(out[2]).toBeCloseTo(-dx * s + dz * c, 5);
    expect(out[3]).toBeCloseTo(0.6, 5);
    // Zero span: zero delta.
    applyRootMotionDelta(motion, 0.7, 0.7, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('planar motion has a raw position delta and no yaw', () => {
    const { motion } = extractRootMotion(walk(), 0, { planar: true });
    applyRootMotionDelta(motion, 0, 2, out);
    expect(out[0]).toBeCloseTo(3, 5);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.4, 5);
    expect(out[3]).toBe(0);
  });

  it('t1 < t0 wraps through the end of the loop', () => {
    const { motion } = extractRootMotion(walk(), 0);
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    applyRootMotionDelta(motion, 1.5, 2, a);
    applyRootMotionDelta(motion, 0, 0.5, b);
    applyRootMotionDelta(motion, 1.5, 0.5, out);
    // Yaws add; the second segment is turned by the first's yaw.
    expect(out[3]).toBeCloseTo(a[3]! + b[3]!, 5);
    const c = Math.cos(a[3]!);
    const s = Math.sin(a[3]!);
    expect(out[0]).toBeCloseTo(a[0]! + b[0]! * c + b[2]! * s, 5);
    expect(out[1]).toBeCloseTo(a[1]! + b[1]!, 5);
    expect(out[2]).toBeCloseTo(a[2]! - b[0]! * s + b[2]! * c, 5);
  });

  it('integrates a looping clip to the same place as the original root', () => {
    // Integrate 0 → 2 in steps from a zero heading: the motion's yaw is zero at the first key, so
    // the result is the original root's travel.
    const src = walk();
    const { motion } = extractRootMotion(src, 0);
    const pos = [0, 0, 0];
    let heading = 0;
    let t = 0;
    for (let i = 0; i < 8; i++) {
      const next = Math.min(2, t + 0.25);
      applyRootMotionDelta(motion, t, next, out);
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      pos[0] += out[0]! * c + out[2]! * s;
      pos[1] += out[1]!;
      pos[2] += -out[0]! * s + out[2]! * c;
      heading += out[3]!;
      t = next;
    }
    const oTr = find(src, 0, 'translation')!;
    const p0 = new Float32Array(3);
    const p2 = new Float32Array(3);
    sampleChannel(oTr, 0, p0, 0);
    sampleChannel(oTr, 2, p2, 0);
    expect(pos[0]).toBeCloseTo(p2[0]! - p0[0]!, 4);
    expect(pos[1]).toBeCloseTo(p2[1]! - p0[1]!, 4);
    expect(pos[2]).toBeCloseTo(p2[2]! - p0[2]!, 4);
    expect(heading).toBeCloseTo(1.2, 4);
  });
});
