/**
 * The voxel-world page (harness/voxel-world.html, ws/voxel-draw, scene S4): a streamed block
 * world drawn through `createVoxelWorld`. It settles at radius 8 and 16, a settled frame costs
 * the same GPU calls at both (three cull dispatches, three bundles), cave culling hides some
 * sections, no engine frame while streaming takes over 50 ms, and the device reports no error.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessVoxelWorldState } from '../harness/voxel-world-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessVoxelWorldState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `voxel-world.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  let settledAt = -1;
  await expect
    .poll(
      async () => {
        const s = await read().catch(() => null);
        if (s?.ready && s.gpu !== 'ok') throw new Error(`voxel-world page: ${s.gpu}`);
        if (s?.settled && settledAt < 0) settledAt = s.frames;
        return s?.settled ? s.frames - settledAt : -1;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(10);
  return read();
}

function read(): Promise<HarnessVoxelWorldState> {
  return frame.evaluate(() => {
    const s = window.__harnessVoxelWorld?.state;
    if (!s) throw new Error('window.__harnessVoxelWorld missing');
    return JSON.parse(JSON.stringify(s)) as HarnessVoxelWorldState;
  });
}

test('a streamed world settles at radius 8 and 16 with flat GPU calls and no hitch', async ({
  page,
  wrapper,
}, info) => {
  test.setTimeout(150_000);
  const small = await open(page, wrapper, 'radius=8');
  const large = await open(page, wrapper, 'radius=16');
  for (const s of [small, large]) {
    expect(s.gpuErrors).toBe(0);
    expect(s.drawn).toBeGreaterThan(0);
    expect(s.hidden).toBeGreaterThan(0);
    expect(s.opaqueQuads).toBeGreaterThan(0);
    expect(s.foliageQuads).toBeGreaterThan(0);
    expect(s.liquidQuads).toBeGreaterThan(0);
    // `boot` does not ask for multi-draw: each set is one bundle after one cull dispatch.
    expect(s.bundles).toBe(3);
    expect(s.dispatches).toBe(3);
    expect(s.maxStreamFrameMs).toBeLessThan(50);
  }
  expect(large.sections).toBeGreaterThan(small.sections * 3);
  expect(large.heldCalls).toBe(small.heldCalls);
  info.annotations.push({
    type: 'S4',
    description: `calls r8 ${small.heldCalls}, r16 ${large.heldCalls}; max stream frame r8 ${small.maxStreamFrameMs.toFixed(1)} ms, r16 ${large.maxStreamFrameMs.toFixed(1)} ms; settle r16 ${large.settleMs} ms; drawn ${large.drawn} hidden ${large.hidden}`,
  });
  console.log(`[S4] ${info.annotations.at(-1)?.description}`);
  expect(errors).toEqual([]);
});
