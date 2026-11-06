/**
 * The XR page (harness/xr.html) on every matrix row (ws/xr). Headless Chromium has no WebXR
 * device, so this proves the non-XR side of the seam: the page boots through `createGame` with
 * the `xr` option, `ctx.xr.supported()` resolves false, the "Enter VR" button stays disabled, the
 * scene renders on the page frame after frame, and nothing logs an error. Entering a session is
 * covered by the unit tests over the fake XR stack (src/core/game.test.ts,
 * src/platform/xr-surface.test.ts); a real headset is a manual check.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessXrState } from '../harness/xr-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}xr.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('xr.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`xr page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessXrState> {
  return frame.evaluate(() => {
    const s = window.__harnessXr?.state();
    if (!s) throw new Error('window.__harnessXr missing');
    return JSON.parse(JSON.stringify(s)) as HarnessXrState;
  });
}

test.describe('xr page', () => {
  test('boots, reports no XR support, keeps rendering on the page and logs nothing', async ({
    page,
    wrapper,
  }) => {
    await open(page, wrapper);
    const s = await read();
    expect(s.supported).toBe(false);
    expect(s.active).toBe(false);
    expect(s.enters).toBe(0);
    expect(s.lastError).toBeNull();
    await expect(frame.locator('#enter-vr')).toBeDisabled();
    // Frames keep coming on the page host.
    await expect.poll(async () => (await read()).frames).toBeGreaterThan(s.frames + 5);
    // enter() rejects cleanly rather than throwing into the page.
    const rejected = await frame.evaluate(() =>
      window.__harnessXr!.enter().then(
        () => 'resolved',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      ),
    );
    expect(rejected).toMatch(/WebXR/);
    expect((await read()).active).toBe(false);
    expect(errors).toEqual([]);
  });
});
