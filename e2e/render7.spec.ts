/**
 * The render 7 page (harness/render7.html, ws/render-7) on every matrix row. The page churns
 * one `InstanceList` on a `MeshLod` every frame (a swap-remove and an append), so rocks change
 * slots without moving. Every number is read from the page's published state and polled
 * (E-017); counters are reset in the same evaluate that reads the frame counter.
 *
 * - lod-keys: with keys every rock keeps its level through the churn (the page counts level
 *   changes per rock: none); `&unkeyed` hands rocks each other's levels;
 * - instanced-velocity: the sliding rocks write velocity and the standing ones write none,
 *   though the churn moves them between slots; `&unkeyed` gives standing rocks a moved one's
 *   history; `&still` parks the sliders and every rock writes zero.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessRender7State } from '../harness/render7-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, flag: string): Promise<HarnessRender7State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `render7.html?${flag}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`render7: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessRender7State> {
  return frame.evaluate(() => {
    const s = window.__harnessRender7?.state;
    if (!s) throw new Error('window.__harnessRender7 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRender7State;
  });
}

/** Zero the page's counters; the frame counter at that moment, read in the same evaluate. */
function reset(): Promise<number> {
  return frame.evaluate(() => {
    const api = window.__harnessRender7;
    if (!api) throw new Error('window.__harnessRender7 missing');
    return api.reset();
  });
}

test('lod-keys: with keys no rock changes level through the churn', async ({ page, wrapper }) => {
  const s0 = await open(page, wrapper, 'lod-keys');
  expect(s0.mode).toBe('lod-keys');
  expect(s0.keyed).toBe(true);
  const from = await reset();
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(from + 30);
  const s = await read();
  expect(s.churns).toBeGreaterThanOrEqual(20);
  expect(s.levelChanges).toBe(0);
  // Even rocks hold level 0 inside the band; odd rocks, arriving from level 2, sit at 1.
  // (`lodCounts` keeps its level-2 slot from the first frame, at 0 now.)
  expect(s.lodCounts).toEqual([8, 8, 0]);
  expect(s.drawCalls).toBe(2);
  // Another 60 churned frames, counted by the page itself: still no rock changed level. (No
  // pixel equality across frames: the captured canvas differs by ±1 between presents.)
  await expect.poll(async () => (await read()).churns).toBeGreaterThanOrEqual(s.churns + 60);
  const t = await read();
  expect(t.levelChanges).toBe(0);
  expect(t.lodCounts).toEqual([8, 8, 0]);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('lod-keys&unkeyed: without keys the churn hands rocks each other levels', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'lod-keys&unkeyed');
  expect(s0.keyed).toBe(false);
  await reset();
  await expect.poll(async () => (await read()).levelChanges).toBeGreaterThan(0);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('instanced-velocity: sliding rocks write velocity, standing rocks none, through the churn', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'instanced-velocity');
  expect(s0.mode).toBe('instanced-velocity');
  await reset();
  await expect.poll(async () => (await read()).readbacks).toBeGreaterThanOrEqual(10);
  await expect.poll(async () => (await read()).velocityMoving).toBeGreaterThan(1e-3);
  const s = await read();
  expect(s.churns).toBeGreaterThanOrEqual(10);
  expect(s.velocityStaticPeak).toBeLessThan(1e-4);
  expect(s.velocityStatic).toBeLessThan(1e-4);
  // Two distances, two LOD levels, one list: one draw per level.
  expect(s.lodCounts).toEqual([8, 8]);
  expect(s.instances).toBe(16);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('instanced-velocity&unkeyed: standing rocks take a moved rock history', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'instanced-velocity&unkeyed');
  expect(s0.keyed).toBe(false);
  await reset();
  await expect.poll(async () => (await read()).velocityStaticPeak).toBeGreaterThan(1e-3);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('instanced-velocity&still: parked rocks write zero velocity', async ({ page, wrapper }) => {
  const s0 = await open(page, wrapper, 'instanced-velocity&still');
  expect(s0.still).toBe(true);
  await reset();
  await expect.poll(async () => (await read()).readbacks).toBeGreaterThanOrEqual(10);
  const s = await read();
  expect(s.velocityMoving).toBeLessThan(1e-4);
  expect(s.velocityStaticPeak).toBeLessThan(1e-4);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
