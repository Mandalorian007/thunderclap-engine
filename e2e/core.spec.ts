/**
 * The render-core page (harness/core.html, ws/core-retained): a block of boxes in one static,
 * GPU-culled draw set of the retained core. A held frame costs the same GPU calls at 1,500 and at
 * 6,000 meshes (one view write, one cull dispatch, one `executeBundles`), the bundle is recorded
 * once, and the device reports no error.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessCoreState } from '../harness/core-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessCoreState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `core.html?${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`core page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(10);
  return read();
}

function read(): Promise<HarnessCoreState> {
  return frame.evaluate(() => {
    const s = window.__harnessCore?.state;
    if (!s) throw new Error('window.__harnessCore missing');
    return JSON.parse(JSON.stringify(s)) as HarnessCoreState;
  });
}

test('a held scene costs the same GPU calls at 1,500 and 6,000 meshes', async ({
  page,
  wrapper,
}) => {
  const small = await open(page, wrapper, 'sets=1500');
  const large = await open(page, wrapper, 'sets=6000');
  for (const s of [small, large]) {
    expect(s.gpuErrors).toBe(0);
    // `boot` does not ask for multi-draw, so the set draws as one bundle.
    expect(s.bundles).toBe(1);
    expect(s.dispatches).toBe(1);
    expect(s.visible).toBeGreaterThan(0);
    expect(s.visible).toBeLessThanOrEqual(s.sets);
  }
  expect(small.sets).toBe(1500);
  expect(large.sets).toBe(6000);
  expect(large.calls).toBe(small.calls);
  expect(large.maxCalls).toBe(small.maxCalls);
  // The camera circles, but the bundle is recorded once for the one target.
  expect(large.bundleBuilds).toBe(1);
  expect(errors).toEqual([]);
});
