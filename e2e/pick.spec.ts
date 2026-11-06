/**
 * Mesh picking (ws/pick) on every matrix row, against harness/pick.html: six spinning meshes,
 * each on a `meshTester` over the geometry it draws, selected by click (mouse rows) or tap
 * (touch rows, real touch events through CDP).
 *
 * - boots: six meshes are recorded (culled ones counted) with no GPU error;
 * - a click at the centre of a mesh's screen position hits that mesh, with a world point near it
 *   and a unit normal; a second one on another mesh moves the pick;
 * - a click on empty sky hits nothing (`hit` null) and clears the pick.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessPickState } from '../harness/pick-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}

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
    await page.goto(`${HARNESS_URL}pick.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('pick.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`pick demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
});

function read(): Promise<HarnessPickState> {
  return frame.evaluate(() => {
    const s = window.__harnessPick?.state;
    if (!s) throw new Error('window.__harnessPick missing');
    return JSON.parse(JSON.stringify(s)) as HarnessPickState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: Pt): Promise<Pt> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** The centre of mesh `id` on the page now. */
async function centreOf(id: string): Promise<Pt> {
  const p = (await read()).screenPositions[id];
  if (!p) throw new Error(`no screen position for ${id}`);
  return toPage(p);
}

/** A tap (touch rows, CDP) or a click (mouse). */
async function tap(page: Page, p: Pt): Promise<void> {
  if (touch) {
    cdp ??= await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: p.x, y: p.y, id: 1 }],
    });
    await frames(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(p.x, p.y);
    await frames(1);
    await page.mouse.down();
    await page.mouse.up();
  }
}

test('boots six pickable meshes', async () => {
  const s = await read();
  expect(s.instances + s.culled).toBe(6);
  expect(s.gpuErrors).toBe(0);
  expect(s.hit).toBeNull();
  expect(Object.keys(s.screenPositions).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  expect(errors).toEqual([]);
});

test('a click at a mesh centre picks that mesh; another moves the pick', async ({ page }) => {
  await tap(page, await centreOf('b'));
  await expect.poll(async () => (await read()).selects).toBe(1);
  let s = await read();
  expect(s.hit).toBe('b');
  // Mesh b is the icosphere of radius 1 (scale 2) at (0, 2.6, -2): the hit sits on one of its
  // flat faces, just inside the sphere.
  expect(s.hitPoint).not.toBeNull();
  const [x, y, z] = s.hitPoint!;
  const r = Math.hypot(x, y - 2.6, z + 2);
  expect(r).toBeGreaterThan(0.85);
  expect(r).toBeLessThanOrEqual(1.001);
  expect(s.hitNormal).not.toBeNull();
  expect(Math.hypot(...s.hitNormal!)).toBeCloseTo(1, 5);
  // The eye is at (0, 4.5, 13): about 15 units away.
  expect(s.hitDistance).toBeGreaterThan(13);
  expect(s.hitDistance).toBeLessThan(16);

  await tap(page, await centreOf('f'));
  await expect.poll(async () => (await read()).selects).toBe(2);
  s = await read();
  expect(s.hit).toBe('f');
  expect(s.hitPoint![0]).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('a click on empty sky picks nothing', async ({ page }) => {
  await tap(page, await centreOf('a'));
  await expect.poll(async () => (await read()).hit).toBe('a');
  // The top-left corner shows sky only.
  await tap(page, await toPage({ x: 60, y: 60 }));
  await expect.poll(async () => (await read()).selects).toBe(2);
  const s = await read();
  expect(s.hit).toBeNull();
  expect(s.hitPoint).toBeNull();
  expect(errors).toEqual([]);
});
