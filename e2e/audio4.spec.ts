/**
 * ws/audio-4 on every top-level matrix row, against harness/audio4.html (no WebGPU): the
 * occlusion probe closes the emitter's lowpass behind a wall and opens it in the clear, a
 * passing emitter's Doppler multiplier rises then falls, sprite clips play from one buffer,
 * and a streamed track drives the beat grid from its element clock. The itch-iframe row is
 * skipped as in music.spec; every moving value is polled (E-017).
 */
import type { Page } from '@playwright/test';
import type { HarnessAudio4State } from '../harness/audio4-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'audio-4 harness runs top-level only');
  const query = /\?[a-z&]+/.exec(test.info().title)?.[0] ?? '';
  await page.goto(`${HARNESS_URL}audio4.html${query}`);
  await expect.poll(() => read(page).then((s) => s.ready), { timeout: 20_000 }).toBe(true);
  const root = page.locator('#root');
  if (test.info().project.use.hasTouch) await root.tap({ position: { x: 8, y: 8 } });
  else await root.click({ position: { x: 8, y: 8 } });
  await expect.poll(() => read(page).then((s) => s.audioState)).toBe('running');
});

function read(page: Page): Promise<HarnessAudio4State> {
  return page.evaluate(() => {
    const s = window.__harnessAudio4?.state;
    if (!s) throw new Error('window.__harnessAudio4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessAudio4State;
  });
}

const playClip = (page: Page, name: string) =>
  page.evaluate((n) => window.__harnessAudio4?.playClip(n), name);
const setStill = (page: Page, still: boolean) =>
  page.evaluate((s) => window.__harnessAudio4?.setStill(s), still);
const background = (page: Page, hidden: boolean) =>
  page.evaluate((h) => window.__harnessAudio4?.background(h), hidden);

test('?occlude&still parks the listener behind the wall: the probe closes the lowpass', async ({
  page,
}) => {
  await expect.poll(() => read(page).then((s) => s.occlusion)).toBe(1);
  const s = await read(page);
  expect(s.still).toBe(true);
  expect(s.cutoff).toBeCloseTo(600, 0);
  expect(s.voices).toBe(1);
  // Released, the orbit comes round into the clear and the filter opens.
  await setStill(page, false);
  await expect.poll(() => read(page).then((s) => s.occlusion), { timeout: 15_000 }).toBe(0);
  expect((await read(page)).cutoff).toBeCloseTo(20000, 0);
});

test('?occlude orbits: the emitter is occluded and clear in turn', async ({ page }) => {
  await expect.poll(() => read(page).then((s) => s.occlusion), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => read(page).then((s) => s.occlusion), { timeout: 15_000 }).toBe(0);
  const s = await read(page);
  expect(s.frames).toBeGreaterThan(0);
  expect(Math.abs(s.listener[0]!) <= 3 && Math.abs(s.listener[2]!) <= 3).toBe(true);
});

test('?doppler: an emitter passing at 20 m/s raises the rate on approach and lowers it after', async ({
  page,
}) => {
  await expect
    .poll(() => read(page).then((s) => s.rate), { timeout: 15_000 })
    .toBeGreaterThan(1.01);
  await expect.poll(() => read(page).then((s) => s.rate), { timeout: 15_000 }).toBeLessThan(0.99);
  // Parked, the rate settles back to 1.
  await setStill(page, true);
  await expect.poll(() => read(page).then((s) => Math.abs(s.rate - 1))).toBeLessThan(1e-3);
});

test('?sprites: a clip plays as one sfx voice and ends on its own', async ({ page }) => {
  expect((await read(page)).voices).toBe(0);
  await playClip(page, 'two');
  await expect.poll(() => read(page).then((s) => s.lastClip)).toBe('two');
  await expect.poll(() => read(page).then((s) => s.voices)).toBe(1);
  // A 0.4 s clip: gone well inside the poll timeout.
  await expect.poll(() => read(page).then((s) => s.voices)).toBe(0);
  await playClip(page, 'one');
  await playClip(page, 'three');
  await expect.poll(() => read(page).then((s) => s.voices)).toBe(2);
  expect((await read(page)).lastClip).toBe('three');
});

test('?stream: the track streams through a media element and the grid advances from its clock', async ({
  page,
}) => {
  await expect.poll(() => read(page).then((s) => s.streaming), { timeout: 15_000 }).toBe(true);
  const s0 = await read(page);
  await expect
    .poll(() => read(page).then((s) => s.grid.totalBeats), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(s0.grid.totalBeats + 3);
  const s1 = await read(page);
  expect(s1.grid.bar * 4 + s1.grid.beat).toBe(s1.grid.totalBeats);
  // background(true) suspends the context; background(false) brings it back, nothing paused.
  await background(page, true);
  await expect.poll(() => read(page).then((s) => s.audioState)).toBe('suspended');
  expect((await read(page)).background).toBe(true);
  await background(page, false);
  await expect.poll(() => read(page).then((s) => s.audioState)).toBe('running');
  expect((await read(page)).paused).toBe(false);
});
