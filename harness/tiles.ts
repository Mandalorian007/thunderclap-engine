/**
 * Tiles demo page: a 32 × 18 `TileLayer` of 60 px tiles from a generated 2 × 2 checker atlas,
 * filling the 1920 × 1080 logical canvas as one draw, plus one sprite walking along a row whose
 * frames come from a `Flipbook` over the same atlas. Nothing here is engine code beyond those
 * two helpers: the atlas pixels and the walk are what a game would write.
 *
 * `?iso` (ws/ergo-2d-2): a 12 × 12 diamond map in painter mode with a two-level ramp, a sprite
 * walking row 6 drawn between the tiles at `layer.depthOf`, and pointer hover picking through
 * `isoInverseProbe`. `?parallax`: three wrapped layers under a `createFollow2D` camera that
 * follows a dot, with the dead zone drawn as a box.
 *
 * e2e/tiles.spec.ts counts draw calls, watches the flipbook frame advance, samples the pixel
 * at a tile's centre before and after `set`, hovers the iso ramp and moves the dot.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { createIso, isoInverseProbe } from '@thunderclap/engine/geom';
import { boot, type Surface } from '@thunderclap/engine/platform';
import {
  atlasFrames,
  Camera,
  createFlipbook,
  createFollow2D,
  createParallax,
  createTileLayer,
  type DrawParams,
  gpuDiagnostics,
  installGpuErrorLogging,
  type Material,
  Renderer,
} from '@thunderclap/engine/render';
import type { HarnessTilesApi, HarnessTilesMode, HarnessTilesState } from './tiles-state';

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

const params = new URLSearchParams(location.search);
const MODE: HarnessTilesMode = params.has('iso')
  ? 'iso'
  : params.has('parallax')
    ? 'parallax'
    : 'grid';

const state: HarnessTilesState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  mode: MODE,
  grid: GRID,
  tiles: 0,
  frame: 0,
  uv: [0, 0, 0, 0],
  sprite: true,
  drawCalls: 0,
  gpuErrors: 0,
  order: 'grid',
  iso: { tileW: 0, tileH: 0, elevH: 0, originX: 0, originY: 0 },
  hoverTile: [-1, -1],
  walker: [0, 6],
  cameraX: 0,
  cameraY: 0,
  layerOffsets: [],
  layerFactors: [],
  layerWraps: [],
  dot: [0, 0],
  deadZone: { w: 0, h: 0 },
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

interface Ctx {
  renderer: Renderer;
  surface: Surface;
  api: HarnessTilesApi;
}

/** The default page: the checker layer and the flipbook walker. */
function gridMode({ renderer, api }: Ctx): GameLoop {
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
  state.order = layer.order;

  const book = createFlipbook({ frames: atlasFrames(ATLAS, [2, 3, 2, 1]), fps: 8 });
  const sprite: DrawParams = {
    x: 0,
    y: (WALK_ROW + 0.5) * GRID.tileH,
    w: GRID.tileW,
    h: GRID.tileH,
    uv: book.uv,
    order: 1,
  };
  api.set = (col, row, tileIndex) => layer.set(col, row, tileIndex);

  let walk = 0;
  return new GameLoop({
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
}

// ------------------------------------------------------------------------------------------ ?iso

const ISO_CELL = 64;
const ISO = { tileW: 64, tileH: 32, elevH: 16, originX: 960, originY: 300 };
const ISO_MAP = 12;
/** Top and wall colours (sRGB bytes) of the three elevations, then the walker. */
const ISO_RGBA: readonly (readonly [number, number, number, number])[] = [
  [70, 160, 96, 255],
  [210, 180, 120, 255],
  [120, 170, 230, 255],
  [240, 150, 40, 255],
];
const ISO_WALL: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [150, 120, 70, 255],
  [70, 100, 160, 255],
  [0, 0, 0, 0],
];
const WALKER_W = 96;
const WALKER_H = 48;
const WALK_ROW_ISO = 6;
const WALK_TILES_PER_S = 1.5;

/** The ramp: flat for tx < 4, one step up to 7, two steps from 8; off the map -1. */
function rampHeight(tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= ISO_MAP || ty >= ISO_MAP) return -1;
  return tx >= 8 ? 2 : tx >= 4 ? 1 : 0;
}

/**
 * A 2 × 2 atlas of 64 × 64 cells: cell `e` (0..2) is a diamond top at elevation `e` with a
 * `16 × e` px wall under its lower edges, over transparent; cell 3 is the solid walker.
 */
function isoAtlasPixels(): Uint8Array<ArrayBuffer> {
  const w = ATLAS.cols * ISO_CELL;
  const h = ATLAS.rows * ISO_CELL;
  const data = new Uint8Array(new ArrayBuffer(w * h * 4));
  const put = (x: number, y: number, rgba: readonly [number, number, number, number]) => {
    const o = (y * w + x) * 4;
    data[o] = rgba[0];
    data[o + 1] = rgba[1];
    data[o + 2] = rgba[2];
    data[o + 3] = rgba[3];
  };
  for (let cell = 0; cell < 4; cell++) {
    const cx0 = (cell % ATLAS.cols) * ISO_CELL;
    const cy0 = Math.floor(cell / ATLAS.cols) * ISO_CELL;
    const skirt = cell < 3 ? cell * ISO.elevH : 0;
    for (let y = 0; y < ISO_CELL; y++) {
      for (let x = 0; x < ISO_CELL; x++) {
        if (cell === 3) {
          put(cx0 + x, cy0 + y, ISO_RGBA[3]!);
          continue;
        }
        // Diamond centred at (32, 16): |dx| / 32 + |dy| / 16 <= 1. Its lower edge at this x.
        const dx = Math.abs(x + 0.5 - ISO.tileW / 2) / (ISO.tileW / 2);
        const dy = Math.abs(y + 0.5 - ISO.tileH / 2) / (ISO.tileH / 2);
        const edge = ISO.tileH / 2 + (ISO.tileH / 2) * (1 - dx);
        if (dx + dy <= 1) put(cx0 + x, cy0 + y, ISO_RGBA[cell]!);
        else if (y + 0.5 > edge && y + 0.5 <= edge + skirt) put(cx0 + x, cy0 + y, ISO_WALL[cell]!);
      }
    }
  }
  return data;
}

function isoMode({ renderer, surface, api }: Ctx): GameLoop {
  const texture = renderer.textureFromPixels({
    width: ATLAS.cols * ISO_CELL,
    height: ATLAS.rows * ISO_CELL,
    data: isoAtlasPixels(),
    format: 'rgba8unorm-srgb',
    label: 'tiles-iso-atlas',
  });
  const material = renderer.createSpriteMaterial(texture, 'tiles-iso', {
    sampler: 'nearest-clamp',
  });
  const iso = createIso(ISO);
  state.iso = ISO;
  const layer = createTileLayer(renderer, {
    material,
    tileW: ISO_CELL,
    tileH: ISO_CELL,
    columns: ISO_MAP,
    rows: ISO_MAP,
    atlas: ATLAS,
    order: 'painter',
    diamond: true,
    iso,
    elevation: (tx, ty) => Math.max(0, rampHeight(tx, ty)),
    label: 'tiles-iso',
  });
  for (let ty = 0; ty < ISO_MAP; ty++) {
    for (let tx = 0; tx < ISO_MAP; tx++) layer.set(tx, ty, rampHeight(tx, ty));
  }
  state.order = layer.order;
  state.grid = { columns: ISO_MAP, rows: ISO_MAP, tileW: ISO_CELL, tileH: ISO_CELL };

  const walkerUv = atlasFrames(ATLAS, [3])[0]!;
  const walker: DrawParams = { x: 0, y: 0, w: WALKER_W, h: WALKER_H, uv: walkerUv, order: 0 };
  const pt = { x: 0, y: 0 };
  let walkX = 0;
  let walkY = WALK_ROW_ISO;
  let walking = true;
  api.set = (col, row, tileIndex) => layer.set(col, row, tileIndex);
  api.setWalker = (tx, ty) => {
    walking = false;
    walkX = tx;
    walkY = ty;
  };

  const hover = { x: 0, y: 0 };
  root.addEventListener('pointermove', (e) => {
    surface.clientToLogical(e.clientX, e.clientY, hover);
    isoInverseProbe(iso, hover.x, hover.y, rampHeight, 2, hover);
    state.hoverTile[0] = hover.x;
    state.hoverTile[1] = hover.y;
  });

  return new GameLoop({
    update(dt) {
      if (walking) walkX = (walkX + dt * WALK_TILES_PER_S) % ISO_MAP;
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(0, 0, 0);
      layer.draw(frame);
      if (state.sprite) {
        // The walker stands on the tile under its feet, at that tile's height.
        const tx = Math.floor(walkX);
        const elev = Math.max(0, rampHeight(tx, walkY));
        iso.toScreen(walkX, walkY, elev, pt);
        walker.x = pt.x;
        walker.y = pt.y - ISO.tileH / 2;
        walker.order = layer.depthOf(walkX, walkY, elev);
        frame.sprite(material, walker);
      }
      renderer.endFrame();
      state.frames++;
      state.tiles = layer.count;
      state.walker[0] = walkX;
      state.walker[1] = walkY;
      state.drawCalls = renderer.stats.drawCalls;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
}

// ------------------------------------------------------------------------------------- ?parallax

const PAR_TILE = 60;
const PAR_LAYERS = [
  { factor: 0.2, period: 8, rows: 3, y: 60, cell: 0, pattern: [0, -1, -1, 0, 0, -1, 0, -1] },
  { factor: 0.5, period: 6, rows: 2, y: 420, cell: 1, pattern: [1, 1, -1, 1, -1, -1] },
  { factor: 0.8, period: 5, rows: 2, y: 760, cell: 2, pattern: [2, -1, 2, 2, -1] },
] as const;
const DEAD_ZONE = { w: 400, h: 200 };
const DOT = 24;
const LINE = 4;

function parallaxMode({ renderer, surface, api }: Ctx): GameLoop {
  const texture = renderer.textureFromPixels({
    width: ATLAS.cols * CELL,
    height: ATLAS.rows * CELL,
    data: atlasPixels(),
    format: 'rgba8unorm-srgb',
    label: 'tiles-atlas',
  });
  const material: Material = renderer.createSpriteMaterial(texture, 'tiles', {
    sampler: 'nearest-clamp',
  });
  const camera = Camera.ortho2d(LOGICAL.width, LOGICAL.height);
  renderer.camera = camera;

  const viewCols = Math.ceil(LOGICAL.width / PAR_TILE) + 1;
  const parallax = createParallax(
    renderer,
    PAR_LAYERS.map((spec, i) => {
      const columns = viewCols + spec.period;
      const layer = createTileLayer(renderer, {
        material,
        tileW: PAR_TILE,
        tileH: PAR_TILE,
        columns,
        rows: spec.rows,
        atlas: ATLAS,
        label: `parallax-${i}`,
      });
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < columns; c++) {
          const idx = spec.pattern[c % spec.period]!;
          if (idx >= 0) layer.set(c, r, r === 0 ? idx : spec.cell);
        }
      }
      layer.origin.y = spec.y;
      return {
        layer,
        factorX: spec.factor,
        factorY: spec.factor,
        wrapW: spec.period * PAR_TILE,
        params: { order: i },
      };
    }),
  );
  state.order = parallax.layers[0]!.layer.order;
  state.layerFactors = PAR_LAYERS.map((l) => l.factor);
  state.layerWraps = PAR_LAYERS.map((l) => l.period * PAR_TILE);
  state.layerOffsets = PAR_LAYERS.map(() => [0, 0]);
  state.deadZone = DEAD_ZONE;

  const follow = createFollow2D(camera, {
    deadZone: DEAD_ZONE,
    lookAhead: { x: 160, y: 0 },
    lookAheadSmoothing: 0.3,
    smoothing: 0.15,
    bounds: { minX: -6000, minY: -3000, maxX: 8000, maxY: 4000 },
  });
  const dot = { x: LOGICAL.width / 2, y: LOGICAL.height / 2, vx: 0, vy: 0 };
  const prev = { x: dot.x, y: dot.y };
  api.moveDot = (dx, dy) => {
    // A jump, not a run: no velocity, so the look-ahead stays put.
    dot.x += dx;
    dot.y += dy;
    prev.x = dot.x;
    prev.y = dot.y;
  };
  const press = { x: 0, y: 0 };
  let pressed = false;
  root.addEventListener('pointerdown', (e) => {
    pressed = true;
    surface.clientToLogical(e.clientX, e.clientY, press);
  });
  root.addEventListener('pointermove', (e) => {
    if (pressed) surface.clientToLogical(e.clientX, e.clientY, press);
  });
  root.addEventListener('pointerup', () => {
    pressed = false;
  });

  const solid = atlasFrames(ATLAS, [3])[0]!;
  const orange = atlasFrames(ATLAS, [2])[0]!;
  const dotDraw: DrawParams = { x: 0, y: 0, w: DOT, h: DOT, uv: orange, order: 10 };
  const box: DrawParams[] = [0, 1, 2, 3].map(() => ({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    uv: solid,
    order: 9,
  }));

  return new GameLoop({
    update(dt) {
      if (pressed) {
        // The pointer, in world px, is where the dot goes.
        dot.x = press.x + camera.x;
        dot.y = press.y + camera.y;
      }
      dot.vx = dt > 0 ? (dot.x - prev.x) / dt : 0;
      dot.vy = dt > 0 ? (dot.y - prev.y) / dt : 0;
      prev.x = dot.x;
      prev.y = dot.y;
      follow.update(dt, dot.x, dot.y, dot.vx, dot.vy);
      parallax.update(camera.x, camera.y);
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(0.05, 0.05, 0.08);
      parallax.draw(frame);
      // The dead zone as four lines around the anchor, then the dot.
      const hw = DEAD_ZONE.w / 2;
      const hh = DEAD_ZONE.h / 2;
      const ax = follow.anchorX;
      const ay = follow.anchorY;
      Object.assign(box[0]!, { x: ax, y: ay - hh, w: DEAD_ZONE.w, h: LINE });
      Object.assign(box[1]!, { x: ax, y: ay + hh, w: DEAD_ZONE.w, h: LINE });
      Object.assign(box[2]!, { x: ax - hw, y: ay, w: LINE, h: DEAD_ZONE.h });
      Object.assign(box[3]!, { x: ax + hw, y: ay, w: LINE, h: DEAD_ZONE.h });
      for (const b of box) frame.sprite(material, b);
      if (state.sprite) {
        dotDraw.x = dot.x;
        dotDraw.y = dot.y;
        frame.sprite(material, dotDraw);
      }
      renderer.endFrame();
      state.frames++;
      state.tiles = parallax.layers[0]!.layer.count;
      state.cameraX = camera.x;
      state.cameraY = camera.y;
      for (let i = 0; i < parallax.layers.length; i++) {
        const l = parallax.layers[i]!;
        state.layerOffsets[i]![0] = l.offsetX;
        state.layerOffsets[i]![1] = l.offsetY;
      }
      state.dot[0] = dot.x;
      state.dot[1] = dot.y;
      state.drawCalls = renderer.stats.drawCalls;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
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

  const api: HarnessTilesApi = {
    state,
    set() {},
    setSprite(visible) {
      state.sprite = visible;
    },
    setWalker() {},
    moveDot() {},
  };
  window.__harnessTiles = api;

  const ctx: Ctx = { renderer, surface, api };
  const loop =
    MODE === 'iso' ? isoMode(ctx) : MODE === 'parallax' ? parallaxMode(ctx) : gridMode(ctx);
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
