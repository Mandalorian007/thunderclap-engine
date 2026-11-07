import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import { SkinPalette } from '../render/skin';
import type { AnimationClip } from './clip';
import { AnimationMixer } from './mixer';
import {
  createPose,
  inverseBindFromRest,
  POSE_NODE_FLOATS,
  poseToWorld,
  type Skeleton,
  skinMatrices,
  WORLD_NODE_FLOATS,
} from './pose';
import { quatFromAxisAngle } from './quat';
import { skinPose } from './skin-pose';

/** Four nodes: a root, a two-joint chain on it and a leaf; joints 1..3 drive the mesh. */
function rig(withBind = true): Skeleton {
  const rest = new Float32Array(4 * POSE_NODE_FLOATS);
  for (let i = 0; i < 4; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o] = i === 0 ? 0.5 : 0;
    rest[o + 1] = i === 0 ? 0 : 0.8;
    quatFromAxisAngle(rest, o + 3, 0.3, 0.2, 1, 0.1 * i + 0.05);
    rest[o + 7] = 1;
    rest[o + 8] = i === 2 ? 1.25 : 1;
    rest[o + 9] = 1;
  }
  const sk: Skeleton = {
    parents: new Int16Array([-1, 0, 1, 2]),
    rest,
    joints: new Uint16Array([1, 2, 3]),
  };
  if (withBind) {
    // Inverse bind per joint, 12 floats, from the rest pose of the nodes the joints drive.
    const all = inverseBindFromRest({ parents: sk.parents, rest });
    const ib = new Float32Array(3 * 12);
    for (let j = 0; j < 3; j++) ib.set(all.subarray((j + 1) * 12, (j + 2) * 12), j * 12);
    sk.inverseBind = ib;
  }
  return sk;
}

const swing: AnimationClip = {
  name: 'swing',
  duration: 1,
  channels: [
    {
      node: 1,
      path: 'rotation',
      interpolation: 'LINEAR',
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    },
    {
      node: 2,
      path: 'translation',
      interpolation: 'LINEAR',
      times: new Float32Array([0, 0.5, 1]),
      values: new Float32Array([0, 0.8, 0, 0.2, 1, 0, 0, 0.8, 0.1]),
    },
  ],
};

function palette(instances = 2): SkinPalette {
  return new SkinPalette(createFakeDevice().device, { joints: 3, instances });
}

const RealF32 = globalThis.Float32Array;
afterEach(() => {
  globalThis.Float32Array = RealF32;
});

describe('skinPose', () => {
  it('matches update → poseToWorld → skinMatrices → palette.write bit for bit', () => {
    for (const withBind of [true, false]) {
      const sk = rig(withBind);
      const a = new AnimationMixer(sk);
      const b = new AnimationMixer(sk);
      a.play(swing);
      b.play(swing);
      const pa = palette();
      const pb = palette();
      const world = new Float32Array(4 * WORLD_NODE_FLOATS);
      for (let f = 0; f < 50; f++) {
        const dt = 1 / 60 + f * 0.001;
        // The five-step path.
        a.update(dt);
        poseToWorld(sk, a.pose, world);
        skinMatrices(sk, world, pa.write(1));
        // One call.
        const w = skinPose(sk, b, pb, 1, dt);
        expect(Array.from(w)).toEqual(Array.from(world));
        expect(Array.from(pb.write(1))).toEqual(Array.from(pa.write(1)));
      }
      // The written slot is marked for the next flush.
      expect(pb.isDirty).toBe(true);
    }
  });

  it('takes a bare pose, or a source without dt, without advancing it', () => {
    const sk = rig();
    const mixer = new AnimationMixer(sk);
    const action = mixer.play(swing);
    mixer.update(0.3);
    const p = palette();
    const before = action.time;
    skinPose(sk, mixer, p, 0);
    expect(action.time).toBe(before);
    const fromMixer = Array.from(p.write(0));
    skinPose(sk, mixer.pose, p, 1);
    expect(Array.from(p.write(1))).toEqual(fromMixer);
    // The rest pose skins to the identity.
    skinPose(sk, createPose(sk), p, 0);
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const m = p.write(0);
    for (let k = 0; k < 36; k++) expect(m[k]).toBeCloseTo(id[k % 12]!, 5);
  });

  it('reuses one world array per skeleton, or writes the one given', () => {
    const sk = rig();
    const p = palette();
    const w1 = skinPose(sk, createPose(sk), p, 0);
    const w2 = skinPose(sk, createPose(sk), p, 1);
    expect(w2).toBe(w1);
    expect(w1.length).toBe(4 * WORLD_NODE_FLOATS);
    expect(skinPose(rig(), createPose(sk), p, 0)).not.toBe(w1);
    const own = new Float32Array(4 * WORLD_NODE_FLOATS);
    expect(skinPose(sk, createPose(sk), p, 0, undefined, own)).toBe(own);
    expect(Array.from(own)).toEqual(Array.from(w1));
  });

  it('SkinPalette.jointCount is the joints per slot (ws/render-11)', () => {
    const p = palette();
    expect(p.jointCount).toBe(3);
    expect(p.jointCount).toBe(p.joints);
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(p), 'jointCount')?.get).toBeTypeOf(
      'function',
    );
  });

  it('refuses a palette smaller than the skeleton, before advancing the source', () => {
    const sk = rig();
    const small = new SkinPalette(createFakeDevice().device, { joints: 2, instances: 1 });
    small.flush();
    const mixer = new AnimationMixer(sk);
    mixer.play(swing);
    const t0 = new Float32Array(mixer.pose);
    expect(() => skinPose(sk, mixer, small, 0, 0.25)).toThrow(
      'skinPose: the skeleton has 3 joints but the palette holds 2 per slot (slot 0); make the SkinPalette with joints: 3 or more',
    );
    expect(mixer.pose).toEqual(t0);
    expect(small.isDirty).toBe(false);
    // A bigger palette is fine (the extra joints keep identity).
    const big = new SkinPalette(createFakeDevice().device, { joints: 5, instances: 1 });
    expect(() => skinPose(sk, mixer, big, 0)).not.toThrow();
    // A plain target without jointCount is checked by its block's length.
    const block = new Float32Array(2 * 12);
    expect(() => skinPose(sk, mixer.pose, { write: () => block })).toThrow(
      /3 joints but the palette holds 2 per slot/,
    );
  });

  it('allocates nothing in steady state', () => {
    for (const withBind of [true, false]) {
      const sk = rig(withBind);
      const mixer = new AnimationMixer(sk);
      mixer.play(swing);
      const p = palette();
      skinPose(sk, mixer, p, 0, 1 / 60); // first call: world scratch and the slot's view
      skinPose(sk, mixer, p, 1, 1 / 60);
      let constructed = 0;
      let views = 0;
      const Counting = new Proxy(RealF32, {
        construct(target, args, newTarget) {
          constructed++;
          return Reflect.construct(target, args, newTarget);
        },
      });
      const proto = RealF32.prototype;
      const subarray = proto.subarray;
      proto.subarray = function (this: Float32Array, ...args: [number?, number?]) {
        views++;
        return subarray.apply(this, args);
      } as typeof subarray;
      globalThis.Float32Array = Counting as typeof Float32Array;
      try {
        for (let i = 0; i < 1000; i++) {
          skinPose(sk, mixer, p, i & 1, 1 / 60);
          skinPose(sk, mixer.pose, p, 0);
        }
      } finally {
        globalThis.Float32Array = RealF32;
        proto.subarray = subarray;
      }
      expect(constructed).toBe(0);
      expect(views).toBe(0);
    }
  });
});
