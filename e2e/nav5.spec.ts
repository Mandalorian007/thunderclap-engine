/**
 * Engine navigation, fifth pass (ws/nav-5) on every matrix row, against harness/nav5.html (no
 * WebGPU): a tactics floor with blocks and a strip of mud baked into a `NavMesh` on the page,
 * and a unit whose movement range is `reachable(mesh, …)` traced by `reachableOutline`.
 *
 * - the range covers some but not all of the mesh, and its outline is drawn as closed loops;
 * - a block inside the range punches a hole: the outline has a second loop;
 * - a larger budget reaches more polygons, a zero budget only the unit's own;
 * - the free-running page keeps recomputing the range every frame.
 *
 * State changes and the read that checks them run in one `page.evaluate` (E-017), and every
 * moving value is polled.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessNav5State } from '../harness/nav5-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  const file = `nav5.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready)).toBe(true);
}

function read(): Promise<HarnessNav5State> {
  return frame.evaluate(() => {
    const s = window.__harnessNav5?.state;
    if (!s) throw new Error('window.__harnessNav5 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessNav5State;
  });
}

/** Parks the unit at `(x, z)` with `budget`, runs one step and reads the state, all at once. */
function rangeAt(x: number, z: number, budget: number): Promise<HarnessNav5State> {
  return frame.evaluate(
    ([ux, uz, b]) => {
      const api = window.__harnessNav5;
      if (!api) throw new Error('window.__harnessNav5 missing');
      api.moveUnit(ux!, uz!);
      api.setBudget(b!);
      api.advance(1);
      return JSON.parse(JSON.stringify(api.state)) as HarnessNav5State;
    },
    [x, z, budget],
  );
}

test('the range covers part of the mesh and its outline closes', async ({ page, wrapper }) => {
  await open(page, wrapper, '?range&still');
  const s0 = await read();
  expect(s0.mode).toBe('range');
  expect(s0.polyCount).toBeGreaterThan(50);
  expect(s0.queries).toBe(1);
  // The patrol's first tile, beside a block inside the range: an outer loop and the block's hole.
  expect(s0.polys).toBeGreaterThan(1);
  expect(s0.polys).toBeLessThan(s0.polyCount);
  expect(s0.outlineLoops).toBeGreaterThanOrEqual(2);
  expect(s0.outlinePoints).toBeGreaterThanOrEqual(s0.outlineLoops * 3);
  // In the open, far from every block, the range is one loop.
  const open1 = await rangeAt(-8.5, 0.5, 3);
  expect(open1.unit).toEqual({ x: -8.5, z: 0.5 });
  expect(open1.polys).toBeGreaterThan(1);
  expect(open1.outlineLoops).toBe(1);
});

test('a larger budget reaches more of the mesh, a zero budget only the start', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?range&still');
  const counts: number[] = [];
  for (const budget of [0, 2, 4, 8, 16]) {
    const s = await rangeAt(6.5, -4.5, budget);
    expect(s.budget).toBe(budget);
    expect(s.outlineLoops).toBeGreaterThanOrEqual(1);
    counts.push(s.polys);
  }
  expect(counts[0]).toBe(1);
  for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  // An unbounded budget reaches every polygon on the one connected floor.
  const all = await rangeAt(6.5, -4.5, 1e9);
  expect(all.polys).toBe(all.polyCount);
});

test('the free-running page recomputes the range every frame', async ({ page, wrapper }) => {
  await open(page, wrapper, '?range');
  const q0 = (await read()).queries;
  await expect.poll(() => read().then((s) => s.queries)).toBeGreaterThan(q0 + 30);
  const s = await read();
  expect(s.polys).toBeGreaterThan(1);
  expect(s.outlineLoops).toBeGreaterThanOrEqual(1);
  // Range plus outline on a few hundred polygons: inside a frame on any row (the bench is the 2 ms proof).
  expect(s.ms).toBeLessThan(16);
});
