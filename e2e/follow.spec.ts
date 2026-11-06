/**
 * Follow camera (ws/follow) on every matrix row, against harness/follow.html: a capsule between
 * walls, the camera on a `Follow` fed by `Look`.
 *
 * - boots: the ground, four walls and the capsule are recorded (culled ones counted);
 * - the mode toggles: key `V` on keyboard rows, `setMode` everywhere; first person puts the eye
 *   on the capsule and `distance` at 0;
 * - the distance shrinks when a wall sits behind the target, and recovers when it moves away.
 */
import type { Frame } from '@playwright/test';
import type { HarnessFollowState } from '../harness/follow-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];
const touchRow = () => test.info().project.use.hasTouch === true;

test.beforeEach(async ({ page, wrapper }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}follow.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('follow.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`follow demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
});

function read(): Promise<HarnessFollowState> {
  return frame.evaluate(() => {
    const s = window.__harnessFollow?.state;
    if (!s) throw new Error('window.__harnessFollow missing');
    return JSON.parse(JSON.stringify(s)) as HarnessFollowState;
  });
}

test('boots the walled ground with the capsule in third person behind it', async () => {
  const s = await read();
  // Ground + 4 walls + capsule; the frustum culls what the camera does not see (ws/cull).
  expect(s.instances + s.culled).toBe(6);
  expect(s.gpuErrors).toBe(0);
  expect(s.mode).toBe('third');
  expect(s.distance).toBeCloseTo(4, 1);
  // Yaw 0 looks down -z: the eye sits behind (+z of) and above the feet.
  expect(s.position[2]).toBeGreaterThan(s.target[2] + 3);
  expect(s.position[1]).toBeGreaterThan(1.5);
  // projectMany (ws/camera-ergo): the capsule the camera looks at is on screen, the back wall
  // behind the eye is not; the near frustum corner sits at the near plane.
  expect(s.projected).toBeGreaterThanOrEqual(1);
  expect(s.projected).toBeLessThan(6);
  expect(s.nearCornerZ).toBeCloseTo(0.1, 3);
  expect(errors).toEqual([]);
});

test('V toggles first and third person', async ({ page }) => {
  test.skip(touchRow(), 'keyboard rows only');
  await frame.locator('body').focus();
  await page.keyboard.press('KeyV');
  await expect.poll(async () => (await read()).mode).toBe('first');
  const s = await read();
  // The eye is on the capsule at eye height; the body is not drawn in first person.
  expect(s.distance).toBe(0);
  expect(s.position[0]).toBeCloseTo(s.target[0], 3);
  expect(s.position[2]).toBeCloseTo(s.target[2], 3);
  expect(s.position[1]).toBeCloseTo(1.5, 3);
  await expect.poll(async () => (await read()).instances + (await read()).culled).toBe(5);
  await page.keyboard.press('KeyV');
  await expect.poll(async () => (await read()).mode).toBe('third');
  await expect.poll(async () => (await read()).distance).toBeGreaterThan(3.9);
  expect(errors).toEqual([]);
});

test('setMode switches the view with one assignment', async () => {
  await frame.evaluate(() => window.__harnessFollow?.setMode('first'));
  await expect.poll(async () => (await read()).mode).toBe('first');
  await expect.poll(async () => (await read()).distance).toBe(0);
  await frame.evaluate(() => window.__harnessFollow?.setMode('third'));
  await expect.poll(async () => (await read()).mode).toBe('third');
  await expect.poll(async () => (await read()).distance).toBeGreaterThan(3.9);
  expect(errors).toEqual([]);
});

test('a wall behind the target pulls the camera in; it eases back out in the open', async () => {
  // The back wall spans z 5.75..6.25; from z 4.5 the orbit wants the eye at z 8.5.
  await frame.evaluate(() => window.__harnessFollow?.teleport(0, 4.5));
  await expect.poll(async () => (await read()).distance).toBeLessThan(1.3);
  const s = await read();
  expect(s.wanted).toBe(4);
  expect(s.position[2]).toBeLessThan(5.75);
  expect(s.position[2]).toBeGreaterThan(s.target[2]);
  await frame.evaluate(() => window.__harnessFollow?.teleport(0, 0));
  await expect.poll(async () => (await read()).distance).toBeGreaterThan(3.9);
  expect(errors).toEqual([]);
});
