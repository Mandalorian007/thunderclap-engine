/**
 * World panels (ws/ui-world-panel) on every matrix row, against harness/world-panel.html: two
 * panels on the walls of a `geom` room and one head-locked, every widget on each, hit by the
 * mouse ray (mouse rows) or a touch ray (touch rows, real touch events through CDP).
 *
 * - a click at a button's world position (projected here from the camera's `viewProjection`)
 *   presses it: `pressed` increments on the wall panels and on the head-locked one;
 * - dragging the slider's knob along its track changes `slider` by the dragged fraction;
 * - (mouse rows) hovering a button sets `hover`; leaving the panel clears it;
 * - `uploads` stops growing within three frames of the last change;
 * - the head-locked panel stays `distance` from the eye as the camera moves.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessWorldPanelState, WorldPoint } from '../harness/world-panel-state';
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
    await page.goto(`${HARNESS_URL}world-panel.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('world-panel.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`world-panel demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
});

/** The state, with `canvas` as the page sees it (the wrapper rows offset the frame). */
async function read(): Promise<HarnessWorldPanelState> {
  const s = await frame.evaluate(() => {
    const api = window.__harnessWorldPanel;
    if (!api) throw new Error('window.__harnessWorldPanel missing');
    return JSON.parse(JSON.stringify(api.state())) as HarnessWorldPanelState;
  });
  if (s.ready && s.gpu === 'ok') {
    const box = await frame.locator('canvas').first().boundingBox();
    if (box) s.canvas = box;
  }
  return s;
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function aim(eye: WorldPoint, target: WorldPoint): Promise<void> {
  await frame.evaluate(([e, t]) => window.__harnessWorldPanel?.aim(e, t), [eye, target] as const);
  await frames(2);
}

/** World point → client px through the state's matrix and canvas box; null behind the camera. */
function project(s: HarnessWorldPanelState, w: WorldPoint): Pt | null {
  const m = s.viewProjection;
  const c = [0, 1, 2, 3].map(
    (r) => m[r]! * w[0] + m[4 + r]! * w[1] + m[8 + r]! * w[2] + m[12 + r]!,
  );
  const cw = c[3]!;
  if (cw <= 0) return null;
  const sx = s.screen.x + ((c[0]! / cw + 1) / 2) * s.screen.width;
  const sy = s.screen.y + ((1 - c[1]! / cw) / 2) * s.screen.height;
  return {
    x: s.canvas.x + (sx / s.logical.width) * s.canvas.width,
    y: s.canvas.y + (sy / s.logical.height) * s.canvas.height,
  };
}

/** The client px of widget `id`'s centre now. */
async function widgetAt(id: string): Promise<Pt> {
  const s = await read();
  const w = s.widgets[id];
  if (!w) throw new Error(`no widget ${id}`);
  const p = project(s, w);
  if (!p) throw new Error(`${id} is behind the camera`);
  return p;
}

/** A press at `from`, a drag through `via`, a release at `to` (touch through CDP, else mouse). */
async function drag(page: Page, from: Pt, via: Pt[], to: Pt): Promise<void> {
  if (touch) {
    cdp ??= await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    await frames(1);
    for (const p of [...via, to]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: p.x, y: p.y, id: 1 }],
      });
      await frames(1);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(from.x, from.y);
    await frames(1);
    await page.mouse.down();
    await frames(1);
    for (const p of [...via, to]) {
      await page.mouse.move(p.x, p.y);
      await frames(1);
    }
    await page.mouse.up();
  }
  await frames(2);
}

const tap = (page: Page, p: Pt) => drag(page, p, [], p);

test('boots three panels with no GPU error and nothing pressed', async () => {
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(s.pressed).toEqual({});
  expect(s.hover).toBeNull();
  expect(s.uploads).toBeGreaterThanOrEqual(3);
  expect(s.headLockedDistance).toBeCloseTo(2, 2);
  for (const id of ['a-button', 'b-button', 'hud-button', 'a-slider', 'a-list']) {
    expect(s.widgets[id], id).toBeDefined();
  }
  expect(errors).toEqual([]);
});

test('a click at a button world position presses it, on each wall and head-locked', async ({
  page,
}) => {
  await tap(page, await widgetAt('a-button'));
  await expect.poll(async () => (await read()).pressed['a-button']).toBe(1);
  await tap(page, await widgetAt('a-button'));
  await expect.poll(async () => (await read()).pressed['a-button']).toBe(2);
  await tap(page, await widgetAt('b-button2'));
  await expect.poll(async () => (await read()).pressed['b-button2']).toBe(1);
  await tap(page, await widgetAt('hud-button'));
  await expect.poll(async () => (await read()).pressed['hud-button']).toBe(1);
  const s = await read();
  expect(s.pressed).toEqual({ 'a-button': 2, 'b-button2': 1, 'hud-button': 1 });
  // A tap on the wall beside the panel presses nothing.
  const beside = project(s, [2.5, 2.4, -5.99])!;
  await tap(page, beside);
  await frames(2);
  expect((await read()).pressed).toEqual(s.pressed);
  expect(errors).toEqual([]);
});

test('toggle and list respond to a tap', async ({ page }) => {
  await tap(page, await widgetAt('a-toggle'));
  await expect.poll(async () => (await read()).toggle).toBe(true);
  // The list shows three rows; its centre is the second row.
  await tap(page, await widgetAt('a-list'));
  await expect.poll(async () => (await read()).listSelected).toBe(1);
  expect(errors).toEqual([]);
});

test('dragging the slider knob along the track changes slider by the dragged fraction', async ({
  page,
}) => {
  const s = await read();
  expect(s.slider).toBe(50);
  const from = project(s, s.sliderTrack.from)!;
  const to = project(s, s.sliderTrack.to)!;
  const at = (f: number): Pt => ({
    x: from.x + (to.x - from.x) * f,
    y: from.y + (to.y - from.y) * f,
  });
  await drag(page, at(0.5), [at(0.6), at(0.7)], at(0.8));
  let v = (await read()).slider;
  expect(v).toBeGreaterThan(76);
  expect(v).toBeLessThan(84);
  await drag(page, at(0.8), [at(0.5)], at(0.2));
  v = (await read()).slider;
  expect(v).toBeGreaterThan(16);
  expect(v).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test('hover follows the mouse onto a button and clears when it leaves', async ({ page }) => {
  test.skip(touch, 'touch has no hover');
  const p = await widgetAt('a-button2');
  await page.mouse.move(p.x, p.y);
  await expect.poll(async () => (await read()).hover).toBe('a-button2');
  const s = await read();
  await page.mouse.move(s.canvas.x + 8, s.canvas.y + 8);
  await expect.poll(async () => (await read()).hover).toBeNull();
  expect((await read()).pressed).toEqual({});
  expect(errors).toEqual([]);
});

test('uploads stop within three frames of the last change', async ({ page }) => {
  await tap(page, await widgetAt('a-button'));
  await expect.poll(async () => (await read()).pressed['a-button']).toBe(1);
  if (!touch) {
    const s = await read();
    await page.mouse.move(s.canvas.x + 8, s.canvas.y + 8);
  }
  await frames(3);
  const settled = (await read()).uploads;
  await frames(6);
  const s = await read();
  expect(s.uploads).toBe(settled);
  expect(s.repaints).toBeLessThanOrEqual(s.uploads);
  expect(errors).toEqual([]);
});

test('the head-locked panel stays at its distance as the camera moves', async () => {
  const before = await read();
  const hudBefore = before.widgets['hud-button']!;
  expect(before.headLockedDistance).toBeCloseTo(2, 2);
  await aim([-2, 3, 3], [4, 1, -5]);
  const after = await read();
  expect(after.headLockedDistance).toBeCloseTo(2, 2);
  const moved = Math.hypot(
    after.widgets['hud-button']![0] - hudBefore[0],
    after.widgets['hud-button']![1] - hudBefore[1],
    after.widgets['hud-button']![2] - hudBefore[2],
  );
  expect(moved).toBeGreaterThan(1);
  // The panel sits where the camera looks: its button projects to the same place as before.
  const a = project(before, hudBefore)!;
  const b = project(after, after.widgets['hud-button']!)!;
  expect(Math.abs(a.x - b.x)).toBeLessThan(2);
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  // The wall panels did not move.
  expect(after.widgets['a-button']).toEqual(before.widgets['a-button']);
  expect(errors).toEqual([]);
});
