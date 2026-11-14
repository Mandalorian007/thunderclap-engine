/**
 * Actors: many animated characters, rigid or skinned, at a fixed number of GPU calls.
 * Exported from `@thunderclap-engine/engine/actors`.
 */
export type { PoseScratch } from './pose-cpu';
export { actorMatrix, createPoseScratch, poseRecord } from './pose-cpu';
export type {
  ActorFieldType,
  ActorRecordInput,
  ActorRecordLayout,
  ActorRecordShape,
} from './record';
export { ACTOR_HEADER_WORDS, ACTOR_NONE, ACTOR_RECORD, recordShape } from './record';
export type {
  ActorClipDesc,
  ActorMesh,
  ActorRig,
  BakedClip,
  LinearRigDesc,
  RigDesc,
  RigidBoneDesc,
  RigidRigDesc,
  SkinnedMeshDesc,
} from './rig';
export { ACTOR_CLIP_FPS, ACTOR_VERTEX_BYTES, bakeClip, defineRig } from './rig';
export type { ActorStats, ActorSystemOptions } from './system';
export { ACTOR_VERTEX_LAYOUT, ActorSystem, createActorSystem } from './system';
export { ACTOR_DEFAULT_LIGHT_WGSL } from './wgsl';
