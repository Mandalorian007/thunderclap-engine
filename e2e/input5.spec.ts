/**
 * ws/input-5 on every matrix row, against harness/input5.html (a 2D canvas, no WebGPU): action
 * contexts, the input buffer, the three stick shapes, gyro aim from a fake rotation rate,
 * `Look.onTap` (a click or a touch tap through CDP; a drag does not tap) and the all-pointer
 * record lane replaying a two-thumb session. Every moving value is polled (E-017).
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessInput5State } from '../harness/input5-state';
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

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function open(page: Page, wrapper: 'top' | 'itch-iframe', query: string): Promise<void> {
  const path = `input5.html${query}`;
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
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
  await frame.locator('body').focus();
}

function read(): Promise<HarnessInput5State> {
  return frame.evaluate(() => {
    const s = window.__harnessInput5?.state;
    if (!s) throw new Error('window.__harnessInput5 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessInput5State;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function ticks(n: number): Promise<void> {
  const start = (await read()).ticks;
  await expect.poll(async () => (await read()).ticks).toBeGreaterThanOrEqual(start + n);
}

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

function touchAt(cdp: CDPSession, type: 'touchStart' | 'touchMove', x: number, y: number) {
  return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id: 1 }] });
}

/** Press at `from`, move through `path`, lift: a touch through CDP on touch rows, else the mouse. */
async function gesture(
  page: Page,
  from: { x: number; y: number },
  path: { x: number; y: number }[],
) {
  if (touchRow()) {
    const cdp = await page.context().newCDPSession(page);
    await touchAt(cdp, 'touchStart', from.x, from.y);
    for (const p of path) await touchAt(cdp, 'touchMove', p.x, p.y);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const p of path) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
}

test('?contexts: the menu pushed at 1 s silences attack and takes J; Escape pops it', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?contexts');
  await expect.poll(async () => (await read()).context).toBe('menu');
  await page.keyboard.press('KeyJ');
  await expect.poll(async () => (await read()).confirmFired).toBe(1);
  expect((await read()).attackFired).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read()).context).toBeNull();
  await page.keyboard.press('KeyJ');
  await expect.poll(async () => (await read()).attackFired).toBe(1);
  expect((await read()).confirmFired).toBe(1);
});

test('?buffer: a press 3 ticks early is buffered once, 7 ticks late it is not', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?buffer');
  await expect.poll(async () => (await read()).bufferedLate).not.toBeNull();
  const s = await read();
  expect(s.buffered).toBe(true);
  expect(s.consumed).toBe(true);
  expect(s.bufferedAfter).toBe(false);
  expect(s.bufferedLate).toBe(false);
});

test('?stick&still: radial, axial and scaled radial shape one parked stick', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?stick&still');
  await expect.poll(async () => (await read()).radial[0]).toBeCloseTo(0.6, 5);
  const s = await read();
  expect(s.radial[1]).toBeCloseTo(0.1, 5);
  // Axial drops the 0.1 axis inside the 0.15 dead zone.
  expect(s.axial).toEqual([0.6, 0]);
  // Scaled radial: the length rescaled past the dead zone, the direction kept.
  const m = Math.hypot(0.6, 0.1);
  const k = (m - 0.15) / 0.85 / m;
  expect(s.scaledRadial[0]).toBeCloseTo(0.6 * k, 5);
  expect(s.scaledRadial[1]).toBeCloseTo(0.1 * k, 5);
  // Released, the stick moves and the shapes follow.
  await frame.evaluate(() => window.__harnessInput5?.setStill(false));
  await expect.poll(async () => (await read()).raw[1]).not.toBe(0.1);
});

test('?gyro: a fake rotation rate turns the camera right and up; ?still holds it', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?gyro');
  await expect.poll(async () => (await read()).yaw).toBeGreaterThan(0.3);
  expect((await read()).pitch).toBeGreaterThan(0);
  await open(page, wrapper, '?gyro&still');
  await ticks(30);
  const s = await read();
  expect(s.yaw).toBe(0);
  expect(s.pitch).toBe(0);
});

test('?tap: a click or a touch tap reports once in logical px; a drag does not tap', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?tap');
  const box = await canvasBox();
  const at = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.5 };
  await gesture(page, at, []);
  await expect.poll(async () => (await read()).taps.length).toBe(1);
  const [x, y] = (await read()).taps[0]!;
  expect(Math.abs(x - 720)).toBeLessThanOrEqual(2);
  expect(Math.abs(y - 270)).toBeLessThanOrEqual(2);
  const from = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.5 };
  await gesture(page, from, [
    { x: from.x + 15, y: from.y },
    { x: from.x + 40, y: from.y },
  ]);
  await frames(3);
  expect((await read()).taps.length).toBe(1);
});

test('?replay: a recorded two-thumb session replays to identical action states', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?replay');
  await expect.poll(async () => (await read()).match, { timeout: 20_000 }).not.toBeNull();
  const s = await read();
  expect(s.recorded).toBe(100);
  expect(s.replayed).toBe(100);
  expect(s.match).toBe(true);
});
