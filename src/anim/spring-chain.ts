/**
 * Secondary motion: a chain of joints (tail, cape, hair, antenna) simulated as Verlet particles
 * in instance space that spring back toward the sampled pose, with gravity, damping, bone-length
 * constraints, an angle limit and sphere/capsule colliders. After the step the joints' local
 * rotations are rewritten so each bone points at its simulated child; translations are kept.
 * The rest position each frame is the sampled pose, so the animation still drives the chain
 * and the simulation adds lag and sway. Same conventions as `ik.ts`: `worldPose` is
 * `poseToWorld` of the sampled `pose`, `instanceWorld` is the 3×4 instance matrix (`null` for
 * the identity). Allocates in `createSpringChain`, nothing per frame.
 */
import {
  anyPerpendicular,
  applyDelta,
  IDENTITY,
  normalize,
  rotateBy,
  rotateByQuat,
  rotationBetween,
  transformDir,
  transformPoint,
} from './ik';
import { invertAffine, type Pose, type Skeleton, WORLD_NODE_FLOATS } from './pose';
import { quatFromAxisAngle, quatMultiply, quatNormalize } from './quat';

/** A sphere in instance space. */
export interface SpringSphere {
  center: ArrayLike<number>;
  radius: number;
}
/** A capsule in instance space: the segment `a`–`b` swept by `radius`. */
export interface SpringCapsule {
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  radius: number;
}
export type SpringCollider = SpringSphere | SpringCapsule;

export interface SpringChainDesc {
  /** The first joint of the chain; it is pinned to the animation and only turns. */
  root: number;
  /** The last joint: the chain is every node on the path from `root` down to `tip`. */
  tip?: number;
  /** Or the joints in order, parent before child, as an alternative to `tip`. */
  joints?: ArrayLike<number>;
  /** Spring toward the sampled position, per second². Default 80. */
  stiffness?: number;
  /** Velocity decay per second. Default 6. */
  damping?: number;
  /** Instance-space gravity, units per second². Default `[0, -9.8, 0]`. */
  gravity?: ArrayLike<number>;
  /** 0..1: the fraction of the sampled pose's own motion the joints inherit. Default 0. */
  drag?: number;
  /** Joint radius for collisions. Default 0. */
  radius?: number;
  /** Largest angle (radians) a bone may swing away from its sampled direction. Default π. */
  limitAngle?: number;
  /** Colliders, read every frame (mutate them in place to move them). */
  collide?: SpringCollider[];
  /** Largest sub-step; a frame is split into equal steps no longer than this. Default 1/120. */
  maxDt?: number;
  /** A root jump beyond this (instance units) in one frame shifts the chain with no velocity. Default 1. */
  teleportDistance?: number;
}

/** A spring chain with its state, from `createSpringChain`. */
export interface SpringChain {
  readonly joints: Int16Array;
  stiffness: number;
  damping: number;
  readonly gravity: Float32Array;
  drag: number;
  radius: number;
  limitAngle: number;
  collide: SpringCollider[];
  maxDt: number;
  teleportDistance: number;
  /** Simulated joint positions in instance space, 3 per joint, after the last update. */
  readonly positions: Float32Array;
  /** The sampled joint positions in instance space, 3 per joint, from the last update. */
  readonly animated: Float32Array;
  /** Forget the state: the next update starts the chain at the sampled pose with no velocity. */
  reset(): void;
  /** @internal */
  readonly prev: Float32Array;
  /** @internal */
  readonly animPrev: Float32Array;
  /** @internal */
  readonly lengths: Float32Array;
  /** @internal */
  started: boolean;
}

const EPS = 1e-6;

/** Validate and allocate; call once. */
export function createSpringChain(skeleton: Skeleton, desc: SpringChainDesc): SpringChain {
  const n = skeleton.parents.length;
  let joints: Int16Array;
  if (desc.joints) {
    joints = Int16Array.from(desc.joints);
    if (joints.length < 2) throw new Error('SpringChain: at least two joints');
    if (joints[0] !== desc.root) throw new Error('SpringChain: joints must start at root');
  } else {
    if (desc.tip === undefined) throw new Error('SpringChain: tip or joints');
    let count = 0;
    for (let j = desc.tip; j >= 0 && j !== desc.root; j = skeleton.parents[j]!) count++;
    joints = new Int16Array(count + 1);
    let j = desc.tip;
    for (let i = count; i >= 1; i--) {
      joints[i] = j;
      j = skeleton.parents[j]!;
    }
    joints[0] = j;
    if (j !== desc.root) throw new Error(`SpringChain: tip ${desc.tip} does not descend from root`);
  }
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i]!;
    if (j < 0 || j >= n) throw new Error(`SpringChain: joint ${j} must be in [0, ${n})`);
    if (i > 0) {
      let p = skeleton.parents[j]!;
      while (p >= 0 && p !== joints[i - 1]) p = skeleton.parents[p]!;
      if (p < 0) throw new Error(`SpringChain: joint ${j} does not descend from ${joints[i - 1]}`);
    }
  }
  const count = joints.length;
  return {
    joints,
    stiffness: desc.stiffness ?? 80,
    damping: desc.damping ?? 6,
    gravity: Float32Array.from(desc.gravity ?? [0, -9.8, 0]),
    drag: desc.drag ?? 0,
    radius: desc.radius ?? 0,
    limitAngle: desc.limitAngle ?? Math.PI,
    collide: desc.collide ?? [],
    maxDt: desc.maxDt ?? 1 / 120,
    teleportDistance: desc.teleportDistance ?? 1,
    positions: new Float32Array(count * 3),
    animated: new Float32Array(count * 3),
    prev: new Float32Array(count * 3),
    animPrev: new Float32Array(count * 3),
    lengths: new Float32Array(count),
    started: false,
    reset() {
      this.started = false;
    },
  };
}

const inv = new Float32Array(WORLD_NODE_FLOATS);
const p = new Float32Array(3);
const a = new Float32Array(3);
const b = new Float32Array(3);
const delta = new Float32Array(4);
const acc = new Float32Array(4);
const dq = new Float32Array(4);

/**
 * Step the chain by `dt` (split into sub-steps of at most `maxDt`) and rewrite the chain's
 * rotations in `pose`. Call after sampling and `poseToWorld`, before skinning. No allocation.
 */
export function updateSpringChain(
  pose: Pose,
  skeleton: Skeleton,
  worldPose: Float32Array,
  chain: SpringChain,
  instanceWorld: Float32Array | null,
  dt: number,
): void {
  const joints = chain.joints;
  const count = joints.length;
  const pos = chain.positions;
  const prev = chain.prev;
  const anim = chain.animated;
  const animPrev = chain.animPrev;

  // Sampled positions into instance space; bone lengths from them.
  animPrev.set(anim);
  for (let i = 0; i < count; i++) {
    const wo = joints[i]! * WORLD_NODE_FLOATS;
    p[0] = worldPose[wo + 3]!;
    p[1] = worldPose[wo + 7]!;
    p[2] = worldPose[wo + 11]!;
    if (instanceWorld) transformPoint(a, instanceWorld, 0, p);
    else a.set(p);
    anim[i * 3] = a[0]!;
    anim[i * 3 + 1] = a[1]!;
    anim[i * 3 + 2] = a[2]!;
    if (i > 0) {
      chain.lengths[i] = Math.hypot(
        a[0]! - anim[i * 3 - 3]!,
        a[1]! - anim[i * 3 - 2]!,
        a[2]! - anim[i * 3 - 1]!,
      );
    }
  }

  if (!chain.started) {
    pos.set(anim);
    prev.set(anim);
    animPrev.set(anim);
    chain.started = true;
  } else {
    // A teleport moves the whole chain with the root, keeping its velocity.
    const sx = anim[0]! - animPrev[0]!;
    const sy = anim[1]! - animPrev[1]!;
    const sz = anim[2]! - animPrev[2]!;
    if (Math.hypot(sx, sy, sz) > chain.teleportDistance) {
      for (let i = 0; i < count; i++) {
        pos[i * 3] = pos[i * 3]! + sx;
        pos[i * 3 + 1] = pos[i * 3 + 1]! + sy;
        pos[i * 3 + 2] = pos[i * 3 + 2]! + sz;
        prev[i * 3] = prev[i * 3]! + sx;
        prev[i * 3 + 1] = prev[i * 3 + 1]! + sy;
        prev[i * 3 + 2] = prev[i * 3 + 2]! + sz;
        animPrev[i * 3] = animPrev[i * 3]! + sx;
        animPrev[i * 3 + 1] = animPrev[i * 3 + 1]! + sy;
        animPrev[i * 3 + 2] = animPrev[i * 3 + 2]! + sz;
      }
    }
  }

  // Verlet sub-steps.
  const steps = dt > 0 ? Math.max(1, Math.ceil(dt / Math.max(chain.maxDt, 1e-4))) : 0;
  const h = steps > 0 ? dt / steps : 0;
  const decay = Math.max(0, 1 - chain.damping * h);
  const drag = Math.min(1, Math.max(0, chain.drag)) / Math.max(1, steps);
  const k = chain.stiffness * h * h;
  const gx = chain.gravity[0]! * h * h;
  const gy = chain.gravity[1]! * h * h;
  const gz = chain.gravity[2]! * h * h;
  const limit = chain.limitAngle;
  for (let s = 0; s < steps; s++) {
    // Integrate every joint but the pinned root.
    for (let i = 1; i < count; i++) {
      const o = i * 3;
      const x = pos[o]!;
      const y = pos[o + 1]!;
      const z = pos[o + 2]!;
      const vx = (x - prev[o]!) * decay + (anim[o]! - animPrev[o]!) * drag;
      const vy = (y - prev[o + 1]!) * decay + (anim[o + 1]! - animPrev[o + 1]!) * drag;
      const vz = (z - prev[o + 2]!) * decay + (anim[o + 2]! - animPrev[o + 2]!) * drag;
      prev[o] = x;
      prev[o + 1] = y;
      prev[o + 2] = z;
      pos[o] = x + vx + (anim[o]! - x) * k + gx;
      pos[o + 1] = y + vy + (anim[o + 1]! - y) * k + gy;
      pos[o + 2] = z + vz + (anim[o + 2]! - z) * k + gz;
    }
    pos[0] = anim[0]!;
    pos[1] = anim[1]!;
    pos[2] = anim[2]!;
    // Constraints, parent before child: bone length, angle limit, colliders.
    for (let i = 1; i < count; i++) {
      const o = i * 3;
      const po = o - 3;
      const len = chain.lengths[i]!;
      a[0] = pos[o]! - pos[po]!;
      a[1] = pos[o + 1]! - pos[po + 1]!;
      a[2] = pos[o + 2]! - pos[po + 2]!;
      if (normalize(a) <= EPS) {
        b[0] = anim[o]! - anim[po]!;
        b[1] = anim[o + 1]! - anim[po + 1]!;
        b[2] = anim[o + 2]! - anim[po + 2]!;
        if (normalize(b) <= EPS) anyPerpendicular(b, UP);
        a.set(b);
      }
      if (limit < Math.PI) {
        b[0] = anim[o]! - anim[po]!;
        b[1] = anim[o + 1]! - anim[po + 1]!;
        b[2] = anim[o + 2]! - anim[po + 2]!;
        if (normalize(b) > EPS) {
          rotationBetween(delta, b, a);
          if (delta[3]! > limit) {
            a.set(b);
            rotateBy(a, delta, limit);
          }
        }
      }
      pos[o] = pos[po]! + a[0]! * len;
      pos[o + 1] = pos[po + 1]! + a[1]! * len;
      pos[o + 2] = pos[po + 2]! + a[2]! * len;
      const colliders = chain.collide;
      for (let c = 0; c < colliders.length; c++) pushOut(pos, o, colliders[c]!, chain.radius);
    }
  }

  // Rotations: each joint turns so its bone points at the simulated child. Deltas accumulate
  // down the chain (`acc`, instance space); each one's axis is taken back through the
  // accumulated turn and the instance matrix before `applyDelta` sees the parent's old matrix.
  if (instanceWorld) invertAffine(inv, 0, instanceWorld, 0);
  acc[0] = 0;
  acc[1] = 0;
  acc[2] = 0;
  acc[3] = 1;
  for (let i = 0; i + 1 < count; i++) {
    const o = i * 3;
    a[0] = anim[o + 3]! - anim[o]!;
    a[1] = anim[o + 4]! - anim[o + 1]!;
    a[2] = anim[o + 5]! - anim[o + 2]!;
    if (normalize(a) <= EPS) continue;
    rotateByQuat(a, acc, 0);
    b[0] = pos[o + 3]! - pos[o]!;
    b[1] = pos[o + 4]! - pos[o + 1]!;
    b[2] = pos[o + 5]! - pos[o + 2]!;
    if (normalize(b) <= EPS) continue;
    rotationBetween(delta, a, b);
    if (delta[3]! < 1e-7) continue;
    quatFromAxisAngle(dq, 0, delta[0]!, delta[1]!, delta[2]!, delta[3]!);
    // Axis into the frame the parent's sampled matrix lives in.
    acc[0] = -acc[0]!;
    acc[1] = -acc[1]!;
    acc[2] = -acc[2]!;
    rotateByQuat(delta, acc, 0);
    acc[0] = -acc[0]!;
    acc[1] = -acc[1]!;
    acc[2] = -acc[2]!;
    if (instanceWorld) {
      transformDir(delta, inv, 0, delta);
      normalize(delta);
    }
    const j = joints[i]!;
    const parent = skeleton.parents[j]!;
    if (parent < 0) applyDelta(pose, j, delta, IDENTITY, 0, null);
    else applyDelta(pose, j, delta, worldPose, parent * WORLD_NODE_FLOATS, null);
    quatMultiply(acc, 0, dq, 0, acc, 0);
    quatNormalize(acc, 0);
  }
}

const UP = new Float32Array([0, 1, 0]);
const cp = new Float32Array(3);

/** Move `pos[o..]` out of `c`, keeping `radius` clear of its surface. */
function pushOut(pos: Float32Array, o: number, c: SpringCollider, radius: number): void {
  const x = pos[o]!;
  const y = pos[o + 1]!;
  const z = pos[o + 2]!;
  if ('a' in c) {
    // Closest point on the segment.
    const ax = c.a[0]!;
    const ay = c.a[1]!;
    const az = c.a[2]!;
    const dx = c.b[0]! - ax;
    const dy = c.b[1]! - ay;
    const dz = c.b[2]! - az;
    const dd = dx * dx + dy * dy + dz * dz;
    let t = dd > EPS ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / dd : 0;
    t = Math.min(1, Math.max(0, t));
    cp[0] = ax + dx * t;
    cp[1] = ay + dy * t;
    cp[2] = az + dz * t;
  } else {
    cp[0] = c.center[0]!;
    cp[1] = c.center[1]!;
    cp[2] = c.center[2]!;
  }
  const nx = x - cp[0]!;
  const ny = y - cp[1]!;
  const nz = z - cp[2]!;
  const dist = Math.hypot(nx, ny, nz);
  const want = c.radius + radius;
  if (dist >= want) return;
  if (dist <= EPS) {
    pos[o + 1] = y + want;
    return;
  }
  const s = want / dist;
  pos[o] = cp[0]! + nx * s;
  pos[o + 1] = cp[1]! + ny * s;
  pos[o + 2] = cp[2]! + nz * s;
}
