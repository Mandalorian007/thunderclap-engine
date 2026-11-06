/**
 * The assets demo (harness/assets.html) on every matrix row: a 12-entry manifest loads through
 * `createBundle` from an in-memory `read` (no network), progress reaches 1 and `done` fires, every
 * kind decodes, one shared uri is read once, the packed atlas draws its sprites with the right
 * colour, `?fail=one` reports one error and still finishes, and `?cancel` stops below 1.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessAssetsState } from '../harness/assets-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}assets.html${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`assets.html${query}`)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`assets demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessAssetsState> {
  return frame.evaluate(() => {
    const s = window.__harnessAssets?.state;
    if (!s) throw new Error('window.__harnessAssets missing');
    return JSON.parse(JSON.stringify(s)) as HarnessAssetsState;
  });
}

async function settled(): Promise<HarnessAssetsState> {
  await expect.poll(async () => (await read()).settled).toBe(true);
  return read();
}

/** Logical canvas px to page CSS px. */
async function toPage(p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around a page point, from a screenshot. */
async function sample(page: Page, p: { x: number; y: number }): Promise<[number, number, number]> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pt]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(Math.round(pt.x) - 1, Math.round(pt.y) - 1, 3, 3).data;
      const out: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        out[0] += d[i]! / 9;
        out[1] += d[i + 1]! / 9;
        out[2] += d[i + 2]! / 9;
      }
      return out;
    },
    [png.toString('base64'), p] as const,
  );
}

test('loads every kind: progress reaches 1, done fires, the atlas sprite has its colour', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await settled();
  expect(s.loadError).toBeNull();
  expect(s.errors).toEqual([]);
  expect(s.progress).toMatchObject({ loaded: 12, failed: 0, total: 12, fraction: 1 });
  expect(s.progress.bytes).toBeGreaterThan(0);
  expect(s.progress.bytesTotal).toBe(s.progress.bytes);
  expect(s.done).toBe(true);
  expect([...s.loaded].sort()).toEqual(
    [
      'blip',
      'config',
      'copy',
      'credits',
      'icon',
      'raw',
      'scene',
      'sprites',
      'tex',
      'tex2',
      'tex3',
      'tiles',
    ].sort(),
  );
  // 12 distinct uris behind 12 entries and 6 atlas images: config.json, red.png and green.png are
  // each shared by two entries and read once.
  expect(s.reads).toBe(12);
  expect(s.decoded.json).toEqual({ lives: 3, title: 'assets' });
  expect(s.decoded.text).toBe('made in the page');
  expect(s.decoded.bytes).toBe(8);
  expect(s.decoded.audioFrames).toBe(800);
  expect(s.decoded.gltfMeshes).toBe(2);
  expect(s.decoded.textureArrayLayers).toBe(2);
  expect(s.decoded.imageWidth).toBe(24);

  expect(s.rectCount).toBe(6);
  expect(s.atlasSize.width).toBeGreaterThanOrEqual(64);
  expect(s.atlasSize.width).toBeLessThanOrEqual(256);
  expect(Math.log2(s.atlasSize.width) % 1).toBe(0);
  expect(Math.log2(s.atlasSize.height) % 1).toBe(0);

  await expect.poll(async () => (await read()).frames).toBeGreaterThan(s.frames + 2);
  const rgb = await sample(page, await toPage(s.spritePixel));
  const [er, eg, eb] = s.spritePixel.color;
  expect(rgb[0], `sprite ${rgb}`).toBeGreaterThan(rgb[1] + 60);
  expect(rgb[0], `sprite ${rgb}`).toBeGreaterThan(rgb[2] + 60);
  expect(rgb[0], `sprite ${rgb}`).toBeGreaterThan(er * 0.6);
  expect(rgb[1], `sprite ${rgb}`).toBeLessThan(eg + 80);
  expect(rgb[2], `sprite ${rgb}`).toBeLessThan(eb + 80);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?fail=one reports one error against its key and still finishes', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?fail=one');
  const s = await settled();
  expect(s.loadError).toBeNull();
  expect(s.errors).toHaveLength(1);
  expect(s.errors[0]).toMatchObject({ key: 'credits', uri: 'credits.txt' });
  expect(s.errors[0]!.message).toMatch(/refused credits.txt/);
  expect(s.progress).toMatchObject({ loaded: 11, failed: 1, total: 12, fraction: 1 });
  expect(s.done).toBe(true);
  expect(s.decoded.text).toBeNull();
  expect(s.decoded.json).toEqual({ lives: 3, title: 'assets' });
  expect(s.rectCount).toBe(6);
  expect(errors).toEqual([]);
});

test('?cancel stops the load below 1 without errors or done', async ({ page, wrapper }) => {
  await open(page, wrapper, '?cancel');
  const s = await settled();
  expect(s.cancelled).toBe(true);
  expect(s.loadError).toBeNull();
  expect(s.errors).toEqual([]);
  expect(s.done).toBe(false);
  expect(s.progress.total).toBe(12);
  expect(s.progress.loaded).toBeGreaterThanOrEqual(1);
  expect(s.progress.loaded).toBeLessThan(12);
  expect(s.progress.fraction).toBeLessThan(1);
  // Reads in flight at the cancel finish; nothing new starts, so not every uri was read.
  expect(s.reads).toBeLessThan(12);
  expect(errors).toEqual([]);
});
