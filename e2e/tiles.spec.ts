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

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}tiles.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('tiles.html')}`);
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

/** Page CSS px of the centre of tile `(col, row)`. */
async function tileCentre(col: number, row: number): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical, grid } = await read();
  const x = (col + 0.5) * grid.tileW;
  const y = (row + 0.5) * grid.tileH;
  return {
    x: box.x + (x / logical.width) * box.width,
    y: box.y + (y / logical.height) * box.height,
  };
}

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
