/**
 * Engine navigation, fourth pass (ws/nav-4) on every matrix row, against harness/nav4.html (no
 * WebGPU): a floor with two pillars baked into a `NavMesh` on the page.
 *
 * - `?crowd`: 48 agents on corridors stay on the mesh and reach their targets; `&carve` drops an
 *   obstacle between the pillars at 2 s and every corridor through the gap replans;
 * - `?queue`: 200 requests a second through a `PathQueue` finish within the budget and the queue
 *   never fills;
 * - `?areas`: the probe path priced with mud at 3× is longer than the plain one (it detours);
 * - `?flow3`: walkers reading a mesh flow field all arrive at the goal.
 *
 * The sim is stepped synchronously at 1/60 s through `advance`, so the bounds are sim time;
 * every moving value is polled (E-017).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessNav4State } from '../harness/nav4-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  const file = `nav4.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready)).toBe(true);
}

function read(): Promise<HarnessNav4State> {
  return frame.evaluate(() => {
    const s = window.__harnessNav4?.state;
    if (!s) throw new Error('window.__harnessNav4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessNav4State;
  });
}

function advance(steps: number): Promise<void> {
  return frame.evaluate((n) => window.__harnessNav4?.advance(n), steps);
}

/** Steps a second of sim time at a time until `pick` is true or `seconds` have passed. */
async function until(
  pick: (s: HarnessNav4State) => boolean,
  seconds: number,
): Promise<HarnessNav4State> {
  let s = await read();
  for (let t = 0; t < seconds && !pick(s); t++) {
    await advance(60);
    s = await read();
  }
  return s;
}

test('48 agents on corridors stay on the mesh and reach their targets', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?crowd&still');
  const s0 = await read();
  expect(s0.mode).toBe('crowd');
  expect(s0.polyCount).toBeGreaterThan(4);
  expect(s0.agents).toBe(48);
  // Every agent planned once on `setTarget`.
  expect(s0.replans).toBe(48);
  await expect.poll(() => read().then((s) => s.ticks)).toBe(0);
  await advance(60);
  let s = await read();
  expect(s.onMesh).toBe(48);
  expect(s.reached).toBe(0);
  s = await until((st) => st.reached === 48, 40);
  expect(s.reached).toBe(48);
  expect(s.onMesh).toBe(48);
  expect(s.carved).toBe(false);
  expect(s.meshVersion).toBe(s0.meshVersion);
});

test('an obstacle carved between the pillars replans the corridors through it', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?crowd&carve&still');
  const s0 = await read();
  expect(s0.carved).toBe(false);
  await advance(60);
  let s = await read();
  expect(s.carved).toBe(false);
  expect(s.replans).toBe(48);
  // The carve lands at 2 s; the mesh version moves and the corridors through it replan.
  s = await until((st) => st.carved, 3);
  expect(s.carved).toBe(true);
  expect(s.meshVersion).toBeGreaterThan(s0.meshVersion);
  await expect.poll(() => read().then((st) => st.replans)).toBeGreaterThan(48);
  s = await until((st) => st.reached === 48, 50);
  expect(s.reached).toBe(48);
  expect(s.onMesh).toBe(48);
});

test('200 requests a second through a path queue finish within the budget', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?queue&still');
  const s0 = await read();
  expect(s0.mode).toBe('queue');
  expect(s0.requested).toBe(0);
  await advance(180);
  const s = await read();
  // 3 s at 200 a second, none dropped, nearly all done; a bounded backlog.
  expect(s.requested).toBe(600);
  expect(s.dropped).toBe(0);
  expect(s.doneTotal).toBeGreaterThan(400);
  expect(s.pending).toBeLessThan(200);
  expect(s.doneTotal + s.pending).toBe(s.requested);
  expect(s.failedTotal).toBe(0);
  expect(s.maxUpdateMs).toBeGreaterThan(0);
  // The backlog drains once requests keep coming at the same rate.
  await advance(180);
  const s2 = await read();
  expect(s2.doneTotal).toBeGreaterThan(s.doneTotal);
  expect(s2.pending).toBeLessThan(200);
});

test('the probe path priced with mud detours while the plain one runs straight', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?areas&still');
  const s = await read();
  expect(s.mode).toBe('areas');
  expect(s.mudPolys).toBeGreaterThan(0);
  // South edge to north edge is 16 units straight through the gap.
  expect(s.lengthPlain).toBeGreaterThan(15.5);
  expect(s.lengthPlain).toBeLessThan(17);
  // Mud at 3× sends the path around a pillar instead.
  expect(s.lengthMud).toBeGreaterThan(s.lengthPlain + 2);
});

test('walkers on a mesh flow field all arrive at the goal', async ({ page, wrapper }) => {
  await open(page, wrapper, '?flow3&still');
  const s0 = await read();
  expect(s0.mode).toBe('flow3');
  expect(s0.fieldReached).toBe(s0.polyCount);
  expect(s0.arrived).toBe(0);
  await advance(60);
  let s = await read();
  expect(s.arrived).toBe(0);
  s = await until((st) => st.arrived === 48, 30);
  expect(s.arrived).toBe(48);
});

test('the page animates without `?still` and parks with it', async ({ page, wrapper }) => {
  await open(page, wrapper, '?flow3');
  await expect.poll(() => read().then((s) => s.ticks)).toBeGreaterThan(2);
  await open(page, wrapper, '?flow3&still');
  await frame.evaluate(
    () =>
      new Promise<void>((done) => {
        let left = 3;
        const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
  );
  expect((await read()).ticks).toBe(0);
});
