/**
 * Merged mesh runs (ws/core-immediate, D1 §3.3 / §3.9): the immediate API's distinct meshes on
 * the render core's arenas.
 *
 * A *run* is a stretch of consecutive scene commands that share pipeline, material and uniform
 * offset but draw different meshes (`frame.mesh` of many small meshes: what does not batch).
 * Their geometry is copied once into the pool (`MeshPool`: one core `Arena` per vertex stride,
 * one per index format), so the whole run binds one vertex and one index buffer and draws with
 * per-command arguments: one `multiDrawIndexedIndirect` with the multi-draw feature, else a
 * cached render bundle of `drawIndexedIndirect` (one `executeBundles` per run) with
 * `indirect-first-instance`, else direct `drawIndexed` calls with a base vertex. The arguments are
 * written by the CPU each view (the transient set's cull is the renderer's CPU sphere cull), so
 * the GPU calls of a run stay flat in the number of meshes it draws. Draw order, blending and
 * depth are the commands' own: the indirect draws run in command order.
 */

import type { ArenaAlloc } from './core/arena';
import { Arena } from './core/arena';
import type { Mesh } from './mesh';

/** Bytes of one `drawIndexedIndirect` argument record (5 × u32). */
export const INDEXED_ARGS_BYTES = 20;

/** Largest vertex (and index) data a mesh may have to join the pool, in bytes. */
export const POOL_MAX_BYTES = 256 << 10;

/** Frames a pooled mesh may go unused before the pool gives its room back. */
const POOL_IDLE_FRAMES = 600;

/** Bytes per pool block: vertices, indices. */
const VERTEX_BLOCK = 8 << 20;
const INDEX_BLOCK = 4 << 20;

/** A mesh's place in the pool. */
export interface PoolEntry {
  /** The vertex arena's buffer the mesh lives in, and its first vertex there. */
  vertexBuffer: GPUBuffer;
  baseVertex: number;
  /** The index arena's buffer, its format, and the mesh's first index there. */
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  firstIndex: number;
  /** `Mesh.revision` the copy was taken at. */
  revision: number;
  /** Pool frame it was last drawn in. */
  seen: number;
  v: ArenaAlloc;
  i: ArenaAlloc;
  vArena: Arena;
  iArena: Arena;
}

/**
 * The renderer's mesh pool: small indexed meshes copied (GPU to GPU, `copyBufferToBuffer`) into
 * shared arenas so a run of them binds one buffer pair. A mesh is copied when it first joins a
 * run and again after each `update()` (`Mesh.revision`); room unused for `POOL_IDLE_FRAMES`
 * frames, or of a destroyed mesh, is given back.
 */
export class MeshPool {
  private readonly vertex = new Map<number, Arena>();
  private index16: Arena | null = null;
  private index32: Arena | null = null;
  private readonly entries = new Map<Mesh, PoolEntry>();
  private frame = 0;
  /** Copies encoded so far (tests). */
  copies = 0;

  constructor(private readonly device: GPUDevice) {}

  /** Meshes in the pool. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether `mesh` can join a run: indexed, small, with geometry. */
  static fits(mesh: Mesh): boolean {
    const ib = mesh.indexBuffer;
    if (!ib || mesh.indexCount <= 0 || mesh.vertexCount <= 0) return false;
    const bpi = mesh.indexFormat === 'uint32' ? 4 : 2;
    return (
      mesh.vertexCount * mesh.layout.stride <= POOL_MAX_BYTES &&
      mesh.indexCount * bpi <= POOL_MAX_BYTES
    );
  }

  /** The entry of a fitting `mesh`, copying its geometry on `enc` when new or changed. */
  get(mesh: Mesh, enc: GPUCommandEncoder): PoolEntry {
    let e = this.entries.get(mesh);
    if (e && e.revision === mesh.revision && e.indexFormat === mesh.indexFormat) {
      e.seen = this.frame;
      return e;
    }
    const stride = mesh.layout.stride;
    const vBytes = mesh.vertexCount * stride;
    const bpi = mesh.indexFormat === 'uint32' ? 4 : 2;
    const iBytes = (mesh.indexCount * bpi + 3) & ~3;
    const iArena = this.indexArena(mesh.indexFormat);
    const vArena = this.vertexArena(stride);
    if (e && (e.v.size < vBytes || e.i.size < iBytes || e.iArena !== iArena)) {
      e.vArena.free(e.v);
      e.iArena.free(e.i);
      this.entries.delete(mesh);
      e = undefined;
    }
    if (!e) {
      const v = vArena.alloc(vBytes, stride);
      const i = iArena.alloc(iBytes, 4);
      e = {
        vertexBuffer: vArena.buffers[v.block]!,
        baseVertex: v.offset / stride,
        indexBuffer: iArena.buffers[i.block]!,
        indexFormat: mesh.indexFormat,
        firstIndex: i.offset / bpi,
        revision: -1,
        seen: this.frame,
        v,
        i,
        vArena,
        iArena,
      };
      this.entries.set(mesh, e);
    }
    enc.copyBufferToBuffer(mesh.vertexBuffer, 0, e.vertexBuffer, e.v.offset, vBytes);
    enc.copyBufferToBuffer(
      mesh.indexBuffer!,
      0,
      e.indexBuffer,
      e.i.offset,
      Math.min(iBytes, mesh.indexBuffer!.size),
    );
    this.copies += 2;
    e.revision = mesh.revision;
    e.seen = this.frame;
    return e;
  }

  /** The pooled entry of `mesh`, if any, without copying. */
  peek(mesh: Mesh): PoolEntry | undefined {
    return this.entries.get(mesh);
  }

  /** Count a frame; every 256 frames give back the room of meshes idle that long. */
  endFrame(): void {
    this.frame++;
    if ((this.frame & 255) !== 0) return;
    for (const [mesh, e] of this.entries) {
      if (this.frame - e.seen > POOL_IDLE_FRAMES || mesh.revision !== e.revision) {
        e.vArena.free(e.v);
        e.iArena.free(e.i);
        this.entries.delete(mesh);
      }
    }
  }

  destroy(): void {
    for (const a of this.vertex.values()) a.destroy();
    this.vertex.clear();
    this.index16?.destroy();
    this.index32?.destroy();
    this.index16 = this.index32 = null;
    this.entries.clear();
  }

  private vertexArena(stride: number): Arena {
    let a = this.vertex.get(stride);
    if (!a) {
      a = new Arena(this.device, {
        kind: 'vertex',
        blockBytes: VERTEX_BLOCK,
        label: `mesh-pool-v${stride}`,
      });
      this.vertex.set(stride, a);
    }
    return a;
  }

  private indexArena(format: GPUIndexFormat): Arena {
    if (format === 'uint32') {
      this.index32 ??= new Arena(this.device, {
        kind: 'index',
        blockBytes: INDEX_BLOCK,
        label: 'mesh-pool-i32',
      });
      return this.index32;
    }
    this.index16 ??= new Arena(this.device, {
      kind: 'index',
      blockBytes: INDEX_BLOCK,
      label: 'mesh-pool-i16',
    });
    return this.index16;
  }
}

/** Capacity of a bundled run of `k` draws, kept while it still fits with little waste. */
export function runCapacity(k: number, current: number): number {
  if (current >= k && current <= Math.max(16, k * 4)) return current;
  let c = 16;
  while (c < k) c *= 2;
  return c;
}

/** What a cached run bundle was recorded against; any change records it again. */
export interface RunBundle {
  bundle: GPURenderBundle | null;
  pipeline: GPURenderPipeline | null;
  group0: GPUBindGroup | null;
  group1: GPUBindGroup | null;
  offset: number;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  indexFormat: GPUIndexFormat;
  instances: GPUBuffer | null;
  args: GPUBuffer | null;
  argsOffset: number;
  capacity: number;
  /** The pass it replays in: its target (formats, aux attachments) and depth attachment. */
  target: object | null;
  colorFormat: string;
  aux: number;
  depth: boolean;
}

export function emptyRunBundle(): RunBundle {
  return {
    bundle: null,
    pipeline: null,
    group0: null,
    group1: null,
    offset: -1,
    vertexBuffer: null,
    indexBuffer: null,
    indexFormat: 'uint16',
    instances: null,
    args: null,
    argsOffset: -1,
    capacity: 0,
    target: null,
    colorFormat: '',
    aux: 0,
    depth: false,
  };
}
