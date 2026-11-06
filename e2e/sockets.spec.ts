/**
 * Attachment sockets (ws/sockets) on every matrix row, against harness/sockets.html: a
 * three-joint arm animated by the mixer, two cubes riding its joints through `attachTransform`.
 *
 * - the page boots WebGPU, draws the rig and logs no error;
 * - each socket's world position stays exactly the offset length from its joint's, while the
 *   arm bends and the rig turns (polled, E-017);
 * - the socket moves over time, and `setPaused(true)` parks it.
 */
import type { Frame } from '@playwright/test';
import type { HarnessSocketsState, Vec3 } from '../harness/sockets-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

test.beforeEach(async ({ page, wrapper }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}sockets.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('sockets.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`sockets demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
});

function read(): Promise<HarnessSocketsState> {
  return frame.evaluate(() => {
    const s = window.__harnessSockets?.state;
    if (!s) throw new Error('window.__harnessSockets missing');
    return JSON.parse(JSON.stringify(s)) as HarnessSocketsState;
  });
}

function setPaused(paused: boolean): Promise<void> {
  return frame.evaluate((p) => window.__harnessSockets?.setPaused(p), paused);
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('boots, draws the rig and both cosmetics, logs no error', async () => {
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  // Ground, three bones, two attached cubes.
  expect(s.stats.instances).toBe(6);
  expect(s.namedJoint).toBe(1);
  expect(errors).toEqual([]);
});

test('a socket keeps the offset length from its joint while the arm moves', async () => {
  // The offset is applied in joint space and nothing scales, so the distance is constant.
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(dist(s.socketWorldPos, s.jointWorldPos) - s.offsetLength);
    })
    .toBeLessThan(1e-3);
  await frames(5);
  const s = await read();
  expect(dist(s.socketWorldPos, s.jointWorldPos)).toBeCloseTo(s.offsetLength, 3);
  expect(s.offsetLength).toBeGreaterThan(1);
});

test('a socket on a named joint resolves the name and keeps its offset', async () => {
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(dist(s.namedSocketWorldPos, s.namedJointWorldPos) - s.namedOffsetLength);
    })
    .toBeLessThan(1e-3);
  const s = await read();
  expect(s.namedJoint).toBe(1);
  // Elbow and wrist are different joints, so the two cosmetics sit apart.
  expect(dist(s.namedJointWorldPos, s.jointWorldPos)).toBeGreaterThan(0.5);
});

test('the socket moves over time and setPaused parks it', async () => {
  const first = (await read()).socketWorldPos;
  await expect.poll(async () => dist((await read()).socketWorldPos, first)).toBeGreaterThan(1e-3);
  await setPaused(true);
  await frames(2);
  const a = (await read()).socketWorldPos;
  await frames(3);
  const b = (await read()).socketWorldPos;
  expect(dist(a, b)).toBe(0);
  await setPaused(false);
  await expect.poll(async () => dist((await read()).socketWorldPos, b)).toBeGreaterThan(1e-3);
  expect(errors).toEqual([]);
});
