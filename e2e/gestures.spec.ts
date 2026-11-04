/**
 * Engine gestures (ws/gestures) on every matrix row, against the gestures harness page
 * (harness/gestures.html, no WebGPU): real touch events through CDP on the touch rows (iPad and
 * the four phones), real mouse events on desktop and inside the itch-style cross-origin iframe.
 *
 * - tap at a game-space point through the letterbox transform, and the `select` action;
 * - the tap-versus-pan boundary in CSS px (a 6 px wobble is a tap, a 30 px move is a drag);
 * - long-press timing (a 150 ms press taps, a 700 ms press is `info` and never taps);
 * - double tap;
 * - drag origin, and drag-off into the letterbox bar (outside the game rect);
 * - `blocked()` (nothing while blocked; a running drag gets one cancel);
 * - pinch with two real touches (touch rows only).
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { GestureLogEntry, HarnessGesturesState } from '../harness/gestures-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

/** CSS px in the page's viewport. */
interface Pt {
  x: number;
  y: number;
}

let frame: Frame;
let touch = false;

test.beforeEach(async ({ page, wrapper }) => {
  touch = test.info().project.use.hasTouch === true;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}gestures.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=gestures.html`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
});

function read(): Promise<HarnessGesturesState> {
  return frame.evaluate(() => {
    const s = window.__harnessGestures?.state;
    if (!s) throw new Error('window.__harnessGestures missing');
    return JSON.parse(JSON.stringify(s)) as HarnessGesturesState;
  });
}

async function clear(): Promise<void> {
  await frame.evaluate(() => window.__harnessGestures?.clear());
}

async function setBlocked(b: boolean): Promise<void> {
  await frame.evaluate((v) => window.__harnessGestures?.setBlocked(v), b);
}

/** Maps game space to page CSS px (the stage's box on the page, iframe included). */
async function stageMapper(): Promise<{ toPage: (x: number, y: number) => Pt; scale: number }> {
  const box = await frame.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage');
  const { logical } = await read();
  const scale = box.width / logical.width;
  return { toPage: (x, y) => ({ x: box.x + x * scale, y: box.y + y * scale }), scale };
}

/** Waits a few page frames so the harness ticks between steps. */
async function frames(n = 2): Promise<void> {
  await frame.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count;
        const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** One real pointer: CDP touch on the touch rows, the mouse elsewhere. */
class Finger {
  private cdp: CDPSession | null = null;
  constructor(private readonly page: Page) {}

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
    });
  }

  async down(p: Pt): Promise<void> {
    if (touch) return this.send('touchStart', [p]);
    await this.page.mouse.move(p.x, p.y);
    await this.page.mouse.down();
  }
  async move(p: Pt): Promise<void> {
    if (touch) return this.send('touchMove', [p]);
    await this.page.mouse.move(p.x, p.y);
  }
  async up(): Promise<void> {
    if (touch) return this.send('touchEnd', []);
    await this.page.mouse.up();
  }
  /** Down at `from`, move in `steps` to `to` (a frame between steps), up. */
  async drag(from: Pt, to: Pt, steps = 6): Promise<void> {
    await this.down(from);
    await frames(1);
    for (let i = 1; i <= steps; i++) {
      await this.move({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await frames(1);
    }
    await this.up();
  }
  async tap(p: Pt): Promise<void> {
    await this.down(p);
    await this.up();
  }
  /** Two touches (touch rows only). */
  async two(type: 'touchStart' | 'touchMove', a: Pt, b: Pt): Promise<void> {
    await this.send(type, [a, b]);
  }
  async lift(): Promise<void> {
    await this.send('touchEnd', []);
  }
}

const of = (log: GestureLogEntry[], kind: GestureLogEntry['kind']) =>
  log.filter((e) => e.kind === kind);

const device = () => (touch ? 'touch' : 'mouse');

test('a tap reports a game-space point and presses its bound action', async ({ page }) => {
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  await f.tap(toPage(200, 150));
  await expect.poll(async () => (await read()).pressed.select ?? 0).toBe(1);
  await frames(3);
  const s = await read();
  const [tap] = of(s.log, 'tap');
  expect(tap?.device).toBe(device());
  expect(tap?.inside).toBe(true);
  expect(Math.abs((tap?.x ?? 0) - 200)).toBeLessThanOrEqual(2);
  expect(Math.abs((tap?.y ?? 0) - 150)).toBeLessThanOrEqual(2);
  expect(s.released.select).toBe(1);
  expect(of(s.log, 'drag')).toEqual([]);
  expect(s.pressed.info ?? 0).toBe(0);
});

test('tap versus pan: the threshold is 10 CSS px on every row', async ({ page }) => {
  const { toPage, scale } = await stageMapper();
  const f = new Finger(page);
  // A 6 CSS px wobble: still a tap.
  const a = toPage(400, 300);
  await f.drag(a, { x: a.x + 6, y: a.y }, 3);
  await expect.poll(async () => (await read()).pressed.select ?? 0).toBe(1);
  await frames(3);
  expect(of((await read()).log, 'drag')).toEqual([]);
  await clear();

  // A 30 CSS px move: a pan and a drag, no tap. Game-space travel is 30 / scale.
  await f.drag(a, { x: a.x + 30, y: a.y }, 6);
  await expect.poll(async () => (await read()).released.grab ?? 0).toBe(1);
  await frames(2);
  const s = await read();
  expect(s.pressed.select ?? 0).toBe(0);
  expect(s.pressed.grab).toBe(1);
  expect(s.pressed.scroll).toBe(1);
  const drags = of(s.log, 'drag');
  expect(drags[0]?.phase).toBe('start');
  expect(drags.at(-1)?.phase).toBe('end');
  const travel = drags.reduce((sum, e) => sum + (e.dx ?? 0), 0);
  expect(Math.abs(travel - 30 / scale)).toBeLessThanOrEqual(2 / scale);
  expect(drags[0]?.device).toBe(device());
});

test('long-press fires after its time and never taps; a short press taps', async ({ page }) => {
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  const p = toPage(300, 300);
  await f.down(p);
  await page.waitForTimeout(150);
  await f.up();
  await expect.poll(async () => (await read()).pressed.select ?? 0).toBe(1);
  expect((await read()).pressed.info ?? 0).toBe(0);
  await clear();

  await f.down(p);
  await expect.poll(async () => (await read()).pressed.info ?? 0).toBe(1);
  // Held: info stays held until the finger lifts.
  await page.waitForTimeout(250);
  expect((await read()).released.info ?? 0).toBe(0);
  await f.up();
  await expect.poll(async () => (await read()).released.info ?? 0).toBe(1);
  await frames(3);
  const s = await read();
  expect(s.pressed.select ?? 0).toBe(0);
  const [lp] = of(s.log, 'longPress');
  expect(Math.abs((lp?.x ?? 0) - 300)).toBeLessThanOrEqual(2);
});

test('double tap presses zoom once, with a tap for each tap', async ({ page }) => {
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  const p = toPage(500, 200);
  await f.tap(p);
  await f.tap({ x: p.x + 3, y: p.y });
  await expect.poll(async () => (await read()).pressed.zoom ?? 0).toBe(1);
  await frames(3);
  const s = await read();
  expect(s.pressed.select).toBe(2);
  expect(of(s.log, 'doubleTap')).toHaveLength(1);
});

test('drag keeps its origin, and dragging off the game rect reports outside', async ({ page }) => {
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  const from = toPage(100, 300);
  // Into the left letterbox bar: every landscape row has one for a 4:3 stage.
  const bar = toPage(-20, 300);
  expect(bar.x).toBeGreaterThan(0);
  await f.drag(from, toPage(60, 300), 4);
  await expect.poll(async () => (await read()).released.grab ?? 0).toBe(1);
  let drags = of((await read()).log, 'drag');
  for (const d of drags) {
    expect(Math.abs((d.origin?.x ?? 0) - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs((d.origin?.y ?? 0) - 300)).toBeLessThanOrEqual(2);
  }
  expect(Math.abs((drags.at(-1)?.x ?? 0) - 60)).toBeLessThanOrEqual(2);
  await clear();

  await f.drag(from, bar, 6);
  await expect.poll(async () => (await read()).released.grab ?? 0).toBe(1);
  drags = of((await read()).log, 'drag');
  const end = drags.at(-1);
  expect(end?.phase).toBe('end');
  expect(end?.inside).toBe(false);
  expect(end?.origin?.inside).toBe(true);
  // The last inside position stays in the game rect.
  expect(end?.x ?? -1).toBeGreaterThanOrEqual(0);
});

test('blocked: nothing is reported, and a running drag is cancelled once', async ({ page }) => {
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  await setBlocked(true);
  await f.tap(toPage(400, 300));
  await f.drag(toPage(400, 300), toPage(500, 300), 3);
  await frames(4);
  let s = await read();
  expect(s.log).toEqual([]);
  expect(s.pressed).toEqual({});
  await setBlocked(false);

  const a = toPage(300, 300);
  await f.down(a);
  await frames(1);
  await f.move({ x: a.x + 40, y: a.y });
  await expect.poll(async () => (await read()).pressed.grab ?? 0).toBe(1);
  await setBlocked(true);
  await frames(3);
  await f.move({ x: a.x + 80, y: a.y });
  await f.up();
  await setBlocked(false);
  await frames(3);
  s = await read();
  const phases = of(s.log, 'drag').map((d) => d.phase);
  expect(phases[0]).toBe('start');
  expect(phases.at(-1)).toBe('cancel');
  expect(phases.filter((p) => p === 'cancel')).toHaveLength(1);
  expect(phases).not.toContain('end');
});

test('pinch: two real touches report scale', async ({ page }) => {
  test.skip(!touch, 'two-finger touch rows only');
  const { toPage } = await stageMapper();
  const f = new Finger(page);
  const c = toPage(400, 300);
  const d0 = 40;
  await f.two('touchStart', { x: c.x - d0, y: c.y }, { x: c.x + d0, y: c.y });
  await frames(1);
  for (let i = 1; i <= 5; i++) {
    const d = d0 + (d0 * i) / 5; // ends at twice the distance
    await f.two('touchMove', { x: c.x - d, y: c.y }, { x: c.x + d, y: c.y });
    await frames(1);
  }
  await f.lift();
  await expect.poll(async () => (await read()).released.scale ?? 0).toBe(1);
  await frames(2);
  const s = await read();
  const pinches = of(s.log, 'pinch');
  expect(pinches[0]?.phase).toBe('start');
  const end = pinches.at(-1);
  expect(end?.phase).toBe('end');
  expect(end?.scale ?? 0).toBeCloseTo(2, 1);
  expect(Math.abs((end?.x ?? 0) - 400)).toBeLessThanOrEqual(2);
  // Two fingers never tap or drag.
  expect(s.pressed.select ?? 0).toBe(0);
  expect(s.pressed.grab ?? 0).toBe(0);
});
