/**
 * The cover fit (#1) and the zoomed-select specificity (#3), against harness/cover.html:
 * `createGame({ surface: { fit: { minVisibleHeight: 720, belowScale: PHONE_SCALE } } })`.
 *
 * On a phone the canvas covers the viewport with no bars, the visible logical rect keeps the
 * band, a tap lands on the logical point under it, and the overlay frame and
 * `Camera.fitFreeRect` follow the covered canvas. On larger screens the surface letterboxes as
 * before. On every row a game's `.cover-probe select` rule beats the engine's zoomed-select
 * rules, and the engine's own select widget keeps its divided padding.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessCoverState } from '../harness/cover-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

function readCover(frame: Frame): Promise<HarnessCoverState> {
  return frame.evaluate(() => {
    const read = window.__harnessCover;
    if (!read) throw new Error('window.__harnessCover missing');
    return JSON.parse(JSON.stringify(read())) as HarnessCoverState;
  });
}

async function openCover(page: Page, wrapper: 'top' | 'itch-iframe'): Promise<Frame> {
  let frame: Frame;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}cover.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('cover.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await readCover(frame).catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`createGame: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
  return frame;
}

const phone = () => test.info().project.name.startsWith('phone-');

test('a phone is covered with no bars, within the band', async ({ page, wrapper }) => {
  test.skip(!phone(), 'phone rows only (larger screens letterbox)');
  const frame = await openCover(page, wrapper);
  const s = await readCover(frame);
  const { container: c, rect: r, visible: v } = s;
  // The canvas covers the container: no bar on any side.
  expect(r.x).toBeLessThanOrEqual(0);
  expect(r.y).toBeLessThanOrEqual(0);
  expect(r.x + r.width).toBeGreaterThanOrEqual(c.width);
  expect(r.y + r.height).toBeGreaterThanOrEqual(c.height);
  expect(s.canvasBox.x).toBeLessThanOrEqual(0);
  expect(s.canvasBox.y).toBeLessThanOrEqual(0);
  expect(s.canvasBox.x + s.canvasBox.width).toBeGreaterThanOrEqual(c.width - 0.5);
  expect(s.canvasBox.y + s.canvasBox.height).toBeGreaterThanOrEqual(c.height - 0.5);
  // The letterbox would have left bars (the fit is the contain fit, untouched).
  expect(s.fitRect.x).toBeGreaterThan(0);
  // The visible rect: inside the design and at least the band tall, centred.
  expect(v.x).toBeGreaterThanOrEqual(0);
  expect(v.y).toBeGreaterThanOrEqual(0);
  expect(v.x + v.width).toBeLessThanOrEqual(1920 + 1e-6);
  expect(v.y + v.height).toBeLessThanOrEqual(1080 + 1e-6);
  expect(v.height).toBeGreaterThanOrEqual(s.band - 1);
  expect(v.height).toBeLessThan(1080);
  expect(Math.abs(v.y + v.height / 2 - 540)).toBeLessThan(2);
  // The overlay frame (--tc-frame-*) is the covered canvas.
  expect(Math.abs(s.hudBox.x - s.canvasBox.x)).toBeLessThan(1);
  expect(Math.abs(s.hudBox.y - s.canvasBox.y)).toBeLessThan(1);
  expect(Math.abs(s.hudBox.width - s.canvasBox.width)).toBeLessThan(1);
  expect(Math.abs(s.hudBox.height - s.canvasBox.height)).toBeLessThan(1);
  // Camera.fitFreeRect puts the whole design inside the free rect (what the UI leaves).
  const f = s.freeRect;
  expect(s.fitCorners.left).toBeGreaterThanOrEqual(f.x - 0.5);
  expect(s.fitCorners.top).toBeGreaterThanOrEqual(f.y - 0.5);
  expect(s.fitCorners.right).toBeLessThanOrEqual(f.x + f.width + 0.5);
  expect(s.fitCorners.bottom).toBeLessThanOrEqual(f.y + f.height + 0.5);
  expect(s.formFactor).toBe('phone-landscape');
});

test('a tap maps to the logical point under it on a covered phone', async ({ page, wrapper }) => {
  test.skip(!phone() || wrapper !== 'top', 'phone rows, top-level page');
  const frame = await openCover(page, wrapper);
  const { container: c, visible: v } = await readCover(frame);
  const cx = Math.round(c.width * 0.25);
  const cy = Math.round(c.height * 0.75);
  const cdp = await page.context().newCDPSession(page);
  // Press and release go out together, so a runner stall cannot turn the tap into a hold.
  await Promise.all([
    cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cx, y: cy, id: 1 }],
    }),
    cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  ]);
  await expect.poll(() => readCover(frame).then((s) => s.taps.length)).toBeGreaterThan(0);
  const tap = (await readCover(frame)).taps[0];
  // The container is the viewport and the visible rect spans it, so the point is linear in it.
  expect(tap.x).toBeCloseTo(v.x + (cx / c.width) * v.width, 0);
  expect(tap.y).toBeCloseTo(v.y + (cy / c.height) * v.height, 0);
});

test('larger screens keep the letterbox and show the whole design', async ({ page, wrapper }) => {
  test.skip(phone(), 'non-phone rows');
  const frame = await openCover(page, wrapper);
  const s = await readCover(frame);
  expect(s.rect).toEqual(s.fitRect);
  expect(s.visible).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
});

test("a game's select rule beats the engine's zoomed-select rules (#3)", async ({
  page,
  wrapper,
}) => {
  const frame = await openCover(page, wrapper);
  const { selects } = await readCover(frame);
  expect(selects.gamePadding).toBe('7px');
  // The engine's own select widget draws exactly as before: the token divided by the zoom.
  expect(selects.enginePadding).toBe(selects.engineExpected);
});
