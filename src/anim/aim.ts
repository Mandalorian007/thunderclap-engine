/**
 * Aim offset: a multi-joint `lookAt`. The yaw and pitch from the last joint's forward axis
 * toward a world target are clamped, then spread across a chain (spine, spine, head) by
 * weight, additive on top of the sampled pose. Rotations about one skeleton-space axis add
 * exactly, so the chain's summed turn reaches the clamped target. Same conventions as `ik.ts`:
 * reads `worldPose` (the sampled pose's world matrices), writes local rotations into `pose`;
 * `instanceWorld` is the 3×4 instance matrix or `null` for skeleton-space targets. Allocates
 * in `createAimOffset`, nothing per call.
 */
import {
  anyPerpendicular,
  applyDelta,
  IDENTITY,
  normalize,
  rotateByQuat,
  toSkeleton,
  transformDir,
} from './ik';
import { POSE_NODE_FLOATS, type Pose, type Skeleton, WORLD_NODE_FLOATS } from './pose';
import { quatFromAxisAngle, quatMultiply, quatNormalize, quatSlerp } from './quat';

export interface AimOffsetDesc {
  /** Joints from the base of the chain to the one that aims (the head), ancestors first. */
  joints: ArrayLike<number>;
  /** Share of the turn per joint, normalised to sum 1. Default: equal shares. */
  weights?: ArrayLike<number>;
  /** Largest yaw (radians) either way. Default `Math.PI / 2`. */
  maxYaw?: number;
  /** Largest pitch (radians) either way. Default `Math.PI / 3`. */
  maxPitch?: number;
  /** The aiming joint's local axis that should point at the target. Default `[0, 0, 1]`. */
  forward?: ArrayLike<number>;
  /** Skeleton-space up: yaw turns about it, pitch about the side axis. Default `[0, 1, 0]`. */
  up?: ArrayLike<number>;
}

export interface AimOffsetOptions {
  /** 0..1 blend against the sampled rotations. Default 1. */
  weight?: number;
}

/** An aim chain with its scratch, from `createAimOffset`; `yaw`/`pitch` are the last applied. */
export interface AimOffset {
  readonly joints: Int16Array;
  readonly weights: Float32Array;
  readonly maxYaw: number;
  readonly maxPitch: number;
  readonly forward: Float32Array;
  readonly up: Float32Array;
  /** The clamped yaw of the last `applyAimOffset` (radians, + toward the side axis). */
  yaw: number;
  /** The clamped pitch of the last `applyAimOffset` (radians, + toward `up`). */
  pitch: number;
  /** @internal the input local rotations per joint (for `weight`). */
  readonly saved: Float32Array;
}

const EPS = 1e-6;

/** Validate and allocate an aim chain; call once. Weights are normalised to sum 1. */
export function createAimOffset(skeleton: Skeleton, desc: AimOffsetDesc): AimOffset {
  const n = skeleton.parents.length;
  const joints = Int16Array.from(desc.joints);
  if (joints.length === 0) throw new Error('AimOffset: at least one joint');
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i]!;
    if (j < 0 || j >= n) throw new Error(`AimOffset: joint ${j} must be in [0, ${n})`);
    if (i > 0) {
      // Each joint descends from the one before it.
      let p = skeleton.parents[j]!;
      while (p >= 0 && p !== joints[i - 1]) p = skeleton.parents[p]!;
      if (p < 0) throw new Error(`AimOffset: joint ${j} does not descend from ${joints[i - 1]}`);
    }
  }
  const weights = new Float32Array(joints.length);
  let sum = 0;
  for (let i = 0; i < joints.length; i++) {
    const w = desc.weights ? desc.weights[i] : 1;
    if (w === undefined || w < 0) throw new Error(`AimOffset: weight ${i} must be >= 0`);
    weights[i] = w;
    sum += w;
  }
  if (sum <= 0) throw new Error('AimOffset: weights sum to 0');
  for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / sum;
  const forward = Float32Array.from(desc.forward ?? [0, 0, 1]);
  const up = Float32Array.from(desc.up ?? [0, 1, 0]);
  if (normalize(forward) <= EPS || normalize(up) <= EPS)
    throw new Error('AimOffset: forward and up must be non-zero');
  return {
    joints,
    weights,
    maxYaw: desc.maxYaw ?? Math.PI / 2,
    maxPitch: desc.maxPitch ?? Math.PI / 3,
    forward,
    up,
    yaw: 0,
    pitch: 0,
    saved: new Float32Array(joints.length * 4),
  };
}

const tgt = new Float32Array(3);
const fwd = new Float32Array(3);
const dir = new Float32Array(3);
const side = new Float32Array(3);
const flat = new Float32Array(3);
const qy = new Float32Array(4);
const qp = new Float32Array(4);
const q = new Float32Array(4);
const delta = new Float32Array(4);

/**
 * Turn the chain of `aim` so the last joint's forward points at `targetWorld`, yaw and pitch
 * each clamped, the turn shared by the joints' weights. The pivot is the last joint; the
 * reference forward is that joint's as sampled (an aim offset of zero leaves the pose as it
 * is). `weight` slerps every joint against its sampled rotation. No allocation.
 */
export function applyAimOffset(
  pose: Pose,
  skeleton: Skeleton,
  worldPose: Float32Array,
  aim: AimOffset,
  targetWorld: ArrayLike<number>,
  instanceWorld: Float32Array | null,
  opts?: AimOffsetOptions,
): void {
  const weight = opts?.weight ?? 1;
  aim.yaw = 0;
  aim.pitch = 0;
  if (weight <= 0) return;
  const joints = aim.joints;
  const head = joints[joints.length - 1]!;
  const wo = head * WORLD_NODE_FLOATS;
  toSkeleton(tgt, targetWorld, instanceWorld);
  transformDir(fwd, worldPose, wo, aim.forward);
  if (normalize(fwd) <= EPS) return;
  dir[0] = tgt[0]! - worldPose[wo + 3]!;
  dir[1] = tgt[1]! - worldPose[wo + 7]!;
  dir[2] = tgt[2]! - worldPose[wo + 11]!;
  if (normalize(dir) <= EPS) return;

  // A frame from up and the sampled forward: `flat` is forward levelled, `side` = up × flat.
  const up = aim.up;
  const fu = fwd[0]! * up[0]! + fwd[1]! * up[1]! + fwd[2]! * up[2]!;
  flat[0] = fwd[0]! - up[0]! * fu;
  flat[1] = fwd[1]! - up[1]! * fu;
  flat[2] = fwd[2]! - up[2]! * fu;
  if (normalize(flat) <= EPS) anyPerpendicular(flat, up);
  side[0] = up[1]! * flat[2]! - up[2]! * flat[1]!;
  side[1] = up[2]! * flat[0]! - up[0]! * flat[2]!;
  side[2] = up[0]! * flat[1]! - up[1]! * flat[0]!;
  normalize(side);

  // Yaw and pitch of the target direction relative to the sampled forward.
  const dFlat = dir[0]! * flat[0]! + dir[1]! * flat[1]! + dir[2]! * flat[2]!;
  const dSide = dir[0]! * side[0]! + dir[1]! * side[1]! + dir[2]! * side[2]!;
  const dUp = dir[0]! * up[0]! + dir[1]! * up[1]! + dir[2]! * up[2]!;
  const fFlat = Math.hypot(
    flat[0]! * fu - fwd[0]!,
    flat[1]! * fu - fwd[1]!,
    flat[2]! * fu - fwd[2]!,
  );
  let yaw = Math.atan2(dSide, dFlat);
  let pitch = Math.atan2(dUp, Math.hypot(dFlat, dSide)) - Math.atan2(fu, fFlat);
  if (pitch > Math.PI) pitch -= 2 * Math.PI;
  if (pitch < -Math.PI) pitch += 2 * Math.PI;
  const maxYaw = Math.max(0, aim.maxYaw);
  const maxPitch = Math.max(0, aim.maxPitch);
  yaw = Math.min(maxYaw, Math.max(-maxYaw, yaw));
  pitch = Math.min(maxPitch, Math.max(-maxPitch, pitch));
  aim.yaw = yaw;
  aim.pitch = pitch;
  if (yaw === 0 && pitch === 0) return;

  // One rotation: pitch about the yawed side axis after yaw about up (q = qp · qy). A positive
  // turn about `side = up × flat` lowers the forward, so pitch goes in negated.
  quatFromAxisAngle(qy, 0, up[0]!, up[1]!, up[2]!, yaw);
  rotateByQuat(side, qy, 0);
  quatFromAxisAngle(qp, 0, side[0]!, side[1]!, side[2]!, -pitch);
  quatMultiply(q, 0, qp, 0, qy, 0);
  quatNormalize(q, 0);
  const w = q[3]!;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s <= EPS) return;
  delta[0] = q[0]! / s;
  delta[1] = q[1]! / s;
  delta[2] = q[2]! / s;
  const angle = 2 * Math.atan2(s, w);

  // Share the angle out along the chain. The joints below the first rotate with it, so each
  // delta is taken against the parent's sampled matrix (the axis is the same for all).
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i]!;
    const o = j * POSE_NODE_FLOATS + 3;
    for (let c = 0; c < 4; c++) aim.saved[i * 4 + c] = pose[o + c]!;
    delta[3] = angle * aim.weights[i]!;
    const parent = skeleton.parents[j]!;
    if (parent < 0) applyDelta(pose, j, delta, IDENTITY, 0, null);
    else applyDelta(pose, j, delta, worldPose, parent * WORLD_NODE_FLOATS, null);
    if (weight < 1) quatSlerp(pose, o, aim.saved, i * 4, pose, o, weight);
  }
}
