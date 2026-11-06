/**
 * Input (ws/input-3) on every matrix row, against harness/input.html: orbit look, rebinding,
 * hold and chord triggers, the pan candidate, device tracking and prompt glyphs.
 *
 * - every row: an orbit drag (mouse on desktop rows, a touch through CDP on touch rows) turns
 *   the cube without the pointer lock; a slow drag (3 px, a pinned 500 ms gap, 12 px) is a pan,
 *   not a long press;
 * - keyboard rows: `listen` rebinds `jump` to the next key and lists conflicts; hold C fires
 *   after 400 ms and not before; Shift+K fires once and rumbles once; `lastDevice` follows the
 *   keyboard, the mouse and the keyboard again; `jump`'s glyph reads `Space`.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessInputState } from '../harness/input-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];
const touchRow = () => test.info().project.use.hasTouch === true;

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});

async function open(page: Page, wrapper: 'top' | 'itch-iframe', query = ''): Promise<void> {
  const path = `input.html${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`input demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
  // Keys go to the page (the iframe too) without a click, which would start a gesture.
  await frame.locator('body').focus();
}

function read(): Promise<HarnessInputState> {
  return frame.evaluate(() => {
    const s = window.__harnessInput?.state;
    if (!s) throw new Error('window.__harnessInput missing');
    return JSON.parse(JSON.stringify(s)) as HarnessInputState;
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

/** A point on the canvas away from the panel in its top-left corner. */
async function centre(): Promise<{ x: number; y: number }> {
  const box = await canvasBox();
  return { x: box.x + box.width * 0.6, y: box.y + box.height * 0.55 };
}

function touchAt(cdp: CDPSession, type: 'touchStart' | 'touchMove', x: number, y: number) {
  return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id: 1 }] });
}

interface Drag {
  /** Move the held pointer to (x, y) and wait a frame. */
  move(x: number, y: number): Promise<void>;
  /** Lift it. */
  up(): Promise<void>;
}

/** Press at `from` on the row's device (a touch through CDP, else the mouse). */
async function press(page: Page, from: { x: number; y: number }): Promise<Drag> {
  if (touchRow()) {
    const cdp = await page.context().newCDPSession(page);
    await touchAt(cdp, 'touchStart', from.x, from.y);
    return {
      async move(x, y) {
        await touchAt(cdp, 'touchMove', x, y);
        await frames(1);
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      },
    };
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  return {
    async move(x, y) {
      await page.mouse.move(x, y);
      await frames(1);
    },
    up: () => page.mouse.up(),
  };
}

test('boots the cube with no errors, in locked mode by default', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.mode).toBe('locked');
  expect(s.locked).toBe(false);
  expect(s.gpuErrors).toBe(0);
  expect(s.conflicts).toEqual([]);
  expect(JSON.parse(s.bindings).jump).toEqual([
    { key: 'Space' },
    { padButton: 0 },
    { gesture: 'tap' },
  ]);
  expect(errors).toEqual([]);
});

test('orbit: a drag turns the cube without the pointer lock', async ({ page, wrapper }) => {
  await open(page, wrapper, '?orbit');
  const before = await read();
  expect(before.mode).toBe('orbit');
  const from = await centre();
  const drag = await press(page, from);
  for (let k = 1; k <= 6; k++) await drag.move(from.x + 20 * k, from.y);
  // A drag right turns right (polled: slow frames coalesce events, E-017).
  await expect.poll(async () => (await read()).yaw).toBeGreaterThan(before.yaw + 0.05);
  await drag.up();
  await frames(2);
  const after = await read();
  expect(after.locked).toBe(false);
  // The view rests once the pointer is up.
  await page.mouse.move(from.x + 300, from.y + 100);
  await frames(2);
  expect((await read()).yaw).toBe(after.yaw);
  expect(errors).toEqual([]);
});

test('a slow drag (3 px, a 500 ms gap, 12 px) is a pan, not a long press', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const from = await centre();
  await frame.evaluate(() => window.__harnessInput?.setClock(1000));
  const drag = await press(page, from);
  await drag.move(from.x + 3, from.y);
  await frames(2);
  expect((await read()).panOrLong).toBeNull();
  // The gesture clock jumps 500 ms with the pointer still down and barely moved.
  await frame.evaluate(() => window.__harnessInput?.setClock(1500));
  await frames(3);
  expect((await read()).panOrLong).toBeNull();
  await drag.move(from.x + 12, from.y);
  await expect.poll(async () => (await read()).panOrLong).toBe('pan');
  await drag.up();
  await frame.evaluate(() => window.__harnessInput?.setClock(null));
  expect(errors).toEqual([]);
});

test('keyboard: listen rebinds jump to the next key and lists conflicts', async ({
  page,
  wrapper,
}) => {
  test.skip(touchRow(), 'keyboard rows only');
  await open(page, wrapper);
  await frame.evaluate(() => void window.__harnessInput?.listen('jump'));
  await expect.poll(async () => (await read()).listening).toBe('jump');
  await page.keyboard.press('KeyJ');
  await expect
    .poll(async () => JSON.parse((await read()).bindings).jump)
    .toEqual([{ key: 'KeyJ' }]);
  await expect.poll(async () => (await read()).listening).toBeNull();
  // Escape cancels a listen and keeps the binding.
  await frame.evaluate(() => void window.__harnessInput?.listen('jump'));
  await expect.poll(async () => (await read()).listening).toBe('jump');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read()).listening).toBeNull();
  expect(JSON.parse((await read()).bindings).jump).toEqual([{ key: 'KeyJ' }]);
  // Rebinding onto fire's key is a conflict the panel lists (a hold on C would not be: a press
  // and a hold on one key are different bindings).
  await frame.evaluate(() => void window.__harnessInput?.listen('jump'));
  await expect.poll(async () => (await read()).listening).toBe('jump');
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await read()).conflicts).toEqual(['F: jump, fire']);
  expect(errors).toEqual([]);
});

test('keyboard: hold C fires after 400 ms, not at 200 ms', async ({ page, wrapper }) => {
  test.skip(touchRow(), 'keyboard rows only');
  await open(page, wrapper);
  await page.keyboard.down('KeyC');
  await expect.poll(async () => (await read()).holdProgress).toBeGreaterThan(0);
  await expect.poll(async () => (await read()).holdFired, { timeout: 10_000 }).toBe(1);
  const s = await read();
  expect(s.holdFiredAfterMs).toBeGreaterThanOrEqual(350);
  expect(s.holdProgress).toBe(1);
  await page.keyboard.up('KeyC');
  await expect.poll(async () => (await read()).holdProgress).toBe(0);
  expect((await read()).holdFired).toBe(1);
  // A tap never fires; under load a "tap" can outlast 400 ms, and then it fired late, not early.
  await page.keyboard.press('KeyC');
  await frames(3);
  const tapped = await read();
  if (tapped.holdFired > 1) expect(tapped.holdFiredAfterMs).toBeGreaterThanOrEqual(350);
  expect(errors).toEqual([]);
});

test('keyboard: the Shift+K chord fires once and rumbles once', async ({ page, wrapper }) => {
  test.skip(touchRow(), 'keyboard rows only');
  await open(page, wrapper);
  await page.keyboard.down('ShiftLeft');
  await frames(2);
  expect((await read()).chordFired).toBe(0);
  await page.keyboard.down('KeyK');
  await expect.poll(async () => (await read()).chordFired).toBe(1);
  await frames(5);
  const s = await read();
  expect(s.chordFired).toBe(1);
  expect(s.rumbles).toBe(1);
  await page.keyboard.up('KeyK');
  await page.keyboard.up('ShiftLeft');
  await frames(2);
  expect((await read()).chordFired).toBe(1);
  expect(errors).toEqual([]);
});

test('keyboard: lastDevice follows keyboard, mouse, keyboard; jump reads Space', async ({
  page,
  wrapper,
}) => {
  test.skip(touchRow(), 'keyboard rows only');
  await open(page, wrapper);
  const from = await centre();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await read()).lastDevice).toBe('keyboard');
  expect((await read()).glyph).toBe('Space');
  await page.mouse.move(from.x, from.y);
  await page.mouse.move(from.x + 10, from.y);
  await expect.poll(async () => (await read()).lastDevice).toBe('mouse');
  // No mouse binding for jump: the glyph falls back to the first binding.
  expect((await read()).glyph).toBe('Space');
  await page.keyboard.press('Space');
  await expect.poll(async () => (await read()).lastDevice).toBe('keyboard');
  expect((await read()).glyph).toBe('Space');
  expect(errors).toEqual([]);
});
