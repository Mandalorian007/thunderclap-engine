# engine/anim

Keyframe animation with no GPU in it: clips with glTF sampler semantics sampled into poses, a mixer that layers, weights and cross-fades them, a state graph over the mixer (states, 1D blend spaces, conditional transitions), and two resolutions a renderer consumes: node world matrices and skin joint matrices. Flat `Float32Array`s throughout; after setup nothing allocates per frame. No runtime dependency on `render/` (sockets import the `Transform` type only); `render/skin.ts` (ws/skinning) uploads what `skinMatrices` writes.

## Quick start

```ts
import {
  AnimationMixer, type AnimationClip, type Skeleton,
  POSE_NODE_FLOATS, WORLD_NODE_FLOATS, poseToWorld, skinMatrices, inverseBindFromRest,
} from '@thunderclap/engine/anim';

const skeleton: Skeleton = { parents: new Int16Array([-1, 0, 1]), rest };   // 10 floats per node
skeleton.inverseBind = inverseBindFromRest(skeleton);                        // procedural rig; glTF supplies its own

const mixer = new AnimationMixer(skeleton);
const walk = mixer.play(walkClip);                                           // loops
mixer.play(bobClip, { layer: 1, blend: 'additive', weight: 0.5 });           // "floating" idle on top
mixer.onEvent((name) => { if (name === 'footstep') audio.play('step'); });

const world = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS); // 3×4 per node
const joints = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);// 3×4 per joint
function frame(dt: number) {
  mixer.update(dt);                        // writes mixer.pose
  poseToWorld(skeleton, mixer.pose, world);
  skinMatrices(skeleton, world, joints);   // → SkinPalette.set(instance, joints)
}
mixer.crossFade(walk, runClip, 0.3);       // weights sum to 1 throughout
```

## Layouts

- **`Pose`** = `Float32Array`, **`POSE_NODE_FLOATS`** (10) per node: `tx ty tz  qx qy qz qw  sx sy sz`. `Skeleton.rest` uses the same layout.
- **World matrices**: `WORLD_NODE_FLOATS` (12) per node, **3×4 row-major** as in `render/transform.ts`: `[r0 | tx, r1 | ty, r2 | tz]`, local `T · R · S`, world `parent.world · local`.
- **Skin matrices**: the same 3×4 row-major 12 floats **per joint**, `world[joints[j]] · inverseBind[j]`. This is the layout `render/skin.ts` (`SkinPalette`) consumes: joint `j` occupies floats `[12j, 12j + 12)`, rows first, translation in the fourth column of each row.
- **`Skeleton`** `{ parents: Int16Array; rest: Float32Array; inverseBind?: Float32Array; joints?: Uint16Array }`. `parents[i]` is `-1` for a root and otherwise `< i` (parent before child; a glTF importer reorders nodes). `joints[j]` is the node a joint drives (absent: joint `j` is node `j`). `inverseBind` holds 12 floats per joint in this module's layout, or 16 as glTF stores them (4×4 column-major; `skinMatrices` converts on the fly). `validateSkeleton(skeleton)` throws on a bad shape; `nodeCount` and `jointCount` read the sizes.

## Clips (`clip.ts`)

`AnimationClip { name; duration; channels: AnimationChannel[]; events?: AnimationEvent[] }`. `AnimationChannel { node; path: ChannelPath; interpolation: Interpolation; times: Float32Array; values: Float32Array }` is one glTF sampler + target: `ChannelPath` is `'translation' | 'rotation' | 'scale' | 'weights'`, `Interpolation` is `'STEP' | 'LINEAR' | 'CUBICSPLINE'`, `times` are seconds ascending, `values` are packed per key (3, 4, or N morph weights; `CUBICSPLINE` stores in-tangent, value, out-tangent per key, glTF order, tangents scaled by the segment length when evaluated). ws/gltf maps `animations[i].channels` onto this shape one to one; `clipDuration(channels)` gives the last key time. `AnimationEvent { time; name }`: the mixer reports crossings.

- `sampleClip(clip, t, pose, weight = 1, blend: BlendMode = 'override', cursor?)` writes every channel at `t` into `pose`. Outside the key range the first or last value holds (looping is the mixer's). `'override'`: `lerp(pose, value, weight)`, slerp for rotations, a plain write at weight 1. `'additive'`: the clip holds deltas: translation adds `weight × v`, scale multiplies by `lerp(1, v, weight)`, rotation post-multiplies `slerp(identity, q, weight)`. `'weights'` channels are skipped (a pose has no morph slots); a channel whose node is outside the pose is skipped.
- Cursors: `ClipCursor` (`Uint32Array`, one slot per channel, `createClipCursor(clip)`) remembers the last keyframe per channel, so time moving forward costs O(1) amortised; a jump binary-searches (`findKeyframe(times, t, hint)`). `sampleClip` uses one cursor per clip when none is passed; the mixer keeps one per action so one clip can play at two times.
- `sampleChannel(channel, t, out, offset, cursor?, index?)` samples one channel raw (morph weights, custom targets); `channelComponents(channel)` is its width.

## Mixer (`mixer.ts`)

`new AnimationMixer(skeleton, { maxActions = 8 }: AnimationMixerOptions)` owns `pose` (rewritten by `update`) and a fixed pool of `AnimationAction` slots (`actions`, `playing`).

- `play(clip, opts: PlayOptions)` with `layer` (default 0), `weight` (1), `loop` (true; `false` holds the last frame and sets `action.finished`), `speed` (1; negative plays backwards, starting at the end), `fadeIn` seconds, `blend` (`'override' | 'additive'`), `startTime`. Throws when the pool is full.
- `AnimationAction`: `clip`, `layer`, `blend`, settable `weight`, `speed`, `loop`, `time`, `paused`; read `active`, `finished`, `fade`, `effectiveWeight` (`weight × fade`, what the last update used).
- `crossFade(from, to, seconds, opts?)`: `from` fades to 0 and stops; `to` (a clip, started on `from`'s layer with its weight and blend, or an action already playing) fades to 1. The two effective weights sum to `from.weight` throughout, so the pose neither shrinks nor overshoots.
- `stop(action, seconds = 0)` (fade-out or at once), `stopAll()`.
- `update(dt)`: `pose = rest`; per layer ascending, the override actions are averaged by effective weight (cumulative `w_i / Σ`) and lerped onto the pose by `min(1, Σ)`, so a lone half-weight action is half rest; then the layer's additive actions add their deltas at their weights. Nodes a layer does not animate pass through from below.
- `onEvent(cb: AnimationEventListener)` → unsubscribe. `cb(name, action)` fires once per crossing of each `clip.events` time in playback order, across loop wraps (an event at `0` fires again on every wrap), in reverse when `speed < 0`, and for events at the start time on the first update after `play`.

## Graph (`graph.ts`)

`createAnimGraph(mixer, desc: AnimGraphDesc): AnimGraph` puts a small state graph over a mixer so a game sets parameters instead of calling `crossFade` from its own state.

```ts
const graph = createAnimGraph(mixer, {
  params: { speed: 0, jump: false },
  states: {
    move: { blend: { param: 'speed', points: [{ at: 0, clip: idle }, { at: 0.5, clip: walk }, { at: 1, clip: run }] } },
    jump: { clip: jumpClip, loop: false },
  },
  transitions: [
    { from: '*', to: 'jump', when: (p) => p.jump === true, fade: 0.1 },
    { from: 'jump', to: 'move', when: () => true, fade: 0.25, exitTime: 0.9 },
  ],
  initial: 'move',
});
graph.onEnter('jump', () => graph.set('jump', false));
function frame(dt: number) {
  graph.set('speed', velocity / runSpeed);
  graph.update(dt);                        // transitions, fades, then mixer.update(dt)
}
```

- **`AnimGraphDesc`** `{ params: AnimGraphParams; states: Record<string, AnimGraphStateDesc>; transitions: AnimGraphTransition[]; initial }`. `AnimGraphParams` is `Record<string, number | boolean>`; the graph copies it once and passes that same object to every condition, so conditions allocate nothing.
- **States** (`AnimGraphStateDesc`): `AnimGraphClipState { clip; speed?; loop? }` plays one clip; `AnimGraphBlendState { blend: { param; points: AnimGraphBlendPoint[]; syncPhase? } }` is a 1D blend space (`AnimGraphBlendPoint { at; clip }`, sorted by `at`): the two points around the parameter share the weight linearly, beyond the ends the nearest point takes it all. With `syncPhase` (default true) every clip of the space runs at one normalised phase, advancing at the rate of the blended cycle (weighted mean of the durations) with each action's `speed` set to `duration / cycle`, so a walk→run blend keeps its feet in step; `false` plays each clip at speed 1.
- **Transitions** (`AnimGraphTransition`) `{ from: string | '*'; to; when: (params) => boolean; fade; exitTime? }` are evaluated in order on every `update`; the first that applies wins and only one fires per update. `'*'` applies from any state except `to`. `exitTime` (0..1) holds a transition until the current state's phase (`time / duration` for a clip, 1 once a non-looping clip finished, the shared phase for a synced blend space) reaches it. Entering a state rewinds its clips to their start.
- **Weights.** Every clip of every state is started on the mixer at construction with weight 0 (one `AnimationAction` each; size `maxActions` to fit) and keeps its slot. A transition lerps every state's weight from where it is toward 1 for the state entered and 0 for the rest over `fade` seconds (0 switches at once), so the weights sum to 1 at every instant, also when a fade interrupts another; a blend state spreads its weight over its points.
- **`AnimGraph`**: `params`, `state` (the target of the latest transition, from the instant it fires), `previous`, `set(param, value)` (throws for an undeclared name), `get(param)`, `update(dt)`, `onEnter(state, fn)` / `onExit(state, fn)` → unsubscribe (`AnimGraphListener = (from, to) => void`; exit fires before enter, once per change), `weight(state)`, `actions(state)` (the state's mixer actions, in `points` order), `phase(state)`, `go(state, fade?)` (force a state, ignoring the transitions).

## Pose (`pose.ts`)

`createPose(skeleton)` (a copy of `rest`), `copyPose(src, dst)`, `blendPose(a, b, t, out)` (lerp translation and scale, slerp rotation; `out` may alias), `poseToWorld(skeleton, pose, out3x4)`, `skinMatrices(skeleton, world3x4, out)` (copies world matrices when there is no `inverseBind`), `inverseBindFromRest(skeleton)` (12-float inverse bind matrices so the rest pose skins to the identity; allocates, call once). Matrix helpers on the 3×4 layout: `writeNodeMatrix(out, o, pose, po)` (`T · R · S` of one node), `multiplyAffine(out, oo, a, ao, b, bo)`, `invertAffine(out, oo, m, mo)`.

## Sockets (`socket.ts`)

A socket is a joint plus a fixed offset in that joint's space: a sword in a hand, a hat on a head, an emitter at a staff tip. Each frame it yields the world 3×4 of whatever rides it, so a second mesh follows the animated skeleton with no code in the game beyond "attach here".

```ts
const hand = createSocket(skeleton, 'hand.R', { position: [0, 0.08, 0], rotation: grip, scale: 1 });
const sword = new Transform();
function frame(dt) {
  mixer.update(dt);
  poseToWorld(skeleton, mixer.pose, world);
  attachTransform(hand, world, character.world, sword);   // sword.world = character · world[joint] · offset
  frame.mesh(swordMesh, steel, sword);
}
```

- **`Socket`** `{ joint: number; offset: Float32Array /* 12, 3×4 */ }`. `joint` indexes the world array `poseToWorld` writes (a node index).
- **`createSocket(skeleton, joint: number | string, local?: SocketLocal): Socket`** builds `offset` as `T · R · S` of **`SocketLocal`** `{ position?: [x, y, z]; rotation?: [x, y, z, w] (normalised); scale?: [x, y, z] | number }`, each part defaulting to the identity. A string joint resolves through **`Skeleton.names?: string[]`** (one name per node, glTF `node.name`; `validateSkeleton` checks its length); it throws when the skeleton has no `names`, when no node has that name, or when an index is out of range. Allocates (setup).
- **`socketWorld(socket, worldPose, instanceWorld | null, out): out`** writes `instanceWorld · worldPose[joint] · offset` (12 floats at `out[0..12)`). `instanceWorld` is the skeleton instance's own 3×4 (a `Transform.world`), or `null` when the pose is already in world space or the attached transform is parented to the instance. `out` may not alias `worldPose`. No allocation.
- **`attachTransform(socket, worldPose, instanceWorld | null, transform: Transform)`** writes that matrix into a `render/` `Transform` (`Transform.setMatrix`), so the attached mesh draws through `frame.mesh(mesh, material, transform)` like everything else; `transform.position` / `quaternion` / `scale` read the decomposition. Give the transform no parent, or the instance's transform as parent with `instanceWorld` `null`. No allocation.

`Transform` is this module's only tie to `render/`, imported as a type. `harness/sockets.html` shows a three-joint arm with two cubes attached, one by index and one by name.

## Quaternions (`quat.ts`)

All on `(x, y, z, w)` at an offset, allocation-free: `quatIdentity(out, o)`, `quatNormalize(q, o)`, `quatDot(a, ao, b, bo)`, `quatMultiply(out, oo, a, ao, b, bo)` (`a · b`: apply `b`, then `a`; may alias), `quatSlerp(out, oo, a, ao, b, bo, t)` (shorter arc, nlerp fallback when nearly parallel; may alias), `quatNlerp(...)`, `quatFromAxisAngle(out, o, ax, ay, az, radians)`, `quatFromEuler(out, o, x, y, z)` (about X, then Y, then Z: `qz · qy · qx`).

## IK and root motion (`ik.ts`, `root-motion.ts`)

Pose arithmetic that runs after sampling and before the final `poseToWorld`. Both solvers read the world matrices of the pose *as sampled* (`worldPose`: run `poseToWorld` once, hand it in, run it again after), so they never walk the skeleton themselves, and they write only local rotations into `pose`. Targets are points in the space `instanceWorld` (3×4 row-major, `render/transform.ts`) maps the skeleton into, or skeleton space when `instanceWorld` is `null`.

```ts
const chain = createIkChain(skeleton, { root: upperArm, mid: foreArm, tip: hand });  // once
mixer.update(dt);
poseToWorld(skeleton, mixer.pose, world);
twoBoneIk(mixer.pose, skeleton, world, chain, handTarget, elbowPole, instance, { weight: 0.8 });
lookAt(mixer.pose, skeleton, world, head, lookTarget, instance, { forward: [0, 0, 1], up: [0, 1, 0], maxAngle: 1.2 });
poseToWorld(skeleton, mixer.pose, world);                                               // final
```

- `twoBoneIk(pose, skeleton, worldPose, chain, targetWorld, poleWorld, instanceWorld, opts?: TwoBoneIkOptions)`: analytic law-of-cosines solve for `chain.root` and `chain.mid`. The mid joint moves towards `poleWorld` (the bend side); `null` keeps the current bend plane. An unreachable target straightens the chain towards it (no stretching); a target closer than `|a − b|` folds it. `weight` (default 1) slerps the two solved rotations against the input pose; `maxIterations` (default 1, exact for rigid bones) re-solves from the refreshed chain matrices, which helps only under non-uniform scale. Intermediate nodes between root, mid and tip (twist bones) are allowed and untouched.
- `createIkChain(skeleton, { root, mid, tip }: IkChainDesc): IkChain` validates the chain and allocates its scratch (path, world matrices, saved rotations). `twoBoneIk` also accepts a plain `IkChainDesc`, building and caching a chain per object (so keep the object; a fresh literal per call allocates).
- `lookAt(pose, skeleton, worldPose, joint, targetWorld, instanceWorld, opts?: LookAtOptions)`: rotates one joint so its local `forward` (default `[0, 0, 1]`) points at the target, turning at most `maxAngle` radians (default π) from the input forward, blended by `weight`. With an `up` hint (skeleton space) the joint also rolls about its new forward so what was up for it stays up, instead of tilting as it turns sideways.
- `extractRootMotion(clip, rootNode, opts?: RootMotionOptions): RootMotionSplit` → `{ clip, motion }`, two clips sharing keyframe times, channels copied not aliased. `clip` plays in place: the root keeps its first-frame translation (and yaw). `motion` holds the root's translation relative to the first key and, unless `planar`, its yaw about +Y relative to the first key (a swing-twist split: `motion · clip == original` for rotations, `motion + clip == original` for translations, at every key). `planar: true` moves only the horizontal (x, z) translation and leaves height and rotation in the clip. `CUBICSPLINE` translation keeps its tangents; a cubic rotation on the root comes back `LINEAR` over its key values. Allocates; call at load.
- `applyRootMotionDelta(motionClip, t0, t1, outDelta: RootMotionDelta): RootMotionDelta` writes `[dx, dy, dz, yaw]`: the position delta in the root's heading frame at `t0` (the motion clip's own yaw there) and the yaw delta (radians about +Y). The game rotates the position delta by its own heading, adds it, then adds the yaw: `heading += d[3]`. `t1 < t0` is a loop wrap: `t0 → duration` then `0 → t1`, the second part turned by the first's yaw. No allocation.

## Retargeting (`retarget.ts`)

One clip, every rig: a clip authored for one `Skeleton` drives another with different joint names, bone lengths and rest orientations (E-015: each cosmetic is a rig of its own).

- `createRetargetMap(source, target, opts?: RetargetOptions): RetargetMap`. Pairs target joints with source joints and precomputes the rest frames. Per source joint: `opts.pairs` (`[source, target]` by name or node index) first; then `opts.match(sourceName)` (returns the target name or `null`) when given, else the target joint with the same name, else the one whose `normalizeJointName` matches (lowercase, `namespace:` / `Armature|` prefix dropped, `_ - . : |` and spaces stripped: `mixamorig:LeftArm` ↔ `left_arm`). Names come from `Skeleton.names` (glTF `node.name`); two skeletons without names pair by index, and numeric `pairs` work without names. `opts.rootNode` (default: the first matched target node) is the node whose translation follows its source; `opts.scaleTranslation` (default true) scales that delta by the hip-height ratio (length of each root's rest world position). Allocates; build once per clip rig × character.
- `RetargetMap { source; target; pairs: Int32Array (target node → source node, -1 none); unmatched: string[] (target joints without a source, by name or index); root; translationScale (settable); pre; post }`. `pre[j]` and `post[j]` are the two constant quaternions per target node such that `Rt[j] = pre[j] · Rs[i] · post[j]`: the source joint's rest-relative rotation delta in its parent's frame, carried into the target parent's frame and applied on the target's rest rotation. When both rigs' bones point the same way in world space at rest (T- or A-pose), the target's bones follow the source's directions whatever its local joint frames are.
- `retargetPose(map, sourcePose, targetPose)` writes the whole target pose: unmatched joints hold the target rest; matched joints get the transferred rotation; translations and scales stay at the target rest except the root's translation (source delta rotated into the target frame × `translationScale`). No allocation.
- `retargetClip(map, clip, opts?: RetargetClipOptions): AnimationClip` bakes a source clip to the target: at each sample time (the clip's merged key times, or `opts.sampleRate` per second) the source is sampled and retargeted into `LINEAR` rotation keys per matched joint the clip rotates, plus root translation keys; `events` and `duration` kept, `opts.name` optional. Allocates once, for games that would rather not call `retargetPose` per frame.
- `normalizeJointName(name)` is exported for tests and custom `match` functions.

```ts
const map = createRetargetMap(clipRig, outfitRig);        // once
if (map.unmatched.length) console.warn(map.unmatched);    // joints that will hold rest
function frame(dt: number) {
  mixer.update(dt);                                       // mixer on clipRig
  retargetPose(map, mixer.pose, outfitPose);              // zero allocation
  poseToWorld(outfitRig, outfitPose, world);
}
```

## Morph targets (`morph.ts`)

Blend shapes on the CPU, written into an interleaved vertex buffer the mesh uploads (`Mesh.update`). `MorphTarget { position: Float32Array | null; normal: Float32Array | null }` is one target's per-vertex deltas (3 floats per vertex; `assets`' `GltfMorphTarget` is the same shape). `MorphLayout { floats; positionOffset?; normalOffset? }` says where the lanes sit (defaults 0 and 3, `normalOffset: null` for a layout without normals); `VERTEX_LAYOUT_3D` fits as is.

- `createMorphBlender(base, targets, layout, weights?)` → `MorphBlender { weights; targetCount; vertexCount; apply(out) }`. `base` is the primitive's interleaved vertices; `weights` (one per target) may be an array shared between the primitives of a mesh, else it is zeros. Throws `RangeError` when a target's deltas or `weights` are too short.
- `apply(out)` writes `base + Σ weights[i] × targets[i]` into `out`'s position and normal lanes, normals renormalised (a zero-length normal stays zero), every other lane copied from `base`. It returns false and writes nothing when no weight changed since the last apply into the same `out`; the first call, or a new `out`, copies the whole base first. Targets at weight 0 cost nothing. No allocation after creation.
- `sampleWeights(clip, node, t, out, cursor?)` (in `clip.ts`) fills `out[0..n)` from the clip's `'weights'` channel for `node` with the same interpolation rules as `sampleClip` (STEP, LINEAR, CUBICSPLINE, hold outside the key range, keyframe cursor); false when the clip has no such channel, `RangeError` when `out` is shorter than the channel. `sampleClip` is unchanged and still skips `'weights'` channels.

A frame: `sampleWeights(clip, node, t, blender.weights); if (blender.apply(buffer)) mesh.update({ vertices: buffer })`. `assets`' `loadGltf` does exactly this per primitive behind `scene.morph(node)`.

## Not here

Full-body IK, any GPU upload (`render/skin.ts`, `assets/gltf-load.ts` for morphed vertex buffers), glTF parsing (`assets/`).
