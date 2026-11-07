/**
 * The UI 4 demo (harness/ui4.html) on every matrix row (ws/ui-4): float numbers, the radial
 * ring, the compass strip, the minimap and the pad owner, one mode per query. Every value that
 * moves over time is polled (E-017).
 *
 * - `?floats`: numbers stream over the blocks (`ui.floats(camera)`, ws/ui-6); the pool never
 *   passes 64 nodes, the layer holds exactly the pooled nodes, and a click spawns a crit;
 * - `?ring`: the ring's `aria-valuenow` follows the value as it fills;
 * - `?compass`: the heading follows the orbiting camera and each marker sits at its bearing
 *   difference × width / 360 (the default 180° field of view);
 * - `?minimap`: the canvas map (`ui.minimap`, ws/ui-6) holds the four markers; those past the
 *   radius are on the rim (`markerAt` agrees with the map's drawn `rim` count), and the count
 *   changes as the centre moves;
 * - `?modal`: opening the modal hands the pad to the stack once and resets the cursor latch;
 *   closing it hands the pad back once;
 * - `?still` parks the clock while frames keep coming.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessUi4State } from '../harness/ui4-state';
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
  const path = `ui4.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${path}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(path)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`ui4 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessUi4State> {
  return frame.evaluate(() => {
    const s = window.__harnessUi4?.state;
    if (!s) throw new Error('window.__harnessUi4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessUi4State;
  });
}

test('floating numbers stream from a bounded pool; a click spawns a crit', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'floats');
  // Ten a second for a second each: about ten live once the stream is warm.
  await expect.poll(async () => (await read()).live).toBeGreaterThanOrEqual(5);
  const s = await read();
  expect(s.live).toBeLessThanOrEqual(64);
  expect(s.pooled).toBeLessThanOrEqual(64);
  expect(s.pooled).toBeGreaterThanOrEqual(s.live);
  const nodes = frame.locator('.tc-layer[data-layer="hud"] > .tc-floats');
  await expect.poll(async () => (await nodes.count()) <= 64).toBe(true);
  await frame.locator('#root').click({ position: { x: 20, y: 20 } });
  await expect(
    frame.locator('.tc-floats[data-crit]').filter({ hasText: 'CRIT' }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('the ring fills and its aria-valuenow follows', async ({ page, wrapper }) => {
  await open(page, wrapper, 'ring');
  const ring = frame.locator('#ring');
  await expect(ring).toHaveAttribute('role', 'progressbar');
  await expect(ring).toBeVisible();
  const first = Number(await ring.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await ring.getAttribute('aria-valuenow'))).not.toBe(first);
  await expect
    .poll(async () => {
      const v = (await read()).value;
      return v >= 0 && v <= 1;
    })
    .toBe(true);
  expect(errors).toEqual([]);
});

test('the compass follows the heading and places markers by bearing', async ({ page, wrapper }) => {
  await open(page, wrapper, 'compass');
  await expect(frame.locator('#compass')).toHaveAttribute('role', 'img');
  const h0 = (await read()).heading;
  await expect.poll(async () => (await read()).heading).not.toBe(h0);
  const s = await read();
  // fov 180: the strip spans 360°, 560 design px wide.
  const ppd = 560 / 360;
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  expect(s.markers.east).toBeCloseTo(wrap(90 - s.heading) * ppd, 3);
  expect(s.markers.north).toBeCloseTo(wrap(0 - s.heading) * ppd, 3);
  expect(errors).toEqual([]);
});

test('the minimap clamps far markers to the rim as the centre moves', async ({ page, wrapper }) => {
  await open(page, wrapper, 'minimap');
  const map = frame.locator('#minimap');
  await expect(map).toBeVisible();
  await expect(frame.locator('.tc-region[data-region="right"] #minimap')).toHaveCount(1);
  // A canvas: the markers are state, not nodes.
  await expect.poll(async () => (await read()).mapMarkers).toBe(4);
  // A rim count of 3 lasts about 0.37 s of every 2.6 s of page time: the page records each
  // distinct count on the frame it happens (`onRimSeen`) rather than the spec sampling for it.
  await expect.poll(async () => (await read()).onRimSeen.length).toBeGreaterThanOrEqual(2);
  // `onRim` and the drawn `rimDrawn` are written on the same frame and come back in one read.
  await expect
    .poll(async () => {
      const s = await read();
      return s.onRim === s.rimDrawn;
    })
    .toBe(true);
  expect(errors).toEqual([]);
});

test('a modal takes the pad once, resets the cursor latch, and gives it back', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'modal');
  // The page holds right from the start: the cursor latched before the modal opened at 1 s.
  await expect.poll(async () => (await read()).padOwner).toBe('stack');
  let s = await read();
  expect(s.latchedBeforeModal).toBe(true);
  expect(s.padOwnerChanges).toBe(1);
  expect(s.cursorLatched).toBe(false);
  await frame.evaluate(() => window.__harnessUi4?.closeModal());
  await expect.poll(async () => (await read()).padOwner).toBe('game');
  s = await read();
  expect(s.padOwnerChanges).toBe(2);
  // Right is still held: the cursor primes its latch with it rather than stepping again.
  await expect.poll(async () => (await read()).cursorLatched).toBe(true);
  expect(errors).toEqual([]);
});

test('?still parks the clock while frames keep coming', async ({ page, wrapper }) => {
  await open(page, wrapper, 'ring&still');
  const s0 = await read();
  expect(s0.parked).toBe(true);
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(s0.frames + 3);
  expect((await read()).t).toBe(0);
  expect(errors).toEqual([]);
});
