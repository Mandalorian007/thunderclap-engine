/**
 * The GPU side of a level: the map tile layer, the parallax, the flipbook frame tables. Built
 * once per level by `scenes/level.ts`; `destroy` releases the layers. The atlas material is shared
 * by everything, so the sprites after the layers batch into one draw.
 */
import {
  atlasFrames,
  createTileLayer,
  type Material,
  type Renderer,
  type TileLayer,
  type UvRect,
} from '@thunderclap/engine/render';
import { HAZARD, type Level, ONE_WAY, SOLID, TILE } from '../levels/format';
import { ATLAS_COLS, ATLAS_ROWS, CELL, cellUv } from './atlas';
import { createParallax, type Parallax } from './parallax';

export interface Frames {
  idle: UvRect[];
  run: UvRect[];
  jump: UvRect[];
  fall: UvRect[];
  land: UvRect[];
  dash: UvRect[];
  coin: UvRect[];
}

/** Flipbook frame tables; allocated once at load (the atlas is fixed). */
export function buildFrames(): Frames {
  const grid = { cols: ATLAS_COLS, rows: ATLAS_ROWS };
  return {
    idle: atlasFrames(grid, [CELL.idle0, CELL.idle1]),
    run: atlasFrames(grid, [CELL.run0, CELL.run1, CELL.run2, CELL.run3]),
    jump: atlasFrames(grid, [CELL.jump]),
    fall: atlasFrames(grid, [CELL.fall]),
    land: atlasFrames(grid, [CELL.land]),
    dash: atlasFrames(grid, [CELL.dash]),
    coin: atlasFrames(grid, [CELL.coin0, CELL.coin1, CELL.coin2, CELL.coin3]),
  };
}

export interface World {
  readonly map: TileLayer;
  readonly parallax: Parallax;
  destroy(): void;
}

/** A tile's atlas cell: ground gets a grassy top when nothing solid is above it. */
function cellFor(level: Level, col: number, row: number): number {
  const k = level.kinds[row * level.cols + col];
  if (k === SOLID) {
    const above = row > 0 ? level.kinds[(row - 1) * level.cols + col] : 0;
    return above === SOLID ? CELL.groundFill : CELL.groundTop;
  }
  if (k === ONE_WAY) return CELL.oneWay;
  if (k === HAZARD) return CELL.spike;
  return -1;
}

export function buildWorld(
  renderer: Renderer,
  material: Material,
  level: Level,
  viewW: number,
  viewH: number,
): World {
  const map = createTileLayer(renderer, {
    material,
    tileW: TILE,
    tileH: TILE,
    columns: level.cols,
    rows: level.rows,
    atlas: { cols: ATLAS_COLS, rows: ATLAS_ROWS },
    label: `map-${level.id}`,
  });
  const tiles = new Int16Array(level.cols * level.rows);
  for (let r = 0; r < level.rows; r++) {
    for (let c = 0; c < level.cols; c++) tiles[r * level.cols + c] = cellFor(level, c, r);
  }
  map.fill(tiles);
  const parallax = createParallax(renderer, material, viewW, viewH, level.rows * TILE);
  return {
    map,
    parallax,
    destroy() {
      map.destroy();
      parallax.destroy();
    },
  };
}

const moverCell = cellUv(CELL.mover);

export const UV = {
  /** The mover cell's painted top half (the platform is half a tile tall). */
  moverHalf: [moverCell[0], moverCell[1], moverCell[2], (moverCell[1] + moverCell[3]) / 2] as const,
  door: cellUv(CELL.door),
  flagOff: cellUv(CELL.flagOff),
  flagOn: cellUv(CELL.flagOn),
  white: cellUv(CELL.white),
};
