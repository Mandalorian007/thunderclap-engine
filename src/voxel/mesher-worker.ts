/**
 * The Worker side of `createVoxelMesher`. A game's worker script is two lines: import
 * `installVoxelMesherWorker` from the voxel subpath and call it with the mesher options
 * (`installVoxelMesherWorker({ layerOf })`); the page makes `new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })`
 * and hands it to `createVoxelMesher(grid, { worker })`. The Worker keeps its own `VoxelGrid`
 * over the buffer the client transfers, applies the edits the client mirrors and answers each
 * `mesh` request with one transferred `ChunkMesh` buffer. `opts` are the mesher's
 * (`layerOf`, `ao`, `outside`...): functions cannot cross the thread boundary, so the game
 * names them here and again on the client for its in-thread fallback.
 */
import { deserializeVoxelGrid, type VoxelGrid } from './grid';
import { type ChunkMeshOut, createChunkMeshOut, type MeshChunkOptions, meshChunk } from './mesher';
import { packChunkMesh, type VoxelMesherReply, type VoxelMesherRequest } from './worker-client';

/** The part of a Worker's global scope the install uses (a test passes a fake). */
export interface VoxelWorkerScopeLike {
  postMessage(message: VoxelMesherReply, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

const coords = [0, 0, 0];

/**
 * Listen for `VoxelMesherRequest`s on `scope` (default the Worker's `self`) and answer `mesh`
 * requests. Returns the handler, so a test can call it directly.
 */
export function installVoxelMesherWorker(
  opts: MeshChunkOptions = {},
  scope: VoxelWorkerScopeLike = self as unknown as VoxelWorkerScopeLike,
): (req: VoxelMesherRequest) => void {
  let grid: VoxelGrid | null = null;
  let out: ChunkMeshOut | null = null;
  const handle = (req: VoxelMesherRequest): void => {
    if (req.type === 'grid') {
      grid = deserializeVoxelGrid(req.buffer);
      return;
    }
    if (!grid) return;
    if (req.type === 'set') {
      grid.set(req.x, req.y, req.z, req.block);
      return;
    }
    if (req.type === 'mesh') {
      out ??= createChunkMeshOut();
      grid.chunkCoords(req.chunk, coords);
      meshChunk(grid, coords[0]!, coords[1]!, coords[2]!, opts, out);
      const reply: VoxelMesherReply = { type: 'mesh', ...packChunkMesh(out, req.chunk) };
      scope.postMessage(reply, [reply.buffer]);
    }
  };
  scope.addEventListener('message', (e) => {
    const req = e.data as VoxelMesherRequest | null;
    if (req && typeof req === 'object' && 'type' in req) handle(req);
  });
  return handle;
}
