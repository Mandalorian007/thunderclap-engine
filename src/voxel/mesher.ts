/**
 * The chunk mesher: a block grid in, greedy-merged quads out, in `VERTEX_LAYOUT_3D` (12 floats:
 * position, normal, uv, rgba) with uint32 indices. Pure arithmetic over a `VoxelGrid`, so it
 * runs the same on the main thread or in a Worker (`mesher-worker.ts`).
 *
 * Convention (the block material's contract, see README):
 * - positions are chunk-local block units (0..chunk on each axis); the renderer places each
 *   chunk by a transform at its origin;
 * - the normal is the face's axis;
 * - uv is in block units across the quad, u along the face's right, v downward from the top
 *   of the quad (a texture's row 0 is its top), so a merged 3×2 quad spans uv 0..3 × 0..2 and
 *   the material wraps it (`voxel_uv_wrap` or a `repeat` sampler);
 * - colour rgb is the baked ambient occlusion (`aoCurve` of the corner's level, 1 = open) and
 *   colour a is the texture-array layer from `layerOf(block, face)`.
 *
 * Greedy meshing: for each of the six face directions and each slice of the chunk along that
 * axis, a `chunk × chunk` mask holds a key per exposed face (the layer and the four corner AO
 * levels); runs of equal keys merge into one quad, first along the row, then down the rows.
 * AO is the four-neighbour rule: each quad corner looks at the two side cells and the diagonal
 * cell touching it on the face's outer side; both sides solid is the darkest level (0), else
 * `3 - solid count`. A quad whose opposite corners differ in AO is split along the diagonal
 * with the lower sum, so the dark pair shares an edge and the interpolation has no crease
 * (the "riser triangle" a fixed diagonal shows on a one-block step).
 */
import type { MeshBounds } from '../render/mesh';
import { VERTEX3D_FLOATS } from '../render/mesh';
import type { VoxelGrid } from './grid';

/** A block face: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z. */
export type VoxelFace = 0 | 1 | 2 | 3 | 4 | 5;

/** Outward normal of each `VoxelFace`. */
export const VOXEL_FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Default AO curve: corner level (0 darkest .. 3 open) → vertex brightness. */
export const VOXEL_AO_CURVE: readonly number[] = [0.42, 0.62, 0.82, 1];

/** Floats per vertex of the mesher's output (`VERTEX_LAYOUT_3D`). */
export const VOXEL_VERTEX_FLOATS = VERTEX3D_FLOATS;

export interface MeshChunkOptions {
  /** Bake ambient occlusion into colour.rgb. Default true (off: rgb = 1, more merging). */
  ao?: boolean;
  /** Brightness per AO level, 4 entries. Default `VOXEL_AO_CURVE`. */
  aoCurve?: ArrayLike<number>;
  /** Texture-array layer of a block's face, written to colour.a. Default `block - 1`. */
  layerOf?: (block: number, face: VoxelFace) => number;
  /**
   * What lies beyond the grid: a block id for every outside cell (0 = air, so the grid's
   * boundary faces show), or a function of the cell (solid below y 0 and air elsewhere hides
   * a world's underside). Default 0.
   */
  outside?: number | ((x: number, y: number, z: number) => number);
}

/** The mesher's output buffers, reused across calls and grown with slack when a chunk needs more. */
export interface ChunkMeshOut {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Vertices written by the last `meshChunk` (`vertexCount * VOXEL_VERTEX_FLOATS` floats). */
  vertexCount: number;
  /** Indices written by the last `meshChunk` (6 per quad). */
  indexCount: number;
  /** Bounding sphere of the last output in chunk-local units; radius 0 when empty. */
  bounds: MeshBounds;
}

/** Output buffers with room for `quads` quads before the first growth. */
export function createChunkMeshOut(quads = 1024): ChunkMeshOut {
  return {
    vertices: new Float32Array(quads * 4 * VOXEL_VERTEX_FLOATS),
    indices: new Uint32Array(quads * 6),
    vertexCount: 0,
    indexCount: 0,
    bounds: { center: [0, 0, 0], radius: 0 },
  };
}

const defaultLayer = (block: number): number => block - 1;

/** Growth factor of `ChunkMeshOut` buffers (1.5×, a vector's amortised growth). */
const GROWTH = 1.5;

let mask = new Int32Array(0);
const p = [0, 0, 0];
const n = [0, 0, 0];
const ea = [0, 0, 0];
const eb = [0, 0, 0];
const extent = [0, 0, 0];
const corners = new Int32Array(4);
const aoLevels = new Int32Array(4);

/**
 * Mesh chunk (`cx`, `cy`, `cz`) of `grid` into `out`. Returns `out`. Every quad is planar on
 * its face's axis, winds counter-clockwise seen from outside (both triangles) and its vertex
 * normal is the face's normal. `out.vertexCount` 0 means an empty chunk.
 */
export function meshChunk(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
  opts: MeshChunkOptions,
  out: ChunkMeshOut,
): ChunkMeshOut {
  const size = grid.chunk;
  if (mask.length < size * size) mask = new Int32Array(size * size);
  const ao = opts.ao ?? true;
  const curve = opts.aoCurve ?? VOXEL_AO_CURVE;
  const layerOf = opts.layerOf ?? defaultLayer;
  const outside = opts.outside ?? 0;
  const outsideFn = typeof outside === 'function' ? outside : null;
  const outsideBlock = typeof outside === 'number' ? outside : 0;
  const data = grid.data;
  const sx = grid.sizeX;
  const sy = grid.sizeY;
  const sz = grid.sizeZ;
  const ox = cx * size;
  const oy = cy * size;
  const oz = cz * size;
  extent[0] = Math.min(size, sx - ox);
  extent[1] = Math.min(size, sy - oy);
  extent[2] = Math.min(size, sz - oz);

  const at = (x: number, y: number, z: number): number => {
    if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz) {
      return data[x + sx * (y + sy * z)]!;
    }
    return outsideFn ? outsideFn(x, y, z) : outsideBlock;
  };

  let vf = 0; // floats written
  let ic = 0; // indices written
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let d = 0; d < 3; d++) {
    // (a, b, d) is a cyclic permutation of (x, y, z): a × b = d, so corners emitted in
    // (a0,b0) (a1,b0) (a1,b1) (a0,b1) order wind counter-clockwise seen from +d.
    const a = (d + 1) % 3;
    const b = (d + 2) % 3;
    ea[0] = ea[1] = ea[2] = 0;
    eb[0] = eb[1] = eb[2] = 0;
    ea[a] = 1;
    eb[b] = 1;
    const na = extent[a]!;
    const nb = extent[b]!;
    const nd = extent[d]!;
    for (let dir = 1; dir >= -1; dir -= 2) {
      const face = (d * 2 + (dir > 0 ? 0 : 1)) as VoxelFace;
      n[0] = n[1] = n[2] = 0;
      n[d] = dir;
      for (let k = 0; k < nd; k++) {
        // The mask of this slice.
        let any = false;
        for (let j = 0; j < nb; j++) {
          for (let i = 0; i < na; i++) {
            p[d] = k;
            p[a] = i;
            p[b] = j;
            const wx = ox + p[0]!;
            const wy = oy + p[1]!;
            const wz = oz + p[2]!;
            const block = data[wx + sx * (wy + sy * wz)]!;
            let key = 0;
            if (block !== 0) {
              const qx = wx + n[0]!;
              const qy = wy + n[1]!;
              const qz = wz + n[2]!;
              if (at(qx, qy, qz) === 0) {
                key = 1 | ((layerOf(block, face) & 0xff) << 1);
                if (ao) {
                  for (let slot = 0; slot < 4; slot++) {
                    const sa = slot & 1 ? 1 : -1;
                    const sb = slot & 2 ? 1 : -1;
                    const s1 =
                      at(qx + sa * ea[0]!, qy + sa * ea[1]!, qz + sa * ea[2]!) !== 0 ? 1 : 0;
                    const s2 =
                      at(qx + sb * eb[0]!, qy + sb * eb[1]!, qz + sb * eb[2]!) !== 0 ? 1 : 0;
                    let level: number;
                    if (s1 && s2) level = 0;
                    else {
                      const c =
                        at(
                          qx + sa * ea[0]! + sb * eb[0]!,
                          qy + sa * ea[1]! + sb * eb[1]!,
                          qz + sa * ea[2]! + sb * eb[2]!,
                        ) !== 0
                          ? 1
                          : 0;
                      level = 3 - (s1 + s2 + c);
                    }
                    key |= level << (9 + 2 * slot);
                  }
                }
                any = true;
              }
            }
            mask[i + size * j] = key;
          }
        }
        if (!any) continue;
        // Greedy merge.
        for (let j = 0; j < nb; j++) {
          for (let i = 0; i < na; ) {
            const key = mask[i + size * j]!;
            if (key === 0) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < na && mask[i + w + size * j] === key) w++;
            let h = 1;
            outer: while (j + h < nb) {
              for (let t = 0; t < w; t++) {
                if (mask[i + t + size * (j + h)] !== key) break outer;
              }
              h++;
            }
            for (let hh = 0; hh < h; hh++) {
              for (let t = 0; t < w; t++) mask[i + t + size * (j + hh)] = 0;
            }

            // Emit the quad: the plane sits at d = k (+1 for the positive face).
            if (vf + 4 * VOXEL_VERTEX_FLOATS > out.vertices.length) {
              const bigger = new Float32Array(Math.ceil(out.vertices.length * GROWTH));
              bigger.set(out.vertices);
              out.vertices = bigger;
            }
            if (ic + 6 > out.indices.length) {
              const bigger = new Uint32Array(Math.ceil(out.indices.length * GROWTH));
              bigger.set(out.indices);
              out.indices = bigger;
            }
            const verts = out.vertices;
            const layer = (key >> 1) & 0xff;
            const plane = k + (dir > 0 ? 1 : 0);
            const base = vf / VOXEL_VERTEX_FLOATS;
            for (let c = 0; c < 4; c++) {
              // Corner order (a0,b0) (a1,b0) (a1,b1) (a0,b1); reversed for the negative face.
              const cc = dir > 0 ? c : (4 - c) % 4;
              const ha = cc === 1 || cc === 2 ? 1 : 0;
              const hb = cc === 2 || cc === 3 ? 1 : 0;
              const ac = i + ha * w;
              const bc = j + hb * h;
              p[d] = plane;
              p[a] = ac;
              p[b] = bc;
              const px = p[0]!;
              const py = p[1]!;
              const pz = p[2]!;
              if (px < minX) minX = px;
              if (py < minY) minY = py;
              if (pz < minZ) minZ = pz;
              if (px > maxX) maxX = px;
              if (py > maxY) maxY = py;
              if (pz > maxZ) maxZ = pz;
              verts[vf] = px;
              verts[vf + 1] = py;
              verts[vf + 2] = pz;
              verts[vf + 3] = n[0]!;
              verts[vf + 4] = n[1]!;
              verts[vf + 5] = n[2]!;
              // uv in block units: u along the horizontal axis, v downward from the quad's top.
              let u: number;
              let v: number;
              if (d === 0) {
                // a = y (vertical), b = z.
                u = bc - j;
                v = i + w - ac;
              } else if (d === 2) {
                // a = x, b = y (vertical).
                u = ac - i;
                v = j + h - bc;
              } else {
                u = ac - i;
                v = bc - j;
              }
              verts[vf + 6] = u;
              verts[vf + 7] = v;
              const slot = ha | (hb << 1);
              const level = ao ? (key >> (9 + 2 * slot)) & 3 : 3;
              const bright = ao ? (curve[level] ?? 1) : 1;
              aoLevels[c] = level;
              verts[vf + 8] = bright;
              verts[vf + 9] = bright;
              verts[vf + 10] = bright;
              verts[vf + 11] = layer;
              corners[c] = base + c;
              vf += VOXEL_VERTEX_FLOATS;
            }
            // Split along the diagonal whose corners are darker, so the dark pair shares an edge.
            const idx = out.indices;
            if (aoLevels[0]! + aoLevels[2]! > aoLevels[1]! + aoLevels[3]!) {
              idx[ic++] = corners[1]!;
              idx[ic++] = corners[2]!;
              idx[ic++] = corners[3]!;
              idx[ic++] = corners[1]!;
              idx[ic++] = corners[3]!;
              idx[ic++] = corners[0]!;
            } else {
              idx[ic++] = corners[0]!;
              idx[ic++] = corners[1]!;
              idx[ic++] = corners[2]!;
              idx[ic++] = corners[0]!;
              idx[ic++] = corners[2]!;
              idx[ic++] = corners[3]!;
            }
            i += w;
          }
        }
      }
    }
  }

  out.vertexCount = vf / VOXEL_VERTEX_FLOATS;
  out.indexCount = ic;
  const bounds = out.bounds;
  if (vf === 0) {
    bounds.center[0] = bounds.center[1] = bounds.center[2] = 0;
    bounds.radius = 0;
  } else {
    bounds.center[0] = (minX + maxX) / 2;
    bounds.center[1] = (minY + maxY) / 2;
    bounds.center[2] = (minZ + maxZ) / 2;
    bounds.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  }
  return out;
}

/**
 * Exposed faces of chunk (`cx`, `cy`, `cz`) counted one cell at a time (no merging): the
 * reference the mesher's quads must cover exactly. Each quad of `meshChunk` covers
 * `w × h` of these, so a test sums quad areas against it. Same `outside` rule.
 */
export function countExposedFaces(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
  outside: MeshChunkOptions['outside'] = 0,
): number {
  const size = grid.chunk;
  const x0 = cx * size;
  const y0 = cy * size;
  const z0 = cz * size;
  const x1 = Math.min(grid.sizeX, x0 + size);
  const y1 = Math.min(grid.sizeY, y0 + size);
  const z1 = Math.min(grid.sizeZ, z0 + size);
  const at = (x: number, y: number, z: number): number =>
    grid.inBounds(x, y, z)
      ? grid.get(x, y, z)
      : typeof outside === 'function'
        ? outside(x, y, z)
        : outside;
  let faces = 0;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (grid.get(x, y, z) === 0) continue;
        for (const [nx, ny, nz] of VOXEL_FACE_NORMALS) {
          if (at(x + nx, y + ny, z + nz) === 0) faces++;
        }
      }
    }
  }
  return faces;
}
