/**
 * Skeletons, poses and the two resolutions a renderer needs: node world matrices and skin joint
 * matrices. Pure arithmetic on flat `Float32Array`s; nothing here allocates after setup.
 *
 * Layouts:
 * - A `Pose` is `POSE_NODE_FLOATS` (10) floats per node: translation `t3`, rotation `q4`
 *   (`x y z w`), scale `s3`. `Skeleton.rest` has the same layout.
 * - World matrices are **3×4 row-major**, 12 floats per node (`render/transform.ts`):
 *   `[r0 | tx, r1 | ty, r2 | tz]`, local = `T · R · S`, world = `parent.world · local`.
 * - Skin matrices are the same 3×4 layout, 12 floats per joint, `world[joint] · inverseBind[j]`:
 *   what `render/skin.ts` (`SkinPalette`) consumes.
 */
import { quatSlerp } from './quat';

/** Floats per node in a `Pose` and in `Skeleton.rest`: `tx ty tz qx qy qz qw sx sy sz`. */
export const POSE_NODE_FLOATS = 10;
/** Floats per node in a world array and per joint in a skin array (3×4 row-major). */
export const WORLD_NODE_FLOATS = 12;

/**
 * A node hierarchy with a rest pose and, when it skins a mesh, the joint list and its inverse
 * bind matrices. Nodes are in parent-before-child order: `parents[i] < i`, or `-1` for a root
 * (`validateSkeleton` checks it; a glTF importer reorders nodes to satisfy it).
 */
export interface Skeleton {
  /** Parent node index per node, `-1` for a root. `parents[i] < i`. */
  parents: Int16Array;
  /** Rest pose, `POSE_NODE_FLOATS` per node. */
  rest: Float32Array;
  /**
   * Inverse bind matrix per joint: 12 floats (3×4 row-major, this module's layout) or 16 floats
   * (4×4 column-major, as glTF stores them; the last column is read as the translation).
   */
  inverseBind?: Float32Array;
  /** Node index per joint. Absent: joint `j` is node `j`. */
  joints?: Uint16Array;
  /** Node name per node (glTF `node.name`), so `createSocket` can take a joint by name. */
  names?: string[];
}

/** Local transforms per node, `POSE_NODE_FLOATS` floats each. */
export type Pose = Float32Array;

/** Number of nodes in a skeleton. */
export function nodeCount(skeleton: Skeleton): number {
  return skeleton.parents.length;
}

/** Number of joints: `joints.length` when given, else every node is a joint. */
export function jointCount(skeleton: Skeleton): number {
  return skeleton.joints ? skeleton.joints.length : skeleton.parents.length;
}

/**
 * Throw if the skeleton is inconsistent: `rest` length, parent order (`parents[i] < i`), joint
 * indices in range, `inverseBind` length (12 or 16 per joint).
 */
export function validateSkeleton(skeleton: Skeleton): void {
  const n = skeleton.parents.length;
  if (skeleton.rest.length !== n * POSE_NODE_FLOATS) {
    throw new Error(
      `Skeleton: rest has ${skeleton.rest.length} floats, expected ${n * POSE_NODE_FLOATS} (${n} nodes × ${POSE_NODE_FLOATS})`,
    );
  }
  for (let i = 0; i < n; i++) {
    const p = skeleton.parents[i]!;
    if (p >= i || p < -1) {
      throw new Error(
        `Skeleton: parents[${i}] = ${p}; parents must come before children (-1 = root)`,
      );
    }
  }
  const joints = jointCount(skeleton);
  if (skeleton.joints) {
    for (let j = 0; j < joints; j++) {
      const node = skeleton.joints[j]!;
      if (node >= n) throw new Error(`Skeleton: joints[${j}] = ${node} is not a node (${n} nodes)`);
    }
  }
  if (skeleton.names && skeleton.names.length !== n) {
    throw new Error(
      `Skeleton: names has ${skeleton.names.length} entries, expected ${n} (one per node)`,
    );
  }
  const ib = skeleton.inverseBind;
  if (ib && ib.length !== joints * 12 && ib.length !== joints * 16) {
    throw new Error(
      `Skeleton: inverseBind has ${ib.length} floats, expected ${joints * 12} or ${joints * 16} for ${joints} joints`,
    );
  }
}

/** A new pose holding a copy of the rest pose. */
export function createPose(skeleton: Skeleton): Pose {
  return new Float32Array(skeleton.rest);
}

/** Copy `src` into `dst` (same length). */
export function copyPose(src: Pose, dst: Pose): void {
  dst.set(src);
}

/**
 * `out = lerp(a, b, t)` per node: translation and scale linearly, rotation by slerp along the
 * shorter arc. `out` may alias `a` or `b`. No allocation.
 */
export function blendPose(a: Pose, b: Pose, t: number, out: Pose): void {
  const s = 1 - t;
  const n = a.length;
  for (let o = 0; o + POSE_NODE_FLOATS <= n; o += POSE_NODE_FLOATS) {
    out[o] = s * a[o]! + t * b[o]!;
    out[o + 1] = s * a[o + 1]! + t * b[o + 1]!;
    out[o + 2] = s * a[o + 2]! + t * b[o + 2]!;
    quatSlerp(out, o + 3, a, o + 3, b, o + 3, t);
    out[o + 7] = s * a[o + 7]! + t * b[o + 7]!;
    out[o + 8] = s * a[o + 8]! + t * b[o + 8]!;
    out[o + 9] = s * a[o + 9]! + t * b[o + 9]!;
  }
}

/** Write the 3×4 row-major matrix `T · R · S` of the node at `pose[po..po+10)` to `out[o..o+12)`. */
export function writeNodeMatrix(
  out: Float32Array,
  o: number,
  pose: ArrayLike<number>,
  po: number,
): void {
  const x = pose[po + 3]!;
  const y = pose[po + 4]!;
  const z = pose[po + 5]!;
  const w = pose[po + 6]!;
  const sx = pose[po + 7]!;
  const sy = pose[po + 8]!;
  const sz = pose[po + 9]!;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  out[o] = (1 - 2 * (yy + zz)) * sx;
  out[o + 1] = 2 * (xy - wz) * sy;
  out[o + 2] = 2 * (xz + wy) * sz;
  out[o + 3] = pose[po]!;
  out[o + 4] = 2 * (xy + wz) * sx;
  out[o + 5] = (1 - 2 * (xx + zz)) * sy;
  out[o + 6] = 2 * (yz - wx) * sz;
  out[o + 7] = pose[po + 1]!;
  out[o + 8] = 2 * (xz - wy) * sx;
  out[o + 9] = 2 * (yz + wx) * sy;
  out[o + 10] = (1 - 2 * (xx + yy)) * sz;
  out[o + 11] = pose[po + 2]!;
}

/**
 * `out[oo..] = a[ao..] · b[bo..]` for 3×4 affine matrices (implicit last row `0 0 0 1`).
 * `out` may alias neither input.
 */
export function multiplyAffine(
  out: Float32Array,
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!;
    const a1 = a[ao + r * 4 + 1]!;
    const a2 = a[ao + r * 4 + 2]!;
    const a3 = a[ao + r * 4 + 3]!;
    out[oo + r * 4] = a0 * b[bo]! + a1 * b[bo + 4]! + a2 * b[bo + 8]!;
    out[oo + r * 4 + 1] = a0 * b[bo + 1]! + a1 * b[bo + 5]! + a2 * b[bo + 9]!;
    out[oo + r * 4 + 2] = a0 * b[bo + 2]! + a1 * b[bo + 6]! + a2 * b[bo + 10]!;
    out[oo + r * 4 + 3] = a0 * b[bo + 3]! + a1 * b[bo + 7]! + a2 * b[bo + 11]! + a3;
  }
}

/**
 * Invert the 3×4 affine matrix at `m[mo..]` into `out[oo..]` (general 3×3 inverse plus
 * translation). A singular matrix (a zero scale) yields the identity. `out` may not alias `m`.
 */
export function invertAffine(
  out: Float32Array,
  oo: number,
  m: ArrayLike<number>,
  mo: number,
): void {
  const a00 = m[mo]!;
  const a01 = m[mo + 1]!;
  const a02 = m[mo + 2]!;
  const tx = m[mo + 3]!;
  const a10 = m[mo + 4]!;
  const a11 = m[mo + 5]!;
  const a12 = m[mo + 6]!;
  const ty = m[mo + 7]!;
  const a20 = m[mo + 8]!;
  const a21 = m[mo + 9]!;
  const a22 = m[mo + 10]!;
  const tz = m[mo + 11]!;
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a02 * a21 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a10 * c01 + a20 * c02;
  if (det === 0) {
    out.fill(0, oo, oo + 12);
    out[oo] = 1;
    out[oo + 5] = 1;
    out[oo + 10] = 1;
    return;
  }
  const inv = 1 / det;
  const i00 = c00 * inv;
  const i01 = c01 * inv;
  const i02 = c02 * inv;
  const i10 = (a12 * a20 - a10 * a22) * inv;
  const i11 = (a00 * a22 - a02 * a20) * inv;
  const i12 = (a02 * a10 - a00 * a12) * inv;
  const i20 = (a10 * a21 - a11 * a20) * inv;
  const i21 = (a01 * a20 - a00 * a21) * inv;
  const i22 = (a00 * a11 - a01 * a10) * inv;
  out[oo] = i00;
  out[oo + 1] = i01;
  out[oo + 2] = i02;
  out[oo + 3] = -(i00 * tx + i01 * ty + i02 * tz);
  out[oo + 4] = i10;
  out[oo + 5] = i11;
  out[oo + 6] = i12;
  out[oo + 7] = -(i10 * tx + i11 * ty + i12 * tz);
  out[oo + 8] = i20;
  out[oo + 9] = i21;
  out[oo + 10] = i22;
  out[oo + 11] = -(i20 * tx + i21 * ty + i22 * tz);
}

/**
 * Resolve a pose into world matrices: `out[i]` (12 floats, 3×4 row-major) is
 * `world[parent] · T·R·S(pose[i])`, in node order. `out` needs `WORLD_NODE_FLOATS × nodes`.
 * No allocation.
 */
export function poseToWorld(skeleton: Skeleton, pose: Pose, out3x4: Float32Array): void {
  const parents = skeleton.parents;
  const n = parents.length;
  for (let i = 0; i < n; i++) {
    const o = i * WORLD_NODE_FLOATS;
    const p = parents[i]!;
    if (p < 0) {
      writeNodeMatrix(out3x4, o, pose, i * POSE_NODE_FLOATS);
    } else {
      writeNodeMatrix(scratchLocal, 0, pose, i * POSE_NODE_FLOATS);
      multiplyAffine(out3x4, o, out3x4, p * WORLD_NODE_FLOATS, scratchLocal, 0);
    }
  }
}
const scratchLocal = new Float32Array(WORLD_NODE_FLOATS);
const scratchBind = new Float32Array(WORLD_NODE_FLOATS);

/**
 * Joint matrices for skinning: `out[j]` (12 floats, 3×4 row-major) is
 * `world[joints[j]] · inverseBind[j]`, the layout `render/skin.ts` uploads. Without
 * `inverseBind` the world matrix is copied. `out` needs `WORLD_NODE_FLOATS × joints`. No
 * allocation.
 */
export function skinMatrices(skeleton: Skeleton, world3x4: Float32Array, out: Float32Array): void {
  const joints = jointCount(skeleton);
  const map = skeleton.joints;
  const ib = skeleton.inverseBind;
  const stride = ib ? ib.length / joints : 0;
  for (let j = 0; j < joints; j++) {
    const node = map ? map[j]! : j;
    const wo = node * WORLD_NODE_FLOATS;
    const oo = j * WORLD_NODE_FLOATS;
    if (!ib) {
      // A plain copy, not `set(subarray(...))`: no view allocated per joint.
      for (let k = 0; k < WORLD_NODE_FLOATS; k++) out[oo + k] = world3x4[wo + k]!;
      continue;
    }
    if (stride === 16) {
      // glTF column-major 4×4 → our row-major 3×4.
      const b = j * 16;
      for (let r = 0; r < 3; r++) {
        scratchBind[r * 4] = ib[b + r]!;
        scratchBind[r * 4 + 1] = ib[b + 4 + r]!;
        scratchBind[r * 4 + 2] = ib[b + 8 + r]!;
        scratchBind[r * 4 + 3] = ib[b + 12 + r]!;
      }
      multiplyAffine(out, oo, world3x4, wo, scratchBind, 0);
    } else {
      multiplyAffine(out, oo, world3x4, wo, ib, j * 12);
    }
  }
}

/**
 * Inverse bind matrices (12 floats per joint, 3×4 row-major) from the skeleton's rest pose, for
 * procedural rigs: with them `skinMatrices` of the rest pose is the identity. Allocates.
 */
export function inverseBindFromRest(skeleton: Skeleton): Float32Array {
  const n = skeleton.parents.length;
  const world = new Float32Array(n * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, skeleton.rest, world);
  const joints = skeleton.joints ? skeleton.joints.length : n;
  const out = new Float32Array(joints * WORLD_NODE_FLOATS);
  for (let j = 0; j < joints; j++) {
    const node = skeleton.joints ? skeleton.joints[j]! : j;
    invertAffine(out, j * WORLD_NODE_FLOATS, world, node * WORLD_NODE_FLOATS);
  }
  return out;
}
