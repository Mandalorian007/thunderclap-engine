/**
 * Pose matching: a transition starts the target clip at the frame nearest the pose it leaves,
 * instead of at 0, so a walk→run blend does not snap a planted foot to the other leg.
 *
 * `buildPoseFeatures` samples a clip at a fixed rate and stores, per sample, the root-space
 * position and velocity of a few joints (feet, hands, head). `findBestFrame` compares a pose's
 * world matrices (plus per-joint velocities) against every sample and returns the time of the
 * cheapest one. Root space is the frame of one node (the first root by default) so a clip's
 * baked travel and the instance's placement drop out. Allocates at build; the query allocates
 * nothing when given an `out`.
 */
import { type AnimationClip, sampleClip } from './clip';
import { invertAffine, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';

export interface PoseFeaturesOptions {
  /** Node indices whose position and velocity make up a feature (feet, hands, head). */
  joints: ArrayLike<number>;
  /** Samples per second along the clip. Default 30. */
  sampleRate?: number;
  /** The node whose frame is "root space". Default: the first node with no parent. */
  root?: number;
}

/** Per-sample joint positions and velocities of one clip, from `buildPoseFeatures`. */
export interface PoseFeatures {
  readonly clip: AnimationClip;
  readonly joints: Int16Array;
  readonly root: number;
  /** Sample times, ascending from 0. */
  readonly times: Float32Array;
  /** `6 × joints` floats per sample: `px py pz vx vy vz` per joint, root space. */
  readonly data: Float32Array;
  /** Floats per sample (`6 × joints`). */
  readonly stride: number;
}

export interface FindBestFrameOptions {
  /** Weight of the velocity term (s²; a velocity gap of 1 m/s costs this much). Default 0.05. */
  velocityWeight?: number;
}

/** The result of `findBestFrame`: the clip time of the cheapest sample and its cost. */
export interface PoseMatch {
  time: number;
  cost: number;
}

/** Floats per joint per sample. */
const PER_JOINT = 6;

const inv = new Float32Array(WORLD_NODE_FLOATS);
const p = new Float32Array(3);

/** `out = inverse root (3×4) · point`. */
function toRoot(out: Float32Array, m: Float32Array, px: number, py: number, pz: number): void {
  out[0] = m[0]! * px + m[1]! * py + m[2]! * pz + m[3]!;
  out[1] = m[4]! * px + m[5]! * py + m[6]! * pz + m[7]!;
  out[2] = m[8]! * px + m[9]! * py + m[10]! * pz + m[11]!;
}

/** @internal The first node with no parent (0 when none). */
export function firstRoot(skeleton: Skeleton): number {
  const parents = skeleton.parents;
  for (let i = 0; i < parents.length; i++) if (parents[i]! < 0) return i;
  return 0;
}

/**
 * Sample `clip` on `skeleton` every `1 / sampleRate` seconds (the last sample at the clip's
 * duration) and record, per sample and per joint of `opts.joints`, the joint's root-space
 * position and velocity (finite difference to the next sample; the last sample wraps to the
 * first, as a looping clip does). Allocates; call at load.
 */
export function buildPoseFeatures(
  clip: AnimationClip,
  skeleton: Skeleton,
  opts: PoseFeaturesOptions,
): PoseFeatures {
  const rate = opts.sampleRate ?? 30;
  if (!(rate > 0)) throw new Error(`buildPoseFeatures: sampleRate ${rate} must be > 0`);
  const n = skeleton.parents.length;
  const joints = Int16Array.from(opts.joints);
  for (let j = 0; j < joints.length; j++) {
    const node = joints[j]!;
    if (node < 0 || node >= n)
      throw new Error(`buildPoseFeatures: joint ${node} is not a node (${n} nodes)`);
  }
  const root = opts.root ?? firstRoot(skeleton);
  if (root < 0 || root >= n)
    throw new Error(`buildPoseFeatures: root ${root} is not a node (${n} nodes)`);
  const duration = Math.max(0, clip.duration);
  const count = Math.max(1, Math.round(duration * rate)) + 1;
  const times = new Float32Array(count);
  const stride = joints.length * PER_JOINT;
  const data = new Float32Array(count * stride);
  const pose = new Float32Array(skeleton.rest);
  const world = new Float32Array(n * WORLD_NODE_FLOATS);
  const cursor = new Uint32Array(Math.max(1, clip.channels.length));
  // Positions first.
  for (let s = 0; s < count; s++) {
    const t = count > 1 ? (duration * s) / (count - 1) : 0;
    times[s] = t;
    pose.set(skeleton.rest);
    sampleClip(clip, t, pose, 1, 'override', cursor);
    poseToWorld(skeleton, pose, world);
    invertAffine(inv, 0, world, root * WORLD_NODE_FLOATS);
    for (let j = 0; j < joints.length; j++) {
      const wo = joints[j]! * WORLD_NODE_FLOATS;
      toRoot(p, inv, world[wo + 3]!, world[wo + 7]!, world[wo + 11]!);
      const o = s * stride + j * PER_JOINT;
      data[o] = p[0]!;
      data[o + 1] = p[1]!;
      data[o + 2] = p[2]!;
    }
  }
  // Velocities: central difference, wrapping around the ends as a looping clip does (the
  // last sample is the first again, so its neighbours are the second and the second to last).
  const dt = count > 1 ? duration / (count - 1) : 1;
  const span = count > 2 ? 2 * dt : dt;
  for (let s = 0; s < count; s++) {
    const next = s + 1 < count ? s + 1 : count > 2 ? 1 : s;
    const prev = s > 0 ? s - 1 : count > 2 ? count - 2 : s;
    for (let j = 0; j < joints.length; j++) {
      const o = s * stride + j * PER_JOINT;
      const no = next * stride + j * PER_JOINT;
      const po = prev * stride + j * PER_JOINT;
      data[o + 3] = span > 0 ? (data[no]! - data[po]!) / span : 0;
      data[o + 4] = span > 0 ? (data[no + 1]! - data[po + 1]!) / span : 0;
      data[o + 5] = span > 0 ? (data[no + 2]! - data[po + 2]!) / span : 0;
    }
  }
  return { clip, joints, root, times, data, stride };
}

const DEFAULT_OUT: PoseMatch = { time: 0, cost: 0 };

/**
 * Root-space positions of `joints` (3 floats each into `out`) from a pose's world matrices:
 * what a velocity for `findBestFrame` is the time derivative of. Allocation-free.
 */
export function rootSpacePositions(
  poseWorld: Float32Array,
  root: number,
  joints: ArrayLike<number>,
  out: Float32Array,
): void {
  invertAffine(inv, 0, poseWorld, root * WORLD_NODE_FLOATS);
  for (let j = 0; j < joints.length; j++) {
    const wo = joints[j]! * WORLD_NODE_FLOATS;
    toRoot(p, inv, poseWorld[wo + 3]!, poseWorld[wo + 7]!, poseWorld[wo + 11]!);
    out[j * 3] = p[0]!;
    out[j * 3 + 1] = p[1]!;
    out[j * 3 + 2] = p[2]!;
  }
}

/**
 * The sample of `features` nearest a pose: `poseWorld` is `poseToWorld` of that pose (skeleton
 * space; the root node's matrix in it defines root space), `velocity` holds the root-space
 * velocity of each feature joint (`3 × joints` floats in `features.joints` order: the
 * derivative of `rootSpacePositions`, so the root's own travel drops out), or `null` to match
 * on positions alone. Cost per sample is the summed squared position gap plus `velocityWeight`
 * times the summed squared velocity gap. Writes and returns `out` (a shared object when none
 * is given). No allocation with `out`.
 */
export function findBestFrame(
  features: PoseFeatures,
  poseWorld: Float32Array,
  velocity: ArrayLike<number> | null,
  opts?: FindBestFrameOptions,
  out: PoseMatch = DEFAULT_OUT,
): PoseMatch {
  const vw = opts?.velocityWeight ?? 0.05;
  const joints = features.joints;
  const stride = features.stride;
  const data = features.data;
  invertAffine(inv, 0, poseWorld, features.root * WORLD_NODE_FLOATS);
  let best = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  const count = features.times.length;
  for (let s = 0; s < count; s++) {
    let cost = 0;
    for (let j = 0; j < joints.length; j++) {
      const wo = joints[j]! * WORLD_NODE_FLOATS;
      const o = s * stride + j * PER_JOINT;
      toRoot(p, inv, poseWorld[wo + 3]!, poseWorld[wo + 7]!, poseWorld[wo + 11]!);
      const dx = p[0]! - data[o]!;
      const dy = p[1]! - data[o + 1]!;
      const dz = p[2]! - data[o + 2]!;
      cost += dx * dx + dy * dy + dz * dz;
      if (velocity && vw > 0) {
        const vx = velocity[j * 3]! - data[o + 3]!;
        const vy = velocity[j * 3 + 1]! - data[o + 4]!;
        const vz = velocity[j * 3 + 2]! - data[o + 5]!;
        cost += vw * (vx * vx + vy * vy + vz * vz);
      }
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = s;
    }
  }
  out.time = best >= 0 ? features.times[best]! : 0;
  out.cost = best >= 0 ? bestCost : 0;
  return out;
}
