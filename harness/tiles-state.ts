/**
 * What the tiles page (harness/tiles.html) publishes on `window.__harnessTiles` for
 * e2e/tiles.spec.ts. Shared by the page (harness/tiles.ts) and the spec.
 */

export type HarnessTilesMode = 'grid' | 'iso' | 'parallax';

export interface HarnessTilesState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The page's mode from the query (`?iso`, `?parallax`; default `grid`). */
  mode: HarnessTilesMode;
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
  /** The layer's `order` (`'grid'` or `'painter'`). */
  order: string;
  /** `?iso`: the lattice (logical px), the tile under the pointer (`[-1, -1]` none), the walker. */
  iso: { tileW: number; tileH: number; elevH: number; originX: number; originY: number };
  hoverTile: [number, number];
  walker: [number, number];
  /** `?parallax`: the camera's `x`, `y`, each layer's `[offsetX, offsetY]`, factor and period. */
  cameraX: number;
  cameraY: number;
  layerOffsets: [number, number][];
  layerFactors: number[];
  layerWraps: number[];
  dot: [number, number];
  deadZone: { w: number; h: number };
}

export interface HarnessTilesApi {
  state: HarnessTilesState;
  /** `TileLayer.set(col, row, tileIndex)`. */
  set(col: number, row: number, tileIndex: number): void;
  /** Draw (true) or skip (false) the flipbook sprite. */
  setSprite(visible: boolean): void;
  /** `?iso`: park the walker on tile `(tx, ty)` (stops the walk). */
  setWalker(tx: number, ty: number): void;
  /** `?parallax`: move the dot by `(dx, dy)` world px. */
  moveDot(dx: number, dy: number): void;
}

declare global {
  interface Window {
    __harnessTiles?: HarnessTilesApi;
  }
}
