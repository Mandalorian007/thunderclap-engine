/**
 * The tiles demo (harness/tiles.html) on every matrix row: a 32 × 18 `TileLayer` from a
 * generated checker atlas plus one `Flipbook` sprite walking along a row.
 *
 * - the page boots WebGPU with no error, the layer is one draw call (two with the sprite);
 * - the flipbook's frame advances;
 * - `set` on a tile changes the pixel at that tile's centre (sampled from a screenshot before
 *   and after; no golden image).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessTilesState } from '../harness/tiles-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}tiles.html${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`tiles.html${query}`)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`tiles demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

/** harness/tiles.ts walks cells `[2, 3, 2, 1]` of a 2 × 2 atlas: the `UvRect` of each frame. */
const WALK_RECTS = [2, 3, 2, 1].map((cell) => {
  const c = cell % 2;
  const r = Math.floor(cell / 2);
  return [c / 2, r / 2, (c + 1) / 2, (r + 1) / 2];
});

function read(): Promise<HarnessTilesState> {
  return frame.evaluate(() => {
    const s = window.__harnessTiles?.state;
    if (!s) throw new Error('window.__harnessTiles missing');
    return JSON.parse(JSON.stringify(s)) as HarnessTilesState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Page CSS px of a logical point. */
async function toPage(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (x / logical.width) * box.width,
    y: box.y + (y / logical.height) * box.height,
  };
}

/** Page CSS px of the centre of tile `(col, row)`. */
async function tileCentre(col: number, row: number): Promise<{ x: number; y: number }> {
  const { grid } = await read();
  return toPage((col + 0.5) * grid.tileW, (row + 0.5) * grid.tileH);
}

/** Logical px of iso tile `(tx, ty)`'s diamond centre at `elev` (the page's `Iso.toScreen`). */
async function isoCentre(tx: number, ty: number, elev: number): Promise<{ x: number; y: number }> {
  const { iso } = await read();
  return {
    x: iso.originX + ((tx - ty) * iso.tileW) / 2,
    y: iso.originY + ((tx + ty) * iso.tileH) / 2 - elev * iso.elevH,
  };
}

/** harness/tiles.ts `rampHeight`: flat below tx 4, one step to 7, two steps from 8. */
const ramp = (tx: number) => (tx >= 8 ? 2 : tx >= 4 ? 1 : 0);

/** Average colour of the 5×5 CSS px around a page point, from a screenshot of the page. */
async function sample(page: Page, p: { x: number; y: number }): Promise<Rgb> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pt]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(Math.round(pt.x) - 2, Math.round(pt.y) - 2, 5, 5).data;
      const out: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        out[0] += d[i]! / 25;
        out[1] += d[i + 1]! / 25;
        out[2] += d[i + 2]! / 25;
      }
      return out;
    },
    [png.toString('base64'), p] as const,
  );
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

function setSprite(visible: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessTiles?.setSprite(v), visible);
}

function set(col: number, row: number, tileIndex: number): Promise<void> {
  return frame.evaluate((a) => window.__harnessTiles?.set(a[0], a[1], a[2]), [
    col,
    row,
    tileIndex,
  ] as const);
}

test('the layer fills the grid and is one draw call; the sprite adds one', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.tiles).toBe(s.grid.columns * s.grid.rows);
  expect(s.drawCalls).toBe(2);
  await setSprite(false);
  await frames(2);
  expect((await read()).drawCalls).toBe(1);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the flipbook frame advances and its uv follows', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const first = await read();
  // Keep the sample the poll accepted (a later read() could be a whole loop on), and check its uv
  // is the rect of *that* frame: the walk cycle repeats a cell, so two frames can share a rect.
  let next = first;
  await expect
    .poll(async () => {
      next = await read();
      return next.frame;
    })
    .not.toBe(first.frame);
  expect(next.uv).toEqual(WALK_RECTS[next.frame]);
  expect(next.uv.every((v) => v >= 0 && v <= 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('set() changes the pixel at a tile’s centre', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await setSprite(false);
  await frames(2);
  const at = await tileCentre(5, 5);
  const before = await sample(page, at);
  // Tile (5, 5) holds checker cell 0; cell 3 is the sprite's magenta.
  await set(5, 5, 3);
  await expect
    .poll(async () => diff(await sample(page, at), before), { message: 'tile (5, 5) after set' })
    .toBeGreaterThan(40);
  await set(5, 5, -1);
  await expect
    .poll(async () => diff(await sample(page, at), [0, 0, 0]), { message: 'tile (5, 5) emptied' })
    .toBeLessThanOrEqual(4);
  expect(errors).toEqual([]);
});

test('?iso: hovering a lifted tile’s top resolves that tile on every row', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?iso');
  const s = await read();
  expect(s.order).toBe('painter');
  expect(s.tiles).toBe(s.grid.columns * s.grid.rows);
  for (const tx of [9, 5, 2]) {
    for (let ty = 0; ty < s.grid.rows; ty++) {
      const c = await isoCentre(tx, ty, ramp(tx));
      const p = await toPage(c.x, c.y);
      await page.mouse.move(p.x, p.y);
      await expect
        .poll(async () => (await read()).hoverTile, { message: `hover (${tx}, ${ty})` })
        .toEqual([tx, ty]);
    }
  }
  // Off the map: nothing.
  const off = await toPage(100, 100);
  await page.mouse.move(off.x, off.y);
  await expect.poll(async () => (await read()).hoverTile).toEqual([-1, -1]);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?iso: the walker draws over the lower tile and under the higher one', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?iso');
  // Park the walker on (3, 6): flat, with the one-step tile (4, 6) in front of it to the right.
  await frame.evaluate(() => window.__harnessTiles?.setWalker(3, 6));
  await frames(3);
  const s = await read();
  // 23 diagonal bands plus the walker.
  expect(s.drawCalls).toBe(s.grid.columns + s.grid.rows - 1 + 1);
  const c = await isoCentre(3, 6, 0);
  // Inside the walker and over (3, 6)'s diamond: the walker's colour (same as its body).
  const body = await sample(page, await toPage(c.x, c.y - 28));
  const over = await sample(page, await toPage(c.x - 12, c.y - 6));
  // The centre of (4, 6)'s top: inside the walker's quad, but the tile is drawn after it.
  const under = await sample(page, await toPage(c.x + 32, c.y));
  const far = await isoCentre(4, 8, 1);
  const tan = await sample(page, await toPage(far.x, far.y));
  expect(diff(over, body), 'walker over the lower tile').toBeLessThanOrEqual(8);
  expect(diff(under, body), 'walker under the higher tile').toBeGreaterThan(40);
  expect(diff(under, tan), 'the higher tile’s top shows').toBeLessThanOrEqual(8);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?parallax: the camera holds inside the dead zone, moves after, and the layers scroll by factor', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?parallax');
  await frames(3);
  const s0 = await read();
  expect(s0.layerFactors.length).toBe(3);
  // Three layers, then the dead-zone box (four lines) and the dot as one sprite batch.
  expect(s0.drawCalls).toBe(4);
  const move = (dx: number, dy: number) =>
    frame.evaluate((d) => window.__harnessTiles?.moveDot(d[0], d[1]), [dx, dy] as const);
  // 150 px right: still inside the 400 px dead zone.
  await move(150, 0);
  await frames(3);
  const s1 = await read();
  expect(s1.cameraX).toBe(s0.cameraX);
  expect(s1.cameraY).toBe(s0.cameraY);
  expect(s1.dot[0]).toBe(s0.dot[0] + 150);
  // 300 px more: out of the zone, the camera follows.
  await move(300, 0);
  await expect.poll(async () => (await read()).cameraX).toBeGreaterThan(s0.cameraX + 100);
  const s2 = await read();
  expect(s2.cameraY).toBe(s0.cameraY);
  // Each layer's x offset is the camera minus its scroll modulo its period: distinct per factor.
  for (let i = 0; i < 3; i++) {
    const f = s2.layerFactors[i]!;
    const wrap = s2.layerWraps[i]!;
    const scroll = s2.cameraX * f;
    const want = s2.cameraX - (((scroll % wrap) + wrap) % wrap);
    expect(s2.layerOffsets[i]![0], `layer ${i} offset`).toBeCloseTo(want, 6);
    expect(s2.layerOffsets[i]![1]).toBeCloseTo(s2.cameraY * (1 - f), 6);
  }
  expect(new Set(s2.layerOffsets.map((o) => o[0] - s2.cameraX)).size).toBe(3);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
