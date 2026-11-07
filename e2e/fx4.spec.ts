/**
 * The fx-4 demo (harness/fx4.html) on every matrix row (ws/fx-4):
 *
 * - `?seed=N`: an effect seeded with N, stepped 120 fixed steps and frozen, hashes to the same
 *   picture on every load; another seed gives another picture;
 * - `?decalLag`: a box decal stamped on a moving cube reads this frame's depth through the
 *   renderer's hook, so no decal colour lands off the cube (`lagPx` 0); `&copy` takes the
 *   previous-frame fallback and the decal visibly trails.
 *
 * Every assertion on a moving value polls.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessFx4State } from '../harness/fx4-state';
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
  const path = `fx4.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${path}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(path)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`fx4 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessFx4State> {
  return frame.evaluate(() => {
    const s = window.__harnessFx4?.state;
    if (!s) throw new Error('window.__harnessFx4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessFx4State;
  });
}

/** The frozen picture's hash for `seed`, from a fresh load. */
async function hashOf(page: Page, wrapper: string, seed: number): Promise<HarnessFx4State> {
  await open(page, wrapper, `seed=${seed}`);
  await expect.poll(async () => (await read()).hash, { timeout: 20_000 }).not.toBeNull();
  const s = await read();
  expect(s.steps).toBe(120);
  expect(s.gpuErrors).toBe(0);
  return s;
}

test('a seeded effect draws the same frozen picture on every load; another seed differs', async ({
  page,
  wrapper,
}) => {
  const a = await hashOf(page, wrapper, 7);
  expect(a.lit).toBeGreaterThan(100);
  const b = await hashOf(page, wrapper, 7);
  expect(b.hash).toBe(a.hash);
  expect(b.lit).toBe(a.lit);
  const c = await hashOf(page, wrapper, 8);
  expect(c.hash).not.toBe(a.hash);
  expect(errors).toEqual([]);
});

test('a decal on a moving cube reads this frame depth: nothing lands off the cube', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'decalLag');
  await expect.poll(async () => (await read()).readbacks, { timeout: 20_000 }).toBeGreaterThan(30);
  const s = await read();
  expect(s.readsDepth).toBe(true);
  expect(s.decalMode).toBe('box');
  expect(s.decalMin).toBeGreaterThan(0);
  expect(s.lagMax).toBe(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the copy fallback reads the previous frame depth: the decal trails the cube', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'decalLag&copy');
  await expect.poll(async () => (await read()).lagMax, { timeout: 20_000 }).toBeGreaterThan(0);
  const s = await read();
  expect(s.readsDepth).toBe(false);
  expect(s.decalMode).toBe('box');
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
