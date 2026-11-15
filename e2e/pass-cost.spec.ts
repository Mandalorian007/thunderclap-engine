/**
 * The pass-cost page (harness/pass-cost.html, ws/pass-cost): a 3D frame on the retained core
 * (opaque boxes, sky, a water pass, an fx pass with nothing to draw, post with TAA and bloom),
 * drawn once as before ws/pass-cost and once with what it added (`?cost=1`: the water pass
 * attaches no extra target, the empty fx pass opens no render pass, TAA writes one output).
 * The second frame begins fewer passes and attachments, and both draw without a GPU error.
 * `TC_PASS_COST=1` logs each mode's passes, attachments and GPU time (median and p95).
 */
import type { Page } from '@playwright/test';
import type { HarnessPassCostState } from '../harness/pass-cost-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

async function run(page: Page, query: string): Promise<HarnessPassCostState> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${HARNESS_URL}pass-cost.html?${query}`);
  const read = () => page.evaluate(() => window.__harnessPassCost?.state ?? null);
  await expect
    .poll(
      async () => {
        const s = await read();
        if (s?.ready && s.gpu !== 'ok') throw new Error(`pass-cost page: ${s.gpu}`);
        if (!s?.ready) return false;
        return s.frames >= 240 && (!s.timestamps || s.gpuSamples >= 120);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const s = (await read())!;
  expect(errors).toEqual([]);
  expect(s.gpuErrors).toBe(0);
  if (process.env.TC_PASS_COST === '1') {
    console.log(`pass-cost ${query || 'base'}: ${JSON.stringify(s)}`);
  }
  return s;
}

test('ws/pass-cost: fewer passes and attachments, no GPU error', async ({ page }) => {
  test.setTimeout(180_000);
  const before = await run(page, '');
  const kept = await run(page, 'cost=1&taa1=0');
  const after = await run(page, 'cost=1');
  expect(before.labels).toContain('core fx');
  expect(kept.labels).not.toContain('core fx');
  expect(after.labels).not.toContain('core fx');
  expect(kept.passes).toBe(before.passes - 1);
  expect(after.passes).toBe(before.passes - 1);
  // Water: its three extra targets; fx: its colour (the pass is gone).
  expect(kept.attachments).toBe(before.attachments - 4);
  // And TAA's aux output.
  expect(after.attachments).toBe(before.attachments - 5);
});
