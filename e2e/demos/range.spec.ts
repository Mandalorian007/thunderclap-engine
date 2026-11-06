/**
 * Range demo (`demos/range`) on every matrix row: look + pick + fx + spatial audio together.
 *
 * - boots the courtyard with no console errors and every target standing;
 * - `aimAt(index)` turns the view onto a known target and a click (touch rows: a tap, real touch
 *   events through CDP) knocks it over: `lastHit` is that index, `score` and `shots` are 1, and
 *   `RESET_SECONDS` of sim later the target stands again;
 * - a shot at the sky misses: `shots` grows, `score` and `targetsUp` do not;
 * - desktop rows run above 20 fps once settled.
 *
 * Server: the harness Vite server serves the demo at `/demos/range/` (the `serveDemos` plugin in
 * vite.harness.config.ts). The itch row embeds that route in the wrapper page (`?page=`).
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import { type RangeDemoApi, type RangeDemoState, TARGET_COUNT } from '../../demos/range/state';
import { expect, test } from '../fixtures';
import { HARNESS_URL, WRAPPER_URL } from '../ports';

const demoUrl = `${HARNESS_URL}demos/range/`;
let frame: Frame;
let touch = false;
let cdp: CDPSession | null = null;
const errors: string[] = [];

test.beforeEach(async ({ page, wrapper }) => {
  touch = test.info().project.use.hasTouch === true;
  cdp = null;
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(demoUrl);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(demoUrl)}`);
    await expect.poll(() => page.frames().some((f) => f.url().startsWith(demoUrl))).toBe(true);
    const f = page.frames().find((f) => f.url().startsWith(demoUrl));
    if (!f) throw new Error('range demo iframe not found');
    frame = f;
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`range demo: ${s.gpu}`);
      return s?.ready ? s.frame : -1;
    })
    .toBeGreaterThanOrEqual(3);
  // Mouse rows: park the pointer at the reticle once. A later move under a granted pointer lock
  // would turn the view, so every click lands where the pointer already is.
  if (!touch) {
    const c = await centre();
    await page.mouse.move(c.x, c.y);
  }
});

function read(): Promise<RangeDemoState> {
  return frame.evaluate(() => {
    const d = (window as unknown as { __demo?: RangeDemoApi }).__demo;
    if (!d) throw new Error('window.__demo missing');
    return JSON.parse(JSON.stringify(d.state)) as RangeDemoState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frame;
  await expect.poll(async () => (await read()).frame).toBeGreaterThanOrEqual(start + n);
}

async function centre(): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function aimAt(index: number): Promise<void> {
  return frame.evaluate((i) => {
    (window as unknown as { __demo: RangeDemoApi }).__demo.aimAt(i);
  }, index);
}

function aim(yaw: number, pitch: number): Promise<void> {
  return frame.evaluate(
    ([y, p]) => {
      (window as unknown as { __demo: RangeDemoApi }).__demo.aim(y, p);
    },
    [yaw, pitch] as const,
  );
}

/** A shot: a tap at the screen centre (touch rows, CDP) or a click where the mouse rests. */
async function shoot(page: Page): Promise<void> {
  if (touch) {
    const c = await centre();
    cdp ??= await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: c.x, y: c.y, id: 1 }],
    });
    await frames(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.down();
    await page.mouse.up();
  }
}

/** Errors the page threw, minus the browser's own note when it refuses the pointer lock. */
const pageErrors = () => errors.filter((e) => !/pointer ?lock/i.test(e));

test('boots the courtyard with every target standing', async () => {
  const s = await read();
  expect(s.targetsUp).toBe(TARGET_COUNT);
  expect(s.score).toBe(0);
  expect(s.shots).toBe(0);
  expect(s.lastHit).toBeNull();
  // The ground, four walls, twelve posts and twelve plates; culled ones still count.
  expect(s.stats.instances + s.stats.culled).toBeGreaterThanOrEqual(29);
  expect(s.gpuErrors).toBe(0);
  expect(Math.hypot(...s.aimDir)).toBeCloseTo(1, 5);
  expect(pageErrors()).toEqual([]);
});

test('a shot at a known target knocks it over, then it resets', async ({ page }) => {
  await aimAt(3);
  const aimed = await read();
  expect(aimed.aimDir[2]).toBeLessThan(0);
  await shoot(page);
  await expect.poll(async () => (await read()).shots).toBe(1);
  const hit = await read();
  expect(hit.lastHit).toBe(3);
  expect(hit.score).toBe(1);
  expect(hit.targetsUp).toBe(TARGET_COUNT - 1);
  // RESET_SECONDS of sim after the hit the plate is standing again (fall + reset + rise).
  await expect.poll(async () => (await read()).targetsUp, { timeout: 8_000 }).toBe(TARGET_COUNT);
  expect((await read()).score).toBe(1);
  expect(pageErrors()).toEqual([]);
});

test('a shot at the sky misses', async ({ page }) => {
  await aim(0, 1.2);
  await shoot(page);
  await expect.poll(async () => (await read()).shots).toBe(1);
  const s = await read();
  expect(s.lastHit).toBeNull();
  expect(s.score).toBe(0);
  expect(s.targetsUp).toBe(TARGET_COUNT);
  expect(pageErrors()).toEqual([]);
});

test('touch: a tap fires', async ({ page }) => {
  test.skip(!touch, 'touch rows only');
  await aimAt(8);
  await shoot(page);
  await expect.poll(async () => (await read()).shots).toBe(1);
  expect((await read()).lastHit).toBe(8);
  expect(pageErrors()).toEqual([]);
});

test('desktop: runs above 20 fps', async () => {
  test.skip(!/^desktop-/.test(test.info().project.name), 'desktop rows only');
  await frames(40);
  await expect.poll(async () => (await read()).fps).toBeGreaterThan(20);
  expect(pageErrors()).toEqual([]);
});
