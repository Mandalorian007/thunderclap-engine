/**
 * The mesher behind a promise: `createVoxelMesher(grid, { worker })` runs `meshChunk` in the
 * Worker the game made from a three-line script calling `installVoxelMesherWorker`
 * (`mesher-worker.ts`), or on the main thread when no Worker is given (the same code, the same
 * reply shape, a microtask later). The Worker owns a copy of the grid: `createVoxelMesher`
 * sends `grid.serialize()` once and mirrors every `set` the grid reports afterwards
 * (`VoxelGrid.subscribe`), so the game edits the grid and nothing else.
 *
 * `remesh(chunk)` resolves with a `ChunkMesh`: one transferred `ArrayBuffer` in the
 * `MeshReply` shape `Mesh.update` takes as it is (vertices from byte 0, uint32 indices after
 * them). One request per chunk is in flight at a time; a repeat while one is in flight waits
 * for the next run (coalesced: a burst of edits to one chunk meshes it twice at most).
 */
import type { MeshBounds, MeshReply } from '../render/mesh';
import type { VoxelGrid } from './grid';
import {
  type ChunkMeshOut,
  createChunkMeshOut,
  type MeshChunkOptions,
  meshChunk,
  VOXEL_VERTEX_FLOATS,
} from './mesher';

/** A meshed chunk: `Mesh.update` takes it as a `MeshReply`. */
export interface ChunkMesh extends MeshReply {
  chunk: number;
  buffer: ArrayBuffer;
  vertexCount: number;
  /** 6 per quad; 0 for an empty chunk (`buffer` is then empty). */
  indexCount: number;
  /** Byte offset of the uint32 indices in `buffer`. */
  indexOffset: number;
  /** Bounding sphere in chunk-local units (radius 0 when empty). */
  bounds: MeshBounds;
}

/** Page → Worker. */
export type VoxelMesherRequest =
  | { type: 'grid'; buffer: ArrayBuffer }
  | { type: 'set'; x: number; y: number; z: number; block: number }
  | { type: 'mesh'; chunk: number };

/** Worker → page. */
export type VoxelMesherReply = ChunkMesh & { type: 'mesh' };

/** The part of a `Worker` the client uses (a test passes a fake). */
export interface VoxelWorkerLike {
  postMessage(message: VoxelMesherRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

export interface VoxelMesherOptions extends MeshChunkOptions {
  /** Mesh in this Worker (made from a script calling `installVoxelMesherWorker`). Default: in-thread. */
  worker?: VoxelWorkerLike;
}

export interface VoxelMesher {
  readonly grid: VoxelGrid;
  /** True when a Worker does the meshing. */
  readonly offThread: boolean;
  /** Requests not yet resolved. */
  readonly pending: number;
  /** Mesh `chunk` (a chunk index) as the grid stands when the request runs. */
  remesh(chunk: number): Promise<ChunkMesh>;
  /** Resend the whole grid to the Worker (`fill` and `deserialize` do this on their own). */
  sync(): void;
  /** Stop mirroring the grid and listening to the Worker. The game terminates the Worker. */
  dispose(): void;
}

/**
 * Copy the mesher's output into one new `ArrayBuffer` (vertices, then uint32 indices) as a
 * `ChunkMesh`, ready to transfer. An empty output gives an empty buffer.
 */
export function packChunkMesh(out: ChunkMeshOut, chunk: number): ChunkMesh {
  const vertexBytes = out.vertexCount * VOXEL_VERTEX_FLOATS * 4;
  const indexBytes = out.indexCount * 4;
  const buffer = new ArrayBuffer(vertexBytes + indexBytes);
  if (vertexBytes > 0) {
    new Float32Array(buffer, 0, out.vertexCount * VOXEL_VERTEX_FLOATS).set(
      out.vertices.subarray(0, out.vertexCount * VOXEL_VERTEX_FLOATS),
    );
  }
  if (indexBytes > 0) {
    new Uint32Array(buffer, vertexBytes, out.indexCount).set(
      out.indices.subarray(0, out.indexCount),
    );
  }
  const b = out.bounds;
  return {
    chunk,
    buffer,
    vertexCount: out.vertexCount,
    indexCount: out.indexCount,
    indexOffset: vertexBytes,
    bounds: { center: [b.center[0], b.center[1], b.center[2]], radius: b.radius },
  };
}

interface Deferred {
  promise: Promise<ChunkMesh>;
  resolve: (m: ChunkMesh) => void;
}

function deferred(): Deferred {
  let resolve!: (m: ChunkMesh) => void;
  const promise = new Promise<ChunkMesh>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const coordsOut = [0, 0, 0];

export function createVoxelMesher(grid: VoxelGrid, opts: VoxelMesherOptions = {}): VoxelMesher {
  const worker = opts.worker ?? null;
  const inflight = new Map<number, Deferred>();
  const queued = new Map<number, Deferred>();
  let out: ChunkMeshOut | null = null;
  let pendingCount = 0;

  const send = (chunk: number, d: Deferred): void => {
    inflight.set(chunk, d);
    worker!.postMessage({ type: 'mesh', chunk });
  };

  const onMessage = (e: { data: unknown }): void => {
    const reply = e.data as VoxelMesherReply | null;
    if (!reply || reply.type !== 'mesh') return;
    const d = inflight.get(reply.chunk);
    if (!d) return;
    inflight.delete(reply.chunk);
    pendingCount--;
    const next = queued.get(reply.chunk);
    if (next) {
      queued.delete(reply.chunk);
      send(reply.chunk, next);
    }
    d.resolve(reply);
  };

  const unsubscribe = grid.subscribe({
    set: (x, y, z, block) => worker?.postMessage({ type: 'set', x, y, z, block }),
    reset: () => sync(),
  });

  function sync(): void {
    if (!worker) return;
    const buffer = grid.serialize();
    worker.postMessage({ type: 'grid', buffer }, [buffer]);
  }

  if (worker) {
    worker.addEventListener('message', onMessage);
    sync();
  }

  const remeshInThread = (chunk: number): Promise<ChunkMesh> => {
    const d = deferred();
    inflight.set(chunk, d);
    pendingCount++;
    queueMicrotask(() => {
      inflight.delete(chunk);
      pendingCount--;
      out ??= createChunkMeshOut();
      grid.chunkCoords(chunk, coordsOut);
      meshChunk(grid, coordsOut[0]!, coordsOut[1]!, coordsOut[2]!, opts, out);
      d.resolve(packChunkMesh(out, chunk));
    });
    return d.promise;
  };

  return {
    grid,
    offThread: worker !== null,
    get pending() {
      return pendingCount;
    },
    remesh(chunk) {
      const current = inflight.get(chunk);
      if (current) {
        if (!worker) return current.promise;
        let next = queued.get(chunk);
        if (!next) {
          next = deferred();
          queued.set(chunk, next);
          pendingCount++;
        }
        return next.promise;
      }
      if (!worker) return remeshInThread(chunk);
      const d = deferred();
      pendingCount++;
      send(chunk, d);
      return d.promise;
    },
    sync,
    dispose() {
      unsubscribe();
      worker?.removeEventListener('message', onMessage);
      inflight.clear();
      queued.clear();
    },
  };
}
