/**
 * The mesher Worker of the streaming page (harness/stream.html): game code, not engine code. It
 * fills the chunk buffer the page sent it with a heightfield of columns in `VERTEX_LAYOUT_3D`
 * (12 floats: xyz, normal, uv, rgba) followed by uint16 indices, and transfers it back. The page
 * hands the same buffer straight to `mesh.update()`, so no copy happens on the main thread.
 */
import {
  STREAM_COLUMNS,
  STREAM_GRID,
  STREAM_INDEX_OFFSET,
  STREAM_MAX_INDICES,
  STREAM_MAX_VERTICES,
  STREAM_VERTEX_FLOATS,
  type StreamReply,
  type StreamRequest,
} from './stream-state';

/** Face normal, then the two tangents spanning the quad (right, up), as in the mesh demo. */
const SIDES: [number[], number[], number[]][] = [
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

/** Height of the column at world (wx, wz) for `phase`, or 0 for no column. */
function height(wx: number, wz: number, phase: number): number {
  const v = Math.sin(wx * 0.35 + phase) * Math.cos(wz * 0.3 - 0.6 * phase);
  if (v < -0.35) return 0;
  return 0.5 + Math.floor((v + 0.35) * 3) * 0.5;
}

function mesh(req: StreamRequest): StreamReply {
  const verts = new Float32Array(req.buffer, 0, STREAM_MAX_VERTICES * STREAM_VERTEX_FLOATS);
  const idx = new Uint16Array(req.buffer, STREAM_INDEX_OFFSET, STREAM_MAX_INDICES);
  let v = 0;
  let i = 0;
  const half = STREAM_COLUMNS / 2;
  const cx = (req.chunk % STREAM_GRID) * STREAM_COLUMNS - (STREAM_GRID * STREAM_COLUMNS) / 2;
  const cz =
    Math.floor(req.chunk / STREAM_GRID) * STREAM_COLUMNS - (STREAM_GRID * STREAM_COLUMNS) / 2;

  /** One quad: centre c, normal n, tangents r and u (half extents hr, hu), colour rgb. */
  const quad = (
    c: readonly number[],
    n: readonly number[],
    r: readonly number[],
    u: readonly number[],
    hr: number,
    hu: number,
    red: number,
    green: number,
    blue: number,
  ): void => {
    const base = v / STREAM_VERTEX_FLOATS;
    for (const [sx, sy] of CORNERS) {
      for (let k = 0; k < 3; k++) verts[v + k] = c[k]! + sx * r[k]! * hr + sy * u[k]! * hu;
      verts[v + 3] = n[0]!;
      verts[v + 4] = n[1]!;
      verts[v + 5] = n[2]!;
      verts[v + 6] = (sx + 1) / 2;
      verts[v + 7] = (1 - sy) / 2;
      verts[v + 8] = red;
      verts[v + 9] = green;
      verts[v + 10] = blue;
      verts[v + 11] = 1;
      v += STREAM_VERTEX_FLOATS;
    }
    idx[i++] = base;
    idx[i++] = base + 1;
    idx[i++] = base + 2;
    idx[i++] = base;
    idx[i++] = base + 2;
    idx[i++] = base + 3;
  };

  // The floor: always present, so the chunk never empties.
  quad([0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, -1], half, half, 0.42, 0.46, 0.36);
  for (let z = 0; z < STREAM_COLUMNS; z++) {
    for (let x = 0; x < STREAM_COLUMNS; x++) {
      const h = height(cx + x, cz + z, req.phase);
      if (h <= 0) continue;
      const lx = x - half + 0.5;
      const lz = z - half + 0.5;
      const g = 0.45 + 0.18 * h;
      quad([lx, h, lz], [0, 1, 0], [1, 0, 0], [0, 0, -1], 0.5, 0.5, 0.3, g, 0.25);
      for (const [n, r, u] of SIDES) {
        const c = [lx + n[0]! * 0.5, h / 2, lz + n[2]! * 0.5];
        quad(c, n, r, u, 0.5, h / 2, 0.25, g * 0.8, 0.2);
      }
    }
  }
  return {
    chunk: req.chunk,
    buffer: req.buffer,
    vertexCount: v / STREAM_VERTEX_FLOATS,
    indexCount: i,
  };
}

self.addEventListener('message', (e: MessageEvent<StreamRequest>) => {
  const reply = mesh(e.data);
  self.postMessage(reply, { transfer: [reply.buffer] });
});
