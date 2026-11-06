# Brief: ws/anim

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *Transforms*; `src/render/transform.ts` (3×4 matrix conventions, `multiply`/`compose` helpers if any); `docs/briefs/gltf.md` and `docs/briefs/skinning.md` (your consumers; you do not edit their files).

## Goal

A pure animation module: keyframe clips sampled into poses, blended and cross-faded, resolved into node world matrices and skin joint matrices, with no GPU and no allocations per frame. Cosmetic "floating" idles, weapon swings and character locomotion all run on it (E-015). glTF animation data maps onto it one-to-one.

STATUS row, *done when*: `@thunderclap/engine/anim` with `AnimationClip`, `sampleClip`, `Pose`, `Skeleton`, `AnimationMixer` (layers, weights, crossfade, loop/once, time scale, events at keyframes), `poseToWorld`, `skinMatrices`; unit tests incl. a step/linear/cubic-spline sampling table and a slerp sanity test; documented.

## Scope

- `src/anim/clip.ts`: `AnimationClip { name; duration; channels: AnimationChannel[] }`, `AnimationChannel { node: number; path: 'translation' | 'rotation' | 'scale' | 'weights'; interpolation: 'STEP' | 'LINEAR' | 'CUBICSPLINE'; times: Float32Array; values: Float32Array }` (glTF sampler semantics, including cubic-spline in/out tangents). `sampleClip(clip, t, pose, weight = 1, blend: 'override' | 'additive' = 'override')` with a per-channel keyframe cursor cache so sampling is O(1) amortised while time moves forward.
- `src/anim/pose.ts`: `Skeleton { parents: Int16Array; rest: Float32Array (10 floats per node: t3 q4 s3); inverseBind?: Float32Array (16 or 12 per joint); joints?: Uint16Array }`; `Pose` = `Float32Array` 10 floats per node; `createPose(skeleton)`, `copyPose`, `blendPose(a, b, t, out)` (slerp rotations, lerp the rest); `poseToWorld(skeleton, pose, out3x4: Float32Array)`; `skinMatrices(skeleton, world3x4, out: Float32Array)` = world × inverseBind in the layout `src/render/skin.ts` consumes (3×4 rows, 12 floats per joint; say so in the README so ws/skinning matches).
- `src/anim/mixer.ts`: `AnimationMixer(skeleton)` with `play(clip, { layer?, weight?, loop?, speed?, fadeIn? })`, `crossFade(from, to, seconds)`, `stop`, `update(dt)` → writes `mixer.pose`; keyframe events: `clip.events?: { time; name }[]`, `mixer.onEvent(cb)` fires once per crossing.
- Quaternion helpers in `src/anim/quat.ts` (normalise, slerp, nlerp, from-euler) — no dependency on `render/`.
- Tests on every file; a golden table for sampling; mixer crossfade sums to 1; `skinMatrices` identity for rest pose.
- `src/anim/index.ts`, `src/anim/README.md`, `package.json` `exports` `"./anim"`, root README row, ARCHITECTURE new *Animation* paragraph after *Transforms*, CHANGELOG.

Out of scope: IK, retargeting, root motion (report as wishes if a game would want them), any GPU code.

## Files owned

`src/anim/**`, `package.json` (one `exports` line; ws/gltf adds `./assets` on the line above: the integrator keeps both), root `README.md` (one row), `ARCHITECTURE.md` (one paragraph), `CHANGELOG.md`, `scripts/check-boundaries.mjs` / `check-docs.mjs` only if they enumerate modules.

Running alongside: ws/gltf (will later parse glTF animations into your `AnimationClip` shape: keep the shape documented), ws/skinning (consumes `skinMatrices`), ws/follow, ws/pbr, ws/xr, ws/template-first-person. Branch from `main`.
