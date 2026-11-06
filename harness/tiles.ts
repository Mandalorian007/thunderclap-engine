/**
 * Tiles demo page: a 32 × 18 `TileLayer` of 60 px tiles from a generated 2 × 2 checker atlas,
 * filling the 1920 × 1080 logical canvas as one draw, plus one sprite walking along a row whose
 * frames come from a `Flipbook` over the same atlas. Nothing here is engine code beyond those
 * two helpers: the atlas pixels and the walk are what a game would write.
 *
 * e2e/tiles.spec.ts counts draw calls, watches the flipbook frame advance and samples the pixel
 * at a tile's centre before and after `set`.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import {
  atlasFrames,
  createFlipbook,
  createTileLayer,
  type DrawParams,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
} from '@thunderclap/engine/render';
import type { HarnessTilesApi, HarnessTilesState } from './tiles-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const GRID = { columns: 32, rows: 18, tileW: 60, tileH: 60 };
const ATLAS = { cols: 2, rows: 2 };
const CELL = 16;
/** Atlas cell colours (sRGB bytes): two checker tones, then two sprite tones. */
const CELL_RGBA: readonly (readonly [number, number, number, number])[] = [
  [36, 48, 92, 255],
  [70, 160, 96, 255],
  [240, 150, 40, 255],
  [220, 60, 170, 255],
];
const WALK_ROW = 12;
const WALK_PX_PER_S = 240;

const state: HarnessTilesState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  grid: GRID,
  tiles: 0,
  frame: 0,
  uv: [0, 0, 0, 0],
  sprite: true,
  drawCalls: 0,
  gpuErrors: 0,
};

/** A `cols × rows` atlas of flat-coloured `CELL × CELL` cells. */
function atlasPixels(): Uint8Array<ArrayBuffer> {
  const w = ATLAS.cols * CELL;
  const h = ATLAS.rows * CELL;
  const data = new Uint8Array(new ArrayBuffer(w * h * 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = Math.floor(y / CELL) * ATLAS.cols + Math.floor(x / CELL);
      const rgba = CELL_RGBA[cell]!;
      const o = (y * w + x) * 4;
      data[o] = rgba[0];
      data[o + 1] = rgba[1];
      data[o + 2] = rgba[2];
      data[o + 3] = rgba[3];
    }
  }
  return data;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine tiles demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const texture = renderer.textureFromPixels({
    width: ATLAS.cols * CELL,
    height: ATLAS.rows * CELL,
    data: atlasPixels(),
    format: 'rgba8unorm-srgb',
    label: 'tiles-atlas',
  });
  const material = renderer.createSpriteMaterial(texture, 'tiles', { sampler: 'nearest-clamp' });

  const layer = createTileLayer(renderer, { material, ...GRID, atlas: ATLAS, label: 'tiles' });
  const checker = new Int16Array(GRID.columns * GRID.rows);
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.columns; c++) checker[r * GRID.columns + c] = (c + r) % 2;
  }
  layer.fill(checker);

  const book = createFlipbook({ frames: atlasFrames(ATLAS, [2, 3, 2, 1]), fps: 8 });
  const sprite: DrawParams = {
    x: 0,
    y: (WALK_ROW + 0.5) * GRID.tileH,
    w: GRID.tileW,
    h: GRID.tileH,
    uv: book.uv,
    order: 1,
  };

  const api: HarnessTilesApi = {
    state,
    set(col, row, tileIndex) {
      layer.set(col, row, tileIndex);
    },
    setSprite(visible) {
      state.sprite = visible;
    },
  };
  window.__harnessTiles = api;

  let walk = 0;
  const loop = new GameLoop({
    update(dt) {
      walk = (walk + dt * WALK_PX_PER_S) % LOGICAL.width;
      book.update(dt);
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(0, 0, 0);
      layer.draw(frame);
      if (state.sprite) {
        sprite.x = walk;
        sprite.uv = book.uv;
        frame.sprite(material, sprite);
      }
      renderer.endFrame();
      state.frames++;
      state.tiles = layer.count;
      state.frame = book.frame;
      const uv = book.uv;
      state.uv[0] = uv[0];
      state.uv[1] = uv[1];
      state.uv[2] = uv[2];
      state.uv[3] = uv[3];
      state.drawCalls = renderer.stats.drawCalls;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
