/**
 * The core-decals page (harness/decals-core.html, ws/core-decals B6) on every matrix row: `Decals`
 * as a render-core drawable, drawn in both eyes of a stereo pair.
 *
 * - the page boots WebGPU, the decals join the core and nothing logs an error;
 * - both eyes execute the same bundles, and adding hundreds of decals records no new bundle
 *   (the count lives in an indirect draw);
 * - the decals draw in both eyes: taking the drawable off the core changes the picture at the
 *   ring on the ground and the splat folded over the pillar's corner, in each half (screenshots,
 *   no golden image); putting it back gives the same picture.
 */
import type { Frame, Page } from '@playwright/test';
import type {
  DecalsCoreProbe,
  DecalsCoreSet,
  HarnessDecalsCoreState,
} from '../harness/decals-core-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}decals-core.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('decals-core.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`core decals demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessDecalsCoreState> {
  return frame.evaluate(() => {
    const s = window.__harnessDecalsCore?.state;
    if (!s) throw new Error('window.__harnessDecalsCore missing');
    return JSON.parse(JSON.stringify(s)) as HarnessDecalsCoreState;
  });
}

async function set(o: DecalsCoreSet): Promise<void> {
  await frame.evaluate((o) => window.__harnessDecalsCore!.set(o), o);
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
async function around(p: DecalsCoreProbe, r: number): Promise<Box> {
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

test('decals join the core; both eyes execute the same bundles, held while decals are added', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(s.drawables).toBe(1);
  expect(s.live).toBe(3);
  const [l, r] = s.eyes;
  expect(l.bundles).toBeGreaterThanOrEqual(2);
  expect(r.bundles).toBe(l.bundles);
  expect(r.passes).toBe(l.passes);
  await set({ scatter: 400 });
  await frames(10);
  const t = await read();
  expect(t.live).toBe(403);
  expect(t.bundleBuilds).toBe(s.bundleBuilds);
  expect(t.eyes[1].bundles).toBe(t.eyes[0].bundles);
  expect(t.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the decals draw in both eyes, on the ground and folded over a corner', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const on = await shot(page);
  const s = await read();
  const probes = (k: 'floor' | 'corner') => Promise.all(s.eyes.map((e) => around(e.probes[k], 5)));
  await set({ shown: false });
  expect((await read()).drawables).toBe(0);
  const off = await shot(page);
  for (const k of ['floor', 'corner'] as const) {
    for (const d of await diff(page, on, off, await probes(k))) expect(d).toBeGreaterThan(8);
  }
  // Back on: the same picture (nothing moves on this page).
  await set({ shown: true });
  const again = await shot(page);
  for (const d of await diff(page, on, again, await halves())) expect(d).toBeLessThan(0.5);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
