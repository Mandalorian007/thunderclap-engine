/**
 * The render 10 page (harness/render10.html, ws/render-10) on every matrix row: sky, water,
 * box decals, world and 2D particles, billboards and debug lines drawn through
 * `createGame({ aux })` with the scene target's aux attachments on. Every scene-pass pipeline
 * takes its colour targets from `renderer.sceneTargets`, so no frame raises a GPU validation
 * error. Numbers are read from the page's published state and polled (E-017).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessRender10State } from '../harness/render10-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, flag: string): Promise<HarnessRender10State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `render10.html?${flag}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`render10: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessRender10State> {
  return frame.evaluate(() => {
    const s = window.__harnessRender10?.state;
    if (!s) throw new Error('window.__harnessRender10 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRender10State;
  });
}

const CASES = [
  { aux: 'velocity', key: 2, targets: 3 },
  { aux: 'all', key: 3, targets: 4 },
  { aux: 'none', key: 0, targets: 2 },
] as const;

for (const c of CASES) {
  test(`aux=${c.aux}: every fx drawable draws into a ${c.targets}-target scene pass with no GPU error`, async ({
    page,
    wrapper,
  }) => {
    const s0 = await open(page, wrapper, `aux=${c.aux}`);
    expect(s0.aux).toBe(c.aux);
    expect(s0.auxKey).toBe(c.key);
    expect(s0.sceneTargets).toBe(c.targets);
    await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(s0.frames + 60);
    // Before ws/render-10 every frame raised one per fx pipeline (and the frame was dropped).
    expect((await read()).gpuErrors).toBe(0);
    // The world particles are live (the readback lags a few frames), so the system drew.
    await expect.poll(async () => (await read()).particles).toBeGreaterThan(0);
    const s = await read();
    // Sky, debug, decals, water, two particle systems and billboards.
    expect(s.drawables).toBeGreaterThanOrEqual(7);
    expect(s.gpuErrors).toBe(0);
    expect(errors).toEqual([]);
  });
}
