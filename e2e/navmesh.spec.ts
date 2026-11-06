/**
 * The navmesh demo (harness/navmesh.html) on every matrix row: a level of `geom` boxes and a
 * ramp baked into a `NavMesh` on the page, a path drawn over it and a crowd on the floor.
 *
 * - the bake produces polygons on the page, a probe at a pillar's centre finds no polygon within
 *   its radius and the floor and platform tops are at their heights;
 * - the path from the floor to the platform climbs the ramp (its height never drops) with the
 *   link at its default cost, and takes the "jump down" link when that is made cheaper;
 * - `?crowd=24` agents converging on one point never overlap over three seconds of fixed steps.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessNavmeshState } from '../harness/navmesh-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = 'still'): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const target = `navmesh.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${target}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(target)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(
      async () => {
        const s = await read().catch(() => null);
        if (s?.ready && s.gpu !== 'ok') throw new Error(`navmesh demo: ${s.gpu}`);
        return s?.ready ? s.frames : -1;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessNavmeshState> {
  return frame.evaluate(() => {
    const s = window.__harnessNavmesh?.state;
    if (!s) throw new Error('window.__harnessNavmesh missing');
    return JSON.parse(JSON.stringify(s)) as HarnessNavmeshState;
  });
}

function probeNearest(x: number, y: number, z: number, radius: number): Promise<number> {
  return frame.evaluate(
    ([px, py, pz, r]) => window.__harnessNavmesh?.probeNearest(px, py, pz, r) ?? -2,
    [x, y, z, radius] as const,
  );
}

function probeHeight(x: number, z: number): Promise<number> {
  return frame.evaluate(([px, pz]) => window.__harnessNavmesh?.probeHeight(px, pz) ?? Number.NaN, [
    x,
    z,
  ] as const);
}

function setLinkCost(cost: number): Promise<void> {
  return frame.evaluate((c) => window.__harnessNavmesh?.setLinkCost(c), cost);
}

/** The path's waypoint heights in order. */
function heights(s: HarnessNavmeshState): number[] {
  const ys: number[] = [];
  for (let i = 1; i < s.pathPoints.length; i += 3) ys.push(s.pathPoints[i]!);
  return ys;
}

test('bakes polygons, leaves the pillars out and reads the floor and platform heights', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.polyCount).toBeGreaterThan(10);
  expect(s.bakeMs).toBeGreaterThan(0);
  // The pillar at (2, 2) is 1 m square, its foot eroded by the agent radius: no polygon within
  // half a metre of its centre at floor height.
  expect(await probeNearest(2, 0, 2, 0.5)).toBe(-1);
  // The floor well away from anything is found at once.
  expect(await probeNearest(8, 0, 6, 0.5)).toBeGreaterThanOrEqual(0);
  // Surface heights sit within one cell height of the real tops.
  expect(await probeHeight(8, 6)).toBeGreaterThanOrEqual(0);
  expect(await probeHeight(8, 6)).toBeLessThanOrEqual(0.25);
  expect(await probeHeight(-4, -5)).toBeGreaterThanOrEqual(2);
  expect(await probeHeight(-4, -5)).toBeLessThanOrEqual(2.25);
  expect(Number.isNaN(await probeHeight(2, 2))).toBe(true);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the path to the platform climbs the ramp, or takes the link once that is cheaper', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const a = await read();
  expect(a.pathFound).toBe(true);
  expect(a.linkUsed).toBe(false);
  expect(a.pathLength).toBeGreaterThan(20);
  // Up the ramp: the height never drops along the way and ends on the platform.
  const ys = heights(a);
  expect(ys.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! - 1e-3);
  expect(ys[ys.length - 1]!).toBeGreaterThan(1.9);
  // A cheap link beats the ramp: the path jumps up through it and is shorter.
  await setLinkCost(1);
  const b = await read();
  expect(b.pathFound).toBe(true);
  expect(b.linkUsed).toBe(true);
  expect(b.pathLength).toBeLessThan(a.pathLength);
  // Back to the default: the ramp again.
  await setLinkCost(50);
  const c = await read();
  expect(c.linkUsed).toBe(false);
  expect(c.pathLength).toBeCloseTo(a.pathLength, 3);
  expect(errors).toEqual([]);
});

test('24 crowd agents converging on one point never overlap over three seconds', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'still&crowd=24');
  const s0 = await read();
  expect(s0.crowd).toBe(24);
  await expect
    .poll(async () => (await read()).crowdSteps, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(s0.crowdSteps + 180);
  const s1 = await read();
  expect(s1.crowdOverlaps).toBe(0);
  expect(s1.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
