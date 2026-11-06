/**
 * Look controls (ws/look) on every matrix row, against harness/look.html: a first-person walk
 * driven only by `Look`'s `look` and `move`.
 *
 * - touch rows: real touches through CDP; a drag on the right half turns the view, a finger held
 *   off-centre on the left half walks (the move stick);
 * - desktop rows (and the itch iframe): WASD walks; the pointer lock cannot be granted to
 *   synthesized input, so `request()` must settle to a boolean without throwing and `locked` is
 *   false after `release()`.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessLookState } from '../harness/look-state';
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
    await page.goto(`${HARNESS_URL}look.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('look.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`look demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
});

function read(): Promise<HarnessLookState> {
  return frame.evaluate(() => {
    const s = window.__harnessLook?.state;
    if (!s) throw new Error('window.__harnessLook missing');
    return JSON.parse(JSON.stringify(s)) as HarnessLookState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

async function touchCdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

function touchAt(cdp: CDPSession, type: 'touchStart' | 'touchMove', x: number, y: number) {
  return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id: 1 }] });
}

test('boots the cube field with no errors', async () => {
  const s = await read();
  // 26 cubes recorded; the camera frustum-culls the ones out of view (ws/cull).
  expect(s.instances + s.culled).toBe(26);
  expect(s.gpuErrors).toBe(0);
  expect(s.locked).toBe(false);
  expect(errors).toEqual([]);
});

test('touch: a drag on the right half turns the view', async ({ page }) => {
  test.skip(!touchRow(), 'touch rows only');
  const before = await read();
  const box = await canvasBox();
  const from = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.5 };
  const dx = Math.round(box.width * 0.15);
  const cdp = await touchCdp(page);
  await touchAt(cdp, 'touchStart', from.x, from.y);
  for (let k = 1; k <= 8; k++) {
    await touchAt(cdp, 'touchMove', from.x + (dx * k) / 8, from.y);
    await frames(1);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // A drag right turns right (polled: slow frames coalesce touch events, E-017); it never walks.
  await expect.poll(async () => (await read()).yaw).toBeGreaterThan(before.yaw + 0.05);
  const after = await read();
  expect(after.position).toEqual(before.position);
  expect(errors).toEqual([]);
});

test('touch: a finger held up-stick on the left half walks forward', async ({ page }) => {
  test.skip(!touchRow(), 'touch rows only');
  const before = await read();
  const box = await canvasBox();
  const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.6 };
  const cdp = await touchCdp(page);
  await touchAt(cdp, 'touchStart', from.x, from.y);
  await touchAt(cdp, 'touchMove', from.x, from.y - 40);
  await touchAt(cdp, 'touchMove', from.x, from.y - 80);
  await expect.poll(async () => (await read()).stick).toBe(true);
  // Forward from the start is -z.
  await expect.poll(async () => (await read()).position[2]).toBeLessThan(before.position[2] - 0.5);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect.poll(async () => (await read()).stick).toBe(false);
  const after = await read();
  // The stick never turns the view.
  expect(after.yaw).toBe(before.yaw);
  expect(after.pitch).toBe(before.pitch);
  expect(errors).toEqual([]);
});

test('keyboard: WASD walks', async ({ page }) => {
  test.skip(touchRow(), 'keyboard rows only');
  const box = await canvasBox();
  // Focus the page (the iframe too) without a click on the canvas, which would ask for the lock.
  await frame.locator('body').focus();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await read();
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read()).position[2]).toBeLessThan(before.position[2] - 0.5);
  await page.keyboard.up('KeyW');
  await frames(2);
  const mid = await read();
  await page.keyboard.down('KeyD');
  await expect.poll(async () => (await read()).position[0]).toBeGreaterThan(mid.position[0] + 0.5);
  await page.keyboard.up('KeyD');
  expect((await read()).yaw).toBe(before.yaw);
  expect(errors).toEqual([]);
});

test('pointer lock: request settles to a boolean, release leaves it unlocked', async () => {
  test.skip(touchRow(), 'pointer lock rows only');
  const got = await frame.evaluate(async () => {
    const api = window.__harnessLook;
    if (!api) throw new Error('window.__harnessLook missing');
    return api.request();
  });
  expect(typeof got).toBe('boolean');
  await frame.evaluate(() => window.__harnessLook?.release());
  await expect.poll(async () => (await read()).locked).toBe(false);
  // A refused request may log a browser warning; nothing the page throws.
  expect(errors.filter((e) => !/pointer ?lock/i.test(e))).toEqual([]);
});
