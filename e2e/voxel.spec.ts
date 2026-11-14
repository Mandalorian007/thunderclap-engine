/**
 * Voxel page (ws/voxel-render) on every matrix row, against harness/voxel.html: a 4×2×4-chunk
 * block world through `@thunderclap-engine/engine/voxel`, meshed in a Worker, frustum-culled, picked
 * by the centre ray and edited in place.
 *
 * - boot: every non-empty chunk is drawn or culled, the centre ray hits ground, no errors;
 * - aim: turning the view changes how many chunks are drawn;
 * - break: a click (a tap on the right half on touch rows) sets `hit` and changes `triangles`;
 * - place + break: a block placed then broken leaves the chunk meshes ungrown (`growths` 0).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessVoxelState } from '../harness/voxel-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];
const touchRow = () => test.info().project.use.hasTouch === true;
/** The browser refuses the pointer lock to synthesized input; that note is not a page error. */
const pageErrors = () => errors.filter((e) => !/pointer ?lock/i.test(e));

test.beforeEach(async ({ page, wrapper }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}voxel.html?still`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('voxel.html?still')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`voxel demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
  // The Worker's first remeshes land over the first frames: wait for every chunk to be in.
  await expect.poll(async () => (await read()).chunks).toBeGreaterThanOrEqual(16);
  await expect.poll(async () => (await read()).remeshes).toBeGreaterThanOrEqual(32);
  await frames(2);
});

function read(): Promise<HarnessVoxelState> {
  return frame.evaluate(() => {
    const s = window.__harnessVoxel?.state;
    if (!s) throw new Error('window.__harnessVoxel missing');
    return JSON.parse(JSON.stringify(s)) as HarnessVoxelState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

function aim(yaw: number, pitch: number): Promise<void> {
  return frame.evaluate(([y, p]) => window.__harnessVoxel?.aim(y, p), [yaw, pitch] as const);
}

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** A primary click at the centre on mouse rows, a tap on the right half on touch rows. */
async function tapBreak(page: Page): Promise<void> {
  const box = await canvasBox();
  if (touchRow()) {
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height * 0.5;
    const cdp = await page.context().newCDPSession(page);
    // Back to back, no runner round trip between: the page's tap must lift inside 250 ms.
    await Promise.all([
      cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }),
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ]);
    await cdp.detach();
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

/** The secondary button on mouse rows, `E` on touch rows (no secondary button there). */
async function tapPlace(page: Page): Promise<void> {
  if (touchRow()) {
    await page.keyboard.down('KeyE');
    await page.keyboard.up('KeyE');
    return;
  }
  const box = await canvasBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
}

test('boots the world: every chunk drawn or culled, the centre ray on the ground', async () => {
  const s = await read();
  expect(s.chunks).toBeGreaterThanOrEqual(16);
  expect(s.drawn + s.culled).toBe(s.chunks);
  expect(s.drawn).toBeGreaterThan(0);
  expect(s.triangles).toBeGreaterThan(0);
  expect(s.growths).toBe(0);
  expect(s.hit).not.toBeNull();
  expect(s.gpuErrors).toBe(0);
  expect(pageErrors()).toEqual([]);
});

test('turning the view changes how many chunks are drawn', async () => {
  await aim(0, -0.45);
  await frames(2);
  const level = await read();
  await aim(0, -1.4);
  await expect.poll(async () => (await read()).drawn).not.toBe(level.drawn);
  const down = await read();
  expect(down.drawn + down.culled).toBe(down.chunks);
  expect(down.culled).toBeGreaterThan(level.culled);
  expect(pageErrors()).toEqual([]);
});

test('a click at the centre breaks the picked block, changing the triangles', async ({ page }) => {
  test.fixme(
    test.info().project.use.browserName === 'webkit',
    'Playwright drives touch through CDP, which is Chromium-only',
  );
  await aim(0, -0.45);
  await frames(2);
  const before = await read();
  expect(before.hit).not.toBeNull();
  await tapBreak(page);
  await expect.poll(async () => (await read()).broken).toBe(1);
  await expect.poll(async () => (await read()).triangles).not.toBe(before.triangles);
  await expect.poll(async () => (await read()).hit).not.toEqual(before.hit);
  expect((await read()).remeshes).toBeGreaterThan(before.remeshes);
  expect(pageErrors()).toEqual([]);
});

test('place then break rewrites the chunk in place: growths stays 0', async ({ page }) => {
  test.fixme(
    test.info().project.use.browserName === 'webkit',
    'Playwright drives touch through CDP, which is Chromium-only',
  );
  await aim(0, -0.45);
  await frames(2);
  const before = await read();
  await tapPlace(page);
  await expect.poll(async () => (await read()).placed).toBe(1);
  await expect.poll(async () => (await read()).triangles).not.toBe(before.triangles);
  // The new block is now what the centre ray hits; breaking it restores the view.
  await expect.poll(async () => (await read()).hit).not.toEqual(before.hit);
  await tapBreak(page);
  await expect.poll(async () => (await read()).broken).toBe(1);
  await expect.poll(async () => (await read()).triangles).toBe(before.triangles);
  await expect.poll(async () => (await read()).hit).toEqual(before.hit);
  const after = await read();
  expect(after.growths).toBe(0);
  expect(after.remeshes).toBeGreaterThanOrEqual(before.remeshes + 2);
  expect(after.gpuErrors).toBe(0);
  expect(pageErrors()).toEqual([]);
});
