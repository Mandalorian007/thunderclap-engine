/**
 * Inverse kinematics on a `Pose`: an analytic two-bone solver (feet on uneven ground, a hand on
 * a target) and a one-joint look-at (a head turning to a point). Both run after sampling and
 * before the final `poseToWorld`: they read the world matrices of the pose as sampled
 * (`worldPose`, from a `poseToWorld` the caller already ran, so nothing here walks the skeleton
 * again), and write new local rotations into `pose`. Pure arithmetic; after `createIkChain`
 * nothing allocates per call.
 *
 * Conventions: positions are 3-component `ArrayLike<number>`s; `instanceWorld` is the 3×4
 * row-major instance matrix (`render/transform.ts`) that places the skeleton in the world, or
 * `null` when the target is already in skeleton space. Rotations are expressed as deltas in
 * skeleton space and converted into each joint's parent frame through the parent's world matrix.
 */
import {
  invertAffine,
  multiplyAffine,
  POSE_NODE_FLOATS,
  type Pose,
  type Skeleton,
  WORLD_NODE_FLOATS,
  writeNodeMatrix,
} from './pose';
import { quatFromAxisAngle, quatMultiply, quatNormalize, quatSlerp } from './quat';

/** The three joints of a two-bone chain: `mid` descends from `root`, `tip` from `mid`. */
export interface IkChainDesc {
  root: number;
  mid: number;
  tip: number;
}

/**
 * A two-bone chain with its scratch space, from `createIkChain`. Opaque beyond `root`, `mid`,
 * `tip`; pass it to `twoBoneIk` every frame. A plain `IkChainDesc` works too: `twoBoneIk` builds
 * and caches a chain per object, so keep the object rather than writing a new literal per call.
 */
export interface IkChain extends IkChainDesc {
  /** @internal nodes from `root` to `tip`, parent before child. */
  readonly path: Int16Array;
  /** @internal index of `mid` in `path`. */
  readonly midIndex: number;
  /** @internal world matrices of the path nodes, 12 floats each. */
  readonly world: Float32Array;
  /** @internal the input local rotations of root and mid (for `weight`). */
  readonly saved: Float32Array;
}

export interface TwoBoneIkOptions {
  /** 0..1: how far the solved rotations replace the input ones (slerp). Default 1. */
  weight?: number;
  /**
   * Solve passes. One is exact for rigid bones; a second refines when a chain node carries a
   * non-uniform scale. Default 1.
   */
  maxIterations?: number;
}

export interface LookAtOptions {
  /** 0..1 blend against the input rotation. Default 1. */
  weight?: number;
  /** The joint's local axis that should point at the target. Default `[0, 0, 1]`. */
  forward?: ArrayLike<number>;
  /**
   * World (skeleton-space) up hint: after aiming, the joint rolls about the new forward so the
   * direction that was "up" for it stays up, instead of tilting as it turns. Default: none
   * (the minimal rotation).
   */
  up?: ArrayLike<number>;
  /** Largest angle (radians) the joint turns away from its input forward. Default `Math.PI`. */
  maxAngle?: number;
}

const EPS = 1e-6;

/**
 * Build a chain for `twoBoneIk` over `skeleton`: validates that `mid` descends from `root` and
 * `tip` from `mid` (intermediate nodes, such as twist bones, are allowed) and allocates the
 * scratch space the solver needs. Allocates; call once per chain.
 */
export function createIkChain(skeleton: Skeleton, chain: IkChainDesc): IkChain {
  const { root, mid, tip } = chain;
  const parents = skeleton.parents;
  const n = parents.length;
  if (root < 0 || root >= n || mid < 0 || mid >= n || tip < 0 || tip >= n) {
    throw new Error(`IkChain: nodes ${root}, ${mid}, ${tip} must be in [0, ${n})`);
  }
  const nodes: number[] = [];
  let node = tip;
  let midIndex = -1;
  while (node >= 0 && node !== root) {
    nodes.push(node);
    node = parents[node]!;
  }
  if (node !== root) throw new Error(`IkChain: tip ${tip} does not descend from root ${root}`);
  nodes.push(root);
  nodes.reverse();
  midIndex = nodes.indexOf(mid);
  if (midIndex <= 0 || midIndex >= nodes.length - 1) {
    throw new Error(`IkChain: mid ${mid} must lie strictly between root ${root} and tip ${tip}`);
  }
  return {
    root,
    mid,
    tip,
    path: Int16Array.from(nodes),
    midIndex,
    world: new Float32Array(nodes.length * WORLD_NODE_FLOATS),
    saved: new Float32Array(8),
  };
}

const chains = new WeakMap<IkChainDesc, IkChain>();
function chainFor(skeleton: Skeleton, chain: IkChainDesc): IkChain {
  if ('path' in chain) return chain as IkChain;
  let c = chains.get(chain);
  if (!c || c.root !== chain.root || c.mid !== chain.mid || c.tip !== chain.tip) {
    c = createIkChain(skeleton, chain);
    chains.set(chain, c);
  }
  return c;
}

// Scratch, module level: no allocation per call.
const inv = new Float32Array(WORLD_NODE_FLOATS);
const local = new Float32Array(WORLD_NODE_FLOATS);
const tgt = new Float32Array(3);
const pol = new Float32Array(3);
const dir = new Float32Array(3);
const perp = new Float32Array(3);
const v = new Float32Array(3);
const m2 = new Float32Array(3);
const t1 = new Float32Array(3);
/** A rotation delta in skeleton space: unit axis, angle. */
const d1 = new Float32Array(4);
const d2 = new Float32Array(4);
const dq = new Float32Array(4);
const axis = new Float32Array(3);
const fwd = new Float32Array(3);
const upw = new Float32Array(3);
const savedRot = new Float32Array(4);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** `out = m[mo..] · p` (point, with translation). */
function transformPoint(
  out: Float32Array,
  m: ArrayLike<number>,
  mo: number,
  p: ArrayLike<number>,
): void {
  const x = p[0]!;
  const y = p[1]!;
  const z = p[2]!;
  out[0] = m[mo]! * x + m[mo + 1]! * y + m[mo + 2]! * z + m[mo + 3]!;
  out[1] = m[mo + 4]! * x + m[mo + 5]! * y + m[mo + 6]! * z + m[mo + 7]!;
  out[2] = m[mo + 8]! * x + m[mo + 9]! * y + m[mo + 10]! * z + m[mo + 11]!;
}

/** `out = upper3x3(m[mo..]) · d` (direction, no translation); `out` may alias `d`. */
function transformDir(
  out: Float32Array,
  m: ArrayLike<number>,
  mo: number,
  d: ArrayLike<number>,
): void {
  const x = d[0]!;
  const y = d[1]!;
  const z = d[2]!;
  out[0] = m[mo]! * x + m[mo + 1]! * y + m[mo + 2]! * z;
  out[1] = m[mo + 4]! * x + m[mo + 5]! * y + m[mo + 6]! * z;
  out[2] = m[mo + 8]! * x + m[mo + 9]! * y + m[mo + 10]! * z;
}

/** A world-space point into skeleton space through the inverse of `instanceWorld`. */
function toSkeleton(out: Float32Array, p: ArrayLike<number>, instanceWorld: Float32Array | null) {
  if (!instanceWorld) {
    out[0] = p[0]!;
    out[1] = p[1]!;
    out[2] = p[2]!;
    return;
  }
  invertAffine(inv, 0, instanceWorld, 0);
  transformPoint(out, inv, 0, p);
}

function normalize(a: Float32Array): number {
  const len = Math.hypot(a[0]!, a[1]!, a[2]!);
  if (len > EPS) {
    const s = 1 / len;
    a[0]! *= s;
    a[1]! *= s;
    a[2]! *= s;
  }
  return len;
}

/** Any unit vector perpendicular to the unit vector `u`, into `out`. */
function anyPerpendicular(out: Float32Array, u: Float32Array): void {
  const ax = Math.abs(u[0]!);
  const ay = Math.abs(u[1]!);
  const az = Math.abs(u[2]!);
  // Cross with the axis u is least aligned with.
  if (ax <= ay && ax <= az) {
    out[0] = 0;
    out[1] = -u[2]!;
    out[2] = u[1]!;
  } else if (ay <= az) {
    out[0] = u[2]!;
    out[1] = 0;
    out[2] = -u[0]!;
  } else {
    out[0] = -u[1]!;
    out[1] = u[0]!;
    out[2] = 0;
  }
  normalize(out);
}

/** The shortest rotation taking unit `a` onto unit `b`, as (unit axis, angle) in `out`. */
function rotationBetween(out: Float32Array, a: Float32Array, b: Float32Array): void {
  const cx = a[1]! * b[2]! - a[2]! * b[1]!;
  const cy = a[2]! * b[0]! - a[0]! * b[2]!;
  const cz = a[0]! * b[1]! - a[1]! * b[0]!;
  const sin = Math.hypot(cx, cy, cz);
  const cos = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  if (sin < EPS) {
    if (cos >= 0) {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
    } else {
      anyPerpendicular(out, a);
      out[3] = Math.PI;
    }
    return;
  }
  out[0] = cx / sin;
  out[1] = cy / sin;
  out[2] = cz / sin;
  out[3] = Math.atan2(sin, cos);
}

/** Rotate `p` in place by the (unit axis, angle) delta `d` (Rodrigues). */
function rotateBy(p: Float32Array, d: Float32Array, angle = d[3]!): void {
  const kx = d[0]!;
  const ky = d[1]!;
  const kz = d[2]!;
  const x = p[0]!;
  const y = p[1]!;
  const z = p[2]!;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = (kx * x + ky * y + kz * z) * (1 - c);
  p[0] = x * c + (ky * z - kz * y) * s + kx * dot;
  p[1] = y * c + (kz * x - kx * z) * s + ky * dot;
  p[2] = z * c + (kx * y - ky * x) * s + kz * dot;
}

/**
 * Pre-multiply the local rotation of `node` by the skeleton-space delta `d` (unit axis, angle):
 * the axis goes through the inverse of the parent's world 3×3 (`parent`, or the identity for a
 * skeleton root), after an optional extra rotation `pre` of the axis (used when the parent itself
 * has just been rotated by `pre` and `parent` still holds its old matrix).
 */
function applyDelta(
  pose: Pose,
  node: number,
  d: Float32Array,
  parent: ArrayLike<number>,
  po: number,
  pre: Float32Array | null,
): void {
  if (d[3] === 0) return;
  axis[0] = d[0]!;
  axis[1] = d[1]!;
  axis[2] = d[2]!;
  if (pre) rotateBy(axis, pre, -pre[3]!);
  invertAffine(inv, 0, parent, po);
  transformDir(axis, inv, 0, axis);
  if (normalize(axis) <= EPS) return;
  quatFromAxisAngle(dq, 0, axis[0]!, axis[1]!, axis[2]!, d[3]!);
  const o = node * POSE_NODE_FLOATS + 3;
  quatMultiply(pose, o, dq, 0, pose, o);
  quatNormalize(pose, o);
}

/** Recompute the chain's world matrices from `pose`, the root's parent read from `worldPose`. */
function refreshChain(c: IkChain, skeleton: Skeleton, pose: Pose, worldPose: Float32Array): void {
  const path = c.path;
  for (let i = 0; i < path.length; i++) {
    const node = path[i]!;
    const o = i * WORLD_NODE_FLOATS;
    if (i === 0) {
      const p = skeleton.parents[node]!;
      if (p < 0) writeNodeMatrix(c.world, o, pose, node * POSE_NODE_FLOATS);
      else {
        writeNodeMatrix(local, 0, pose, node * POSE_NODE_FLOATS);
        multiplyAffine(c.world, o, worldPose, p * WORLD_NODE_FLOATS, local, 0);
      }
    } else {
      writeNodeMatrix(local, 0, pose, node * POSE_NODE_FLOATS);
      multiplyAffine(c.world, o, c.world, o - WORLD_NODE_FLOATS, local, 0);
    }
  }
}

/**
 * Analytic two-bone IK (law of cosines) with a pole vector. Rotates `chain.root` and `chain.mid`
 * in `pose` so that `chain.tip` reaches `targetWorld`; an unreachable target straightens the
 * chain towards it (no stretching). `poleWorld` picks the bend side (the mid joint moves towards
 * it); `null` keeps the chain's current bend plane. `worldPose` is `poseToWorld` of `pose` as it
 * is on entry (the solver reads it, never rewrites it). `instanceWorld` (3×4 row-major) maps
 * skeleton space to the space the target and pole are given in. `weight` slerps the result
 * against the input rotations. No allocation when `chain` is an `IkChain` (or a reused object).
 */
export function twoBoneIk(
  pose: Pose,
  skeleton: Skeleton,
  worldPose: Float32Array,
  chain: IkChainDesc,
  targetWorld: ArrayLike<number>,
  poleWorld: ArrayLike<number> | null,
  instanceWorld: Float32Array | null,
  opts?: TwoBoneIkOptions,
): void {
  const weight = opts?.weight ?? 1;
  if (weight <= 0) return;
  const iterations = Math.max(1, opts?.maxIterations ?? 1);
  const c = chainFor(skeleton, chain);
  const path = c.path;
  const last = path.length - 1;
  const rootO = c.root * POSE_NODE_FLOATS + 3;
  const midO = c.mid * POSE_NODE_FLOATS + 3;
  for (let i = 0; i < 4; i++) {
    c.saved[i] = pose[rootO + i]!;
    c.saved[4 + i] = pose[midO + i]!;
  }
  for (let i = 0; i <= last; i++) {
    const wo = path[i]! * WORLD_NODE_FLOATS;
    c.world.set(worldPose.subarray(wo, wo + WORLD_NODE_FLOATS), i * WORLD_NODE_FLOATS);
  }
  toSkeleton(tgt, targetWorld, instanceWorld);
  if (poleWorld) toSkeleton(pol, poleWorld, instanceWorld);

  const W = c.world;
  const mo = c.midIndex * WORLD_NODE_FLOATS;
  const to = last * WORLD_NODE_FLOATS;
  for (let iter = 0; iter < iterations; iter++) {
    const rx = W[3]!;
    const ry = W[7]!;
    const rz = W[11]!;
    const mx = W[mo + 3]!;
    const my = W[mo + 7]!;
    const mz = W[mo + 11]!;
    const tx = W[to + 3]!;
    const ty = W[to + 7]!;
    const tz = W[to + 11]!;
    const a = Math.hypot(mx - rx, my - ry, mz - rz);
    const b = Math.hypot(tx - mx, ty - my, tz - mz);
    if (a <= EPS || b <= EPS) break;
    dir[0] = tgt[0]! - rx;
    dir[1] = tgt[1]! - ry;
    dir[2] = tgt[2]! - rz;
    const d = normalize(dir);
    if (d <= EPS) break;
    // Out of reach: straight towards the target (cos 1); too close: folded (cos ±1).
    const reach = Math.max(d, Math.abs(a - b), EPS);
    const cos =
      d >= a + b ? 1 : Math.min(1, Math.max(-1, (a * a + reach * reach - b * b) / (2 * a * reach)));
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));

    // Bend direction: the pole (or the current mid) projected off the root→target line.
    if (poleWorld) {
      v[0] = pol[0]! - rx;
      v[1] = pol[1]! - ry;
      v[2] = pol[2]! - rz;
    } else {
      v[0] = mx - rx;
      v[1] = my - ry;
      v[2] = mz - rz;
    }
    let along = v[0]! * dir[0]! + v[1]! * dir[1]! + v[2]! * dir[2]!;
    perp[0] = v[0]! - dir[0]! * along;
    perp[1] = v[1]! - dir[1]! * along;
    perp[2] = v[2]! - dir[2]! * along;
    if (normalize(perp) <= 1e-4) {
      if (poleWorld) {
        // Pole on the line: fall back to the chain's own bend, then to anything perpendicular.
        v[0] = mx - rx;
        v[1] = my - ry;
        v[2] = mz - rz;
        along = v[0]! * dir[0]! + v[1]! * dir[1]! + v[2]! * dir[2]!;
        perp[0] = v[0]! - dir[0]! * along;
        perp[1] = v[1]! - dir[1]! * along;
        perp[2] = v[2]! - dir[2]! * along;
      }
      if (normalize(perp) <= 1e-4) anyPerpendicular(perp, dir);
    }

    // Where the mid joint must be, then the root rotation that puts it there.
    m2[0] = rx + dir[0]! * a * cos + perp[0]! * a * sin;
    m2[1] = ry + dir[1]! * a * cos + perp[1]! * a * sin;
    m2[2] = rz + dir[2]! * a * cos + perp[2]! * a * sin;
    v[0] = (mx - rx) / a;
    v[1] = (my - ry) / a;
    v[2] = (mz - rz) / a;
    perp[0] = (m2[0]! - rx) / a;
    perp[1] = (m2[1]! - ry) / a;
    perp[2] = (m2[2]! - rz) / a;
    rotationBetween(d1, v, perp);

    // The tip after the root rotation, then the mid rotation that brings it to the target.
    t1[0] = tx - rx;
    t1[1] = ty - ry;
    t1[2] = tz - rz;
    rotateBy(t1, d1);
    t1[0] = t1[0]! + rx - m2[0]!;
    t1[1] = t1[1]! + ry - m2[1]!;
    t1[2] = t1[2]! + rz - m2[2]!;
    normalize(t1);
    v[0] = tgt[0]! - m2[0]!;
    v[1] = tgt[1]! - m2[1]!;
    v[2] = tgt[2]! - m2[2]!;
    if (normalize(v) <= EPS) {
      d2[3] = 0;
    } else rotationBetween(d2, t1, v);

    const rootParent = skeleton.parents[c.root]!;
    if (rootParent < 0) applyDelta(pose, c.root, d1, IDENTITY, 0, null);
    else applyDelta(pose, c.root, d1, worldPose, rootParent * WORLD_NODE_FLOATS, null);
    applyDelta(pose, c.mid, d2, W, mo - WORLD_NODE_FLOATS, d1);
    if (iter + 1 < iterations) refreshChain(c, skeleton, pose, worldPose);
  }

  if (weight < 1) {
    quatSlerp(pose, rootO, c.saved, 0, pose, rootO, weight);
    quatSlerp(pose, midO, c.saved, 4, pose, midO, weight);
  }
}

const DEFAULT_FORWARD = new Float32Array([0, 0, 1]);

/**
 * Rotate `joint` in `pose` so that its local `forward` axis points at `targetWorld`, turning at
 * most `maxAngle` radians away from its input direction and blended by `weight`. With an `up`
 * hint the joint also rolls so what was up for it stays up. Reads the joint's world matrix from
 * `worldPose` (`poseToWorld` of the input pose) and its parent's; never rewrites it. No
 * allocation.
 */
export function lookAt(
  pose: Pose,
  skeleton: Skeleton,
  worldPose: Float32Array,
  joint: number,
  targetWorld: ArrayLike<number>,
  instanceWorld: Float32Array | null,
  opts?: LookAtOptions,
): void {
  const weight = opts?.weight ?? 1;
  if (weight <= 0) return;
  const maxAngle = opts?.maxAngle ?? Math.PI;
  const wo = joint * WORLD_NODE_FLOATS;
  toSkeleton(tgt, targetWorld, instanceWorld);
  transformDir(fwd, worldPose, wo, opts?.forward ?? DEFAULT_FORWARD);
  if (normalize(fwd) <= EPS) return;
  v[0] = tgt[0]! - worldPose[wo + 3]!;
  v[1] = tgt[1]! - worldPose[wo + 7]!;
  v[2] = tgt[2]! - worldPose[wo + 11]!;
  if (normalize(v) <= EPS) return;
  rotationBetween(d1, fwd, v);
  d1[3] = Math.min(d1[3]!, Math.max(0, maxAngle));
  if (d1[3] === 0) return;

  const o = joint * POSE_NODE_FLOATS + 3;
  for (let i = 0; i < 4; i++) savedRot[i] = pose[o + i]!;
  const parent = skeleton.parents[joint]!;
  const pm = parent < 0 ? IDENTITY : worldPose;
  const po = parent < 0 ? 0 : parent * WORLD_NODE_FLOATS;
  applyDelta(pose, joint, d1, pm, po, null);

  const up = opts?.up;
  if (up) {
    // The up hint off the old forward, carried along by the aim, against the hint off the new
    // forward: the roll between them is the twist that keeps "up" up.
    upw[0] = up[0]!;
    upw[1] = up[1]!;
    upw[2] = up[2]!;
    let along = upw[0]! * fwd[0]! + upw[1]! * fwd[1]! + upw[2]! * fwd[2]!;
    t1[0] = upw[0]! - fwd[0]! * along;
    t1[1] = upw[1]! - fwd[1]! * along;
    t1[2] = upw[2]! - fwd[2]! * along;
    rotateBy(fwd, d1);
    if (normalize(t1) > EPS) {
      rotateBy(t1, d1);
      along = upw[0]! * fwd[0]! + upw[1]! * fwd[1]! + upw[2]! * fwd[2]!;
      m2[0] = upw[0]! - fwd[0]! * along;
      m2[1] = upw[1]! - fwd[1]! * along;
      m2[2] = upw[2]! - fwd[2]! * along;
      if (normalize(m2) > EPS) {
        rotationBetween(d2, t1, m2);
        applyDelta(pose, joint, d2, pm, po, null);
      }
    }
  }

  if (weight < 1) quatSlerp(pose, o, savedRot, 0, pose, o, weight);
}
