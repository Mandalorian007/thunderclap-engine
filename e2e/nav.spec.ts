/**
 * Engine navigation (ws/nav) on every matrix row, against the nav harness page (harness/nav.html,
 * no WebGPU): a grid with a wall, A* plus string pulling for a probe path, a flow field that 32
 * agents follow with separation, and a click or tap that moves the goal.
 *
 * - the probe path bends around the wall through its gap (rows 5-6 of column 20);
 * - closing one gap cell reroutes through the other, closing both leaves no path, reopening
 *   restores the first route;
 * - a tap on the stage moves the goal to that cell;
 * - all 32 agents arrive within a bound of sim time, stepped synchronously at 1/60 s.
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { HarnessNavState } from '../harness/nav-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
let touch = false;

async function open(page: Page, wrapper: string): Promise<void> {
  touch = test.info().project.use.hasTouch === true;
  const file = 'nav.html';
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready && s.ticks > 2)).toBe(true);
}

function read(): Promise<HarnessNavState> {
  return frame.evaluate(() => {
    const s = window.__harnessNav?.state;
    if (!s) throw new Error('window.__harnessNav missing');
    return JSON.parse(JSON.stringify(s)) as HarnessNavState;
  });
}

function toggleWall(cx: number, cy: number): Promise<void> {
  return frame.evaluate(([x, y]) => window.__harnessNav?.toggleWall(x, y), [cx, cy] as const);
}

function advance(steps: number): Promise<void> {
  return frame.evaluate((n) => window.__harnessNav?.advance(n), steps);
}

async function frames(n = 1): Promise<void> {
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

let cdp: CDPSession | null = null;
/** A tap (touch rows, CDP) or a click (mouse) at the centre of a cell. */
async function tapCell(page: Page, cx: number, cy: number): Promise<void> {
  const box = await frame.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage');
  const { logical, grid } = await read();
  const s = box.width / logical.width;
  const p = {
    x: box.x + (cx + 0.5) * grid.cellSize * s,
    y: box.y + (cy + 0.5) * grid.cellSize * s,
  };
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

test.beforeEach(() => {
  cdp = null;
});

test('the probe path bends around the wall through its gap', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.agents).toHaveLength(32);
  expect(s.walls).toBeGreaterThan(10);
  expect(s.pathFound).toBe(true);
  // Start (3,12) to goal (36,12): the straight line is 33 cells; the gap at rows 5-6 forces a
  // detour (34 king moves, 12 of them diagonal) and string pulling keeps the bend.
  expect(s.rawPathLength).toBe(34);
  expect(s.pathLength).toBeGreaterThanOrEqual(3);
  expect(s.pathLength).toBeLessThanOrEqual(5);
  expect(s.pathDistance).toBeGreaterThan(33 * s.grid.cellSize);
  expect(s.buildMs).toBeGreaterThanOrEqual(0);
  expect(s.builds).toBe(1);
});

test('toggling a wall reroutes the path; a sealed wall has no path', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s0 = await read();
  // Close the gap cell nearest the probe row: the route goes through the other, further one.
  await toggleWall(20, 6);
  await expect.poll(async () => (await read()).gridVersion).toBe(s0.gridVersion + 1);
  let s = await read();
  expect(s.pathFound).toBe(true);
  expect(s.pathLength).toBeGreaterThanOrEqual(3);
  expect(s.pathDistance).toBeGreaterThan(s0.pathDistance);
  // Close the last gap cell: no path at all.
  await toggleWall(20, 5);
  await expect.poll(async () => (await read()).pathFound).toBe(false);
  s = await read();
  expect(s.pathLength).toBe(0);
  expect(s.builds).toBe(3);
  // Reopen the first cell and the original route is back.
  await toggleWall(20, 6);
  await expect.poll(async () => (await read()).pathFound).toBe(true);
  s = await read();
  expect(s.pathDistance).toBeCloseTo(s0.pathDistance, 3);
  expect(s.gridVersion).toBe(s0.gridVersion + 3);
});

test('a tap moves the goal to that cell', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await tapCell(page, 30, 16);
  await expect.poll(async () => (await read()).goal).toEqual({ x: 30, y: 16 });
  const s = await read();
  expect(s.pathFound).toBe(true);
  expect(s.pathLength).toBeGreaterThanOrEqual(3);
  expect(s.arrived).toBe(0);
  expect(s.builds).toBe(2);
});

test('all 32 agents flow to the goal within 15 s of sim time', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const t0 = (await read()).simTime;
  // 60 steps a call: 15 s is 900 steps; the rAF ticks that pass meanwhile count too.
  for (let i = 0; i < 15 && (await read()).arrived < 32; i++) await advance(60);
  const s = await read();
  expect(s.arrived).toBe(32);
  expect(s.simTime - t0).toBeLessThan(16);
  const goalX = (s.goal.x + 0.5) * s.grid.cellSize;
  const goalZ = (s.goal.y + 0.5) * s.grid.cellSize;
  for (const a of s.agents) {
    expect(a.arrived).toBe(true);
    expect(Math.hypot(a.x - goalX, a.z - goalZ)).toBeLessThan(s.grid.cellSize * 5);
    // Past the wall.
    expect(a.x).toBeGreaterThan(21 * s.grid.cellSize);
  }
});
