# engine/anim

Keyframe animation with no GPU in it: clips with glTF sampler semantics sampled into poses, a mixer that layers, weights and cross-fades them, and two resolutions a renderer consumes: node world matrices and skin joint matrices. Flat `Float32Array`s throughout; after setup nothing allocates per frame. No dependency on `render/`; `render/skin.ts` (ws/skinning) uploads what `skinMatrices` writes.

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

## Pose (`pose.ts`)

`createPose(skeleton)` (a copy of `rest`), `copyPose(src, dst)`, `blendPose(a, b, t, out)` (lerp translation and scale, slerp rotation; `out` may alias), `poseToWorld(skeleton, pose, out3x4)`, `skinMatrices(skeleton, world3x4, out)` (copies world matrices when there is no `inverseBind`), `inverseBindFromRest(skeleton)` (12-float inverse bind matrices so the rest pose skins to the identity; allocates, call once). Matrix helpers on the 3×4 layout: `writeNodeMatrix(out, o, pose, po)` (`T · R · S` of one node), `multiplyAffine(out, oo, a, ao, b, bo)`, `invertAffine(out, oo, m, mo)`.

## Quaternions (`quat.ts`)

All on `(x, y, z, w)` at an offset, allocation-free: `quatIdentity(out, o)`, `quatNormalize(q, o)`, `quatDot(a, ao, b, bo)`, `quatMultiply(out, oo, a, ao, b, bo)` (`a · b`: apply `b`, then `a`; may alias), `quatSlerp(out, oo, a, ao, b, bo, t)` (shorter arc, nlerp fallback when nearly parallel; may alias), `quatNlerp(...)`, `quatFromAxisAngle(out, o, ax, ay, az, radians)`, `quatFromEuler(out, o, x, y, z)` (about X, then Y, then Z: `qz · qy · qx`).

## Not here

IK, retargeting, root motion extraction, morph-target application (sample `'weights'` channels yourself), any GPU upload (`render/skin.ts`), glTF parsing (`assets/`).
