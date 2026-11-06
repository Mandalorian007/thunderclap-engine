/**
 * What the tiles page (harness/tiles.html) publishes on `window.__harnessTiles` for
 * e2e/tiles.spec.ts. Shared by the page (harness/tiles.ts) and the spec.
 */

export interface HarnessTilesState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The layer's grid and tile size (logical px), and `TileLayer.count`. */
  grid: { columns: number; rows: number; tileW: number; tileH: number };
  tiles: number;
  /** The walking sprite's flipbook: current frame index and its `UvRect`. */
  frame: number;
  uv: number[];
  /** Whether the sprite is drawn this frame (the layer always is). */
  sprite: boolean;
  /** `renderer.stats.drawCalls` of the last frame. */
  drawCalls: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessTilesApi {
  state: HarnessTilesState;
  /** `TileLayer.set(col, row, tileIndex)`. */
  set(col: number, row: number, tileIndex: number): void;
  /** Draw (true) or skip (false) the flipbook sprite. */
  setSprite(visible: boolean): void;
}

declare global {
  interface Window {
    __harnessTiles?: HarnessTilesApi;
  }
}
