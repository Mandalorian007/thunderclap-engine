/**
 * Collision queries (ws/collide) on every matrix row, against the collision page
 * (harness/collide.html, opened on `?still` so the sim moves only through `advance`):
 *
 * - the capsule walking into the wall stops at it: x is unchanged after a further second of
 *   pushing, and a sweep toward the wall ends short of it;
 * - walking at the stairs climbs every step onto the platform: y rises by rise × steps and the
 *   capsule ends grounded;
 * - dropped over the ramp the capsule lands grounded on it, with the ramp's tilted normal;
 * - on `?grid`, a circle pushed diagonally slides down the corridor and round its bend to the
 *   far end without snagging on a tile edge.
 */
import type { Frame, Page } from '@playwright/test';
import {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  CIRCLE_RADIUS,
  CORRIDOR_COL,
  CORRIDOR_ROW,
  GRID_WIDTH,
  type HarnessCollideState,
  RAMP_TILT,
  RAMP_X,
  RAMP_Z,
  STAIR_RISE,
  STAIR_STEPS,
  STAIRS_Z0,
  WALL_X,
  WALL_Z,
} from '../harness/collide-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = '?still'): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `collide.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`collide demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessCollideState> {
  return frame.evaluate(() => {
    const s = window.__harnessCollide?.state;
    if (!s) throw new Error('window.__harnessCollide missing');
    return JSON.parse(JSON.stringify(s)) as HarnessCollideState;
  });
}

function teleport(x: number, y: number, z: number): Promise<void> {
  return frame.evaluate(([px, py, pz]) => window.__harnessCollide?.teleport(px, py, pz), [
    x,
    y,
    z,
  ] as const);
}

function setMove(x: number, y: number): Promise<void> {
  return frame.evaluate(([mx, my]) => window.__harnessCollide?.setMove(mx, my), [x, y] as const);
}

function advance(steps: number): Promise<void> {
  return frame.evaluate((n) => window.__harnessCollide?.advance(n), steps);
}

function sweepProbe(dx: number, dy: number, dz: number): Promise<number> {
  return frame.evaluate(([x, y, z]) => window.__harnessCollide?.sweepProbe(x, y, z) ?? -1, [
    dx,
    dy,
    dz,
  ] as const);
}

const STAND_Y = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;

test('the capsule stops at the wall', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s0 = await read();
  expect(s0.mode).toBe('level');
  expect(s0.still).toBe(true);
  expect(s0.triangleCount).toBeGreaterThan(100);
  expect(s0.wireLines).toBe(s0.triangleCount * 3);
  // 1.5 units from the wall at walking speed (2.5/s): there within a second.
  await teleport(WALL_X - 1.5, STAND_Y, WALL_Z);
  await setMove(1, 0);
  await advance(60);
  const atWall = await read();
  const stop = WALL_X - CAPSULE_RADIUS;
  expect(atWall.pos[0]).toBeLessThanOrEqual(stop);
  expect(atWall.pos[0]).toBeGreaterThan(stop - 0.02);
  expect(atWall.hitWall).toBe(true);
  expect(atWall.grounded).toBe(true);
  // Another second of pushing moves nothing.
  await advance(60);
  const later = await read();
  expect(later.pos[0]).toBeCloseTo(atWall.pos[0], 4);
  expect(later.pos[2]).toBeCloseTo(atWall.pos[2], 3);
  // A sweep toward the wall ends at the gap left by the skin, far short of a full unit.
  const t = await sweepProbe(1, 0, 0);
  expect(t).toBeLessThan(0.02);
  expect((await read()).lastSweepT).toBe(t);
  expect(errors).toEqual([]);
});

test('the capsule climbs the stairs onto the platform', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await teleport(0, STAND_Y, STAIRS_Z0 + 1);
  await advance(10);
  const foot = await read();
  expect(foot.grounded).toBe(true);
  expect(foot.pos[1]).toBeCloseTo(STAND_Y, 1);
  // Forward is -z: 3.75 units of travel in 1.5 s cover the run-up and the 1.5 of stairs and
  // end on the platform (its far edge is 4.5 away).
  await setMove(0, 1);
  await advance(90);
  const top = await read();
  expect(top.pos[1] - foot.pos[1]).toBeCloseTo(STAIR_STEPS * STAIR_RISE, 1);
  expect(top.pos[2]).toBeLessThan(STAIRS_Z0 - STAIR_STEPS * 0.3);
  expect(top.grounded).toBe(true);
  expect(top.groundNormal[1]).toBeCloseTo(1, 3);
  expect(errors).toEqual([]);
});

test('the capsule lands grounded on the ramp', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await teleport(RAMP_X, 3, RAMP_Z);
  await advance(90);
  const s = await read();
  expect(s.grounded).toBe(true);
  expect(s.groundNormal[1]).toBeCloseTo(Math.cos(RAMP_TILT), 2);
  expect(s.groundNormal[2]).toBeGreaterThan(0.2);
  // Standing on the slope: no drift down it from one second to the next.
  await advance(60);
  const later = await read();
  expect(later.grounded).toBe(true);
  expect(later.pos[2]).toBeCloseTo(s.pos[2], 2);
  expect(later.pos[1]).toBeGreaterThan(STAND_Y + 0.2);
  expect(errors).toEqual([]);
});

test('the 2D circle slides down the corridor and round the bend', async ({ page, wrapper }) => {
  await open(page, wrapper, '?still&grid');
  const s0 = await read();
  expect(s0.mode).toBe('grid');
  expect(s0.pos[0]).toBeCloseTo(CORRIDOR_COL + 0.5, 6);
  expect(s0.pos[1]).toBe(0);
  // Pushed toward +x and +z at once (forward is -z, so "back"): the column's walls hold it to
  // +z, the bend's wall turns it to +x along the row. 12 units of path at 2.5/s needs 5 s.
  await setMove(1, -1);
  await advance(360);
  const s = await read();
  // Pressed into the row's end wall and its +z side, a radius and the skin off each.
  const end = GRID_WIDTH - 1 - CIRCLE_RADIUS;
  expect(s.pos[0]).toBeGreaterThan(end - 0.02);
  expect(s.pos[0]).toBeLessThanOrEqual(end);
  expect(s.pos[2]).toBeGreaterThan(CORRIDOR_ROW + 1 - CIRCLE_RADIUS - 0.02);
  expect(s.pos[2]).toBeLessThanOrEqual(CORRIDOR_ROW + 1 - CIRCLE_RADIUS);
  expect(s.grounded).toBe(false);
  expect(s.hitWall).toBe(true);
  expect(errors).toEqual([]);
});
