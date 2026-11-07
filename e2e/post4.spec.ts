/**
 * The post 4 page (harness/post4.html, ws/post-4) on every matrix row, one mode per flag. Every
 * number is computed by the page from read-back frames (the measured stack against a reference
 * stack with the feature off, or against an earlier phase) and polled (E-017):
 *
 * - taa: on camera jitter, a static scene converges within 1/255 of the TAA-off frame over its
 *   flat pixels after 16 frames, and a bar sliding over a dark band leaves no more trail than
 *   the ws/post-3 resolve did; a striped cube moving under a still camera strays from the
 *   TAA-off frame at most half as far with velocity reprojection as with the camera matrix
 *   (ws/post-5);
 * - ssr: with the rough-metal target the smooth half of the floor reflects and the rough half
 *   does not;
 * - blur: with the velocity target a cube moving under a still camera blurs and the static
 *   background does not;
 * - ortho: the AO term at a point near a crease holds across two zooms and distances of an
 *   orthographic camera.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessPost4State } from '../harness/post4-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

/**
 * The trail the ws/post-3 resolve (sample-uv jitter, its own matrices) left behind the bar on
 * this page, measured on 9254884 before the switch: at most 0.0031 (luma 0..1) on every matrix
 * row. The new resolve may not exceed it by more than 2/255.
 */
const GHOST_TODAY = 0.0031;
const GHOST_MARGIN = 2 / 255;

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, flags: string): Promise<HarnessPost4State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `post4.html?${flags}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`post4: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

/** Poll the state until `done` holds for one snapshot and return that snapshot. */
async function settle(done: (s: HarnessPost4State) => boolean): Promise<HarnessPost4State> {
  let last: HarnessPost4State | null = null;
  await expect
    .poll(async () => {
      last = await read();
      return done(last);
    })
    .toBe(true);
  return last!;
}

function read(): Promise<HarnessPost4State> {
  return frame.evaluate(() => {
    const s = window.__harnessPost4?.state;
    if (!s) throw new Error('window.__harnessPost4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessPost4State;
  });
}

test('taa: a static scene converges on camera jitter; a moving edge ghosts no more than before', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'taa');
  expect(s0.mode).toBe('taa');
  await expect.poll(async () => (await read()).convergedDelta ?? -1).toBeGreaterThanOrEqual(0);
  const c = await read();
  // The stack asked for the jitter and the renderer applied it.
  expect(c.wantsJitter).toBe(true);
  expect(c.active).toBe(true);
  expect(Math.hypot(c.jitter[0], c.jitter[1])).toBeGreaterThan(0);
  expect(Math.abs(c.jitter[0])).toBeLessThanOrEqual(0.5);
  expect(Math.abs(c.jitter[1])).toBeLessThanOrEqual(0.5);
  expect(c.convergedDelta!).toBeLessThan(1 / 255);
  await expect.poll(async () => (await read()).ghost ?? -1).toBeGreaterThanOrEqual(0);
  const g = await read();
  expect(g.ghost!).toBeLessThanOrEqual(GHOST_TODAY + GHOST_MARGIN);
  expect(g.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('taa: velocity reprojection halves the ghost of a cube moving under a still camera', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'taa');
  expect(s0.mode).toBe('taa');
  // Each phase reads six frames after the bar's; the poll waits for both (E-017).
  const s = await settle((x) => x.ghostObject !== null && x.ghostObjectCamera !== null);
  expect(s.phase).toBe('done');
  expect(s.velocityActive).toBe(true);
  expect(s.ghostObjectCamera!).toBeGreaterThan(0);
  expect(s.ghostObject!).toBeLessThanOrEqual(s.ghostObjectCamera! * 0.5);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('taa: ?still converges and never starts the bar', async ({ page, wrapper }) => {
  await open(page, wrapper, 'taa&still');
  await expect.poll(async () => (await read()).phase).toBe('done');
  const s = await read();
  expect(s.still).toBe(true);
  expect(s.ghost).toBeNull();
  expect(s.convergedDelta!).toBeLessThan(1 / 255);
  expect(errors).toEqual([]);
});

test('ssr: with the rough-metal target only the smooth half of the floor reflects', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'ssr');
  expect(s0.mode).toBe('ssr');
  await expect.poll(async () => (await read()).smoothReflect ?? -1).toBeGreaterThan(0.02);
  const s = await read();
  expect(s.active).toBe(true);
  expect(s.roughReflect!).toBeLessThan(s.smoothReflect! * 0.15);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('blur: with the velocity target a moving cube blurs under a still camera; the background does not', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'blur');
  expect(s0.mode).toBe('blur');
  // Over at least 12 reads, a third of the swing: the cube smears across a dozen px at its
  // fastest on every row of the matrix, the background never moves.
  const s = await settle((x) => x.readbacks >= 12 && (x.cubeBlurPx ?? -1) > 12);
  expect(s.active).toBe(true);
  expect(s.backgroundBlurPx).toBe(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('ortho: the AO term is stable across zoom and distance', async ({ page, wrapper }) => {
  const s0 = await open(page, wrapper, 'ortho');
  expect(s0.mode).toBe('ortho');
  await expect.poll(async () => (await read()).aoDelta ?? -1).toBeGreaterThanOrEqual(0);
  const s = await read();
  // AO darkens the probe in both configurations, by the same amount.
  expect(s.aoTerms![0]).toBeLessThan(0.97);
  expect(s.aoTerms![1]).toBeLessThan(0.97);
  expect(s.aoDelta!).toBeLessThan(0.03);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
