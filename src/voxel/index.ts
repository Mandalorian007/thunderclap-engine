/**
 * `@thunderclap-engine/engine/voxel`: streamed block worlds on the retained render core. Block
 * tables and formats as data, a sparse section store, a Worker section mesher pool with light
 * and connectivity, `createVoxelWorld` drawing the sections through GPU-culled sets, a
 * `VoxelGrid` (a small bounded world, fed in with `feedVoxelGrid`) and picking rays. The game
 * ships the blocks: what each id is, how a face looks, what a click does. (The chunk-mesh path,
 * `createVoxelChunks` and `meshChunk`, was removed by ws/core-passes.)
 */

// Streamed sections (any block game): block tables as data, a declared vertex layout, a
// sparse section store, a Worker mesher pool with light and connectivity, and a picking ray.
export type {
  BlockDef,
  BlockTable,
  BlockTableOptions,
  CellField,
  CellLayout,
  FaceClass,
} from './blocks';
export { defineBlockTable, FACE_CLASS, LIGHT_HUES, NO_HUE_MIX } from './blocks';
export type { SectionConnectivity } from './connectivity';
export {
  ALL_FACE_PAIRS,
  ConnectivityFlood,
  facePairBit,
  uniformConnectivity,
} from './connectivity';
export type { SectionCodec, VoxelFormat, VoxelFormatOptions } from './format';
export {
  defineVoxelFormat,
  encodeRawSection,
  RAW_SECTION_CODEC,
  sectionIndex,
  sectionKey,
  sectionKeyX,
  sectionKeyY,
  sectionKeyZ,
} from './format';
export type { VoxelGrid, VoxelGridListener, VoxelGridOptions } from './grid';
export { createVoxelGrid, deserializeVoxelGrid } from './grid';
export type { VoxelGridSource, VoxelGridSourceOptions } from './grid-source';
export { feedVoxelGrid } from './grid-source';
export { BlockLightFlood } from './light';
export type {
  MesherPort,
  SectionMeshPoolErrors,
  SectionMeshPoolOptions,
  SectionMeshPoolStats,
} from './pool';
export { inThreadMesherPort, SectionMeshPool, workerMesherPort } from './pool';
export type { VoxelHit } from './ray';
export { createVoxelHit, raycastVoxels } from './ray';
export type {
  VertexField,
  VertexFieldDef,
  VertexSchema,
  VertexSchemaOptions,
  VertexSchemaWgslOptions,
} from './schema';
export {
  defineVertexSchema,
  packVertexField,
  unpackSectionVertex,
  VOXEL_VERTEX_DEFAULTS,
  VOXEL_VERTEX_OPTIONAL,
  vertexField,
  vertexFieldValue,
  vertexSchemaWgsl,
} from './schema';
export type { InsetFieldBits, SectionMesh, SectionMeshOptions } from './section-mesher';
export { CROSS_FACE, SECTION_VERTEX_WORDS, SectionMesher } from './section-mesher';
export type {
  PoolMeshOptions,
  SectionMesherReply,
  SectionMesherRequest,
  SectionMeshResult,
  SectionWorkerScopeLike,
} from './section-protocol';
export { installSectionMesherWorker, sectionReplyTransfers } from './section-protocol';
export {
  RAY_HIT,
  RAY_PASS,
  RAY_UNKNOWN,
  raycastCells,
  sectionRayProbe,
} from './section-ray';
export type { SectionInput, SectionJob, SourceSection } from './sources';
export {
  HEIGHT_BLOCKED,
  HEIGHT_OPEN,
  jobTransfers,
  packSources,
  SectionInputBuilder,
  sourceIndex,
} from './sources';
export type { SectionStore, SectionStoreOptions, SectionStoreStats } from './store';
export { createSectionStore } from './store';
export type { SectionBox, SectionVisibilityOptions, SectionVisibilityStats } from './visibility';
export { SectionVisibility } from './visibility';
export type {
  VoxelMaterial,
  VoxelSetDesc,
  VoxelWorld,
  VoxelWorldOptions,
  VoxelWorldStats,
} from './world';
export { createVoxelWorld, voxelSetDesc } from './world';
export type { VoxelStream } from './world-shaders';
export {
  VOXEL_DEFAULT_FRAGMENT,
  VOXEL_DEFAULT_WRITES,
  VOXEL_VARYING_WGSL,
  voxelVertexWgsl,
} from './world-shaders';
