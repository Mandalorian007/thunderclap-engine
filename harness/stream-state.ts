/**
 * What the mesh streaming page (harness/stream.html) publishes on `window.__harnessStream` for
 * e2e/stream.spec.ts, and the messages between the page and its mesher Worker
 * (harness/stream-worker.ts). Shared by the page, the Worker and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface StreamProbe {
  x: number;
  y: number;
}

/** Chunks per side of the grid, columns per side of a chunk, world units per column. */
export const STREAM_GRID = 4;
export const STREAM_COLUMNS = 8;
/** Floats per vertex (`VERTEX_LAYOUT_3D`) and bytes per index (uint16), as the Worker packs them. */
export const STREAM_VERTEX_FLOATS = 12;
/** Vertices and indices of a chunk at its fullest: a floor plus 5 quads per column. */
export const STREAM_MAX_VERTICES = 4 + STREAM_COLUMNS * STREAM_COLUMNS * 20;
export const STREAM_MAX_INDICES = 6 + STREAM_COLUMNS * STREAM_COLUMNS * 30;
/** Byte offset of the indices in a chunk buffer (after the vertices, 4-byte aligned). */
export const STREAM_INDEX_OFFSET = STREAM_MAX_VERTICES * STREAM_VERTEX_FLOATS * 4;
/** Size of one chunk buffer: vertices, then indices padded to 4 bytes. */
export const STREAM_BUFFER_BYTES =
  STREAM_INDEX_OFFSET + Math.ceil((STREAM_MAX_INDICES * 2) / 4) * 4;

/** Layers of the page's block texture array (harness/stream.ts `blockLayers`). */
export const STREAM_LAYERS = 4;

/**
 * Texture-array layer of every face of `chunk`. The Worker writes it into each vertex colour's
 * alpha (the 3D layout has no spare uv channel) and the page's material samples that layer.
 * Neighbouring chunks differ: x parity + 2 × z parity of the chunk's grid cell.
 */
export function streamChunkLayer(chunk: number): number {
  return ((chunk % STREAM_GRID) % 2) + 2 * (Math.floor(chunk / STREAM_GRID) % 2);
}

/** Page → Worker: re-mesh `chunk` for `phase`, into `buffer` (transferred). */
export interface StreamRequest {
  chunk: number;
  phase: number;
  buffer: ArrayBuffer;
}

/**
 * Worker → page: `buffer` (transferred back) holds `vertexCount` vertices and `indexCount`
 * indices; `bounds` is their bounding sphere in chunk space (what `mesh.update` takes, so the
 * page never scans the vertices).
 */
export interface StreamReply {
  chunk: number;
  buffer: ArrayBuffer;
  vertexCount: number;
  indexCount: number;
  bounds: { center: [number, number, number]; radius: number };
}

/** Where the page's camera looks: `grid` (the default, every chunk in view) or `edge` (half). */
export type StreamLook = 'grid' | 'edge';

export interface HarnessStreamState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** Chunk meshes in the scene. */
  chunks: number;
  /** Mesh updates applied so far (one per Worker reply). */
  updates: number;
  /** Updates whose vertex count differed from that chunk's previous one. */
  changed: number;
  /** Buffer reallocations summed over the meshes (`mesh.growths`). */
  growths: number;
  /** Vertices and indices uploaded during the last frame, and the most in any frame. */
  uploaded: { vertices: number; indices: number; peakVertices: number };
  /** Current `vertexCount` of each chunk mesh. */
  vertexCounts: number[];
  /**
   * Screen positions (logical px) of two world points: `ground`, the centre of the grid (always
   * covered by a floor or a column), and `sky`, well above and behind the grid.
   */
  probes: { ground: StreamProbe; sky: StreamProbe };
  /**
   * Screen positions (logical px) of the floor centres of two neighbouring chunks, with the
   * texture-array layer each one's faces sample (ws/texture-array).
   */
  layerProbes: { at: StreamProbe; layer: number }[];
  /** `renderer.stats` of the last frame (`culled`: chunk draws the frustum test skipped). */
  stats: { drawCalls: number; instances: number; culled: number };
  /** Current camera aim (`api.look`). */
  look: StreamLook;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessStreamApi {
  state: HarnessStreamState;
  /** Re-aim the camera: `edge` looks at the grid's far corner so about half the chunks leave the frustum. */
  look(where: StreamLook): void;
}

declare global {
  interface Window {
    __harnessStream?: HarnessStreamApi;
  }
}
