# engine/actors

Crowds: hundreds or thousands of animated characters, each a slot of plain numbers, drawn in a fixed number of GPU calls. `@thunderclap-engine/engine/actors` sits on the retained render core (`createRenderCore` in `@thunderclap-engine/engine/render`). It runs one compute pass a frame that reads every slot, culls it per view, picks its LOD and poses its bones. It draws one bundle of `drawIndexedIndirect` calls, one per model and LOD. The calls a frame makes are the same at 100 actors and at 1,000. A frame where no actor changes uploads nothing and allocates nothing.

An actor is a **record**: position, velocity and the time they were set (`since`), yaw, scale, model, a clip with its start time and rate, a second clip and a blend weight, a tint and a light word, plus any fields the game adds. The GPU moves the actor along its velocity and plays its clips from the clock, so a walking actor costs nothing until it changes course.

## Quick use

<!-- snippet:check -->
```ts
import { createActorSystem, defineRig } from '@thunderclap-engine/engine/actors';
import type { AnimationClip } from '@thunderclap-engine/engine/anim';
import type { PartModel } from '@thunderclap-engine/engine/models';
import type { RenderCore, RenderView } from '@thunderclap-engine/engine/render';

declare const core: RenderCore;
declare const view: RenderView;
declare const robot: PartModel; // parts: body, legL, legR
declare const walk: AnimationClip; // channels target parts by index in robot.parts
declare const encoder: GPUCommandEncoder;

const actors = createActorSystem(core, { slots: 2048, lods: [40] });
const model = actors.addModel(
  defineRig({
    kind: 'rigid',
    model: robot,
    materials: {},
    bones: { legL: { parent: 'body', pivot: [-0.15, 0.7, 0] }, legR: { parent: 'body', pivot: [0.15, 0.7, 0] } },
    clips: [{ clip: walk }],
  }),
);
actors.setRecord(0, { model, position: [0, 0, 0], velocity: [0, 0, 1], clip: 0 });

// Each frame, before core.prepare and core.draw:
actors.prepare(encoder, [view], performance.now() / 1000);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createActorSystem(core, opts)` | the slot table, the pose pass and the actors' draw set on a render core |
| `defineRig(desc)` | a model to add: `kind: 'rigid'` (a part model, each named top-level part a bone) or `kind: 'linear'` (a `Skeleton` and skinned meshes in the 56-byte `VERTEX_SKINNED_STRIDE` layout); clips are baked at `fps` (30) |
| `actors.addModel(rig)` | returns the model id a record names |
| `actors.setRecord(slot, input)` | writes fields; only changed slots upload, as one range a frame |
| `actors.remove(slot)`, `has(slot)`, `readF32` / `readU32` | the CPU mirror |
| `actors.prepare(encoder, views, time)` | uploads, resets the indirect counts and runs the pose pass |
| `actors.poseCpu(slot, out, 'world' or 'skin', time?)` | the same pose on the CPU, for hit tests, attachments and tests |
| `actors.bones`, `actors.args`, `drawOf(model, lod)` | the GPU outputs, for readback or a game's own pass |
| `recordShape(layout)` / `opts.recordLayout` | extra per-actor fields (`f32`, `u32`, `i32`) after the 20 header words, visible to WGSL as `ACTOR_FIELD_<NAME>` |
| `ACTOR_RECORD` | the header's word offsets |

## How it works

- **Records.** `slots` × `stride` words on the CPU and in one storage buffer. `setRecord` marks a dirty range; `prepare` uploads it in one `writeBuffer`.
- **Pose pass.** One thread per slot up to the highest used. It places the actor at `position + velocity × (time − since)` and culls its bounding sphere against each view's frustum. It picks the LOD by distance to view 0, samples the baked clips (two, blended), and writes the bones into `actors.bones`. Then it appends itself to its draw's instance list with an atomic add on the indirect args.
- **Draws.** One `DrawSet` with `cull: 'external'`: the core records its bundle once, and the pose pass fills the instance counts. A vertex is 32 bytes (position, normal, colour, four joints and weights, and the draw id), so rigid and skinned models share one pipeline.
- **Lighting.** Each record carries a light word (RGBA8). `opts.sampleLight(x, y, z)` fills it when a position is set (for example, from a voxel light grid). `opts.lightWgsl` replaces the default `actor_light(actor, world, normal, color, light)` with the game's shading.

## Limits

Up to 65,535 slots, 64 bones a slot (16 by default), 4 LOD distances, `maxModels` models (16) and `maxViews` views (2, at most the core's). LOD picks from view 0. A rigid rig's clips target top-level parts by index; nested parts ride their top-level part.

## Reference

| Name | Kind |
| --- | --- |
| `ActorSystem`, `ActorSystemOptions`, `ActorStats` (`calls`, `recordBytes`, `dispatched`) | the system, its options and its per-frame counts |
| `ActorRig`, `ActorMesh`, `BakedClip` | what `defineRig` returns: bones, meshes (one per LOD) and clips baked into TRS frames |
| `RigDesc`, `RigidRigDesc`, `RigidBoneDesc`, `LinearRigDesc`, `SkinnedMeshDesc`, `ActorClipDesc` | what `defineRig` takes |
| `bakeClip`, `ACTOR_CLIP_FPS` | bake one `AnimationClip` at a rate (30 by default) |
| `ActorRecordInput`, `ActorRecordLayout`, `ActorFieldType`, `ActorRecordShape` | what `setRecord` takes and what `recordShape` returns |
| `ACTOR_HEADER_WORDS`, `ACTOR_NONE` | the header's 20 words; the empty-model and no-clip value (`0xffffffff`) |
| `ACTOR_VERTEX_LAYOUT`, `ACTOR_VERTEX_BYTES` | the 32-byte vertex every actor model is converted into |
| `ACTOR_DEFAULT_LIGHT_WGSL` | the default `actor_light`, a starting point for `lightWgsl` |
| `poseRecord`, `actorMatrix`, `createPoseScratch`, `PoseScratch` | the CPU pose behind `poseCpu`, for a record in any `Float32Array` |
