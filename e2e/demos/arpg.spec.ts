/**
 * The ARPG demo (demos/arpg) on the device matrix: the courtyard boots clean inside the
 * draw-call band, a ground click (a tap on touch rows) paths the hero over the navmesh to the
 * spot, a gear key and a gear button swap the set's materials without rebuilding the rig, three
 * strikes on an adjacent ghoul kill it (the third number a crit) and it burns away on a pooled
 * dissolve material, a tap on the minimap walks the hero there, zooming out puts the walls,
 * pillars and ghouls on more than one LOD level, no floor seam shows at screen centre at spawn
 * (desktop-1280), the desktop rows hold a playable frame rate, no HUD widget overflows its
 * content bar on any row, and on phone-portrait the bars leave the world 70% of the height.
 *
 * `?still&seed=3` parks the enemy AI and fixes the spawns so the interaction rows are
 * deterministic; every wait is a poll on `window.__demo`, never a sleep.
 */
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import type { ArpgDemoApi, ArpgDemoState } from '../../demos/arpg/state';
import { HARNESS_URL } from '../ports';

const URL = `${HARNESS_URL}demos/arpg/`;

/**
 * Scene lists (~10), LOD lists (walls, pillars, drums, ghouls: one draw per level in view), hero,
 * four gear pieces, trail and particles, plus shadow and post passes.
 */
const DRAW_CALLS_MIN = 10;
const DRAW_CALLS_MAX = 80;
const MIN_FPS_DESKTOP = 20;

type Win = { __demo?: ArpgDemoState; __arpgApi?: ArpgDemoApi };

const readState = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() => resolve(JSON.stringify((window as unknown as Win).__demo))),
      ),
  );
const parse = (s: string) => JSON.parse(s) as ArpgDemoState;
const read = async (page: Page) => parse(await readState(page));

/** Three strikes on a summoned ghoul; resolves once the kill registers. */
async function killOne(page: Page, before: ArpgDemoState): Promise<void> {
  const idx = await page.evaluate(() => (window as unknown as Win).__arpgApi!.summon());
  expect(idx).toBeGreaterThanOrEqual(0);
  for (let i = 1; i <= 3; i++) {
    await expect.poll(async () => (await read(page)).heroState, { timeout: 10_000 }).toBe('move');
    await page.keyboard.press('Space');
    await expect
      .poll(async () => (await read(page)).hits, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(before.hits + i);
  }
  await expect
    .poll(async () => (await read(page)).kills, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(before.kills + 1);
}

async function boot(
  page: Page,
  query = '',
): Promise<{ errors: string[]; layoutWarnings: string[]; state: ArpgDemoState }> {
  const errors: string[] = [];
  const layoutWarnings: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    // ws/ui-7's `[layout] <id> overflows …`, counted as it is logged.
    if (m.type() === 'warning' && m.text().startsWith('[layout]')) layoutWarnings.push(m.text());
  });
  await page.goto(`${URL}${query}`);
  await expect.poll(async () => (await read(page)).ready, { timeout: 30_000 }).toBe(true);
  expect((await read(page)).gpu, 'WebGPU came up').toBe('ok');
  await expect.poll(async () => (await read(page)).frame, { timeout: 15_000 }).toBeGreaterThan(5);
  return { errors, layoutWarnings, state: await read(page) };
}

/** A world point in client px (for clicks and taps). */
const screenOf = (page: Page, x: number, y: number, z: number) =>
  page.evaluate(
    ([a, b, c]) => (window as unknown as Win).__arpgApi!.screenOf(a!, b!, c!),
    [x, y, z],
  );

let cdp: CDPSession | undefined;
async function tap(page: Page, x: number, y: number): Promise<void> {
  cdp ??= await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('demo: arpg', () => {
  test.afterEach(() => {
    cdp = undefined;
  });

  test('boots the courtyard within the draw-call band, no console errors', async ({
    page,
  }, info) => {
    const { errors, layoutWarnings } = await boot(page);
    await expect
      .poll(async () => (await read(page)).frame, { timeout: 15_000 })
      .toBeGreaterThan(40);
    const s = await read(page);
    expect(s.drawCalls).toBeGreaterThanOrEqual(DRAW_CALLS_MIN);
    expect(s.drawCalls).toBeLessThanOrEqual(DRAW_CALLS_MAX);
    expect(s.triangles).toBeGreaterThan(10_000);
    expect(s.navPolys).toBeGreaterThan(0);
    expect(s.enemiesAlive).toBe(12);
    // Six braziers and twelve ghouls on the map; the orbs are engine meters.
    expect(s.mapMarkers).toBe(18);
    await expect(page.locator('#arpg-health[role="meter"]')).toBeVisible();
    await expect(page.locator('#arpg-map')).toBeVisible();
    expect(s.cameraPitch).toBe(50);
    expect(s.gpuErrors).toBe(0);
    if (info.project.name.startsWith('desktop')) {
      await expect
        .poll(async () => (await read(page)).fps, { timeout: 15_000 })
        .toBeGreaterThan(MIN_FPS_DESKTOP);
    }
    // Content bars (ws/ui-8): the orbs and slots fit the bottom bar, the gear row the top one.
    expect(s.overflows).toEqual([]);
    expect(layoutWarnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  test.describe('phone-portrait', () => {
    // Not a matrix row: phone-port runs layout.spec only, so this one viewport is set here.
    test.use({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    test('the bars leave the world at least 70% of the height, no overflows', async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'desktop-1280', 'one portrait run, on the desktop-1280 row');
      const { errors, layoutWarnings } = await boot(page, '?still&seed=3');
      await expect.poll(async () => (await read(page)).formFactor).toBe('phone-portrait');
      const s = await read(page);
      expect(s.bottomBar).toBeGreaterThan(0);
      expect(s.worldView).toBeGreaterThanOrEqual(0.7);
      expect(s.overflows).toEqual([]);
      expect(layoutWarnings).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  test('a ground click (a tap on touch) paths the hero to the spot', async ({ page, hasTouch }) => {
    const { errors, state: before } = await boot(page, '?still&seed=3');
    const [hx, hy, hz] = before.heroPos;
    const c = await screenOf(page, hx + 4, hy, hz - 2.5);
    if (hasTouch) await tap(page, c.x, c.y);
    else await page.mouse.click(c.x, c.y);
    await expect
      .poll(async () => (await read(page)).pathLength, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const target = (await read(page)).moveTarget;
    expect(target).not.toBeNull();
    await expect
      .poll(
        async () => {
          const p = (await read(page)).heroPos;
          return Math.hypot(p[0] - target![0], p[2] - target![2]);
        },
        { timeout: 20_000 },
      )
      .toBeLessThan(0.5);
    const moved = (await read(page)).heroPos;
    expect(Math.hypot(moved[0] - hx, moved[2] - hz), 'the hero moved').toBeGreaterThan(2);
    expect(errors).toEqual([]);
  });

  test('a gear key and a gear button swap the set without rebuilding the rig', async ({ page }) => {
    const { errors, state: before } = await boot(page, '?still&seed=3');
    expect(before.gearSet).toBe('iron');
    await page.keyboard.press('Digit2');
    await expect.poll(async () => (await read(page)).gearSet, { timeout: 10_000 }).toBe('gilded');
    const gilded = await read(page);
    expect(gilded.gearMaterialIds).not.toEqual(before.gearMaterialIds);
    await page.locator('[data-gear="2"]').click();
    await expect.poll(async () => (await read(page)).gearSet, { timeout: 10_000 }).toBe('bone');
    const bone = await read(page);
    expect(bone.gearMaterialIds).not.toEqual(gilded.gearMaterialIds);
    expect(bone.gearSwaps).toBe(2);
    expect(bone.rigBuilds).toBe(1);
    expect(errors).toEqual([]);
  });

  test('three strikes on an adjacent ghoul kill it', async ({ page }) => {
    const { errors, state: before } = await boot(page, '?still&seed=3');
    expect(before.kills).toBe(0);
    await killOne(page, before);
    expect((await read(page)).crits).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('a killed ghoul dissolves, then the pool empties', async ({ page }) => {
    const { errors, state: before } = await boot(page, '?still&seed=3');
    expect(before.dissolving).toBe(0);
    expect(before.dissolvePeak).toBe(0);
    await killOne(page, before);
    // The burn lasts 0.8 s of sim: the peak is counted in page state when it starts, so a slow
    // poll cannot miss it; then the material goes back to the pool.
    await expect
      .poll(async () => (await read(page)).dissolvePeak, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(async () => (await read(page)).dissolving, { timeout: 10_000 }).toBe(0);
    const s = await read(page);
    expect(s.enemiesAlive).toBe(11);
    expect(s.gpuErrors).toBe(0);
    expect(errors).toEqual([]);
  });

  test('zoomed out, the LOD props draw on more than one level', async ({ page }) => {
    const { errors } = await boot(page, '?still&seed=3');
    const applied = await page.evaluate(() => (window as unknown as Win).__arpgApi!.zoom(64));
    expect(applied).toBe(64);
    await expect
      .poll(
        async () => {
          const s = await read(page);
          return s.cameraDistance === 64 ? s.lodCounts.filter((n) => n > 0).length : 0;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(1);
    const s = await read(page);
    expect(s.drawCalls).toBeLessThanOrEqual(DRAW_CALLS_MAX);
    expect(s.gpuErrors).toBe(0);
    expect(errors).toEqual([]);
  });

  test('no floor seam at screen centre at spawn', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'measured on desktop-1280 (column 640)');
    const { errors } = await boot(page, '?still&seed=3');
    // Read back once, on frame 60, in the frame's own task: poll until it is published.
    await expect
      .poll(async () => (await read(page)).centreSeam, { timeout: 15_000 })
      .not.toBeNull();
    const s = await read(page);
    // Column 640 less the mean of 636 and 644: the old grout gap at x = 0 read about +69, the
    // texture's mid-tile grout line there about -22; a quarter-tile offset puts both 0.5 m off.
    expect(Math.abs(s.centreSeam!)).toBeLessThan(10);
    expect(errors).toEqual([]);
  });

  test('a tap on the minimap walks the hero there', async ({ page, hasTouch }) => {
    const { errors, state: before } = await boot(page, '?still&seed=3');
    const [hx, , hz] = before.heroPos;
    const goal = { x: hx + 4, z: hz - 2.5 }; // the ground-click test's spot: open floor
    const c = await page.evaluate(
      ([x, z]) => (window as unknown as Win).__arpgApi!.mapPointOf(x!, z!),
      [goal.x, goal.z],
    );
    if (hasTouch) {
      // Both touch events in one go, so a runner stall cannot turn the tap into a hold.
      cdp ??= await page.context().newCDPSession(page);
      await Promise.all([
        cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: c.x, y: c.y, id: 1 }],
        }),
        cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      ]);
    } else await page.mouse.click(c.x, c.y);
    await expect.poll(async () => (await read(page)).mapPicks, { timeout: 10_000 }).toBe(1);
    const s = await read(page);
    expect(s.pathLength).toBeGreaterThan(0);
    // The map is 200 design px over 60 m: a pick lands within a few tenths of a metre.
    expect(Math.hypot(s.moveTarget![0] - goal.x, s.moveTarget![2] - goal.z)).toBeLessThan(1);
    await expect
      .poll(
        async () => {
          const p = (await read(page)).heroPos;
          return Math.hypot(p[0] - s.moveTarget![0], p[2] - s.moveTarget![2]);
        },
        { timeout: 20_000 },
      )
      .toBeLessThan(0.5);
    expect(errors).toEqual([]);
  });
});
