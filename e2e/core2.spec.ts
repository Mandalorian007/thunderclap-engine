/**
 * The core-2 page (harness/core2.html) on every matrix row: the deterministic utilities in
 * `@thunderclap-engine/engine/core`.
 *
 * - `?random`: the first 100 draws of `createRandom('core2')` hash to the golden pinned in
 *   random.test.ts (the same sequence in every browser), and 2000 points are drawn;
 * - `?noise`: the fbm field hashes to the golden pinned in noise.test.ts and spans a sane range;
 * - `?timer`: the scheduler fires on the loop's clock and the cooldown cycles ready / not ready;
 *   `?still` pauses it;
 * - `?preload`: a pushed scene's 1 s preload runs under the loading screen while the old scene
 *   keeps updating, then the push resolves with the new scene on top and the loading screen closes.
 */
import type { Frame, Page } from '@playwright/test';
import {
  CORE2_NOISE_CHECKSUM,
  CORE2_RANDOM_CHECKSUM,
  type HarnessCore2State,
} from '../harness/core2-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `core2.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`core2 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessCore2State> {
  return frame.evaluate(() => {
    const s = window.__harnessCore2?.state;
    if (!s) throw new Error('window.__harnessCore2 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessCore2State;
  });
}

test('random: the seeded sequence matches the golden and the scatter is drawn', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'random');
  const s = await read();
  expect(s.mode).toBe('random');
  expect(s.checksum).toBe(CORE2_RANDOM_CHECKSUM);
  expect(s.forkChecksum).not.toBe(s.checksum);
  expect(s.forkChecksum).toBeGreaterThan(0);
  expect(s.points).toBe(2000);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('noise: the fbm field matches the golden and spans a sane range', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'noise');
  const s = await read();
  expect(s.checksum).toBe(CORE2_NOISE_CHECKSUM);
  expect(s.cells).toBe(128 * 72);
  expect(s.min).toBeGreaterThanOrEqual(-1);
  expect(s.max).toBeLessThanOrEqual(1);
  expect(s.max - s.min).toBeGreaterThan(0.5);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('timer: the scheduler fires and the cooldown cycles', async ({ page, wrapper }) => {
  await open(page, wrapper, 'timer');
  // The auto-use every 2 s puts the cooldown on for 1.2 s; the page latches each use and each
  // return to ready, so the poll does not have to land inside the 0.8 s ready window.
  await expect
    .poll(async () => (await read()).readyTransitions, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  const s = await read();
  expect(s.cooldownUses).toBeGreaterThanOrEqual(1);
  expect(s.fires).toBeGreaterThan(8);
  expect(s.timerTime).toBeGreaterThan(3.2 - 1e-6);
  // Reset, then use() from the page succeeds once and the cooldown refuses the second.
  const used = await frame.evaluate(() => {
    const api = window.__harnessCore2;
    if (!api) throw new Error('window.__harnessCore2 missing');
    api.resetCooldown();
    return [api.useCooldown(), api.useCooldown()];
  });
  expect(used).toEqual([true, false]);
  expect(errors).toEqual([]);
});

test('timer ?still: the paused scheduler fires nothing', async ({ page, wrapper }) => {
  await open(page, wrapper, 'timer&still');
  await expect.poll(async () => (await read()).frames, { timeout: 10_000 }).toBeGreaterThan(30);
  const s = await read();
  expect(s.still).toBe(true);
  expect(s.fires).toBe(0);
  expect(s.timerTime).toBe(0);
  expect(s.cooldownReady).toBe(true);
  expect(errors).toEqual([]);
});

test('preload: the old scene runs under the loading screen, then the push resolves', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'preload');
  await expect.poll(async () => (await read()).phase, { timeout: 15_000 }).toBe('done');
  const s = await read();
  expect(s.loadingShown).toBe(true);
  expect(s.pushResolved).toBe(true);
  expect(s.preloadSeconds).toBeGreaterThanOrEqual(1 - 1e-6);
  expect(s.preloadSeconds).toBeLessThan(1.1);
  // ~60 updates at 60 Hz; a slow row still runs several.
  expect(s.oldSceneFrames).toBeGreaterThan(5);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
