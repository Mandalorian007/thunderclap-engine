/**
 * The water demo (harness/water.html) on every matrix row, sun parked with `?still` (E-017):
 *
 * - the page boots WebGPU, draws the basin, ramp, `Sky` and `Water` in two views and logs no
 *   error;
 * - depth fade: the shoreline probe (shallow water over the ramp) is closer to the shallow
 *   colour than the deep probe (over the basin floor) is;
 * - foam: the foam probe at the waterline is brighter than the water 30 px below it on screen;
 * - specular: the probe under the sun's reflection is far brighter than the deep water (the
 *   emissive target cannot be read from a screenshot, so the highlight itself is the evidence);
 * - waves: `height` (`waterHeight` at a fixed point) changes between two reads;
 * - `?hook=1` (ws/render-hooks): one view, the renderer's depth hook feeds the water the same
 *   frame (two scene passes) and the shoreline and foam probes still hold.
 *
 * Pixels are sampled from a screenshot (no golden image) and every assertion polls.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessWaterState, WaterProbe } from '../harness/water-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

/** The demo's `shallowColor` is the `Water` default, in linear light. */
const SHALLOW: Rgb = [0.1, 0.45, 0.45];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = 'still'): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}water.html?${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`water.html?${query}`)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`water demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessWaterState> {
  return frame.evaluate(() => {
    const s = window.__harnessWater?.state;
    if (!s) throw new Error('window.__harnessWater missing');
    return JSON.parse(JSON.stringify(s)) as HarnessWaterState;
  });
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Logical canvas px to page CSS px. */
async function toPage(p: WaterProbe, dy = 0): Promise<Pt> {
  const box = await canvasBox();
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + ((p.y + dy) / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around each page point, from a screenshot of the page. */
async function sample(page: Page, points: Pt[]): Promise<Rgb[]> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map((p) => {
        const d = g.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0] += d[i]! / 9;
          out[1] += d[i + 1]! / 9;
          out[2] += d[i + 2]! / 9;
        }
        return out;
      });
    },
    [png.toString('base64'), points] as const,
  );
}

const sum = (c: Rgb) => c[0] + c[1] + c[2];
/** sRGB-encode a linear colour to 0..255 for comparison with screenshot pixels. */
const srgb = (c: Rgb): Rgb =>
  c.map((v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) as Rgb;
/** Chroma-only distance: brightness is dropped so lighting and fog do not move the verdict. */
function hueDistance(a: Rgb, b: Rgb): number {
  const na = sum(a) || 1;
  const nb = sum(b) || 1;
  let d = 0;
  for (let i = 0; i < 3; i++) d += Math.abs(a[i]! / na - b[i]! / nb);
  return d;
}

/** The probes sampled from one screenshot. */
async function probes(page: Page) {
  const s = await read();
  const [shoreline, deep, foam, below, specular] = await sample(page, [
    await toPage(s.probes.shorelinePixel),
    await toPage(s.probes.deepPixel),
    await toPage(s.probes.foamPixel),
    await toPage(s.probes.foamPixel, 30),
    await toPage(s.probes.specularPixel),
  ]);
  return { shoreline: shoreline!, deep: deep!, foam: foam!, below: below!, specular: specular! };
}

test('boots, parks the sun and draws the scene in two views without errors', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.still).toBe(true);
  expect(s.stats.drawables).toBe(2);
  expect(s.stats.drawCalls).toBeGreaterThanOrEqual(4);
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(10);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the shoreline is nearer the shallow colour than the deep water is', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const shallow = srgb(SHALLOW);
  await expect
    .poll(async () => {
      const { shoreline, deep } = await probes(page);
      // Shallow water is greener and brighter; deep water is bluer, darker and, at a grazing
      // angle, greyed by the sky reflection.
      const ok =
        hueDistance(shoreline, shallow) + 0.05 < hueDistance(deep, shallow) &&
        sum(shoreline) > sum(deep);
      return `${ok} shoreline ${shoreline} deep ${deep}`;
    })
    .toMatch(/^true/);
  expect(errors).toEqual([]);
});

test('foam at the waterline is brighter than the water below it', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await expect
    .poll(async () => {
      const { foam, below } = await probes(page);
      return sum(foam) - sum(below);
    })
    .toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('the sun highlight is far brighter than the deep water', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await expect
    .poll(async () => {
      const { specular, deep } = await probes(page);
      return sum(specular) - sum(deep);
    })
    .toBeGreaterThan(150);
  expect(errors).toEqual([]);
});

test('the surface height moves with the wave clock', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const first = await read();
  expect(first.t).toBeGreaterThan(0);
  await expect.poll(async () => (await read()).t).toBeGreaterThan(first.t + 0.1);
  await expect.poll(async () => (await read()).height).not.toBe(first.height);
  const second = await read();
  // Displacement is 0.05 and the two default layers sum to at most 0.37 before it.
  expect(Math.abs(second.height)).toBeLessThan(0.05 * 0.37 + 1e-6);
  expect(errors).toEqual([]);
});

test('?hook=1: one view splits at the water, the depth hook keeps the shoreline and foam', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'still&hook=1');
  const s = await read();
  expect(s.depthHook).toBe(true);
  expect(s.stats.drawables).toBe(2);
  await expect.poll(async () => (await read()).stats.passes).toBe(2);
  const shallow = srgb(SHALLOW);
  await expect
    .poll(async () => {
      const { shoreline, deep, foam, below } = await probes(page);
      const ok =
        hueDistance(shoreline, shallow) + 0.05 < hueDistance(deep, shallow) &&
        sum(shoreline) > sum(deep) &&
        sum(foam) - sum(below) > 40;
      return `${ok} shoreline ${shoreline} deep ${deep} foam ${foam} below ${below}`;
    })
    .toMatch(/^true/);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
