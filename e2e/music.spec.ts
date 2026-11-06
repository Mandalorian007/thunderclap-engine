/**
 * The game audio toolkit (`createMusic`, `createVariations`, `createSend`, `createDucker`) on
 * every top-level matrix row, against harness/music.html (no WebGPU): the beat grid advances
 * from the real context clock once a gesture unlocks audio, intensity moves the layer gains,
 * footsteps never repeat, and a line on `ui` ducks `music` and lets it back.
 *
 * The itch-iframe row is skipped: the wrapper embeds the WebGPU harness page, and the audio
 * graph does not depend on the frame. Every moving value is polled (E-017).
 */
import type { Page } from '@playwright/test';
import type { HarnessMusicState } from '../harness/music-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'music harness runs top-level only');
  const query = test.info().title.includes('?pause') ? '?pause' : '';
  await page.goto(`${HARNESS_URL}music.html${query}`);
  await expect.poll(() => read(page).then((s) => s.ready), { timeout: 20_000 }).toBe(true);
  // The first gesture unlocks the context; the stems queued at boot start on it.
  const root = page.locator('#root');
  if (test.info().project.use.hasTouch) await root.tap({ position: { x: 8, y: 8 } });
  else await root.click({ position: { x: 8, y: 8 } });
  await expect.poll(() => read(page).then((s) => s.audioState)).toBe('running');
});

function read(page: Page): Promise<HarnessMusicState> {
  return page.evaluate(() => {
    const s = window.__harnessMusic?.state;
    if (!s) throw new Error('window.__harnessMusic missing');
    return JSON.parse(JSON.stringify(s)) as HarnessMusicState;
  });
}

const setIntensity = (page: Page, level: number) =>
  page.evaluate((l) => window.__harnessMusic?.setIntensity(l), level);
const step = (page: Page) => page.evaluate(() => window.__harnessMusic?.step());
const speak = (page: Page) => page.evaluate(() => window.__harnessMusic?.speak());
const playSfx = (page: Page) => page.evaluate(() => window.__harnessMusic?.playSfx());
const stopSfx = (page: Page) => page.evaluate(() => window.__harnessMusic?.stopSfx());
const sendProbe = (page: Page, amount: number) =>
  page.evaluate((a) => window.__harnessMusic?.sendProbe(a), amount);
const unpause = (page: Page) => page.evaluate(() => window.__harnessMusic?.unpause());

test('the beat grid advances from the context clock and fires onBeat', async ({ page }) => {
  const s0 = await read(page);
  expect(s0.beat).toBeGreaterThanOrEqual(0);
  expect(s0.beat).toBeLessThan(4);
  // 120 bpm: two beats a second. Three more beats inside the poll timeout, even under load.
  await expect
    .poll(() => read(page).then((s) => s.totalBeats))
    .toBeGreaterThanOrEqual(s0.totalBeats + 3);
  const s1 = await read(page);
  expect(s1.beats).toBeGreaterThan(s0.beats);
  expect(s1.bar * 4 + s1.beat).toBe(s1.totalBeats);
  expect(s1.frames).toBeGreaterThan(s0.frames);
  // The stems are on: the pad at full gain, the drums layer at its low stem.
  expect(s1.layerGains.pad).toBe(1);
  expect(s1.layerGains['pulse-low']).toBe(1);
  expect(s1.layerGains['pulse-high']).toBe(0);
});

test('intensity 0 → 1 crossfades the drums stems, gains summing to 1', async ({ page }) => {
  await setIntensity(page, 1);
  await expect.poll(() => read(page).then((s) => s.layerGains['pulse-high'])).toBe(1);
  let s = await read(page);
  expect(s.intensity).toBe(1);
  expect(s.layerGains['pulse-low']).toBe(0);
  expect(s.layerGains.pad).toBe(1);
  await setIntensity(page, 0.25);
  await expect.poll(() => read(page).then((s) => s.layerGains['pulse-low'])).toBe(1);
  s = await read(page);
  expect(s.layerGains['pulse-high']).toBe(0);
  expect(s.layerGains['pulse-low']! + s.layerGains['pulse-high']!).toBeCloseTo(1);
});

test('footsteps pick a variation and never repeat the last one', async ({ page }) => {
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    await step(page);
    const s = await read(page);
    expect(s.lastVariation).toBeGreaterThanOrEqual(0);
    expect(s.lastVariation).toBeLessThan(3);
    if (seen.length) expect(s.lastVariation).not.toBe(seen.at(-1));
    seen.push(s.lastVariation);
  }
  expect(new Set(seen).size).toBeGreaterThan(1);
});

test('speak ducks the music bus and releases it when the line ends', async ({ page }) => {
  const s0 = await read(page);
  expect(s0.ducked).toBe(false);
  expect(s0.duckGain).toBe(1);
  await speak(page);
  await expect.poll(() => read(page).then((s) => s.ducked)).toBe(true);
  await expect.poll(() => read(page).then((s) => s.duckGain)).toBeLessThan(0.5);
  // The chime is about a second long; the release is 0.4 s after it ends.
  await expect.poll(() => read(page).then((s) => s.ducked)).toBe(false);
  await expect.poll(() => read(page).then((s) => s.duckGain)).toBe(1);
  expect((await read(page)).reverb).toBeCloseTo(0.3);
});

test('voices counts the stems under music and two probes under sfx; sendTo shows one send', async ({
  page,
}) => {
  // The three stems queued at boot are registered voices on `music`.
  await expect.poll(() => read(page).then((s) => s.voices.music)).toBe(3);
  let s = await read(page);
  expect(s.voices.sfx).toBe(0);
  expect(s.sends).toBe(0);
  await playSfx(page);
  await playSfx(page);
  await expect.poll(() => read(page).then((s) => s.voices.sfx)).toBe(2);
  s = await read(page);
  expect(s.voices.master).toBe(s.voices.music + s.voices.sfx + s.voices.ui);
  await sendProbe(page, 1);
  await expect.poll(() => read(page).then((s) => s.sends)).toBe(1);
  await sendProbe(page, 0);
  await expect.poll(() => read(page).then((s) => s.sends)).toBe(0);
  await stopSfx(page);
  await expect.poll(() => read(page).then((s) => s.voices.sfx)).toBe(0);
  expect((await read(page)).voices.music).toBe(3);
});

test('?pause ramps music and sfx to silence, keeps ui, and unpause restores the bus gains', async ({
  page,
}) => {
  await expect.poll(() => read(page).then((s) => s.paused)).toBe(true);
  let s = await read(page);
  expect(s.pausedBuses).toEqual(['music', 'sfx']);
  // The 50 ms ramp heads down (a loaded machine may read it mid-way; the direction is what
  // matters, with a wide budget); `ui` and `master` are untouched.
  await expect
    .poll(() => read(page).then((s) => s.busGains.sfx), { timeout: 20_000 })
    .toBeLessThan(0.05);
  await expect
    .poll(() => read(page).then((s) => s.busGains.music), { timeout: 20_000 })
    .toBeLessThan(0.05);
  s = await read(page);
  expect(s.busGains.ui).toBeCloseTo(s.busTargets.ui!, 5);
  expect(s.busGains.master).toBeCloseTo(s.busTargets.master!, 5);
  // The stems are still on the books while paused.
  expect(s.voices.music).toBe(3);
  await unpause(page);
  await expect.poll(() => read(page).then((s) => s.paused)).toBe(false);
  // Restored to exactly what the settings ask for.
  await expect
    .poll(() => read(page).then((s) => Math.abs(s.busGains.sfx! - s.busTargets.sfx!)))
    .toBeLessThan(1e-5);
  await expect
    .poll(() => read(page).then((s) => Math.abs(s.busGains.music! - s.busTargets.music!)))
    .toBeLessThan(1e-5);
  expect((await read(page)).pausedBuses).toEqual([]);
});
