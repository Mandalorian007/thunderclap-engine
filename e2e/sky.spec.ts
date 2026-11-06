/**
 * The sky demo (harness/sky.html) on every matrix row, parked at noon with `?still` (E-017):
 *
 * - the page boots WebGPU, draws the `Sky` drawable under the ground and blocks and logs no
 *   error;
 * - the dome: the zenith probe is bluer than the horizon probe (the horizon is hazed towards
 *   the fog colour), and the sun disc is brighter than the zenith;
 * - depth: the ground probe still shows ground (the sky, drawn as a fullscreen triangle, did not
 *   paint over geometry).
 *
 * Pixels are sampled from a screenshot (no golden image) and every assertion polls.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessSkyState, SkyProbe } from '../harness/sky-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
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
    await page.goto(`${HARNESS_URL}sky.html?still`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('sky.html?still')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`sky demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessSkyState> {
  return frame.evaluate(() => {
    const s = window.__harnessSky?.state;
    if (!s) throw new Error('window.__harnessSky missing');
    return JSON.parse(JSON.stringify(s)) as HarnessSkyState;
  });
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Logical canvas px to page CSS px. */
async function toPage(p: SkyProbe): Promise<Pt> {
  const box = await canvasBox();
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
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

/** The four probes sampled from one screenshot. */
async function probes(page: Page) {
  const s = await read();
  const [zenith, horizon, sunDisc, ground] = await sample(page, [
    await toPage(s.probes.zenith),
    await toPage(s.probes.horizon),
    await toPage(s.probes.sunDisc),
    await toPage(s.probes.ground),
  ]);
  return { zenith: zenith!, horizon: horizon!, sunDisc: sunDisc!, ground: ground! };
}

test('boots, parks the sun at noon and draws the sky without errors', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.still).toBe(true);
  expect(s.sunElevation).toBeCloseTo((25 * Math.PI) / 180, 3);
  expect(s.stats.drawables).toBe(1);
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(10);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the zenith is bluer than the horizon and the sun disc brighter than the zenith', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await expect
    .poll(async () => {
      const p = await probes(page);
      return p.zenith[2] - p.zenith[0] - (p.horizon[2] - p.horizon[0]);
    })
    .toBeGreaterThan(20);
  await expect
    .poll(async () => {
      const p = await probes(page);
      return sum(p.sunDisc) - sum(p.zenith);
    })
    .toBeGreaterThan(60);
  expect(errors).toEqual([]);
});

test('the ground keeps its colour under the sky', async ({ page, wrapper }) => {
  await open(page, wrapper);
  // The ground probe is lit ground, not sky: far less blue than the hazed horizon, and not dark.
  await expect
    .poll(async () => {
      const { ground, horizon } = await probes(page);
      const blue = (c: Rgb) => c[2] - (c[0] + c[1]) / 2;
      const ok = ground[1] > ground[2] + 8 && sum(ground) > 120 && blue(horizon) > blue(ground) + 6;
      return `${ok} ground ${ground} horizon ${horizon}`;
    })
    .toMatch(/^true/);
  expect(errors).toEqual([]);
});
