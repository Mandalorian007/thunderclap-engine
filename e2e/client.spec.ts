/**
 * Client mode, on every matrix row: `createGame` without a save and with `sim: false` (the
 * harness's `?mode=client`) renders, runs one update per rendered frame instead of fixed steps,
 * still reads input, hides and resumes, and never touches `host.storage`. A server-authoritative
 * client keeps nothing on the device (VISION pillar 6).
 */
import type { Frame } from '@playwright/test';
import { expect, openGameHarness, readGame, test } from './fixtures';

function setHidden(frame: Frame, hidden: boolean) {
  return frame.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('client mode renders at frame rate with no save and no storage access', async ({
  page,
  wrapper,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const frame = await openGameHarness(page, wrapper, 10, '?mode=client');
  const s = await readGame(frame);
  expect(s.mode).toBe('client');
  expect(s.saveNull).toBe(true);
  expect(s.frames).toBeGreaterThanOrEqual(10);
  expect(s.canvas.width).toBeGreaterThan(0);
  // No fixed steps: hooks.update never runs, hooks.frame runs once per rendered frame.
  expect(s.updates).toBe(0);
  expect(Math.abs(s.clientFrames - s.frames)).toBeLessThanOrEqual(1);

  // Input still reaches the client through the per-frame update.
  const canvas = frame.locator('canvas').first();
  const position = { x: 20, y: 20 };
  if (test.info().project.use.hasTouch) await canvas.tap({ position });
  else await canvas.click({ position });
  await expect.poll(async () => (await readGame(frame)).taps.length).toBe(1);

  // Hide (with its reason) and show work without a save to flush.
  await setHidden(frame, true);
  await expect.poll(async () => (await readGame(frame)).lastHide).toBe('hidden');
  expect((await readGame(frame)).loopRunning).toBe(false);
  await setHidden(frame, false);
  const before = (await readGame(frame)).frames;
  await expect.poll(async () => (await readGame(frame)).frames).toBeGreaterThan(before + 2);

  expect((await readGame(frame)).storageReads).toBe(0);
  expect(errors).toEqual([]);
});

test('the full mode reads storage through the host (the probe works)', async ({
  page,
  wrapper,
}) => {
  const frame = await openGameHarness(page, wrapper);
  const s = await readGame(frame);
  expect(s.mode).toBe('full');
  expect(s.saveNull).toBe(false);
  expect(s.updates).toBeGreaterThan(0);
  expect(s.clientFrames).toBe(0);
  expect(s.storageReads).toBeGreaterThan(0);
});
