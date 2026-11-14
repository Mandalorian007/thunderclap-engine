/**
 * The part-models demo (harness/models.html) on every matrix row: a toon windmill and a
 * walking machine built from part trees, compiled against the page's material table and
 * animated by state channels in the shader.
 *
 * - the page boots WebGPU with no error (the model WGSL and the game's toon shade function
 *   compile), and draws one call per unit in use;
 * - parked (`?still`), a frame writes no instance bytes;
 * - the tower and the walker are drawn over the clear colour;
 * - the sails turn in the shader: parking them at a quarter turn moves the cloth off a probe
 *   on the upright sail, and back at 0 it returns.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessModelsState, ModelsProbe } from '../harness/models-state';
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
    await page.goto(`${HARNESS_URL}models.html?still`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('models.html?still')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`models demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessModelsState> {
  return frame.evaluate(() => {
    const s = window.__harnessModels?.state;
    if (!s) throw new Error('window.__harnessModels missing');
    return JSON.parse(JSON.stringify(s)) as HarnessModelsState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: ModelsProbe): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** The average colour of the 5×5 CSS px around a page point, from a screenshot. */
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
      const n = d.length / 4;
      const avg: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        avg[0] += d[i]! / n;
        avg[1] += d[i + 1]! / n;
        avg[2] += d[i + 2]! / n;
      }
      return avg;
    },
    [png.toString('base64'), p] as const,
  );
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

test('boots with no GPU error and draws one call per unit', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.instances).toBe(s.units);
  expect(s.drawCalls).toBe(s.units);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('parked, a frame writes no instance bytes', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const a = await read();
  await frames(5);
  const b = await read();
  expect(b.instanceBytes).toBe(a.instanceBytes);
  expect(b.instanceBytes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the tower and the walker are drawn over the clear colour', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  const sky = await sample(page, await toPage(s.probes.sky));
  const tower = await sample(page, await toPage(s.probes.tower));
  const walker = await sample(page, await toPage(s.probes.walker));
  expect(diff(tower, sky)).toBeGreaterThan(30);
  expect(diff(walker, sky)).toBeGreaterThan(30);
  expect(errors).toEqual([]);
});

test('the sails turn in the shader from their channel', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const at = await toPage((await read()).probes.sail);
  const up = await sample(page, at);
  await frame.evaluate(() => window.__harnessModels?.setSpin(Math.PI / 4));
  await expect
    .poll(async () => diff(await sample(page, at), up), {
      message: 'the cloth moved off the probe',
    })
    .toBeGreaterThan(30);
  await frame.evaluate(() => window.__harnessModels?.setSpin(0));
  await expect
    .poll(async () => diff(await sample(page, at), up), { message: 'the cloth came back' })
    .toBeLessThanOrEqual(6);
  expect(errors).toEqual([]);
});
