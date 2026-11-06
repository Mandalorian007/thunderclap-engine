# Brief: ws/retarget

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *Animation*; `src/anim/README.md` whole; `src/anim/pose.ts` (`Skeleton`, `Pose`, `POSE_NODE_FLOATS`, `poseToWorld`, `invertAffine`, `multiplyAffine`), `src/anim/clip.ts` (`AnimationClip`, `AnimationChannel`, `sampleClip`), `src/anim/quat.ts`, `src/anim/mixer.ts` (how a `Pose` reaches the mixer), `src/anim/pose.test.ts` (fixture rigs), `src/assets/gltf.ts` (`skeletonFromSkin`, node names).

## Goal

One walk cycle plays on every character: a clip authored for one skeleton drives another with different joint names, bone lengths and rest orientations. Cosmetics (E-015) are rigs of their own, so without this every outfit needs its own animation set.

STATUS row, *done when*: `createRetargetMap(source: Skeleton, target: Skeleton, opts?: RetargetOptions): RetargetMap` where `RetargetOptions { pairs?: Array<[string | number, string | number]>; match?: (sourceName: string) => string | null; rootNode?: string | number; scaleTranslation?: boolean (default true: root translation scaled by hip-height ratio) }` and unmatched joints are listed in `map.unmatched`; `retargetPose(map, sourcePose, targetPose)` writes the target pose (rotations transferred as rest-relative deltas in each joint's parent frame so differing rest orientations work; translations kept from the target rest except the root; zero allocation); `retargetClip(map, clip, opts?): AnimationClip` bakes a clip to the target at a sample rate (default: the clip's key times) for games that would rather pay once; name matching defaults to exact names, then a lowercase, separator-stripped compare (`mixamorig:LeftArm` ↔ `left_arm`), overridable by `match`; harness `retarget.html`; tests; documented.

## Scope

- `src/anim/retarget.ts`: `RetargetMap { pairs: Int32Array (target joint → source joint or -1); unmatched: string[]; …precomputed rest frames }`, the three functions, `normalizeJointName(name)` exported for tests. Uses `Skeleton.names` (ws/sockets added it; index joints when a skeleton has no names and the pair list is numeric).
- Tests `src/anim/retarget.test.ts`: identical skeletons give an identical pose; a target with rotated rest bones reproduces the source's world-space bone directions (compare via `poseToWorld`, tolerance 1e-4); a longer-legged target scales root translation by hip height; missing joints hold rest and appear in `unmatched`; name normalisation cases; `retargetClip` round trip equals per-frame `retargetPose`.
- Harness `harness/retarget.html|ts|-state.ts`: 2D canvas like `ik.html` with two stick figures side by side, the left playing a procedural wave clip, the right a differently proportioned rig with rotated rests driven by `retargetPose`; state exposes `sourceTipY`, `targetTipY`, `unmatched`. `e2e/retarget.spec.ts`: both tips move (poll), `unmatched` is empty, the target's hand direction matches the source's within tolerance via an exported pure check.
- Docs: `src/anim/README.md` *Retargeting* section; ARCHITECTURE *Animation* clause (the *Planned* line names retargeting: move it to *Today*); CHANGELOG; root README harness item.

## Files owned

`src/anim/retarget.ts`, `src/anim/retarget.test.ts`, `src/anim/index.ts` (append; Biome may sort), `src/anim/README.md` (*Retargeting*), `harness/retarget.*`, `e2e/retarget.spec.ts`, `ARCHITECTURE.md` (one clause), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `main` (9a4e798 or later; anim is on main). Running alongside: ws/ik (`ik.ts`, `root-motion.ts`: landing via chain 4, same index/README/ARCHITECTURE lines will conflict trivially), ws/anim-graph (`graph.ts`), ws/sockets (landing), ws/ui-hud, ws/gesture-longpress, ws/audio-zones. Use `E2E_PORT_OFFSET=110`.
