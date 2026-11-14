/**
 * `@thunderclap-engine/engine/voxel`: block grids into chunk meshes and onto the screen. A
 * `VoxelGrid` of block ids with per-chunk dirty flags, a greedy mesher with baked ambient
 * occlusion (`meshChunk`, pure, Worker-ready) and its Worker bridge (`createVoxelMesher`,
 * `installVoxelMesherWorker`), a chunk renderer that owns one mesh per non-empty chunk and
 * frustum-culls them (`createVoxelChunks`), a block-picking ray (`raycastVoxels`) and the WGSL
 * prelude a block material reads the vertex convention with (`VOXEL_WGSL`). The game ships the
 * blocks: what each id is, which texture layer each face shows, what a click does.
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
export type {
  VoxelChunks,
  VoxelChunksOptions,
  VoxelChunksStats,
  VoxelDrawStats,
} from './chunks';
export { createVoxelChunks } from './chunks';
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
export type { ChunkMeshOut, MeshChunkOptions, VoxelFace } from './mesher';
export {
  countExposedFaces,
  createChunkMeshOut,
  meshChunk,
  VOXEL_AO_CURVE,
  VOXEL_FACE_NORMALS,
  VOXEL_VERTEX_FLOATS,
} from './mesher';
export type { VoxelWorkerScopeLike } from './mesher-worker';
export { installVoxelMesherWorker } from './mesher-worker';
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
export type { SectionMesh, SectionMeshOptions } from './section-mesher';
export { CROSS_FACE, SECTION_VERTEX_WORDS, SectionMesher } from './section-mesher';
export type {
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
export { VOXEL_WGSL } from './wgsl';
export type {
  ChunkMesh,
  VoxelMesher,
  VoxelMesherOptions,
  VoxelMesherReply,
  VoxelMesherRequest,
  VoxelWorkerLike,
} from './worker-client';
export { createVoxelMesher, packChunkMesh } from './worker-client';
export type { VoxelMaterial, VoxelWorld, VoxelWorldOptions, VoxelWorldStats } from './world';
export { createVoxelWorld } from './world';
export type { VoxelStream } from './world-shaders';
export { VOXEL_DEFAULT_FRAGMENT, VOXEL_VARYING_WGSL, voxelVertexWgsl } from './world-shaders';
