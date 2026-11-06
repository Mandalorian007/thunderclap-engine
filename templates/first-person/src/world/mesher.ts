/**
 * The chunk mesher: turns a `CHUNK × CHUNK` patch of the terrain into the engine's 3D vertex
 * layout (`VERTEX_LAYOUT_3D`: xyz, normal, uv, rgba; 12 floats) plus uint16 indices, written into
 * one `ArrayBuffer` the page hands straight to `mesh.update()`. Pure: it runs in the Worker and
 * in the tests. Nothing here imports the engine; the layout is a numeric convention.
 *
 * - Positions are local to the chunk's origin (the page places each chunk with a `Transform`).
 * - A column is a top quad plus one quad per side that stands above its neighbour, spanning the
 *   whole drop (so at most five quads per column and the buffer size is known up front).
 * - The texture-array layer of a face is a whole number in the vertex colour's alpha, the same
 *   convention the engine's streaming harness uses; the rgb carries a little per-column shade.
 * - The reply carries the chunk's bounding sphere so the renderer can frustum-cull it without
 *   scanning the vertices.
 */
import { heightAt, layerForSide, layerForTop, type Terrain } from './terrain';

/** Columns per side of a chunk. */
export const CHUNK = 16;
/** Floats per vertex in the engine's 3D layout. */
export const VERTEX_FLOATS = 12;
/** Worst case: five quads per column. */
export const MAX_VERTICES = CHUNK * CHUNK * 5 * 4;
export const MAX_INDICES = CHUNK * CHUNK * 5 * 6;
/** Byte offset of the indices in a chunk buffer (after the vertices; 4-byte aligned). */
export const INDEX_OFFSET = MAX_VERTICES * VERTEX_FLOATS * 4;
/** Bytes of one chunk buffer: the vertices, then the indices padded to 4 bytes. */
export const CHUNK_BUFFER_BYTES = INDEX_OFFSET + Math.ceil((MAX_INDICES * 2) / 4) * 4;

export interface ChunkBounds {
  center: [number, number, number];
  radius: number;
}

/** What `meshChunk` wrote into the buffer, in the shape `MeshUpdate` wants. */
export interface ChunkMesh {
  vertexCount: number;
  indexCount: number;
  bounds: ChunkBounds;
}

/** Side faces: outward normal, then the two tangents spanning the quad (right, up). */
const SIDES: readonly [readonly number[], readonly number[], readonly number[]][] = [
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [-1, 0, 0],
    [0, 1, 0],
  ],
  [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
];
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/**
 * Mesh the chunk whose first column is `(cx * CHUNK, cz * CHUNK)` into `buffer` (at least
 * `CHUNK_BUFFER_BYTES`). Returns the counts and the bounds; the buffer holds the data.
 */
export function meshChunk(t: Terrain, cx: number, cz: number, buffer: ArrayBuffer): ChunkMesh {
  const verts = new Float32Array(buffer, 0, MAX_VERTICES * VERTEX_FLOATS);
  const idx = new Uint16Array(buffer, INDEX_OFFSET, MAX_INDICES);
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  let v = 0;
  let i = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = 0;

  /** One quad: centre c, normal n, tangents r and u with half extents hr and hu, shade, layer. */
  const quad = (
    c: readonly number[],
    n: readonly number[],
    r: readonly number[],
    u: readonly number[],
    hr: number,
    hu: number,
    shade: number,
    layer: number,
  ): void => {
    const base = v / VERTEX_FLOATS;
    for (const [sx, sy] of CORNERS) {
      for (let k = 0; k < 3; k++) verts[v + k] = c[k]! + sx * r[k]! * hr + sy * u[k]! * hu;
      verts[v + 3] = n[0]!;
      verts[v + 4] = n[1]!;
      verts[v + 5] = n[2]!;
      // uv in world units so the sampler tiles one texture per block (sides span their drop).
      verts[v + 6] = (sx + 1) * hr;
      verts[v + 7] = (1 - sy) * hu;
      verts[v + 8] = shade;
      verts[v + 9] = shade;
      verts[v + 10] = shade;
      verts[v + 11] = layer;
      v += VERTEX_FLOATS;
    }
    idx[i++] = base;
    idx[i++] = base + 1;
    idx[i++] = base + 2;
    idx[i++] = base;
    idx[i++] = base + 2;
    idx[i++] = base + 3;
  };

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const wx = ox + lx;
      const wz = oz + lz;
      const h = heightAt(t, wx, wz);
      if (h <= 0) continue;
      if (h > maxY) maxY = h;
      // A faint checker keeps neighbouring columns apart under flat light.
      const shade = 0.92 + 0.08 * ((wx + wz) & 1);
      const x = lx + 0.5;
      const z = lz + 0.5;
      quad([x, h, z], [0, 1, 0], [1, 0, 0], [0, 0, -1], 0.5, 0.5, shade, layerForTop(h));
      const sideLayer = layerForSide(h);
      for (const [n, r, u] of SIDES) {
        const nh = heightAt(t, wx + n[0]!, wz + n[2]!);
        if (nh >= h) continue;
        if (nh < minY) minY = nh;
        const half = (h - nh) / 2;
        quad([x + n[0]! * 0.5, nh + half, z + n[2]! * 0.5], n, r, u, 0.5, half, shade, sideLayer);
      }
    }
  }
  if (minY === Number.POSITIVE_INFINITY) minY = maxY;
  const half = CHUNK / 2;
  const midY = (minY + maxY) / 2;
  return {
    vertexCount: v / VERTEX_FLOATS,
    indexCount: i,
    bounds: { center: [half, midY, half], radius: Math.hypot(half, maxY - midY, half) },
  };
}
