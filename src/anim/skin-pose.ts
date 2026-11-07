/**
 * `skinPose`: one call per frame from an animated pose to a skin palette slot (ws/assets-4).
 * It runs the steps a skinned character repeats every frame: advance the clips (`update(dt)`,
 * when a source and a `dt` are given), resolve the pose into node world matrices
 * (`poseToWorld`), multiply each joint by its inverse bind matrix (`skinMatrices`) and write
 * the result straight into the palette's staging (`palette.write(slot)`). The world matrices
 * live in a scratch array cached per skeleton and are returned, for sockets and IK. Nothing
 * allocates after the first call for a skeleton.
 */
import type { SkinPalette } from '../render/skin';
import {
  jointCount,
  type Pose,
  poseToWorld,
  type Skeleton,
  skinMatrices,
  WORLD_NODE_FLOATS,
} from './pose';

/**
 * What `skinPose` reads a pose from: an object that owns a pose and advances it, such as an
 * `AnimationMixer`. An `AnimGraph` drives a mixer; pass that mixer (after `graph.update`) or
 * its `pose`.
 */
export interface SkinPoseSource {
  readonly pose: Pose;
  update(dt: number): void;
}

/**
 * The part of a `SkinPalette` that `skinPose` uses: a slot's staging block to fill in place.
 * When the target also has a `jointCount` (a `SkinPalette` does), `skinPose` checks it first.
 */
export type SkinPoseTarget = Pick<SkinPalette, 'write'>;

const worldCache = new WeakMap<Skeleton, Float32Array>();

/**
 * Pose one skinned instance into `palette` slot `slot` and return the node world matrices
 * (3×4 row-major, `WORLD_NODE_FLOATS` per node). `source` is a `Pose`, used as it is, or a
 * `SkinPoseSource` (an `AnimationMixer`): with `dt` given, `source.update(dt)` runs first;
 * without it the source's current pose is used, so a game that updated a graph, or edited the
 * pose with IK, passes no `dt`. The result equals `update(dt)` → `poseToWorld` →
 * `skinMatrices(skeleton, world, palette.write(slot))` bit for bit. Throws when the
 * skeleton has more joints than the palette's slot holds (ws/render-11; a `SkinPalette` is
 * checked by `jointCount` before the source advances). The returned array is shared per skeleton and rewritten by the next call for the same skeleton: read it (sockets,
 * `attachTransform`) before posing another instance of that skeleton, or pass your own
 * `world`. Call `palette.flush()` once per frame after posing every slot. Allocates only the
 * scratch array on the first call for a skeleton without `world`.
 */
export function skinPose(
  skeleton: Skeleton,
  source: Pose | SkinPoseSource,
  palette: SkinPoseTarget,
  slot = 0,
  dt?: number,
  world?: Float32Array,
): Float32Array {
  const joints = jointCount(skeleton);
  const has = (palette as { readonly jointCount?: number }).jointCount;
  if (has !== undefined && has < joints) throw tooSmall(joints, has, slot);
  let pose: Pose;
  if (source instanceof Float32Array) {
    pose = source;
  } else {
    if (dt !== undefined) source.update(dt);
    pose = source.pose;
  }
  const out = world ?? worldFor(skeleton);
  poseToWorld(skeleton, pose, out);
  const block = palette.write(slot);
  // A target without `jointCount`: its block's length says how many joints it holds.
  // One 3×4 matrix (`WORLD_NODE_FLOATS`) per joint, as `skinMatrices` writes them.
  if (block.length < joints * WORLD_NODE_FLOATS) {
    throw tooSmall(joints, Math.floor(block.length / WORLD_NODE_FLOATS), slot);
  }
  skinMatrices(skeleton, out, block);
  return out;
}

function tooSmall(joints: number, has: number, slot: number): Error {
  return new Error(
    `skinPose: the skeleton has ${joints} joints but the palette holds ${has} per slot ` +
      `(slot ${slot}); make the SkinPalette with joints: ${joints} or more`,
  );
}

function worldFor(skeleton: Skeleton): Float32Array {
  const floats = skeleton.parents.length * WORLD_NODE_FLOATS;
  let w = worldCache.get(skeleton);
  if (!w || w.length !== floats) {
    w = new Float32Array(floats);
    worldCache.set(skeleton, w);
  }
  return w;
}
