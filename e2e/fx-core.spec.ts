/**
 * The core-effects page (harness/fx-core.html, ws/core-effects B5) on every matrix row: water,
 * particles and weather as render-core drawables, drawn in both eyes of a stereo pair.
 *
 * - the page boots WebGPU, the three effects join the core and nothing logs an error;
 * - both eyes execute the same bundles (one bundle a pass for the pair), and a running frame
 *   records no new bundle while particles spawn and weather falls;
 * - each effect draws in both eyes: with everything paused, removing it changes the picture at
 *   its probe in each half (screenshots, no golden image);
 * - the weather demo runs two configs: the dust storm and snow draw different pictures in each
 *   half, each with live instances.
 */
import type { Frame, Page } from '@playwright/test';
import type { FxCoreProbe, FxCoreSet, HarnessFxCoreState } from '../harness/fx-core-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}fx-core.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('fx-core.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`core effects demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessFxCoreState> {
  return frame.evaluate(() => {
    const s = window.__harnessFxCore?.state;
    if (!s) throw new Error('window.__harnessFxCore missing');
    return JSON.parse(JSON.stringify(s)) as HarnessFxCoreState;
  });
}

async function set(o: FxCoreSet): Promise<void> {
  await frame.evaluate((o) => window.__harnessFxCore!.set(o), o);
  await frames(4);
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function canvasBox(): Promise<Box> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** A square of `r` CSS px around a probe (unit-square canvas fractions), in page px. */
async function around(p: FxCoreProbe, r: number): Promise<Box> {
  const c = await canvasBox();
  return { x: c.x + p.x * c.width - r, y: c.y + p.y * c.height - r, width: 2 * r, height: 2 * r };
}

/** The left and right halves of the canvas, in page px. */
async function halves(): Promise<[Box, Box]> {
  const c = await canvasBox();
  const w = c.width / 2;
  return [
    { x: c.x, y: c.y, width: w, height: c.height },
    { x: c.x + w, y: c.y, width: w, height: c.height },
  ];
}

const shot = async (page: Page) =>
  (await page.screenshot({ scale: 'css', animations: 'disabled' })).toString('base64');

/** Mean absolute channel difference (0..255) of two screenshots inside each box. */
async function diff(page: Page, a: string, b: string, boxes: Box[]): Promise<number[]> {
  return page.evaluate(
    async ([a, b, boxes]) => {
      const load = async (b64: string) => {
        const bmp = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${b64}`)).blob(),
        );
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return g;
      };
      const ga = await load(a);
      const gb = await load(b);
      return boxes.map((r) => {
        const x = Math.round(r.x);
        const y = Math.round(r.y);
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        const da = ga.getImageData(x, y, w, h).data;
        const db = gb.getImageData(x, y, w, h).data;
        let sum = 0;
        for (let i = 0; i < da.length; i += 4) {
          sum += Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!);
          sum += Math.abs(da[i + 2]! - db[i + 2]!);
        }
        return sum / ((da.length / 4) * 3);
      });
    },
    [a, b, boxes] as const,
  );
}

test('three effects join the core; both eyes execute the same bundles, held across frames', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await expect.poll(async () => (await read()).particlesAlive).toBeGreaterThan(0);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(s.drawables).toBe(3);
  expect(s.weather.config).toBe('dust');
  expect(s.weather.instances).toBeGreaterThan(0);
  const [l, r] = s.eyes;
  expect(l.bundles).toBeGreaterThanOrEqual(2);
  expect(r.bundles).toBe(l.bundles);
  expect(r.passes).toBe(l.passes);
  // Particles spawn, weather falls and water moves without a new recording.
  await frames(20);
  expect((await read()).bundleBuilds).toBe(s.bundleBuilds);
  expect(errors).toEqual([]);
});

test('water, particles and weather each draw in both eyes', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await expect.poll(async () => (await read()).particlesAlive).toBeGreaterThan(100);
  await set({ paused: true });
  const all = await shot(page);
  const s = await read();
  const probes = (k: 'water' | 'fountain') =>
    Promise.all(s.eyes.map((e) => around(e.probes[k], 6)));

  await set({ water: false });
  const noWater = await shot(page);
  for (const d of await diff(page, all, noWater, await probes('water'))) {
    expect(d).toBeGreaterThan(6);
  }
  await set({ water: true, particles: false });
  const noParticles = await shot(page);
  for (const d of await diff(page, all, noParticles, await probes('fountain'))) {
    expect(d).toBeGreaterThan(4);
  }
  await set({ particles: true, weather: 'off' });
  const noWeather = await shot(page);
  for (const d of await diff(page, all, noWeather, await halves())) {
    expect(d).toBeGreaterThan(0.5);
  }
  // Back on: the same picture (nothing moved while paused).
  await set({ weather: 'dust' });
  const again = await shot(page);
  for (const d of await diff(page, all, again, await halves())) expect(d).toBeLessThan(0.5);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the weather demo runs two configs: a dust storm and snow', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await set({ paused: true, water: false, particles: false });
  const dust = await shot(page);
  const d = await read();
  expect(d.weather).toMatchObject({ config: 'dust', layers: 2 });
  expect(d.weather.instances).toBeGreaterThan(0);
  await set({ weather: 'snow' });
  const snow = await shot(page);
  const s = await read();
  expect(s.weather).toMatchObject({ config: 'snow', layers: 1 });
  expect(s.weather.instances).toBeGreaterThan(0);
  for (const v of await diff(page, dust, snow, await halves())) expect(v).toBeGreaterThan(0.5);
  await set({ weather: 'off' });
  expect((await read()).weather.instances).toBe(0);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
