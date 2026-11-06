/**
 * IK (ws/ik) on every matrix row, against the IK harness page (harness/ik.html, no WebGPU): a
 * two-bone arm whose wrist follows an orbiting target and a head that looks at it.
 *
 * - while the target moves, `tipError` stays under 1e-3 and `headError` under 1e-3 on every read
 *   (polled across frames per E-017, never read once);
 * - parked, the pose is still and an unreachable target leaves the arm straight towards it.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessIkState } from '../harness/ik-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

async function open(page: Page, wrapper: string): Promise<void> {
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}ik.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('ik.html')}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
}

function read(): Promise<HarnessIkState> {
  return frame.evaluate(() => {
    const s = window.__harnessIk?.state;
    if (!s) throw new Error('window.__harnessIk missing');
    return JSON.parse(JSON.stringify(s)) as HarnessIkState;
  });
}

/** Wait for `n` more frames. */
async function frames(n: number): Promise<void> {
  const start = (await read()).ticks;
  await expect.poll(async () => (await read()).ticks).toBeGreaterThanOrEqual(start + n);
}

const TIP = 1e-3;
const HEAD = 1e-3;

test('the wrist follows the moving target and the head looks at it', async ({ page, wrapper }) => {
  await open(page, wrapper);
  // Several reads across moving frames: every one is on target.
  let lastTick = -1;
  let lastTime = -1;
  for (let i = 0; i < 5; i++) {
    await frames(3);
    const s = await read();
    expect(s.moving).toBe(true);
    expect(s.ticks).toBeGreaterThan(lastTick);
    expect(s.time).toBeGreaterThan(lastTime);
    expect(s.reach).toBeLessThan(2);
    expect(s.tipError).toBeLessThan(TIP);
    expect(s.headError).toBeLessThan(HEAD);
    lastTick = s.ticks;
    lastTime = s.time;
  }
});

test('parked, the solve is still; an unreachable target straightens the arm', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await frame.evaluate(() => window.__harnessIk?.setMoving(false));
  await frames(2);
  const a = await read();
  await frames(3);
  const b = await read();
  expect(b.time).toBe(a.time);
  expect(b.target).toEqual(a.target);
  expect(b.tipError).toBeLessThan(TIP);
  // Out of reach (the arm reaches 2 from the shoulder at (0, 1.5, 0)): tip error is the gap.
  await frame.evaluate(() => window.__harnessIk?.setTarget(4, 1.5, 0));
  await expect.poll(async () => (await read()).reach).toBeCloseTo(4, 5);
  const s = await read();
  expect(s.moving).toBe(false);
  expect(s.tipError).toBeGreaterThan(1.99);
  expect(s.tipError).toBeLessThan(2.01);
  // Back in reach, from any starting pose.
  await frame.evaluate(() => window.__harnessIk?.setTarget(1.2, 2.1, 0.5));
  await expect.poll(async () => (await read()).tipError).toBeLessThan(TIP);
});
