/**
 * The chunk renderer: one `Mesh` per non-empty chunk of a `VoxelGrid`, remeshed through a
 * `VoxelMesher` as chunks go dirty and drawn through `frame.mesh` after a frustum test on each
 * chunk's bounding sphere. `update()` once per tick (requests for dirty chunks out, finished
 * remeshes in and uploaded), `draw(frame, camera)` once per view.
 *
 * Each mesh is created on the chunk's first non-empty reply with `slack` times that reply's
 * counts of room (at least `minQuads` quads), so the edits that follow rewrite it in place and
 * `Mesh.growths` stays 0 until a chunk grows past its slack. A chunk that empties keeps its
 * mesh with nothing to draw. Meshes carry no bounds of their own (`autoBounds` off); the
 * reply's chunk-local sphere, offset by the chunk origin, is the one `draw` tests.
 */
import type { Camera } from '../render/camera';
import type { Frame, InstanceParams } from '../render/frame';
import type { Material } from '../render/material';
import { type Mesh, VERTEX_LAYOUT_3D } from '../render/mesh';
import type { Renderer } from '../render/renderer';
import { Transform } from '../render/transform';
import type { VoxelGrid } from './grid';
import type { MeshChunkOptions } from './mesher';
import { type ChunkMesh, createVoxelMesher, type VoxelMesher } from './worker-client';

export interface VoxelChunksOptions extends MeshChunkOptions {
  /** The block material every chunk is drawn with. */
  material: Material;
  /** Room factor on each mesh's first upload (1 = exact). Default 1.5. */
  slack?: number;
  /** Floor on a mesh's room, in quads. Default 64. */
  minQuads?: number;
  /** The mesher to request from. Default: an in-thread one over `grid` with these options. */
  mesher?: VoxelMesher;
  /** World position of the grid's corner. Default the origin. */
  origin?: ArrayLike<number>;
  /** Instance params (tint, params) every chunk draw carries. */
  params?: InstanceParams;
  /** Clock in ms for `stats.remeshMs`. Default `performance.now()`. */
  now?: () => number;
}

export interface VoxelDrawStats {
  /** Chunks drawn this call. */
  drawn: number;
  /** Non-empty chunks the camera did not see. */
  culled: number;
  /** Triangles drawn this call. */
  triangles: number;
}

export interface VoxelChunksStats extends VoxelDrawStats {
  /** Non-empty chunks (with a mesh that draws). */
  chunks: number;
  /** Sum of `Mesh.growths` over the chunk meshes. */
  growths: number;
  /** Remeshes requested and not yet applied. */
  pending: number;
  /** Remeshes applied so far. */
  remeshes: number;
  /** Request-to-upload time of the last applied remesh, ms. */
  remeshMs: number;
}

export interface VoxelChunks {
  readonly grid: VoxelGrid;
  readonly material: Material;
  readonly mesher: VoxelMesher;
  /** Per chunk index: its mesh once it has drawn anything, else null. */
  readonly meshes: readonly (Mesh | null)[];
  /** Per chunk index: the transform placing it (the chunk origin plus `origin`). */
  readonly transforms: readonly Transform[];
  readonly stats: VoxelChunksStats;
  /**
   * Upload every finished remesh, then request one for every dirty chunk. Returns how many
   * were uploaded. Call once per tick.
   */
  update(): number;
  /** Push every visible non-empty chunk into `frame` and return the draw counts (`stats`). */
  draw(frame: Frame, camera: Camera): VoxelDrawStats;
  /** Destroy the meshes; dispose the mesher when this made it. */
  dispose(): void;
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const coords = [0, 0, 0];

export function createVoxelChunks(
  renderer: Renderer,
  grid: VoxelGrid,
  opts: VoxelChunksOptions,
): VoxelChunks {
  const material = opts.material;
  const slack = Math.max(1, opts.slack ?? 1.5);
  const minQuads = Math.max(1, opts.minQuads ?? 64);
  const ownMesher = !opts.mesher;
  const mesher = opts.mesher ?? createVoxelMesher(grid, opts);
  const now = opts.now ?? defaultNow;
  const params = opts.params;
  const count = grid.chunkCount;
  const meshes: (Mesh | null)[] = new Array(count).fill(null);
  const transforms: Transform[] = new Array(count);
  const ox = opts.origin?.[0] ?? 0;
  const oy = opts.origin?.[1] ?? 0;
  const oz = opts.origin?.[2] ?? 0;
  /** World centre and radius of each chunk's last sphere. */
  const centers = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const requestedAt = new Float64Array(count);
  const finished: ChunkMesh[] = [];
  const stats: VoxelChunksStats = {
    drawn: 0,
    culled: 0,
    triangles: 0,
    chunks: 0,
    growths: 0,
    pending: 0,
    remeshes: 0,
    remeshMs: 0,
  };
  let disposed = false;

  for (let c = 0; c < count; c++) {
    grid.chunkCoords(c, coords);
    transforms[c] = new Transform({
      x: ox + coords[0]! * grid.chunk,
      y: oy + coords[1]! * grid.chunk,
      z: oz + coords[2]! * grid.chunk,
    });
  }

  const apply = (reply: ChunkMesh): void => {
    const c = reply.chunk;
    let mesh = meshes[c];
    if (reply.indexCount === 0) {
      if (mesh && mesh.indexCount > 0) {
        mesh.update({ vertexCount: 0, indexCount: 0 });
        stats.chunks--;
      }
      radii[c] = 0;
      return;
    }
    if (!mesh) {
      const quads = Math.max(minQuads, Math.ceil((reply.indexCount / 6) * slack));
      mesh = renderer.createMesh({
        label: `voxel-chunk-${c}`,
        layout: VERTEX_LAYOUT_3D,
        capacity: { vertices: quads * 4, indices: quads * 6 },
        indexFormat: 'uint32',
        autoBounds: false,
        bounds: { center: [0, 0, 0], radius: Infinity },
      });
      meshes[c] = mesh;
    }
    const wasEmpty = mesh.indexCount === 0;
    mesh.update(reply);
    if (wasEmpty) stats.chunks++;
    const t = transforms[c]!.position;
    const b = reply.bounds;
    centers[c * 3] = t.x + b.center[0];
    centers[c * 3 + 1] = t.y + b.center[1];
    centers[c * 3 + 2] = t.z + b.center[2];
    radii[c] = b.radius;
  };

  const onReply = (reply: ChunkMesh): void => {
    if (!disposed) finished.push(reply);
  };

  return {
    grid,
    material,
    mesher,
    meshes,
    transforms,
    stats,
    update() {
      let applied = 0;
      const clock = now();
      while (finished.length > 0) {
        const reply = finished.shift()!;
        apply(reply);
        applied++;
        stats.pending--;
        stats.remeshes++;
        stats.remeshMs = clock - requestedAt[reply.chunk]!;
      }
      grid.forEachDirtyChunk((c) => {
        requestedAt[c] = clock;
        stats.pending++;
        void mesher.remesh(c).then(onReply);
      });
      let growths = 0;
      for (let c = 0; c < count; c++) {
        const m = meshes[c];
        if (m) growths += m.growths;
      }
      stats.growths = growths;
      return applied;
    },
    draw(frame, camera) {
      let drawn = 0;
      let culled = 0;
      let triangles = 0;
      for (let c = 0; c < count; c++) {
        const mesh = meshes[c];
        if (!mesh || mesh.indexCount === 0) continue;
        if (
          !camera.seesSphere(centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!, radii[c]!)
        ) {
          culled++;
          continue;
        }
        if (params) frame.mesh(mesh, material, transforms[c]!, params);
        else frame.mesh(mesh, material, transforms[c]!);
        drawn++;
        triangles += mesh.indexCount / 3;
      }
      stats.drawn = drawn;
      stats.culled = culled;
      stats.triangles = triangles;
      return stats;
    },
    dispose() {
      disposed = true;
      finished.length = 0;
      for (let c = 0; c < count; c++) {
        meshes[c]?.destroy();
        meshes[c] = null;
      }
      if (ownMesher) mesher.dispose();
    },
  };
}
