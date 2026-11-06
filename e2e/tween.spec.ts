/**
 * The tween demo (harness/tween.html) on every matrix row: a grid of easing curves with a
 * sprite per ease moved by `Tweens.to`.
 *
 * - the page boots WebGPU and logs no error;
 * - every ease reaches exactly 1 at the end of its tween and `active` returns to 0 (the spring
 *   included, which ends on settle);
 * - `restart()` runs the grid again: `active` goes back up, then to 0, every sample at 1 again.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessTweenState } from '../harness/tween-state';
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
    await page.goto(`${HARNESS_URL}tween.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('tween.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`tween demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessTweenState> {
  return frame.evaluate(() => {
    const s = window.__harnessTween?.state;
    if (!s) throw new Error('window.__harnessTween missing');
    return JSON.parse(JSON.stringify(s)) as HarnessTweenState;
  });
}

/** Wait for the current run to land: every tween done, `active` back at 0. */
async function settled(): Promise<HarnessTweenState> {
  await expect
    .poll(async () => {
      const s = await read();
      return s.active === 0 && s.completed === s.eases.length;
    })
    .toBe(true);
  return read();
}

function expectAllAtOne(s: HarnessTweenState): void {
  expect(s.eases.length).toBeGreaterThanOrEqual(35);
  for (const name of s.eases) expect(s.samples[name], name).toBe(1);
}

test('boots the easing grid with no GPU error and a tween per ease', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.runs).toBe(1);
  expect(s.eases).toContain('spring');
  expect(s.eases).toContain('elasticInOut');
  expect(s.active + s.completed).toBe(s.eases.length);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('every ease reaches 1 at the end and active returns to 0', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await settled();
  expectAllAtOne(s);
  expect(s.elapsed).toBeGreaterThanOrEqual(1.5);
  expect(errors).toEqual([]);
});

test('restart() runs the grid again from the left', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await settled();
  await frame.evaluate(() => window.__harnessTween?.restart());
  await expect.poll(async () => (await read()).active).toBeGreaterThan(0);
  const mid = await read();
  expect(mid.runs).toBe(2);
  expect(mid.samples.linear).toBeLessThan(1);
  const s = await settled();
  expectAllAtOne(s);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
