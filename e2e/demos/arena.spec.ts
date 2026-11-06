/**
 * The arena demo (demos/arena, E-021) on the device matrix: the page boots, a held key moves the
 * character for two seconds of sim, a click starts a swing, the draw calls sit in the expected
 * band, the desktop rows hold a playable frame rate, and the console stays clean.
 *
 * The demo is served by the harness Vite server at `/demos/arena/` (vite.harness.config.ts), so
 * every row, the itch iframe one included, loads it directly.
 */
import { expect, type Page, test } from '@playwright/test';
import type { ArenaDemoState } from '../../demos/arena/state';
import { HARNESS_URL } from '../ports';

const URL = `${HARNESS_URL}demos/arena/`;

/** The draw-call band: ground, the pillars (one instanced draw), orbs, body, sword, plus the trail and particles when alive: 4..24 today. */
const DRAW_CALLS_MIN = 4;
const DRAW_CALLS_MAX = 40;
const MIN_FPS_DESKTOP = 20;

const readState = (page: Page) => page.evaluate(() => JSON.stringify(window.__demo));
const parse = (s: string) => JSON.parse(s) as ArenaDemoState;

async function boot(page: Page): Promise<{ errors: string[]; state: ArenaDemoState }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(URL);
  await expect.poll(async () => parse(await readState(page)).ready, { timeout: 30_000 }).toBe(true);
  const state = parse(await readState(page));
  expect(state.gpu, 'WebGPU came up').toBe('ok');
  await expect
    .poll(async () => parse(await readState(page)).frame, { timeout: 15_000 })
    .toBeGreaterThan(5);
  await page.mouse.move(400, 300);
  return { errors, state: parse(await readState(page)) };
}

test.describe('demo: arena', () => {
  test('boots, draws the arena within the draw-call band, no console errors', async ({
    page,
  }, info) => {
    const { errors } = await boot(page);
    await expect
      .poll(async () => parse(await readState(page)).frame, { timeout: 15_000 })
      .toBeGreaterThan(30);
    const s = parse(await readState(page));
    expect(s.drawCalls).toBeGreaterThanOrEqual(DRAW_CALLS_MIN);
    expect(s.drawCalls).toBeLessThanOrEqual(DRAW_CALLS_MAX);
    expect(s.shadowDraws, 'the pillars and the character cast').toBeGreaterThan(0);
    expect(s.triangles).toBeGreaterThan(100);
    expect(s.stats.instances).toBeGreaterThan(0);
    expect(s.gpuErrors).toBe(0);
    if (info.project.name.startsWith('desktop')) expect(s.fps).toBeGreaterThan(MIN_FPS_DESKTOP);
    expect(errors).toEqual([]);
  });

  test('a held key runs the character for 2 s of sim', async ({ page }) => {
    const { errors, state: before } = await boot(page);
    await page.keyboard.down('KeyW');
    await expect
      .poll(async () => parse(await readState(page)).simTime - before.simTime, { timeout: 20_000 })
      .toBeGreaterThan(2);
    const during = parse(await readState(page));
    await page.keyboard.up('KeyW');
    const moved = Math.hypot(
      during.position[0] - before.position[0],
      during.position[2] - before.position[2],
    );
    expect(moved, 'the character moved').toBeGreaterThan(1.5);
    expect(during.speed, 'at a run').toBeGreaterThan(1);
    await expect
      .poll(async () => parse(await readState(page)).speed, { timeout: 10_000 })
      .toBeLessThan(0.3);
    expect(errors).toEqual([]);
  });

  test('a click starts a swing and the sword leaves a trail', async ({ page }) => {
    const { errors, state: before } = await boot(page);
    expect(before.swinging).toBe(false);
    const box = await page.locator('canvas').first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect
      .poll(async () => parse(await readState(page)).swings, { timeout: 10_000 })
      .toBeGreaterThan(before.swings);
    await expect
      .poll(async () => parse(await readState(page)).trailPoints, { timeout: 10_000 })
      .toBeGreaterThan(1);
    await expect
      .poll(async () => parse(await readState(page)).swinging, { timeout: 10_000 })
      .toBe(false);
    expect(errors).toEqual([]);
  });
});
