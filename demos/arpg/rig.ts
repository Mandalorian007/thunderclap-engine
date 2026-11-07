/**
 * The ARPG's procedural humanoid (copied from demos/arena and grown a cape): a 20-node skeleton
 * (16 body joints plus a four-joint cape chain off the chest), its rigid-skinned box body in two
 * looks (the hero with a cape, the ghoul without) and three clips (idle, run, attack) authored as
 * sampled curves. Setup-time code: allocates freely.
 *
 * Conventions: y up, the character faces -z at yaw 0, every node's rest rotation is the
 * identity, so a clip's rotations are read in the parent's frame; a positive rotation about +x
 * lifts a hanging limb forward.
 */
import {
  type AnimationChannel,
  type AnimationClip,
  inverseBindFromRest,
  POSE_NODE_FLOATS,
  poseToWorld,
  quatFromAxisAngle,
  quatMultiply,
  type Skeleton,
  WORLD_NODE_FLOATS,
} from '@thunderclap-engine/engine/anim';
import { MeshBuilder, type MeshData, type Rgb } from './geom';

export const NODES = {
  hips: 0,
  spine: 1,
  chest: 2,
  head: 3,
  upperArmL: 4,
  lowerArmL: 5,
  handL: 6,
  upperArmR: 7,
  lowerArmR: 8,
  handR: 9,
  upperLegL: 10,
  lowerLegL: 11,
  footL: 12,
  upperLegR: 13,
  lowerLegR: 14,
  footR: 15,
  cape0: 16,
  cape1: 17,
  cape2: 18,
  cape3: 19,
} as const;

export const NODE_COUNT = 20;

const NAMES = Object.keys(NODES) as (keyof typeof NODES)[];

/** [parent, local x, local y, local z] per node. */
const LAYOUT: readonly [number, number, number, number][] = [
  [-1, 0, 0.95, 0], // hips
  [0, 0, 0.22, 0], // spine
  [1, 0, 0.26, 0], // chest
  [2, 0, 0.3, 0], // head
  [2, -0.26, 0.2, 0], // upperArmL
  [4, 0, -0.3, 0], // lowerArmL
  [5, 0, -0.28, 0], // handL
  [2, 0.26, 0.2, 0], // upperArmR
  [7, 0, -0.3, 0], // lowerArmR
  [8, 0, -0.28, 0], // handR
  [0, -0.12, -0.05, 0], // upperLegL
  [10, 0, -0.42, 0], // lowerLegL
  [11, 0, -0.43, 0], // footL
  [0, 0.12, -0.05, 0], // upperLegR
  [13, 0, -0.42, 0], // lowerLegR
  [14, 0, -0.43, 0], // footR
  [2, 0, 0.24, 0.17], // cape0: behind the shoulders (the back is +z)
  [16, 0, -0.27, 0], // cape1
  [17, 0, -0.27, 0], // cape2
  [18, 0, -0.27, 0], // cape3: the hem
];

export function createSkeleton(): Skeleton {
  const parents = new Int16Array(NODE_COUNT);
  const rest = new Float32Array(NODE_COUNT * POSE_NODE_FLOATS);
  for (let i = 0; i < NODE_COUNT; i++) {
    const [p, x, y, z] = LAYOUT[i]!;
    parents[i] = p;
    const o = i * POSE_NODE_FLOATS;
    rest[o] = x;
    rest[o + 1] = y;
    rest[o + 2] = z;
    rest[o + 6] = 1; // identity quaternion w
    rest[o + 7] = rest[o + 8] = rest[o + 9] = 1;
  }
  const skeleton: Skeleton = { parents, rest, names: [...NAMES] };
  skeleton.inverseBind = inverseBindFromRest(skeleton);
  return skeleton;
}

/** The colours of one body look. */
export interface BodyLook {
  skin: Rgb;
  tunic: Rgb;
  belt: Rgb;
  pants: Rgb;
  boots: Rgb;
  hair: Rgb;
  /** The cape's colour, or null for no cape. */
  cape: Rgb | null;
}

export const HERO_LOOK: BodyLook = {
  skin: [0.86, 0.62, 0.48],
  tunic: [0.42, 0.1, 0.12],
  belt: [0.24, 0.14, 0.08],
  pants: [0.18, 0.16, 0.22],
  boots: [0.16, 0.1, 0.07],
  hair: [0.12, 0.08, 0.06],
  cape: [0.55, 0.06, 0.1],
};

export const GHOUL_LOOK: BodyLook = {
  skin: [0.5, 0.58, 0.46],
  tunic: [0.22, 0.2, 0.18],
  belt: [0.14, 0.12, 0.1],
  pants: [0.2, 0.19, 0.16],
  boots: [0.32, 0.36, 0.28],
  hair: [0.6, 0.66, 0.52],
  cape: null,
};

/**
 * The body in bind pose, one rigid joint per box. Boxes are placed from each node's rest world
 * position, so the mesh matches `inverseBindFromRest`. The cape is three thin panels, one per
 * cape bone, so the spring chain bends it at the joints. `coarse` is the far LOD level: the
 * hands, feet and hair go (21 boxes to 15 for a ghoul), the silhouette stays.
 */
export function createBodyMesh(skeleton: Skeleton, look: BodyLook, coarse = false): MeshData {
  const world = new Float32Array(NODE_COUNT * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, skeleton.rest, world);
  const at = (node: number): [number, number, number] => {
    const o = node * WORLD_NODE_FLOATS;
    return [world[o + 3]!, world[o + 7]!, world[o + 11]!];
  };
  const b = new MeshBuilder(true);
  const part = (
    node: number,
    dx: number,
    dy: number,
    dz: number,
    hx: number,
    hy: number,
    hz: number,
    c: Rgb,
  ) => {
    const [x, y, z] = at(node);
    b.box(x + dx, y + dy, z + dz, hx, hy, hz, c, node);
  };
  const N = NODES;
  const L = look;
  part(N.hips, 0, 0.1, 0, 0.19, 0.12, 0.12, L.belt);
  part(N.spine, 0, 0.13, 0, 0.21, 0.14, 0.13, L.tunic);
  part(N.chest, 0, 0.12, 0, 0.24, 0.14, 0.14, L.tunic);
  part(N.head, 0, 0.14, 0, 0.12, 0.14, 0.13, L.skin);
  if (!coarse) part(N.head, 0, 0.27, 0.01, 0.13, 0.03, 0.14, L.hair);
  for (const [upper, lower, hand] of [
    [N.upperArmL, N.lowerArmL, N.handL],
    [N.upperArmR, N.lowerArmR, N.handR],
  ] as const) {
    part(upper, 0, -0.15, 0, 0.075, 0.16, 0.075, L.tunic);
    part(lower, 0, -0.14, 0, 0.065, 0.15, 0.065, L.skin);
    if (!coarse) part(hand, 0, -0.06, 0, 0.055, 0.07, 0.04, L.skin);
  }
  for (const [upper, lower, foot] of [
    [N.upperLegL, N.lowerLegL, N.footL],
    [N.upperLegR, N.lowerLegR, N.footR],
  ] as const) {
    part(upper, 0, -0.21, 0, 0.095, 0.22, 0.1, L.pants);
    part(lower, 0, -0.21, 0, 0.08, 0.22, 0.085, L.pants);
    if (!coarse) part(foot, 0, -0.025, -0.05, 0.085, 0.03, 0.15, L.boots);
  }
  if (L.cape) {
    const c = L.cape;
    part(N.cape0, 0, -0.135, 0, 0.25, 0.14, 0.015, c);
    part(N.cape1, 0, -0.135, 0, 0.27, 0.14, 0.015, c);
    part(N.cape2, 0, -0.135, 0, 0.29, 0.14, 0.015, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8]);
  }
  return b.build();
}

// ------------------------------------------------------------------ clips

type Curve = (t: number) => number;

interface Track {
  node: number;
  /** Rotation about x, y, z in radians as functions of normalised time 0..1. */
  rx?: Curve;
  ry?: Curve;
  rz?: Curve;
  /** Translation offset added to the rest translation. */
  ty?: Curve;
}

const SAMPLES = 24;
const TAU = Math.PI * 2;

/** Samples the tracks' curves into LINEAR channels (quaternions from Euler-ish axis angles). */
function buildClip(name: string, duration: number, tracks: Track[]): AnimationClip {
  const channels: AnimationChannel[] = [];
  const times = new Float32Array(SAMPLES + 1);
  for (let i = 0; i <= SAMPLES; i++) times[i] = (i / SAMPLES) * duration;
  const qx = new Float32Array(4);
  const qy = new Float32Array(4);
  const qz = new Float32Array(4);
  const tmp = new Float32Array(4);
  for (const tr of tracks) {
    if (tr.rx || tr.ry || tr.rz) {
      const values = new Float32Array((SAMPLES + 1) * 4);
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        quatFromAxisAngle(qx, 0, 1, 0, 0, tr.rx ? tr.rx(t) : 0);
        quatFromAxisAngle(qy, 0, 0, 1, 0, tr.ry ? tr.ry(t) : 0);
        quatFromAxisAngle(qz, 0, 0, 0, 1, tr.rz ? tr.rz(t) : 0);
        quatMultiply(tmp, 0, qy, 0, qx, 0);
        quatMultiply(values, i * 4, tmp, 0, qz, 0);
      }
      channels.push({ node: tr.node, path: 'rotation', interpolation: 'LINEAR', times, values });
    }
    if (tr.ty) {
      const [, x, y, z] = LAYOUT[tr.node]!;
      const values = new Float32Array((SAMPLES + 1) * 3);
      for (let i = 0; i <= SAMPLES; i++) {
        values[i * 3] = x;
        values[i * 3 + 1] = y + tr.ty(i / SAMPLES);
        values[i * 3 + 2] = z;
      }
      channels.push({ node: tr.node, path: 'translation', interpolation: 'LINEAR', times, values });
    }
  }
  return { name, duration, channels };
}

const sin =
  (phase: number, amp: number, offset = 0): Curve =>
  (t) =>
    offset + amp * Math.sin(TAU * t + phase);

/** Breathing: the torso rises a touch, the arms sway, the head turns a little. */
export function createIdleClip(): AnimationClip {
  const N = NODES;
  return buildClip('idle', 2.6, [
    { node: N.spine, ty: sin(0, 0.012) },
    { node: N.chest, rx: sin(0, 0.03) },
    { node: N.head, ry: sin(Math.PI / 3, 0.12), rx: sin(0, 0.03, 0.04) },
    { node: N.upperArmL, rx: sin(0, 0.05), rz: sin(Math.PI, 0.04, 0.1) },
    { node: N.upperArmR, rx: sin(Math.PI, 0.05), rz: sin(0, 0.04, -0.1) },
    { node: N.lowerArmL, rx: sin(0, 0.04, 0.15) },
    { node: N.lowerArmR, rx: sin(Math.PI, 0.04, 0.15) },
    { node: N.upperLegL, rz: () => 0.04 },
    { node: N.upperLegR, rz: () => -0.04 },
  ]);
}

/** A run cycle: legs and opposite arms swing, knees bend on the back swing, hips bob twice. */
export function createRunClip(): AnimationClip {
  const N = NODES;
  const legSwing = 0.75;
  const knee =
    (phase: number): Curve =>
    (t) =>
      -Math.max(0, Math.sin(TAU * t + phase)) * 1.3 - 0.1;
  return buildClip('run', 0.62, [
    { node: N.hips, ty: (t) => 0.035 * Math.abs(Math.sin(TAU * t)) - 0.02, rx: () => 0.12 },
    { node: N.chest, rx: () => 0.1, ry: sin(0, 0.08) },
    { node: N.head, rx: () => -0.15 },
    { node: N.upperLegL, rx: sin(0, legSwing) },
    { node: N.lowerLegL, rx: knee(-Math.PI / 2) },
    { node: N.footL, rx: sin(Math.PI / 2, 0.2) },
    { node: N.upperLegR, rx: sin(Math.PI, legSwing) },
    { node: N.lowerLegR, rx: knee(Math.PI / 2) },
    { node: N.footR, rx: sin(-Math.PI / 2, 0.2) },
    { node: N.upperArmL, rx: sin(Math.PI, 0.8), rz: () => 0.12 },
    { node: N.lowerArmL, rx: () => 1.1 },
    { node: N.upperArmR, rx: sin(0, 0.8), rz: () => -0.12 },
    { node: N.lowerArmR, rx: () => 1.1 },
  ]);
}

/** Piecewise-linear curve through (t, value) knots in 0..1. */
function knots(points: readonly [number, number][]): Curve {
  return (t) => {
    if (t <= points[0]![0]) return points[0]![1];
    for (let i = 1; i < points.length; i++) {
      const [t1, v1] = points[i]!;
      if (t <= t1) {
        const [t0, v0] = points[i - 1]!;
        const s = (t - t0) / (t1 - t0);
        const e = s * s * (3 - 2 * s);
        return v0 + (v1 - v0) * e;
      }
    }
    return points[points.length - 1]![1];
  };
}

export const ATTACK_DURATION = 0.6;

/** The weapon arm winds up over the shoulder and slashes down across the body; the chest twists. */
export function createAttackClip(): AnimationClip {
  const N = NODES;
  return buildClip('attack', ATTACK_DURATION, [
    {
      node: N.upperArmR,
      rx: knots([
        [0, 0],
        [0.25, 2.7],
        [0.5, 0.9],
        [0.7, 0.6],
        [1, 0],
      ]),
      rz: knots([
        [0, 0],
        [0.25, -0.5],
        [0.5, 0.9],
        [0.7, 0.9],
        [1, 0],
      ]),
    },
    {
      node: N.lowerArmR,
      rx: knots([
        [0, 0],
        [0.25, 1.4],
        [0.5, 0.2],
        [1, 0],
      ]),
    },
    {
      node: N.chest,
      ry: knots([
        [0, 0],
        [0.25, 0.5],
        [0.5, -0.5],
        [1, 0],
      ]),
    },
    {
      node: N.upperArmL,
      rx: knots([
        [0, 0],
        [0.3, 0.6],
        [0.6, 0.3],
        [1, 0],
      ]),
      rz: () => 0.3,
    },
  ]);
}
