# Brief: ws/ik

Read `docs/briefs/common.md` first, then DECISIONS E-015; `src/anim/README.md`, `src/anim/pose.ts` (`Pose` layout `POSE_NODE_FLOATS`, `Skeleton.parents/rest`, `poseToWorld`, `multiplyAffine`, `invertAffine`), `src/anim/quat.ts`, `src/anim/clip.ts` (`sampleClip`, `ChannelPath`), `src/anim/mixer.ts` (where a post-sample hook could run), `src/anim/index.ts`. ws/sockets runs alongside in the same module (`socket.ts`, `Skeleton.names`): do not touch its files.

## Goal

Characters that plant feet on uneven ground, hold a target with a hand, and turn the head to look at something; and clips that move the character through the world without the game guessing. Pure pose arithmetic in `anim`, run after sampling and before `poseToWorld`.

STATUS row, *done when*: `@thunderclap/engine/anim` exports `twoBoneIk(pose, skeleton, chain: { root; mid; tip }, targetWorld: vec3, poleWorld: vec3 | null, instanceWorld: Float32Array | null, opts?: { weight?: number; maxIterations? })` solving analytically for the root and mid rotations in local space; `lookAt(pose, skeleton, joint, targetWorld, instanceWorld, opts?: { weight?; forward?: vec3; up?: vec3; maxAngle? })`; `extractRootMotion(clip, rootNode, opts?: { planar?: boolean }): { clip: AnimationClip; motion: AnimationClip }` splitting a clip's root translation (and yaw when not `planar`-only) into a separate clip so the game integrates `motion` into its transform while `clip` stays in place; `applyRootMotionDelta(motionClip, t0, t1, outDelta)`; all zero-allocation per call after construction (scratch arrays module-level or on an opaque `IkChain` object returned by `createIkChain`); tests; documented.

## Scope

- `src/anim/ik.ts`, `ik.test.ts`: two-bone law-of-cosines solve with pole vector, unreachable target stretches toward it (clamped), `weight` lerps the solved rotations against the input pose, world→local conversion through the parent's world matrix from a `poseToWorld` the caller already ran (take `worldPose: Float32Array` as an input so the solver never re-walks the skeleton). `lookAt` rotates one joint so `forward` points at the target, limited by `maxAngle`, blended by `weight`.
- `src/anim/root-motion.ts`, `root-motion.test.ts`: `extractRootMotion` builds two clips sharing keyframe times (channels copied, not aliased); the stay-in-place clip keeps the root's first-frame translation; `applyRootMotionDelta` samples both ends and returns position delta and yaw delta, handling loop wrap when `t1 < t0`.
- Tests: analytic chain reaches a reachable target within 1e-4; unreachable target points at it; pole vector picks the bend side; weight 0 leaves the pose; `lookAt` angle clamp; root-motion split round-trips (motion + in-place == original root transform at every keyframe); loop wrap delta.
- Harness: extend nothing on other streams' pages; add `harness/ik.html|ts|-state.ts` with a three-joint arm whose tip follows a moving target, a head joint looking at it, built from `createPose` (no assets); state exposes `tipError` (distance tip→target). `e2e/ik.spec.ts`: `tipError` stays under a threshold while the target moves (poll per E-017).
- Docs: `src/anim/README.md` *IK and root motion*, ARCHITECTURE *Animation* one sentence, CHANGELOG, root README harness item.

## Files owned

`src/anim/ik.ts`, `src/anim/ik.test.ts`, `src/anim/root-motion.ts`, `src/anim/root-motion.test.ts`, `src/anim/index.ts` (append, below the sockets block if present), `src/anim/README.md` (*IK and root motion*), `harness/ik.*`, `e2e/ik.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `ws/anim` (01af0cf): `anim` lands on `main` within the hour. Running alongside: ws/sockets (same module, `socket.ts` + `pose.ts` `Skeleton.names`), ws/sky, ws/bench, ws/geom, ws/flake-input; two integrator chains.
