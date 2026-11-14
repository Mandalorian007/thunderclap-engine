/**
 * The actors page (harness/actors.html, ws/actors): a crowd of rigid and skinned actors in one
 * pose pass and one bundle of indirect draws. A frame costs the same GPU calls at 100 and at
 * 1,000 actors, the bundle is recorded once, the GPU's skin matrices match `poseCpu`, the pose
 * pass draws actors at both LODs, and the device reports no error.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessActorsState } from '../harness/actors-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessActorsState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `actors.html?${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`actors page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(10);
  // Ask for a readback and wait for it, in one evaluate per poll.
  const checks = await frame.evaluate(() => {
    const h = window.__harnessActors!;
    h.check();
    return h.state.checks;
  });
  await expect.poll(async () => (await read()).checks).toBeGreaterThan(checks);
  return read();
}

function read(): Promise<HarnessActorsState> {
  return frame.evaluate(() => {
    const s = window.__harnessActors?.state;
    if (!s) throw new Error('window.__harnessActors missing');
    return JSON.parse(JSON.stringify(s)) as HarnessActorsState;
  });
}

test('a crowd costs the same GPU calls at 100 and 1,000 actors, posed as the CPU poses it', async ({
  page,
  wrapper,
}) => {
  const small = await open(page, wrapper, 'n=100');
  const large = await open(page, wrapper, 'n=1000');
  for (const s of [small, large]) {
    expect(s.gpuErrors).toBe(0);
    expect(s.bundles).toBe(1);
    expect(s.dispatched).toBe(s.actors);
    // The GPU pose of rigid and skinned slots matches the CPU mirror.
    expect(s.checkedSlots).toBe(16);
    expect(s.poseError).toBeGreaterThanOrEqual(0);
    expect(s.poseError).toBeLessThan(2e-3);
    expect(s.drawn).toBeGreaterThan(0);
    expect(s.drawn).toBeLessThanOrEqual(s.actors);
  }
  expect(small.actors).toBe(100);
  expect(large.actors).toBe(1000);
  expect(large.calls).toBe(small.calls);
  expect(large.maxCalls).toBe(small.maxCalls);
  // Near robots draw at LOD 0, the far rows at LOD 1, and skinned figures too.
  const [near, far, skinned] = large.drawnPerDraw;
  expect(near).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  expect(skinned).toBeGreaterThan(0);
  // One target: the bundle is recorded once, however the actors move.
  expect(large.bundleBuilds).toBe(1);
  expect(errors).toEqual([]);
});
