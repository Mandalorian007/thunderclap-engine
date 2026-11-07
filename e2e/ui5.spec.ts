/**
 * The UI 5 demo (harness/ui5.html) on every matrix row (ws/ui-5): the orb meter, floating text
 * and the canvas minimap, one mode per query. Every value that moves over time is polled
 * (E-017); a change and the frame count it starts from are taken in one evaluate.
 *
 * - `?orb`: a set moves the measured fill to the value; the trail holds above it, then drains
 *   to it; the readouts follow;
 * - `?floats`: labels stream from a bounded pool (the layer holds exactly the pooled nodes) and
 *   the ones behind the camera are hidden;
 * - `?minimap`: a moving player redraws the map, a still one does not, and a click picks the
 *   world point under it; an arrow marker turns to its heading less the player's yaw (ws/ui-7);
 * - `?still` parks the clock while frames keep coming.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessUi5State } from '../harness/ui5-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const path = `ui5.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${path}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(path)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`ui5 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessUi5State> {
  return frame.evaluate(() => {
    const s = window.__harnessUi5?.state;
    if (!s) throw new Error('window.__harnessUi5 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessUi5State;
  });
}

test('an orb fills to its value and its trail drains after it', async ({ page, wrapper }) => {
  await open(page, wrapper, 'orb&still');
  const orb = frame.locator('#orb-0');
  await expect(orb).toHaveAttribute('role', 'meter');
  await expect(orb).toHaveAttribute('data-shape', 'orb');
  await expect(orb.locator('.tc-orb-readout')).toHaveText('100');
  await expect(frame.locator('#orb-1 .tc-orb-readout')).toHaveText('100%');
  await expect.poll(async () => (await read()).fill[0]).toBeCloseTo(1, 2);
  // The hit and the frame it lands on, in one evaluate.
  const at = await frame.evaluate(() => {
    const api = window.__harnessUi5!;
    api.setOrb(0, 30);
    api.setOrb(1, 55);
    return { frames: api.state.frames, trail: api.state.trail[0]! };
  });
  expect(at.trail).toBe(1); // the band starts where the value was
  await expect(orb).toHaveAttribute('aria-valuenow', '30');
  await expect(orb.locator('.tc-orb-readout')).toHaveText('30');
  await expect(frame.locator('#orb-1 .tc-orb-readout')).toHaveText('55%');
  // The fill eases to the value; the band is still above it (the 400 ms hold) when it lands.
  await expect
    .poll(async () => {
      const s = await read();
      return s.frames > at.frames && Math.abs(s.fill[0]! - 0.3) < 0.02;
    })
    .toBe(true);
  // Then the band catches up, in the model and on screen, and never under the fill.
  await expect
    .poll(async () => {
      const s = await read();
      expect(s.trailDom[0]!).toBeGreaterThanOrEqual(s.fill[0]! - 0.02);
      return Math.abs(s.trail[0]! - 0.3) < 1e-6 && Math.abs(s.trailDom[0]! - 0.3) < 0.02;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(s.fill[1]! - 0.55) < 0.02 && Math.abs(s.trailDom[1]! - 0.55) < 0.02;
    })
    .toBe(true);
  expect(errors).toEqual([]);
});

test('orbs drain in steps and refill on the clock', async ({ page, wrapper }) => {
  await open(page, wrapper, 'orb');
  const seen = new Set<number>();
  await expect
    .poll(async () => {
      const s = await read();
      seen.add(Math.round(s.value[0]! * 100));
      return seen.size;
    })
    .toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('floating text streams from a bounded pool and culls behind the camera', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'floats');
  // Twenty a second for a second each: about twenty in flight once warm.
  await expect.poll(async () => (await read()).active).toBeGreaterThanOrEqual(8);
  await expect.poll(async () => (await read()).culled).toBeGreaterThanOrEqual(1);
  const nodes = frame.locator('.tc-layer[data-layer="hud"] > .tc-floats');
  await expect
    .poll(async () => {
      const [s, n] = await Promise.all([read(), nodes.count()]);
      return s.pooled <= 64 && s.active <= s.pooled && n === s.pooled;
    })
    .toBe(true);
  // Past a few lives the pool stops growing: nodes are reused.
  const s0 = await read();
  await expect.poll(async () => (await read()).spawned).toBeGreaterThan(s0.spawned + 40);
  // About 22 in flight at most (20 a second plus two behind, a second each).
  expect((await read()).pooled).toBeLessThanOrEqual(30);
  await expect(frame.locator('.tc-floats[data-crit]:not([hidden])').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('the minimap redraws while the player moves and not while it is still', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'minimap');
  const map = frame.locator('#minimap');
  await expect(map).toBeVisible();
  await expect(map.locator('canvas')).toHaveCount(1);
  const r0 = (await read()).redraws;
  await expect.poll(async () => (await read()).redraws).toBeGreaterThan(r0 + 3);
  // Park and take the frame in one evaluate; a few frames on, the last change has drawn.
  const parkedAt = await frame.evaluate(() => {
    const api = window.__harnessUi5!;
    api.park(true);
    return api.state.frames;
  });
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(parkedAt + 3);
  // From here the markers are set every frame, unchanged, and the player is still: no draws.
  const a = await frame.evaluate(() => {
    const s = window.__harnessUi5!.state;
    return { frames: s.frames, redraws: s.redraws };
  });
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(a.frames + 10);
  expect((await read()).redraws).toBe(a.redraws);
  expect(errors).toEqual([]);
});

test('a click on the minimap picks the world point under it', async ({ page, wrapper }) => {
  await open(page, wrapper, 'minimap&still');
  const canvas = frame.locator('#minimap canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const pos = { x: box.width * 0.66, y: box.height * 0.38 };
  await canvas.click({ position: pos });
  await expect.poll(async () => (await read()).pick).not.toBeNull();
  const [s, want] = await Promise.all([
    read(),
    frame.evaluate(
      ([fx, fy]) => {
        const api = window.__harnessUi5!;
        return api.toWorld(fx! * api.mapSize, fy! * api.mapSize);
      },
      [pos.x / box.width, pos.y / box.height],
    ),
  ]);
  // A click lands on a whole CSS px: allow a pixel's worth of world units.
  const tol = 40 / 1.6 / box.width + 0.05;
  expect(Math.abs(s.pick!.x - want.x)).toBeLessThan(tol);
  expect(Math.abs(s.pick!.z - want.z)).toBeLessThan(tol);
  // Off the round disc (the box's corner): no new pick.
  await frame.evaluate(() => {
    window.__harnessUi5!.state.pick = null;
  });
  // `force`: the disc's rounded clip lets the corner through to what is under it.
  await canvas.click({ position: { x: 2, y: 2 }, force: true });
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(s.frames + 3);
  expect((await read()).pick).toBeNull();
  expect(errors).toEqual([]);
});

test('an arrow marker turns to its heading on the player-up map (ws/ui-7)', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, 'minimap');
  /** The drawn turn less (heading − yaw), wrapped to (−π, π]. */
  const off = (s: HarnessUi5State) => {
    const m = s.headingMarkers[0]!;
    const d = m.angle - (m.heading - s.player.yaw);
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  };
  await expect.poll(async () => (await read()).headingMarkers.length).toBe(1);
  const s0 = await read();
  expect(s0.headingMarkers[0]!.id).toBe('mover');
  // The heading turns on the clock; each read (one evaluate) has the turn match it.
  await expect
    .poll(async () => {
      const s = await read();
      expect(off(s)).toBeLessThan(1e-9);
      return Math.abs(s.headingMarkers[0]!.heading - s0.headingMarkers[0]!.heading);
    })
    .toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});

test('?still parks the clock while frames keep coming', async ({ page, wrapper }) => {
  await open(page, wrapper, 'floats&still');
  const s0 = await read();
  expect(s0.parked).toBe(true);
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(s0.frames + 3);
  const s1 = await read();
  expect(s1.t).toBe(0);
  expect(s1.spawned).toBe(0);
  expect(errors).toEqual([]);
});
