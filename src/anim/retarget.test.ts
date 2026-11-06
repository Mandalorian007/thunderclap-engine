import { describe, expect, it } from 'vitest';
import type { AnimationClip } from './clip';
import { sampleClip } from './clip';
import { POSE_NODE_FLOATS, type Pose, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';
import { quatFromAxisAngle } from './quat';
import { createRetargetMap, normalizeJointName, retargetClip, retargetPose } from './retarget';

type Named = Skeleton & { names?: string[] };

interface NodeSpec {
  name: string;
  parent: number;
  t: [number, number, number];
  /** Rotation about Z in degrees (rest). */
  rz?: number;
}

function rig(spec: NodeSpec[], named = true): Named {
  const n = spec.length;
  const rest = new Float32Array(n * POSE_NODE_FLOATS);
  const parents = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = spec[i]!;
    const o = i * POSE_NODE_FLOATS;
    parents[i] = s.parent;
    rest.set(s.t, o);
    quatFromAxisAngle(rest, o + 3, 0, 0, 1, ((s.rz ?? 0) * Math.PI) / 180);
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  const sk: Named = { parents, rest };
  if (named) sk.names = spec.map((s) => s.name);
  return sk;
}

/** Hips 1 up, spine 0.5 up, an arm of two unit bones along +X, then the hand. */
const SOURCE: NodeSpec[] = [
  { name: 'mixamorig:Hips', parent: -1, t: [0, 1, 0] },
  { name: 'mixamorig:Spine', parent: 0, t: [0, 0.5, 0] },
  { name: 'mixamorig:LeftArm', parent: 1, t: [0.2, 0, 0] },
  { name: 'mixamorig:LeftForeArm', parent: 2, t: [1, 0, 0] },
  { name: 'mixamorig:LeftHand', parent: 3, t: [1, 0, 0] },
];

/**
 * The same figure with longer legs (hips 1.5 up) and arms (1.4 per bone), snake_case names and
 * rotated rest frames: `left_arm` is turned +90° about Z so its child offset is `(0, -L, 0)`,
 * `left_fore_arm` turns -90° back so the hand offset is along +X again. World-space bone
 * directions at rest are the source's.
 */
const TARGET: NodeSpec[] = [
  { name: 'hips', parent: -1, t: [0, 1.5, 0] },
  { name: 'spine', parent: 0, t: [0, 0.5, 0] },
  { name: 'left_arm', parent: 1, t: [0.2, 0, 0], rz: 90 },
  { name: 'left_fore_arm', parent: 2, t: [0, -1.4, 0], rz: -90 },
  { name: 'left_hand', parent: 3, t: [1.4, 0, 0] },
];

const world = (sk: Skeleton, pose: Pose): Float32Array => {
  const out = new Float32Array(sk.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(sk, pose, out);
  return out;
};
const position = (w: Float32Array, i: number): [number, number, number] => {
  const o = i * WORLD_NODE_FLOATS;
  return [w[o + 3]!, w[o + 7]!, w[o + 11]!];
};
/** Unit direction from node `parent` to node `child` in world space. */
const boneDir = (w: Float32Array, parent: number, child: number): [number, number, number] => {
  const a = position(w, parent);
  const b = position(w, child);
  const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-4) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(tol);
};
const setRotation = (pose: Pose, node: number, ax: number, ay: number, az: number, deg: number) =>
  quatFromAxisAngle(pose, node * POSE_NODE_FLOATS + 3, ax, ay, az, (deg * Math.PI) / 180);

/** A source pose: arm raised 30° about Z, forearm bent 45° about Y, hips moved by (0.1, 0.2, -0.3). */
function wavePose(source: Skeleton): Pose {
  const pose = new Float32Array(source.rest);
  setRotation(pose, 2, 0, 0, 1, 30);
  setRotation(pose, 3, 0, 1, 0, 45);
  pose[0] += 0.1;
  pose[1] += 0.2;
  pose[2] -= 0.3;
  return pose;
}

describe('normalizeJointName', () => {
  it('lowercases, drops a namespace prefix and strips separators', () => {
    expect(normalizeJointName('mixamorig:LeftArm')).toBe('leftarm');
    expect(normalizeJointName('left_arm')).toBe('leftarm');
    expect(normalizeJointName('Left-Arm')).toBe('leftarm');
    expect(normalizeJointName('left arm')).toBe('leftarm');
    expect(normalizeJointName('Armature|LeftArm')).toBe('leftarm');
    expect(normalizeJointName('Left.Arm.001')).toBe('leftarm001');
    expect(normalizeJointName('LeftArm')).not.toBe(normalizeJointName('RightArm'));
  });
});

describe('createRetargetMap', () => {
  it('pairs exact names, then normalised names, and lists the rest', () => {
    const source = rig(SOURCE);
    const target = rig([...TARGET, { name: 'tail', parent: 0, t: [0, 0, -0.5] }]);
    const map = createRetargetMap(source, target);
    expect([...map.pairs]).toEqual([0, 1, 2, 3, 4, -1]);
    expect(map.unmatched).toEqual(['tail']);
    expect(map.root).toBe(0);
    expect(map.translationScale).toBeCloseTo(1.5, 6);
  });

  it('explicit pairs by name and index win over name matching', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const map = createRetargetMap(source, target, {
      pairs: [
        ['mixamorig:LeftHand', 'left_arm'],
        [2, 'left_hand'],
      ],
    });
    expect(map.pairs[2]).toBe(4);
    expect(map.pairs[4]).toBe(2);
    expect(map.pairs[3]).toBe(3);
    expect(map.unmatched).toEqual([]);
  });

  it('match() replaces the default matching', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const map = createRetargetMap(source, target, {
      match: (name) => (name === 'mixamorig:Hips' ? 'hips' : null),
    });
    expect([...map.pairs]).toEqual([0, -1, -1, -1, -1]);
    expect(map.unmatched).toEqual(['spine', 'left_arm', 'left_fore_arm', 'left_hand']);
  });

  it('nameless skeletons pair by index, or by numeric pairs', () => {
    const source = rig(SOURCE, false);
    const target = rig(TARGET, false);
    expect([...createRetargetMap(source, target).pairs]).toEqual([0, 1, 2, 3, 4]);
    const map = createRetargetMap(source, target, { pairs: [[0, 0]] });
    expect([...map.pairs]).toEqual([0, -1, -1, -1, -1]);
    expect(map.unmatched).toEqual(['1', '2', '3', '4']);
  });

  it('rootNode picks the translated node; scaleTranslation false keeps the scale at 1', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const map = createRetargetMap(source, target, { rootNode: 'spine', scaleTranslation: false });
    expect(map.root).toBe(1);
    expect(map.translationScale).toBe(1);
    expect(() => createRetargetMap(source, target, { rootNode: 'nope' })).toThrow(/no node named/);
    expect(() => createRetargetMap(source, target, { pairs: [[9, 0]] })).toThrow(/out of range/);
  });
});

describe('retargetPose', () => {
  it('identical skeletons give an identical pose', () => {
    const source = rig(SOURCE);
    const target = rig(SOURCE);
    const map = createRetargetMap(source, target);
    const pose = wavePose(source);
    const out = new Float32Array(target.rest.length);
    retargetPose(map, pose, out);
    close(world(target, out), world(source, pose), 1e-5);
  });

  it('a target with rotated rest bones reproduces the source bone directions', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const map = createRetargetMap(source, target);
    expect(map.unmatched).toEqual([]);
    const pose = wavePose(source);
    const out = new Float32Array(target.rest.length);
    retargetPose(map, pose, out);
    const ws = world(source, pose);
    const wt = world(target, out);
    for (const [p, c] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ] as const) {
      close(boneDir(wt, p, c), boneDir(ws, p, c), 1e-4);
    }
    // Bone lengths are the target's.
    const arm = position(wt, 3);
    const shoulder = position(wt, 2);
    expect(
      Math.hypot(arm[0] - shoulder[0], arm[1] - shoulder[1], arm[2] - shoulder[2]),
    ).toBeCloseTo(1.4, 5);
  });

  it('a longer-legged target scales root translation by hip height', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const pose = wavePose(source);
    const out = new Float32Array(target.rest.length);
    retargetPose(createRetargetMap(source, target), pose, out);
    close(out.subarray(0, 3), [0.15, 1.8, -0.45], 1e-6);
    retargetPose(createRetargetMap(source, target, { scaleTranslation: false }), pose, out);
    close(out.subarray(0, 3), [0.1, 1.7, -0.3], 1e-6);
  });

  it('missing joints hold their rest and other translations stay at the target rest', () => {
    const source = rig(SOURCE);
    const target = rig([...TARGET, { name: 'tail', parent: 0, t: [0, 0, -0.5], rz: 20 }]);
    const map = createRetargetMap(source, target);
    const pose = wavePose(source);
    pose[1 * POSE_NODE_FLOATS + 1] = 9; // a spine translation the target must ignore
    const out = new Float32Array(target.rest.length);
    out.fill(7);
    retargetPose(map, pose, out);
    const tail = 5 * POSE_NODE_FLOATS;
    close(
      out.subarray(tail, tail + POSE_NODE_FLOATS),
      target.rest.subarray(tail, tail + POSE_NODE_FLOATS),
      0,
    );
    const spine = 1 * POSE_NODE_FLOATS;
    close(out.subarray(spine, spine + 3), [0, 0.5, 0], 0);
    expect(out[spine + 7]).toBe(1);
  });
});

describe('retargetClip', () => {
  function waveClip(): AnimationClip {
    const times = new Float32Array([0, 0.5, 1]);
    const armRot = new Float32Array(12);
    const foreRot = new Float32Array(12);
    for (let k = 0; k < 3; k++) {
      quatFromAxisAngle(armRot, k * 4, 0, 0, 1, (k * 40 * Math.PI) / 180);
      quatFromAxisAngle(foreRot, k * 4, 0, 1, 0, ((k - 1) * 60 * Math.PI) / 180);
    }
    return {
      name: 'wave',
      duration: 1,
      channels: [
        { node: 2, path: 'rotation', interpolation: 'LINEAR', times, values: armRot },
        { node: 3, path: 'rotation', interpolation: 'LINEAR', times, values: foreRot },
        {
          node: 0,
          path: 'translation',
          interpolation: 'LINEAR',
          times,
          values: new Float32Array([0, 1, 0, 0.2, 1.1, 0, 0, 1, 0]),
        },
      ],
      events: [{ time: 0.5, name: 'peak' }],
    };
  }

  it('equals per-frame retargetPose at key times and between them', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const map = createRetargetMap(source, target);
    const clip = waveClip();
    const baked = retargetClip(map, clip);
    expect(baked.name).toBe('wave');
    expect(baked.duration).toBe(1);
    expect(baked.events).toEqual([{ time: 0.5, name: 'peak' }]);
    expect(baked.channels.map((c) => `${c.node}:${c.path}`).sort()).toEqual([
      '0:translation',
      '2:rotation',
      '3:rotation',
    ]);
    const sourcePose = new Float32Array(source.rest);
    const viaPose = new Float32Array(target.rest);
    const viaClip = new Float32Array(target.rest);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      sourcePose.set(source.rest);
      sampleClip(clip, t, sourcePose);
      retargetPose(map, sourcePose, viaPose);
      viaClip.set(target.rest);
      sampleClip(baked, t, viaClip);
      close(world(target, viaClip), world(target, viaPose), 1e-4);
    }
  });

  it('bakes at a sample rate when asked', () => {
    const source = rig(SOURCE);
    const target = rig(TARGET);
    const baked = retargetClip(createRetargetMap(source, target), waveClip(), {
      sampleRate: 10,
      name: 'wave@10',
    });
    expect(baked.name).toBe('wave@10');
    const ch = baked.channels[0]!;
    expect(ch.times.length).toBe(11);
    expect(ch.times[0]).toBe(0);
    expect(ch.times[10]).toBe(1);
    expect(ch.times[3]).toBeCloseTo(0.3, 6);
  });
});
