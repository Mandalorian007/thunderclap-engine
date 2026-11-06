/**
 * The showroom demo (demos/showroom) on every matrix row, parked with `?still`:
 *
 * - it boots WebGPU, draws the 7×7 sphere grid, the floor and the emissive strip in the
 *   expected number of draw calls, reports GPU timing, and logs no error;
 * - the middle sphere's centre pixel is lit: neither black nor blown out (a screenshot sample,
 *   no golden image);
 * - keys 2..5 and 1 switch the post look (`__demo.look`), each look still renders the sphere,
 *   and the frame counter keeps moving;
 * - `?still` parks the three point lights; on the desktop rows `fps` stays above 20.
 *
 * The page is served by the harness vite server through its `/@fs/` route (fs.allow covers the
 * repo), so no second server or config change is needed. The wrapper row loads it top-level too.
 */
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { LookName, ShowroomProbe, ShowroomState } from '../../demos/showroom/state';
import { expect, test } from '../fixtures';
import { HARNESS_URL } from '../ports';

type Rgb = [number, number, number];

/** 51 instances (49 spheres, floor, strip) in three ordered draws: floor, spheres, strip. */
const EXPECTED_DRAW_CALLS = 3;
const EXPECTED_INSTANCES = 51;

const PAGE_URL = `${HARNESS_URL.replace(/\/$/, '')}/@fs${path.resolve('demos/showroom/index.html')}?still`;

const errors: string[] = [];

function read(page: Page): Promise<ShowroomState> {
  return page.evaluate(() => {
    const s = (window as unknown as { __demo?: ShowroomState }).__demo;
    if (!s) throw new Error('window.__demo missing');
    return JSON.parse(JSON.stringify(s)) as ShowroomState;
  });
}

async function open(page: Page): Promise<ShowroomState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(PAGE_URL);
  await expect
    .poll(async () => {
      const s = await read(page).catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`showroom: ${s.gpu}`);
      return s?.ready ? s.frame : -1;
    })
    .toBeGreaterThanOrEqual(10);
  return read(page);
}

/** Average colour of the 3×3 CSS px around a logical canvas point, from a page screenshot. */
async function sample(page: Page, probe: ShowroomProbe): Promise<Rgb> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read(page);
  const pt = {
    x: box.x + (probe.x / logical.width) * box.width,
    y: box.y + (probe.y / logical.height) * box.height,
  };
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, p]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
      const out: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        out[0] += d[i]! / 9;
        out[1] += d[i + 1]! / 9;
        out[2] += d[i + 2]! / 9;
      }
      return out;
    },
    [png.toString('base64'), pt] as const,
  );
}

/** Lit: every channel clearly above black, and not every channel near white. */
function expectLit(c: Rgb, what: string): void {
  expect(Math.min(...c), `${what}: ${c.map(Math.round)} is black`).toBeGreaterThan(24);
  expect(c[0] + c[1] + c[2], `${what}: ${c.map(Math.round)} is too dark`).toBeGreaterThan(180);
  expect(Math.min(...c), `${what}: ${c.map(Math.round)} is blown out`).toBeLessThan(240);
}

test('boots the showroom still: three draws, timing, a lit middle sphere, parked lights', async ({
  page,
}) => {
  const s = await open(page);
  expect(s.still).toBe(true);
  expect(s.grid).toEqual({ cols: 7, rows: 7 });
  expect(s.look).toBe('neutral');
  expect(s.drawCalls).toBe(EXPECTED_DRAW_CALLS);
  expect(s.stats.instances).toBe(EXPECTED_INSTANCES);
  expect(s.stats.shadowDraws).toBeGreaterThan(0);
  expect(s.gpuErrors).toBe(0);
  expect(s.lightPositions).toHaveLength(3);

  // GPU timing: a sample arrives once `timingEvery` frames have been read back.
  await expect.poll(async () => (await read(page)).gpuMs).not.toBeNull();
  const t = await read(page);
  expect(t.gpuMs).toBeGreaterThan(0);
  expect(['timestamp', 'queue']).toContain(t.gpuSource);

  // `?still`: the lights do not move between frames.
  await expect.poll(async () => (await read(page)).frame).toBeGreaterThan(t.frame + 5);
  expect((await read(page)).lightPositions).toEqual(s.lightPositions);

  expectLit(await sample(page, s.probe), 'middle sphere (neutral)');

  if (test.info().project.name.startsWith('desktop')) {
    await expect.poll(async () => (await read(page)).fps, { timeout: 15_000 }).toBeGreaterThan(20);
  }
  expect(errors).toEqual([]);
});

test('keys 1-5 switch the post look and every look still renders the sphere', async ({ page }) => {
  const s = await open(page);
  // The pixel is sampled (a screenshot, the slow part on a loaded matrix) on the two looks most
  // likely to break it: `off` (no tonemap, raw clipping) and the return to `neutral`.
  const steps: [string, LookName, boolean][] = [
    ['2', 'warm', false],
    ['3', 'rays', false],
    ['4', 'contrast', false],
    ['5', 'off', true],
    ['1', 'neutral', true],
  ];
  for (const [key, look, samplePixel] of steps) {
    const before = (await read(page)).frame;
    await page.keyboard.press(key);
    await expect.poll(async () => (await read(page)).look).toBe(look);
    // `?still` finishes the blend at once, so the next frames carry the new look.
    await expect.poll(async () => (await read(page)).frame).toBeGreaterThan(before + 2);
    const now = await read(page);
    expect(now.blending).toBe(false);
    expect(now.drawCalls).toBe(EXPECTED_DRAW_CALLS);
    expect(now.gpuErrors).toBe(0);
    if (samplePixel) expectLit(await sample(page, s.probe), `middle sphere (${look})`);
  }
  expect(errors).toEqual([]);
});
