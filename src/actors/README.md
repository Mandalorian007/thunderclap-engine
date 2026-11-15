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
| `actors.addModel(rig, opts?)` | returns the model id a record names; `opts.lods` (`ActorModelOptions`) gives the model its own LOD distances |
| `actors.setRecord(slot, input)` | writes fields; only changed slots upload, one write per run of changed slots (`stats.recordWrites`) |
| `actors.remove(slot)`, `has(slot)`, `readF32` / `readU32` | the CPU mirror |
| `actors.prepare(encoder, views, time, timestampWrites?)` | uploads, resets the indirect counts and runs the pose pass (timed with the writes given, for example `GpuTimer.pass('actors')`) |
| `actors.lodScale`, `actors.vertexCap` (`opts.lodScale`, `opts.vertexCap`) | scale every LOD distance, and cap the vertices of actors per view (an actor past it draws its model's coarsest mesh); read each `prepare`, so a frame governor may set them |
| `opts.tableWords`, `actors.writeTable(data, at?)` | a game table bound to the pose pass at group 0 binding 7, read with `actor_table_word(i)` / `actor_table_f32(i)` |
| `opts.poseTable`, `addModel(rig, { table })` | the pose hook's own tables (ws/pass-actor-fit), packed into the rig buffer the pose pass already reads (no binding): `actor_pose_word(i)` / `actor_pose_f32(i)` (`ACTOR_POSE_TABLE_WORDS` long) for the set's, `actor_model_word(model, i)` / `actor_model_f32(model, i)` (`actor_model_words(model)` long, 0 without one) for a model's. Fixed at creation or `addModel` (a rig table: bones, keys); data that changes goes in `writeTable` |
| `actors.showModel(model, show, set?)`, `modelShown(model, set?)` | show or hide a model's draws in one set (`addDrawSet`'s, or `actors.drawSet` for the body) or in every set, without a new set: only that set's bundle re-records (ws/pass-actor-fit). A hidden model stays out whatever its actors; shown again, a live set still leaves it out while it has no actor |
| `opts.drawSet`, `actors.hasDrawSet` | `false` (E27): no body set is made, so its pipelines never compile; the actors draw through `addDrawSet`'s sets or the game's own draws. `actors.drawSet` then throws; `showModel`, `setInfo`, `readBack` and restores cover the added sets only, and `modelShown(model)` reads the first added set |
| `opts.drawTable` | the same table bound into every actor draw set too (group 1: binding 3 in the body's, 4 in an added set's), for per-actor game data a draw reads (a status colour, a held item), `lightWgsl` included (ws/actor-fit-2) |
| `opts.asyncPipeline`, `actors.ready` | make the pose pipeline with `createComputePipelineAsync`; the actors draw nothing until `ready` settles; the pose pipeline gets an empty first dispatch at load when `core.warming` (ws/forge-asks-fit) |
| `actors.whenReady()`, `compileNow()`, `pipelineReady` | for tests and harnesses (ws/actor-fit-2): await the current device's pose pipeline (past a restore), or make a pending one now, synchronously |
| `actors.setInfo()` → `ActorSetInfo[]` | each set (the body first): label, shape, `enabled`, the models in its bundle with their names (`addModel(rig, { name })`) and live actors, its draws, and vertices per instance of them; `ActorReadBack.setVertices` has the vertices each drew in view 0 (ws/actor-fit-2) |
| `opts.showLive` | false keeps every model's draws in the body's bundle from the start (no re-record on a model's first actor); `ActorDrawSetDesc.showLive` does the same for one set |
| `actors.poseCpu(slot, out, 'world' or 'skin', time?)` | the same pose on the CPU, for hit tests, attachments and tests |
| `actors.readBack(slots?)` → `Promise<ActorReadBack>` | the last frame's skin matrices and indirect arguments read back beside the CPU twin of the same records at the f32 clock the pass saw, posed at the call (ws/pose-parity-fix): call it right after the frame's submit. Posing with `poseCpu` after awaiting a map poses later records, and a crowd rewritten every frame drifts by a frame's motion. Calls may overlap (each maps its own buffer); after a device restore it rejects until a frame poses, and a failed map rejects naming why. Tests and dev only |
| `actors.bones`, `actors.args`, `drawOf(model, lod)` | the GPU outputs, for readback or a game's own pass |
| `recordShape(layout)` / `opts.recordLayout` | extra per-actor fields (`f32`, `u32`, `i32`) after the 20 header words, visible to WGSL as `ACTOR_FIELD_<NAME>` |
| `ACTOR_RECORD` | the header's word offsets |
| `opts.poseWgsl` / `opts.poseCpu` (`ActorPoseCpu`) | the pose hook (ws/actor-fit): `fn actor_pose(actor, model, node, p: Trs, time) -> Trs` changes each node's local transform after the clips; its CPU twin keeps `poseCpu` matching |
| `actors.addDrawSet(desc)` | another set over the same models, poses and visible lists with its own shader (`ActorDrawSetDesc`: entries, blend, pass, order, own groups at 2+); `shape: 'actor'` with `opts.actorVertices` draws that many unindexed vertices per visible actor (a contact shadow's quad); a list (`[6, 36]`) gives each count its own record and a set picks one with `desc.vertices` |

## How it works

- **Records.** `slots` × `stride` words on the CPU and in one storage buffer. `setRecord` marks its slot; `prepare` uploads each run of changed slots, merging runs less than 1 KB apart, at most 16 writes a frame (the last covers the rest).
- **Pose pass.** One thread per slot up to the highest used. It places the actor at `position + velocity × (time − since)` and culls its bounding sphere against each view's frustum. Its sphere's radius is the record's `cullRadius` (word 19), or the model's radius × scale when 0. It picks the LOD by distance to view 0 against the model's own distances (or the system's), each × `lodScale`; with `vertexCap`, a per-view counter of indices drawn sends an actor past it to its model's coarsest mesh. It samples the baked clips (two, blended), and writes the bones into `actors.bones`. Then it appends itself to its draw's instance list with an atomic add on the indirect args.
- **Draws.** One `DrawSet` with `cull: 'external'`: the core records its bundle once, and the pose pass fills the instance counts. A vertex is 32 bytes (position, normal, colour, four joints and weights, and the draw id), so rigid and skinned models share one pipeline.
- **Empty models.** A model no record shows has its draws hidden, so its indirect draws leave the bundle (re-recorded only when a model gains its first actor or loses its last).
- **Shared sets.** `addDrawSet` prepends the actor buffers at group 1 and helpers (`actor_at(draw, inst)`, `actor_word`, `actor_position`, `actor_yaw`, `actor_scale`, `actor_model`, `actor_bone`, `actor_skin`, `actor_point`, `actor_dir`, `actor_draw_of`, `actor_light`). Its slots are the model meshes and read the system's arguments, so it costs one more bundle and no pass. With `actorVertices` each (view, mesh) cell is the body's five words of `drawIndexedIndirect`, then a four-word `drawIndirect` per count, of that many vertices, whose first vertex is `mesh × count`. Every set (the body too) has an empty shadow fragment entry (`actor_shadow_fs`), so its shadow pipeline keeps the actor groups bound.
- **Lighting.** Each record carries a light word (RGBA8). `opts.sampleLight(x, y, z)` fills it when a position is set (for example, from a voxel light grid). `opts.lightWgsl` replaces the default `actor_light(actor, world, normal, color, light)` with the game's shading.

## Limits

Up to 65,535 slots, 64 bones a slot (16 by default), 4 LOD distances, `maxModels` models (16) and `maxViews` views (2, at most the core's). LOD picks from view 0. A rigid rig's clips target top-level parts by index; nested parts ride their top-level part.

## Reference

| Name | Kind |
| --- | --- |
| `ActorSystem`, `ActorSystemOptions`, `ActorStats` (`calls`, `recordBytes`, `recordWrites`, `dispatched`) | the system, its options and its per-frame counts |
| `ActorModelOptions` | `addModel`'s per-model options (`lods`, `name`) |
| `ActorSetInfo` | one set as `setInfo` sees it |
| `ActorRig`, `ActorMesh`, `BakedClip` | what `defineRig` returns: bones, meshes (one per LOD) and clips baked into TRS frames |
| `RigDesc`, `RigidRigDesc`, `RigidBoneDesc`, `LinearRigDesc`, `SkinnedMeshDesc`, `ActorClipDesc` | what `defineRig` takes |
| `bakeClip`, `ACTOR_CLIP_FPS` | bake one `AnimationClip` at a rate (30 by default) |
| `ActorRecordInput`, `ActorRecordLayout`, `ActorFieldType`, `ActorRecordShape` | what `setRecord` takes and what `recordShape` returns |
| `ACTOR_HEADER_WORDS`, `ACTOR_NONE` | the header's 20 words; the empty-model and no-clip value (`0xffffffff`) |
| `ACTOR_VERTEX_LAYOUT`, `ACTOR_VERTEX_BYTES` | the 32-byte vertex every actor model is converted into |
| `ACTOR_DEFAULT_LIGHT_WGSL` | the default `actor_light`, a starting point for `lightWgsl` |
| `poseRecord`, `actorMatrix`, `createPoseScratch`, `PoseScratch` | the CPU pose behind `poseCpu`, for a record in any `Float32Array` |
