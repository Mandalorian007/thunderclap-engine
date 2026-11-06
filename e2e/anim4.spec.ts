/**
 * ws/anim-4 on every matrix row, against the anim-4 harness page (harness/anim4.html, no
 * WebGPU): one mode per page load.
 *
 * - `?blend2d`: the nine gradient-band weights sum to 1, a query on a sample gives it everything,
 *   one between two neighbours splits them;
 * - `?aim`: the clamped yaw never exceeds the limit while the target orbits; parked, a far
 *   target inside the limits is faced;
 * - `?foot`: over the stepped floor the pelvis sinks and both feet stay on their ground;
 * - `?spring`: the cape lags the turning figure; `?teleport` moves it without a jolt;
 * - `?match`: a matched cut starts the other clip half a cycle on, an unmatched one at 0.
 *
 * Every value is polled across frames per E-017, never read once.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessAnim4State } from '../harness/anim4-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  const file = `anim4.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
}

function read(): Promise<HarnessAnim4State> {
  return frame.evaluate(() => {
    const s = window.__harnessAnim4?.state;
    if (!s) throw new Error('window.__harnessAnim4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessAnim4State;
  });
}

/** Wait for `n` more frames. */
async function frames(n: number): Promise<void> {
  const start = (await read()).ticks;
  await expect.poll(async () => (await read()).ticks).toBeGreaterThanOrEqual(start + n);
}

const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);

test('2D blend: weights sum to 1, land on samples and split between neighbours', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'blend2d');
  for (let i = 0; i < 4; i++) {
    await frames(3);
    const s = await read();
    expect(s.moving).toBe(true);
    expect(s.weights).toHaveLength(9);
    expect(sum(s.weights)).toBeCloseTo(1, 4);
    for (const w of s.weights) expect(w).toBeGreaterThanOrEqual(-1e-6);
  }
  await frame.evaluate(() => window.__harnessAnim4?.setMoving(false));
  // On the centre sample (row 1, column 1): everything to idle.
  await frame.evaluate(() => window.__harnessAnim4?.setParams(0, 0));
  await expect.poll(async () => (await read()).weights[4]).toBeCloseTo(1, 4);
  // On the top-right corner.
  await frame.evaluate(() => window.__harnessAnim4?.setParams(1, 1));
  await expect.poll(async () => (await read()).weights[8]).toBeCloseTo(1, 4);
  // Halfway to the right neighbour: the two split it, nobody else pulls.
  await frame.evaluate(() => window.__harnessAnim4?.setParams(0.5, 0));
  await expect.poll(async () => (await read()).weights[4]).toBeCloseTo(0.5, 3);
  const s = await read();
  expect(s.weights[5]).toBeCloseTo(0.5, 3);
  for (let i = 0; i < 9; i++) if (i !== 4 && i !== 5) expect(s.weights[i]).toBeLessThan(1e-3);
  // Outside the hull: clamped to the edge, still a partition of unity.
  await frame.evaluate(() => window.__harnessAnim4?.setParams(3, 0));
  await expect.poll(async () => (await read()).weights[5]).toBeCloseTo(1, 3);
  expect(sum((await read()).weights)).toBeCloseTo(1, 4);
});

test('aim offset: the chain turns up to the clamp and faces a far target', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'aim');
  for (let i = 0; i < 5; i++) {
    await frames(3);
    const s = await read();
    expect(s.moving).toBe(true);
    expect(Math.abs(s.headYaw)).toBeLessThanOrEqual(1.2 + 1e-6);
    expect(Math.abs(s.headPitch)).toBeLessThanOrEqual(0.7 + 1e-6);
  }
  await frame.evaluate(() => window.__harnessAnim4?.setMoving(false));
  // A far target 45° to the right and level with the head: within the clamps, faced.
  await frame.evaluate(() => window.__harnessAnim4?.setTarget(50, 2, 50));
  await expect.poll(async () => (await read()).headYaw).toBeCloseTo(Math.PI / 4, 3);
  const a = await read();
  expect(a.headError).toBeLessThan(0.02);
  await frames(3);
  const b = await read();
  expect(b.time).toBe(a.time);
  expect(b.headYaw).toBe(a.headYaw);
  // Behind: clamped at the limit.
  await frame.evaluate(() => window.__harnessAnim4?.setTarget(0, 2, -50));
  await expect.poll(async () => Math.abs((await read()).headYaw)).toBeCloseTo(1.2, 5);
});

test('foot placement: the pelvis sinks to the lower step and both feet meet their ground', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'foot');
  // The pelvis approaches the step over the first second; afterwards every read is planted.
  await expect.poll(async () => (await read()).pelvisY, { timeout: 10_000 }).toBeLessThan(0.87);
  for (let i = 0; i < 5; i++) {
    await frames(3);
    const s = await read();
    expect(s.moving).toBe(true);
    expect(s.pelvisY).toBeLessThan(0.87);
    expect(s.pelvisY).toBeGreaterThan(0.83);
    expect(s.footGap).toBeLessThan(0.02);
  }
  await frame.evaluate(() => window.__harnessAnim4?.setMoving(false));
  await frames(2);
  const a = await read();
  await frames(3);
  const b = await read();
  expect(b.pelvisY).toBe(a.pelvisY);
  expect(b.footGap).toBe(a.footGap);
});

test('secondary motion: the cape trails the turning figure and settles when parked', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'spring');
  await expect.poll(async () => (await read()).tipLag, { timeout: 10_000 }).toBeGreaterThan(0.05);
  for (let i = 0; i < 5; i++) {
    await frames(3);
    const s = await read();
    expect(s.moving).toBe(true);
    expect(s.tipLag).toBeGreaterThan(0);
    expect(s.tipLag).toBeLessThan(1);
  }
  await frame.evaluate(() => window.__harnessAnim4?.setMoving(false));
  await frames(2);
  const a = await read();
  await frames(3);
  const b = await read();
  expect(b.tipLag).toBe(a.tipLag);
});

test('secondary motion: a teleport carries the cape along without a jolt', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'spring&teleport');
  await expect.poll(async () => (await read()).teleported, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await read()).lagAfter).toBeGreaterThanOrEqual(0);
  const s = await read();
  expect(s.instanceX).toBeCloseTo(5, 5);
  expect(Math.abs(s.lagAfter - s.lagBefore)).toBeLessThan(0.05);
  for (let i = 0; i < 4; i++) {
    await frames(3);
    expect((await read()).tipLag).toBeLessThan(1);
  }
});

test('pose matching: a matched cut lands half a cycle on, an unmatched one at zero', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'match');
  await expect.poll(async () => (await read()).time).toBeGreaterThan(0.5);
  await frame.evaluate(() => window.__harnessAnim4?.setMoving(false));
  await frames(2);
  const d = (await read()).duration;
  expect(d).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    const before = (await read()).matchState;
    await frame.evaluate(() => window.__harnessAnim4?.cut(true));
    await expect.poll(async () => (await read()).matchState).not.toBe(before);
    const s = await read();
    // The second clip is half a cycle out of phase: the nearest frame is t + d/2 (mod d).
    const want = (s.timeBefore + d / 2) % d;
    const diff = Math.abs(s.startTime - want);
    expect(Math.min(diff, d - diff)).toBeLessThan(0.1);
  }
  const before = (await read()).matchState;
  await frame.evaluate(() => window.__harnessAnim4?.cut(false));
  await expect.poll(async () => (await read()).matchState).not.toBe(before);
  expect((await read()).startTime).toBe(0);
});
