/**
 * Engine pointer rays (ws/input-rays) on every matrix row, against the rays harness page
 * (harness/rays.html, no WebGPU): real touch events through CDP on the touch rows, real mouse
 * events on desktop and inside the itch-style cross-origin iframe, and the pad cursor (a fake
 * gamepad) everywhere.
 *
 * - mouse hover lights a box and ends when the mouse leaves it (`hit`/`hitEnd`);
 * - select toggles the box under the pointer, through the letterbox transform;
 * - a touch is a pointer only while down: nothing stays hovered after it lifts;
 * - the pad cursor moves with the stick, hovers and selects with button 0;
 * - a perspective camera picks the nearest box;
 * - `blocked()`: nothing hovers or selects.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessRaysState, RayLogEntry } from '../harness/rays-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}

let frame: Frame;
let touch = false;

async function open(page: Page, wrapper: string, mode = 'ortho'): Promise<void> {
  touch = test.info().project.use.hasTouch === true;
  const file = `rays.html?mode=${mode}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
}

function read(): Promise<HarnessRaysState> {
  return frame.evaluate(() => {
    const s = window.__harnessRays?.state;
    if (!s) throw new Error('window.__harnessRays missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRaysState;
  });
}

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

/** Logical stage px to page CSS px. */
async function toPage(x: number, y: number): Promise<Pt> {
  const box = await frame.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage');
  const { logical } = await read();
  const s = box.width / logical.width;
  return { x: box.x + x * s, y: box.y + y * s };
}

async function boxAt(id: string): Promise<Pt> {
  const b = (await read()).boxes.find((q) => q.id === id);
  if (!b) throw new Error(`no box ${id}`);
  return toPage(b.x, b.y);
}

let cdp: CDPSession | null = null;
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

const of = (log: RayLogEntry[], kind: RayLogEntry['kind']) => log.filter((e) => e.kind === kind);

test.beforeEach(() => {
  cdp = null;
});

test('select toggles the box under the pointer', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await tap(page, await boxAt('b'));
  await expect.poll(async () => (await read()).selected).toEqual(['b']);
  let s = await read();
  const [sel] = of(s.log, 'select');
  expect(sel?.device).toBe(touch ? 'touch' : 'mouse');
  expect(sel?.target).toBe('b');
  expect(s.selectPresses).toBe(1);
  await tap(page, await boxAt('b'));
  await expect.poll(async () => (await read()).selected).toEqual([]);
  // The ground plane under the boxes: a select with no box.
  await tap(page, await toPage(380, 300));
  await expect.poll(async () => (await read()).selectPresses).toBe(3);
  s = await read();
  expect(s.selected).toEqual([]);
  expect(of(s.log, 'select').at(-1)?.target).toBeNull();
});

test('hover: mouse lights a box; a touch lights nothing once lifted', async ({ page, wrapper }) => {
  await open(page, wrapper);
  if (touch) {
    await tap(page, await boxAt('c'));
    await expect.poll(async () => (await read()).selected).toEqual(['c']);
    await frames(3);
    const s = await read();
    expect(s.hovered).toEqual([]);
    expect(of(s.log, 'hit').map((e) => e.target)).toContain('c');
    expect(of(s.log, 'hitEnd').map((e) => e.target)).toContain('c');
    return;
  }
  const a = await boxAt('a');
  await page.mouse.move(a.x, a.y);
  await expect.poll(async () => (await read()).hovered).toEqual(['a']);
  const d = await boxAt('d');
  await page.mouse.move(d.x, d.y, { steps: 4 });
  await expect.poll(async () => (await read()).hovered).toEqual(['d']);
  const s = await read();
  expect(s.selected).toEqual([]);
  expect(of(s.log, 'hitEnd').map((e) => e.target)).toContain('a');
});

test('the pad cursor moves, hovers and selects', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const setPad = (axes: [number, number], pressed: number[]) =>
    frame.evaluate(([a, p]) => window.__harnessRays?.setPad(a, p), [axes, pressed] as const);
  expect((await read()).cursor).toBeNull();
  // Deflect right: the cursor appears at the centre and moves right.
  await setPad([1, 0], []);
  await expect.poll(async () => (await read()).cursor?.x ?? 0).toBeGreaterThan(420);
  await setPad([0, 0], []);
  // Onto box a, press and release button 0.
  await frame.evaluate(() => window.__harnessRays?.cursorTo(175, 175));
  await expect.poll(async () => (await read()).hovered).toEqual(['a']);
  await setPad([0, 0], [0]);
  await frames(2);
  await setPad([0, 0], []);
  await expect.poll(async () => (await read()).selected).toEqual(['a']);
  const sel = of((await read()).log, 'select').at(-1);
  expect(sel?.device).toBe('gamepad');
  expect(sel?.target).toBe('a');
});

test('a perspective camera picks the nearest box', async ({ page, wrapper }) => {
  await open(page, wrapper, 'persp');
  // d sits behind b; b's centre must pick b.
  await tap(page, await boxAt('b'));
  await expect.poll(async () => (await read()).selected).toEqual(['b']);
  await tap(page, await boxAt('a'));
  await expect.poll(async () => (await read()).selected).toEqual(['b', 'a']);
  expect(of((await read()).log, 'select').some((e) => e.target === 'd')).toBe(false);
});

test('blocked: nothing hovers or selects', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await frame.evaluate(() => window.__harnessRays?.setBlocked(true));
  await tap(page, await boxAt('a'));
  await frames(4);
  let s = await read();
  expect(s.selected).toEqual([]);
  expect(s.hovered).toEqual([]);
  expect(s.selectPresses).toBe(0);
  await frame.evaluate(() => window.__harnessRays?.setBlocked(false));
  await tap(page, await boxAt('a'));
  await expect.poll(async () => (await read()).selected).toEqual(['a']);
  s = await read();
  expect(s.selectPresses).toBe(1);
});
