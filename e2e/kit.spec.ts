/**
 * The kit page (harness/kit.html) on every matrix row: `composeGame` with no services boots the
 * core alone and draws through the built-in present; `?client` runs the loop on the page's own
 * frames (`loop.frames: 'external'`, `ctx.frame(now)`).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessKitState } from '../harness/kit-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `kit.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`kit demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessKitState> {
  return frame.evaluate(() => {
    const s = window.__harnessKit?.state;
    if (!s) throw new Error('window.__harnessKit missing');
    return JSON.parse(JSON.stringify(s)) as HarnessKitState;
  });
}

/** The ctx a kit with no services has: the core, nothing else. */
const CORE_FIELDS = [
  'camera',
  'clock',
  'design',
  'gpu',
  'hooks',
  'host',
  'loop',
  'onDeviceLost',
  'renderer',
  'save',
  'setCamera',
  'stack',
  'surface',
];

test('lean kit: the core alone boots, steps and draws through the built-in present', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '');
  const s = await read();
  expect(s.mode).toBe('host');
  expect(s.fields).toEqual(CORE_FIELDS);
  expect(s.postNull).toBe(true);
  await expect.poll(async () => (await read()).updates).toBeGreaterThan(10);
  expect((await read()).clockMs).toBeGreaterThan(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('client mode: the page drives every frame with ctx.frame(now)', async ({ page, wrapper }) => {
  await open(page, wrapper, '?client');
  const s = await read();
  expect(s.mode).toBe('client');
  expect(s.fields).toEqual([...CORE_FIELDS, 'frame'].sort());
  await expect.poll(async () => (await read()).updates).toBeGreaterThan(10);
  const t = await read();
  // One render per page frame, never more (the engine schedules no frames of its own).
  expect(t.frames).toBeLessThanOrEqual(t.driven);
  expect(t.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
