/**
 * The mesher Worker of the voxel demo: game code, not engine code. It owns a copy of the voxel
 * grid (generated here from the seed, so the page never blocks on generation), applies block
 * edits the page sends, and greedy-meshes chunks on request into `VERTEX_LAYOUT_3D` vertices
 * (xyz, normal, uv in block units, rgb = baked ambient occlusion, a = texture-array layer) and
 * uint32 indices, transferred back one chunk per message.
 *
 * Greedy meshing: for each of the six face directions and each slice of the chunk along that
 * axis, a 16×16 mask holds a key per exposed face (layer + the four corner AO values); runs of
 * equal keys merge into one quad, first along the row, then down the rows. AO is the classic
 * four-neighbour trick: each quad corner looks at the two side blocks and the diagonal block that
 * touch it on the face's outer side.
 */
import {
  Block,
  blockAt,
  blockLayer,
  CHUNK,
  CHUNK_COUNT,
  chunkCoords,
  type Face,
  generateWorld,
  type MesherReply,
  type MesherRequest,
  VERTEX_FLOATS,
  voxelIndex,
} from './world';

let grid: Uint8Array | null = null;

/** Scratch buffers, grown as needed; the reply gets an exact-size copy. */
let scratchVerts = new Float32Array(VERTEX_FLOATS * 4 * 2048);
let scratchIdx = new Uint32Array(6 * 2048);
const mask = new Int32Array(CHUNK * CHUNK);
const coords: [number, number, number] = [0, 0, 0];

/** AO level (0 darkest .. 3 open) → vertex brightness. */
const AO_CURVE = [0.42, 0.62, 0.82, 1.0];

/** Face index of axis `d` (0 x, 1 y, 2 z) and direction `dir` (+1 / -1). */
function faceOf(d: number, dir: number): Face {
  return (d * 2 + (dir > 0 ? 0 : 1)) as Face;
}

/**
 * The mask key of the face of voxel (`wx`, `wy`, `wz`) facing `n` (one unit axis), with `ea` and
 * `eb` the two tangent axes: bit 0 present, bits 1..3 layer, bits 4..11 four 2-bit AO values
 * indexed by `(sa > 0) | (sb > 0) << 1`.
 */
function faceKey(
  g: Uint8Array,
  block: number,
  face: Face,
  wx: number,
  wy: number,
  wz: number,
  nx: number,
  ny: number,
  nz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const ox = wx + nx;
  const oy = wy + ny;
  const oz = wz + nz;
  let key = 1 | (blockLayer(block, face) << 1);
  for (let slot = 0; slot < 4; slot++) {
    const sa = slot & 1 ? 1 : -1;
    const sb = slot & 2 ? 1 : -1;
    const s1 = blockAt(g, ox + sa * ax, oy + sa * ay, oz + sa * az) !== Block.Air ? 1 : 0;
    const s2 = blockAt(g, ox + sb * bx, oy + sb * by, oz + sb * bz) !== Block.Air ? 1 : 0;
    let ao: number;
    if (s1 && s2) ao = 0;
    else {
      const c =
        blockAt(g, ox + sa * ax + sb * bx, oy + sa * ay + sb * by, oz + sa * az + sb * bz) !==
        Block.Air
          ? 1
          : 0;
      ao = 3 - (s1 + s2 + c);
    }
    key |= ao << (4 + 2 * slot);
  }
  return key;
}

function meshChunk(g: Uint8Array, chunk: number, token: number): MesherReply {
  chunkCoords(chunk, coords);
  const ox = coords[0] * CHUNK;
  const oy = coords[1] * CHUNK;
  const oz = coords[2] * CHUNK;
  let v = 0; // floats written
  let i = 0; // indices written
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const ea = [0, 0, 0];
  const eb = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    // (a, b, d) is a cyclic permutation of (x, y, z), so a × b = d and the quad corners emitted
    // in (a0,b0) (a1,b0) (a1,b1) (a0,b1) order wind counter-clockwise seen from +d.
    const a = (d + 1) % 3;
    const b = (d + 2) % 3;
    ea[0] = ea[1] = ea[2] = 0;
    eb[0] = eb[1] = eb[2] = 0;
    ea[a] = 1;
    eb[b] = 1;
    for (let dir = 1; dir >= -1; dir -= 2) {
      const face = faceOf(d, dir);
      n[0] = n[1] = n[2] = 0;
      n[d] = dir;
      for (let k = 0; k < CHUNK; k++) {
        // The mask of this slice.
        let any = false;
        for (let j = 0; j < CHUNK; j++) {
          for (let ii = 0; ii < CHUNK; ii++) {
            p[d] = k;
            p[a] = ii;
            p[b] = j;
            const wx = ox + p[0]!;
            const wy = oy + p[1]!;
            const wz = oz + p[2]!;
            const block = g[voxelIndex(wx, wy, wz)]!;
            let key = 0;
            if (block !== Block.Air) {
              const neighbour = blockAt(g, wx + n[0]!, wy + n[1]!, wz + n[2]!);
              if (neighbour === Block.Air) {
                key = faceKey(
                  g,
                  block,
                  face,
                  wx,
                  wy,
                  wz,
                  n[0]!,
                  n[1]!,
                  n[2]!,
                  ea[0]!,
                  ea[1]!,
                  ea[2]!,
                  eb[0]!,
                  eb[1]!,
                  eb[2]!,
                );
                any = true;
              }
            }
            mask[ii + CHUNK * j] = key;
          }
        }
        if (!any) continue;
        // Greedy merge.
        for (let j = 0; j < CHUNK; j++) {
          for (let ii = 0; ii < CHUNK; ) {
            const key = mask[ii + CHUNK * j]!;
            if (key === 0) {
              ii++;
              continue;
            }
            let w = 1;
            while (ii + w < CHUNK && mask[ii + w + CHUNK * j] === key) w++;
            let h = 1;
            outer: while (j + h < CHUNK) {
              for (let t = 0; t < w; t++) {
                if (mask[ii + t + CHUNK * (j + h)] !== key) break outer;
              }
              h++;
            }
            for (let hh = 0; hh < h; hh++) {
              for (let t = 0; t < w; t++) mask[ii + t + CHUNK * (j + hh)] = 0;
            }

            // Emit the quad: the plane sits at d = k (+1 for the positive face).
            if (v + 4 * VERTEX_FLOATS > scratchVerts.length) {
              const bigger = new Float32Array(scratchVerts.length * 2);
              bigger.set(scratchVerts);
              scratchVerts = bigger;
            }
            if (i + 6 > scratchIdx.length) {
              const bigger = new Uint32Array(scratchIdx.length * 2);
              bigger.set(scratchIdx);
              scratchIdx = bigger;
            }
            const layer = (key >> 1) & 7;
            const plane = k + (dir > 0 ? 1 : 0);
            const base = v / VERTEX_FLOATS;
            for (let c = 0; c < 4; c++) {
              // Corner order: (a0,b0) (a1,b0) (a1,b1) (a0,b1); reversed for the negative face.
              const cc = dir > 0 ? c : (4 - c) % 4;
              const ha = cc === 1 || cc === 2 ? 1 : 0;
              const hb = cc === 2 || cc === 3 ? 1 : 0;
              const ac = ii + ha * w;
              const bc = j + hb * h;
              p[d] = plane;
              p[a] = ac;
              p[b] = bc;
              scratchVerts[v] = p[0]!;
              scratchVerts[v + 1] = p[1]!;
              scratchVerts[v + 2] = p[2]!;
              scratchVerts[v + 3] = n[0]!;
              scratchVerts[v + 4] = n[1]!;
              scratchVerts[v + 5] = n[2]!;
              // uv in block units: u along the horizontal axis, v downward from the quad's top
              // (canvas row 0 is the top of the texture), so grass sides stand upright.
              let u: number;
              let vv: number;
              if (d === 0) {
                // a = y (vertical), b = z.
                u = bc - j;
                vv = ii + w - ac;
              } else if (d === 2) {
                // a = x, b = y (vertical).
                u = ac - ii;
                vv = j + h - bc;
              } else {
                u = ac - ii;
                vv = bc - j;
              }
              scratchVerts[v + 6] = u;
              scratchVerts[v + 7] = vv;
              const slot = ha | (hb << 1);
              const ao = AO_CURVE[(key >> (4 + 2 * slot)) & 3]!;
              scratchVerts[v + 8] = ao;
              scratchVerts[v + 9] = ao;
              scratchVerts[v + 10] = ao;
              scratchVerts[v + 11] = layer;
              v += VERTEX_FLOATS;
            }
            scratchIdx[i++] = base;
            scratchIdx[i++] = base + 1;
            scratchIdx[i++] = base + 2;
            scratchIdx[i++] = base;
            scratchIdx[i++] = base + 2;
            scratchIdx[i++] = base + 3;
            ii += w;
          }
        }
      }
    }
  }
  return {
    type: 'mesh',
    chunk,
    token,
    vertices: scratchVerts.slice(0, v),
    indices: scratchIdx.slice(0, i),
    vertexCount: v / VERTEX_FLOATS,
    indexCount: i,
  };
}

function post(reply: MesherReply): void {
  if (reply.type === 'mesh') {
    self.postMessage(reply, { transfer: [reply.vertices.buffer, reply.indices.buffer] });
  } else {
    self.postMessage(reply, { transfer: [reply.grid.buffer] });
  }
}

self.addEventListener('message', (e: MessageEvent<MesherRequest>) => {
  const req = e.data;
  if (req.type === 'init') {
    grid = generateWorld(req.seed);
    post({ type: 'world', grid: grid.slice() });
    for (let c = 0; c < CHUNK_COUNT; c++) post(meshChunk(grid, c, 0));
    return;
  }
  if (!grid) return;
  if (req.type === 'set') {
    grid[voxelIndex(req.x, req.y, req.z)] = req.block;
  } else if (req.type === 'mesh') {
    for (const c of req.chunks) post(meshChunk(grid, c, req.token));
  }
});
