/**
 * Retargeting (ws/retarget) on every matrix row, against the retarget harness page
 * (harness/retarget.html, no WebGPU): a wave clip authored for one rig drives a second rig with
 * other names, bone lengths and rest frames through `retargetPose`.
 *
 * - every target joint found a source (`unmatched` is empty);
 * - both hands move (polled across frames per E-017, never read once);
 * - the target's forearm points where the source's does, on every read;
 * - parked, both hands stay still and still agree.
 */
import type { Frame, Page } from '@playwright/test';
import { type HarnessRetargetState, handDirectionsMatch } from '../harness/retarget-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

async function open(page: Page, wrapper: string): Promise<void> {
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}retarget.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('retarget.html')}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
}

function read(): Promise<HarnessRetargetState> {
  return frame.evaluate(() => {
    const s = window.__harnessRetarget?.state;
    if (!s) throw new Error('window.__harnessRetarget missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRetargetState;
  });
}

/** Wait for `n` more frames. */
async function frames(n: number): Promise<void> {
  const start = (await read()).ticks;
  await expect.poll(async () => (await read()).ticks).toBeGreaterThanOrEqual(start + n);
}

const DIRECTION = 1e-3;

test('the target rig follows the source clip', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const first = await read();
  expect(first.unmatched).toEqual([]);
  expect(first.moving).toBe(true);
  // Both hands move: poll until each has left where it started.
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(s.sourceTipY - first.sourceTipY) > 0.01 ? s.sourceTipY : first.sourceTipY;
    })
    .not.toBe(first.sourceTipY);
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(s.targetTipY - first.targetTipY) > 0.01 ? s.targetTipY : first.targetTipY;
    })
    .not.toBe(first.targetTipY);
  // Several reads across moving frames: the forearms agree on every one.
  let lastTime = -1;
  for (let i = 0; i < 5; i++) {
    await frames(3);
    const s = await read();
    expect(s.time).toBeGreaterThan(lastTime);
    expect(handDirectionsMatch(s, DIRECTION)).toBe(true);
    lastTime = s.time;
  }
});

test('parked, both hands hold still and still agree', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await frame.evaluate(() => window.__harnessRetarget?.setMoving(false));
  await frames(2);
  const a = await read();
  await frames(3);
  const b = await read();
  expect(a.moving).toBe(false);
  expect(b.time).toBe(a.time);
  expect(b.sourceTipY).toBe(a.sourceTipY);
  expect(b.targetTipY).toBe(a.targetTipY);
  expect(handDirectionsMatch(b, DIRECTION)).toBe(true);
  // The target's hand sits higher: its hips are 1.4 up and its arm bones are longer.
  expect(b.targetTipY).toBeGreaterThan(b.sourceTipY);
});
