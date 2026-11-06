/**
 * Foot placement: a probe (the game's ground query) under each foot, a pelvis that sinks to the
 * lowest foot, two-bone IK per leg to hold the feet on the probed ground and a tilt of each foot
 * onto the ground normal. The animation's floor is the instance origin's plane (`y` of the
 * instance translation); each foot's lift is the probed height above that plane, clamped to
 * `[-maxDrop, maxLift]`. Same conventions as `ik.ts`: `worldPose` is `poseToWorld` of the sampled
 * `pose`, which this rewrites (translations of `pelvis`, rotations of root/mid/tip per foot).
 * Flat ground at the origin plane leaves the pose untouched, bit for bit. Allocates in
 * `createFootIk` (the chains and a world buffer), nothing per frame; the probe must not either.
 */
import {
  applyDelta,
  createIkChain,
  IDENTITY,
  type IkChain,
  normalize,
  rotationBetween,
  transformDir,
  transformPoint,
  twoBoneIk,
} from './ik';
import {
  invertAffine,
  multiplyAffine,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  type Skeleton,
  WORLD_NODE_FLOATS,
} from './pose';

/** One leg: `mid` descends from `root` (hip), `tip` (ankle) from `mid`; `toe` is probed too. */
export interface FootIkFootDesc {
  root: number;
  mid: number;
  tip: number;
  /** Optional toe joint: the ground is probed under it as well and the higher hit is used. */
  toe?: number;
  /** Skeleton-space direction the knee bends toward when the leg is straight. Default +Z. */
  bend?: ArrayLike<number>;
}

/**
 * The ground query, in instance (world) space: writes `[y, nx, ny, nz]` for the ground under
 * `(x, z)` into `out` and returns `true`, or returns `false` for no ground (the foot is left to
 * the animation). It is called once per foot (twice with a toe) per `applyFootIk`.
 */
export type FootIkProbe = (x: number, z: number, out: Float32Array) => boolean;

export interface FootIkDesc {
  feet: FootIkFootDesc[];
  probe: FootIkProbe;
  /** The joint whose translation sinks toward the lowest foot (hips). */
  pelvis: number;
  /** Furthest a foot rises above the animation's floor (world units). Default 0.5. */
  maxLift?: number;
  /** Furthest a foot drops below it. Default 0.5. */
  maxDrop?: number;
  /** Pelvis smoothing rate per second (exponential approach). Default 12. */
  blend?: number;
}

/** The feet with their scratch, from `createFootIk`. Read `pelvisOffset` and `lift`. */
export interface FootIk {
  readonly feet: readonly FootIkFootDesc[];
  readonly probe: FootIkProbe;
  readonly pelvis: number;
  readonly maxLift: number;
  readonly maxDrop: number;
  readonly blend: number;
  /** The current pelvis sink (world units, ≤ 0 going down), smoothed. */
  pelvisOffset: number;
  /** Per foot, the clamped ground height above the floor that the foot was placed at. */
  readonly lift: Float32Array;
  /** Per foot, 1 when the probe hit. */
  readonly grounded: Uint8Array;
  /** @internal */
  readonly chains: IkChain[];
  /** @internal per foot, the bend direction (unit, skeleton space). */
  readonly bends: Float32Array;
  /** @internal per foot, the ground normal in skeleton space (unit). */
  readonly normals: Float32Array;
  /** @internal per foot, the sampled tip position in skeleton space. */
  readonly tips: Float32Array;
  /** @internal world matrices of the pose after the pelvis moved. */
  readonly world: Float32Array;
}

const EPS = 1e-6;

/** Validate and allocate; call once. */
export function createFootIk(skeleton: Skeleton, desc: FootIkDesc): FootIk {
  const n = skeleton.parents.length;
  if (desc.feet.length === 0) throw new Error('FootIk: at least one foot');
  if (desc.pelvis < 0 || desc.pelvis >= n) throw new Error(`FootIk: pelvis ${desc.pelvis}`);
  const chains: IkChain[] = [];
  const bends = new Float32Array(desc.feet.length * 3);
  for (let i = 0; i < desc.feet.length; i++) {
    const f = desc.feet[i]!;
    chains.push(createIkChain(skeleton, f));
    if (f.toe !== undefined && (f.toe < 0 || f.toe >= n)) throw new Error(`FootIk: toe ${f.toe}`);
    const b = f.bend ?? [0, 0, 1];
    bends[i * 3] = b[0]!;
    bends[i * 3 + 1] = b[1]!;
    bends[i * 3 + 2] = b[2]!;
    if (normalize(bends.subarray(i * 3, i * 3 + 3)) <= EPS)
      throw new Error(`FootIk: bend of foot ${i} must be non-zero`);
  }
  return {
    feet: desc.feet,
    probe: desc.probe,
    pelvis: desc.pelvis,
    maxLift: desc.maxLift ?? 0.5,
    maxDrop: desc.maxDrop ?? 0.5,
    blend: desc.blend ?? 12,
    pelvisOffset: 0,
    lift: new Float32Array(desc.feet.length),
    grounded: new Uint8Array(desc.feet.length),
    chains,
    bends,
    normals: new Float32Array(desc.feet.length * 3),
    tips: new Float32Array(desc.feet.length * 3),
    world: new Float32Array(n * WORLD_NODE_FLOATS),
  };
}

const hit = new Float32Array(4);
const inv = new Float32Array(WORLD_NODE_FLOATS);
const upSk = new Float32Array(3);
const upN = new Float32Array(3);
const p = new Float32Array(3);
const q = new Float32Array(3);
const nrm = new Float32Array(3);
const target = new Float32Array(3);
const pole = new Float32Array(3);
const delta = new Float32Array(4);
const undo = new Float32Array(WORLD_NODE_FLOATS);
const WORLD_UP = new Float32Array([0, 1, 0]);

/**
 * Probe under every foot, sink the pelvis toward the lowest one (smoothed by `blend` over `dt`),
 * then solve each leg to its ground height and tilt the foot onto the normal. `instanceWorld`
 * (3×4 row-major, or `null` for the identity) places the skeleton in the probe's space. No
 * allocation.
 */
export function applyFootIk(
  pose: Pose,
  skeleton: Skeleton,
  worldPose: Float32Array,
  footIk: FootIk,
  instanceWorld: Float32Array | null,
  dt: number,
): void {
  const feet = footIk.feet;
  const originY = instanceWorld ? instanceWorld[7]! : 0;
  if (instanceWorld) {
    invertAffine(inv, 0, instanceWorld, 0);
    transformDir(upSk, inv, 0, WORLD_UP);
  } else {
    upSk[0] = 0;
    upSk[1] = 1;
    upSk[2] = 0;
  }
  upN[0] = upSk[0]!;
  upN[1] = upSk[1]!;
  upN[2] = upSk[2]!;
  if (normalize(upN) <= EPS) return;

  // Probe. `lowest` is the pelvis target; `flat` stays true while nothing needs to move.
  let lowest = 0;
  let flat = true;
  for (let i = 0; i < feet.length; i++) {
    const f = feet[i]!;
    const to = f.tip * WORLD_NODE_FLOATS;
    footIk.tips[i * 3] = worldPose[to + 3]!;
    footIk.tips[i * 3 + 1] = worldPose[to + 7]!;
    footIk.tips[i * 3 + 2] = worldPose[to + 11]!;
    footIk.grounded[i] = 0;
    footIk.lift[i] = 0;
    footIk.normals[i * 3] = upN[0]!;
    footIk.normals[i * 3 + 1] = upN[1]!;
    footIk.normals[i * 3 + 2] = upN[2]!;
    let d = Number.NEGATIVE_INFINITY;
    let got = false;
    for (let k = 0; k < 2; k++) {
      const node = k === 0 ? f.tip : f.toe;
      if (node === undefined) break;
      const wo = node * WORLD_NODE_FLOATS;
      p[0] = worldPose[wo + 3]!;
      p[1] = worldPose[wo + 7]!;
      p[2] = worldPose[wo + 11]!;
      if (instanceWorld) transformPoint(q, instanceWorld, 0, p);
      else q.set(p);
      if (!footIk.probe(q[0]!, q[2]!, hit)) continue;
      const h = hit[0]! - originY;
      if (!got || h > d) {
        d = h;
        nrm[0] = hit[1]!;
        nrm[1] = hit[2]!;
        nrm[2] = hit[3]!;
      }
      got = true;
    }
    if (!got) continue;
    d = Math.min(footIk.maxLift, Math.max(-footIk.maxDrop, d));
    footIk.grounded[i] = 1;
    footIk.lift[i] = d;
    if (instanceWorld) transformDir(nrm, inv, 0, nrm);
    if (normalize(nrm) > EPS) {
      footIk.normals[i * 3] = nrm[0]!;
      footIk.normals[i * 3 + 1] = nrm[1]!;
      footIk.normals[i * 3 + 2] = nrm[2]!;
      const dot = nrm[0]! * upN[0]! + nrm[1]! * upN[1]! + nrm[2]! * upN[2]!;
      if (dot < 1 - 1e-6) flat = false;
    }
    if (d !== 0) flat = false;
    if (d < lowest) lowest = d;
  }

  // Pelvis: approach the lowest foot exponentially.
  const k = dt > 0 ? 1 - Math.exp(-footIk.blend * dt) : 1;
  footIk.pelvisOffset += (lowest - footIk.pelvisOffset) * k;
  if (Math.abs(footIk.pelvisOffset) < 1e-6) footIk.pelvisOffset = 0;
  if (flat && footIk.pelvisOffset === 0) return;

  const offset = footIk.pelvisOffset;
  if (offset !== 0) {
    const parent = skeleton.parents[footIk.pelvis]!;
    p[0] = upSk[0]! * offset;
    p[1] = upSk[1]! * offset;
    p[2] = upSk[2]! * offset;
    if (parent >= 0) {
      invertAffine(inv, 0, worldPose, parent * WORLD_NODE_FLOATS);
      transformDir(p, inv, 0, p);
    }
    const po = footIk.pelvis * POSE_NODE_FLOATS;
    pose[po] = pose[po]! + p[0]!;
    pose[po + 1] = pose[po + 1]! + p[1]!;
    pose[po + 2] = pose[po + 2]! + p[2]!;
  }
  poseToWorld(skeleton, pose, footIk.world);

  // Legs: each grounded foot back to its sampled place lifted by its ground height.
  for (let i = 0; i < feet.length; i++) {
    if (!footIk.grounded[i]) continue;
    const c = footIk.chains[i]!;
    const d = footIk.lift[i]!;
    target[0] = footIk.tips[i * 3]! + upSk[0]! * d;
    target[1] = footIk.tips[i * 3 + 1]! + upSk[1]! * d;
    target[2] = footIk.tips[i * 3 + 2]! + upSk[2]! * d;
    // The pole: the knee as it is, nudged toward the bend direction so a straight leg knows
    // which way to fold.
    const mo = c.mid * WORLD_NODE_FLOATS;
    const ro = c.root * WORLD_NODE_FLOATS;
    const W = footIk.world;
    const len = Math.hypot(
      W[mo + 3]! - W[ro + 3]!,
      W[mo + 7]! - W[ro + 7]!,
      W[mo + 11]! - W[ro + 11]!,
    );
    const nudge = Math.max(len, EPS) * 1e-2;
    pole[0] = W[mo + 3]! + footIk.bends[i * 3]! * nudge;
    pole[1] = W[mo + 7]! + footIk.bends[i * 3 + 1]! * nudge;
    pole[2] = W[mo + 11]! + footIk.bends[i * 3 + 2]! * nudge;
    twoBoneIk(pose, skeleton, footIk.world, c, target, pole, null);
  }

  // Feet: each keeps its sampled orientation (the leg's turn is undone at the ankle), then
  // tilts onto its ground normal.
  poseToWorld(skeleton, pose, footIk.world);
  for (let i = 0; i < feet.length; i++) {
    if (!footIk.grounded[i]) continue;
    const f = feet[i]!;
    const to = f.tip * WORLD_NODE_FLOATS;
    invertAffine(inv, 0, footIk.world, to);
    multiplyAffine(undo, 0, worldPose, to, inv, 0);
    matrixToAxisAngle(delta, undo);
    const parent = skeleton.parents[f.tip]!;
    const po = parent < 0 ? 0 : parent * WORLD_NODE_FLOATS;
    const pm = parent < 0 ? IDENTITY : footIk.world;
    applyDelta(pose, f.tip, delta, pm, po, null);
    nrm[0] = footIk.normals[i * 3]!;
    nrm[1] = footIk.normals[i * 3 + 1]!;
    nrm[2] = footIk.normals[i * 3 + 2]!;
    rotationBetween(delta, upN, nrm);
    if (Math.abs(delta[3]!) < 1e-5) continue;
    applyDelta(pose, f.tip, delta, pm, po, null);
  }
}

/** The (unit axis, angle) of the rotation in the upper 3×3 of the 3×4 matrix `m`. */
function matrixToAxisAngle(out: Float32Array, m: Float32Array): void {
  const tr = m[0]! + m[5]! + m[10]!;
  out[0] = m[9]! - m[6]!;
  out[1] = m[2]! - m[8]!;
  out[2] = m[4]! - m[1]!;
  const sin2 = Math.hypot(out[0]!, out[1]!, out[2]!);
  if (sin2 <= EPS) {
    // Identity, or a half turn: take the axis from the symmetric part.
    if (tr > 0) {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    out[0] = Math.sqrt(Math.max(0, (m[0]! + 1) / 2));
    out[1] = Math.sqrt(Math.max(0, (m[5]! + 1) / 2));
    out[2] = Math.sqrt(Math.max(0, (m[10]! + 1) / 2));
    normalize(out);
    out[3] = Math.PI;
    return;
  }
  out[0] = out[0]! / sin2;
  out[1] = out[1]! / sin2;
  out[2] = out[2]! / sin2;
  out[3] = Math.atan2(sin2 / 2, (tr - 1) / 2);
}
