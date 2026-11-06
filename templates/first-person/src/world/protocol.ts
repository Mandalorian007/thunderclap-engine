/**
 * Messages between the scene and the mesher Worker (`world/worker.ts`). The buffer travels both
 * ways by transfer, so neither side copies it.
 */
import type { ChunkBounds } from './mesher';

/** Page → Worker: mesh chunk (cx, cz) of the world `seed` describes into `buffer`. */
export interface ChunkRequest {
  seed: number;
  cx: number;
  cz: number;
  buffer: ArrayBuffer;
}

/** Worker → page: `buffer` holds the vertices and indices; counts and bounds for `mesh.update`. */
export interface ChunkReply {
  cx: number;
  cz: number;
  buffer: ArrayBuffer;
  vertexCount: number;
  indexCount: number;
  bounds: ChunkBounds;
}
