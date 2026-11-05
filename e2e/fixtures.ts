/**
 * Engine e2e fixtures. `harness` is the frame that runs the harness page: the page itself, or
 * the cross-origin iframe inside the itch-style wrapper. Specs read `window.__harness` through
 * `readHarness` and drive it the same way in both cases.
 */
import { test as base, expect, type Frame, type Page } from '@playwright/test';
import type { HarnessGameState } from '../harness/game-state';
import type { HarnessState } from '../harness/state';
import { HARNESS_PORT, HARNESS_URL, WRAPPER_URL } from './ports';

export interface HarnessOptions {
  /** `top`: the harness is the page. `itch-iframe`: it is embedded cross-site, as on itch.io. */
  wrapper: 'top' | 'itch-iframe';
}

interface HarnessFixtures {
  harness: Frame;
}

/**
 * Opens the harness for `wrapper` and returns the frame it runs in. `query` goes on the wrapper
 * URL (e.g. `?launch=1`). Specs that stub browser APIs with `page.addInitScript` call this after
 * installing the stubs; the `harness` fixture calls it for everyone else.
 */
export async function openHarness(
  page: Page,
  wrapper: HarnessOptions['wrapper'],
  query = '',
): Promise<Frame> {
  if (wrapper === 'top') {
    await page.goto(HARNESS_URL);
    return page.mainFrame();
  }
  await page.goto(`${WRAPPER_URL}${query}`);
  return harnessFrame(page);
}

/**
 * Opens the createGame harness page (harness/game.html) for `wrapper`, waits until it has drawn
 * `frames` frames and returns the frame it runs in. `query` goes on the page (`?mode=client`).
 */
export async function openGameHarness(
  page: Page,
  wrapper: HarnessOptions['wrapper'],
  frames = 3,
  query = '',
): Promise<Frame> {
  let frame: Frame;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}game.html${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`game.html${query}`)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await readGame(frame).catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`createGame: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(frames);
  return frame;
}

export function readGame(frame: Frame): Promise<HarnessGameState> {
  return frame.evaluate(() => {
    const g = window.__harnessGame;
    if (!g) throw new Error('window.__harnessGame missing');
    return JSON.parse(JSON.stringify(g.state())) as HarnessGameState;
  });
}

/** The harness iframe inside the wrapper page, once it exists. */
export async function harnessFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().includes(`:${HARNESS_PORT}/`)))
    .toBe(true);
  const frame = page.frames().find((f) => f.url().includes(`:${HARNESS_PORT}/`));
  if (!frame) throw new Error('harness iframe not found');
  return frame;
}

export const test = base.extend<HarnessFixtures & HarnessOptions>({
  wrapper: ['top', { option: true }],
  harness: async ({ page, wrapper }, use) => {
    await use(await openHarness(page, wrapper));
  },
});

export { expect };

export function readHarness(frame: Frame): Promise<HarnessState> {
  return frame.evaluate(() => {
    const s = window.__harness;
    if (!s) throw new Error('window.__harness missing');
    return JSON.parse(JSON.stringify(s)) as HarnessState;
  });
}

/** Wait until boot is done and at least `frames` frames have been presented. */
export async function waitForFrames(frame: Frame, frames = 3): Promise<HarnessState> {
  await expect
    .poll(async () => {
      const s = await readHarness(frame).catch(() => null);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(frames);
  return readHarness(frame);
}
