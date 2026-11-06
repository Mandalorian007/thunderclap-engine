/**
 * `@thunderclap/engine/voxel`: block grids into chunk meshes and onto the screen. A
 * `VoxelGrid` of block ids with per-chunk dirty flags, a greedy mesher with baked ambient
 * occlusion (`meshChunk`, pure, Worker-ready) and its Worker bridge (`createVoxelMesher`,
 * `installVoxelMesherWorker`), a chunk renderer that owns one mesh per non-empty chunk and
 * frustum-culls them (`createVoxelChunks`), a block-picking ray (`raycastVoxels`) and the WGSL
 * prelude a block material reads the vertex convention with (`VOXEL_WGSL`). The game ships the
 * blocks: what each id is, which texture layer each face shows, what a click does.
 */
export type {
  VoxelChunks,
  VoxelChunksOptions,
  VoxelChunksStats,
  VoxelDrawStats,
} from './chunks';
export { createVoxelChunks } from './chunks';
export type { VoxelGrid, VoxelGridListener, VoxelGridOptions } from './grid';
export { createVoxelGrid, deserializeVoxelGrid } from './grid';
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
export type { VoxelHit } from './ray';
export { createVoxelHit, raycastVoxels } from './ray';
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
