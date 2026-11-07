/**
 * The arena's procedural humanoid: a 16-node skeleton, its rigid-skinned box body, a sword and
 * three clips (idle, run, swing) authored as sampled curves. Setup-time code: allocates freely.
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
import {
  box,
  type Geometry,
  mergeGeometry,
  type Rgba,
  transformGeometry,
} from '@thunderclap-engine/engine/geom';
import { Transform } from '@thunderclap-engine/engine/render';
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
} as const;

export const NODE_COUNT = 16;

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

const SKIN: Rgb = [0.87, 0.64, 0.5];
const TUNIC: Rgb = [0.2, 0.42, 0.62];
const BELT: Rgb = [0.3, 0.18, 0.1];
const PANTS: Rgb = [0.26, 0.24, 0.3];
const BOOTS: Rgb = [0.22, 0.14, 0.09];
const HAIR: Rgb = [0.25, 0.15, 0.08];

/**
 * The body in bind pose, one rigid joint per box. Boxes are placed from each node's rest world
 * position, so the mesh matches `inverseBindFromRest`.
 */
export function createBodyMesh(skeleton: Skeleton): MeshData {
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
  part(N.hips, 0, 0.1, 0, 0.19, 0.12, 0.12, BELT);
  part(N.spine, 0, 0.13, 0, 0.21, 0.14, 0.13, TUNIC);
  part(N.chest, 0, 0.12, 0, 0.24, 0.14, 0.14, TUNIC);
  part(N.head, 0, 0.14, 0, 0.12, 0.14, 0.13, SKIN);
  part(N.head, 0, 0.27, -0.01, 0.13, 0.03, 0.14, HAIR);
  for (const [upper, lower, hand] of [
    [N.upperArmL, N.lowerArmL, N.handL],
    [N.upperArmR, N.lowerArmR, N.handR],
  ] as const) {
    part(upper, 0, -0.15, 0, 0.075, 0.16, 0.075, TUNIC);
    part(lower, 0, -0.14, 0, 0.065, 0.15, 0.065, SKIN);
    part(hand, 0, -0.06, 0, 0.055, 0.07, 0.04, SKIN);
  }
  for (const [upper, lower, foot] of [
    [N.upperLegL, N.lowerLegL, N.footL],
    [N.upperLegR, N.lowerLegR, N.footR],
  ] as const) {
    part(upper, 0, -0.21, 0, 0.095, 0.22, 0.1, PANTS);
    part(lower, 0, -0.21, 0, 0.08, 0.22, 0.085, PANTS);
    part(foot, 0, -0.025, -0.05, 0.085, 0.03, 0.15, BOOTS);
  }
  return b.build();
}

export const SWORD_LENGTH = 0.95;

/**
 * A sword with the grip at the origin and the blade down -y (how a hanging hand holds it): five
 * `geom` boxes (grip, pommel, cross-guard, blade, tip), each lifted into place and merged.
 */
export function createSwordMesh(): Geometry {
  const steel: Rgba = [0.85, 0.87, 0.9, 1];
  const brass: Rgba = [0.78, 0.6, 0.25, 1];
  const grip: Rgba = [0.25, 0.14, 0.08, 1];
  const part = (y: number, hx: number, hy: number, hz: number, color: Rgba) =>
    transformGeometry(box({ size: [hx * 2, hy * 2, hz * 2], color }), new Transform({ y }).world);
  return mergeGeometry(
    part(0.12, 0.02, 0.1, 0.02, grip),
    part(0.23, 0.03, 0.02, 0.03, brass),
    part(-0.02, 0.12, 0.018, 0.025, brass),
    part(-0.42, 0.035, 0.4, 0.008, steel),
    part(-0.86, 0.022, 0.07, 0.006, steel),
  );
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

export const SWING_DURATION = 0.6;

/** The sword arm winds up over the shoulder and slashes down across the body; the chest twists. */
export function createSwingClip(): AnimationClip {
  const N = NODES;
  return buildClip('swing', SWING_DURATION, [
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
