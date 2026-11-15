/**
 * The cull readback page (harness/cull.html, ws/cull-fix B18) on the matrix and `webkit-ipad`:
 * what the GPU actually drew, read back. A GPU-culled core (indirect draws from recorded
 * bundles, with a mirror set in a pass that never runs) and a CPU-culled core (direct draws)
 * draw the same streamed, reversed-Z, camera-relative scene of id-coloured sections; the
 * readbacks name the same sections and match pixel for pixel, off-axis and near-plane sections
 * included. Judged by the readback alone, not by time.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessCullState } from '../harness/cull-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

async function open(
  page: Page,
  wrapper: string,
  query: string,
): Promise<{ frame: Frame; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `cull.html${query}`;
  let frame: Frame;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  return { frame, errors };
}

function read(frame: Frame): Promise<HarnessCullState | null> {
  return frame.evaluate(() => {
    const s = window.__harnessCull;
    return s ? (JSON.parse(JSON.stringify(s)) as HarnessCullState) : null;
  });
}

test('indirect draws the same sections and pixels as direct, a never-drawn mirror set beside it', async ({
  page,
  wrapper,
}) => {
  const { frame, errors } = await open(page, wrapper, '');
  let s: HarnessCullState | null = null;
  await expect
    .poll(
      async () => {
        s = await read(frame).catch(() => null);
        if (s?.ready && s.gpu !== 'ok') throw new Error(`cull page: ${s.gpu}`);
        return s?.ready ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const st = s as unknown as HarnessCullState;
  // The scene reaches every kind of section (else the comparison proves little).
  expect(st.drawnOffAxis).toBeGreaterThan(20);
  expect(st.drawnNear).toBeGreaterThan(4);
  expect(st.drawnAhead).toBeGreaterThan(40);
  expect(st.mirror).toBe(true);
  expect({ missing: st.missing, extra: st.extra }).toEqual({ missing: [], extra: [] });
  expect(st.indirectIds).toBe(st.directIds);
  expect(st.diffPixels).toBe(0);
  expect(st.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
