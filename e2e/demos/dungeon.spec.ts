/**
 * demos/dungeon on the engine matrix: boots clean and fast, the player stops flush against a
 * wall, a coin pickup survives a reload through `save`, and the pause menu walks with the arrow
 * keys and a (fake) d-pad.
 *
 * The demo is served by the harness Vite server at `/demos/dungeon/` (the `serveDemos` plugin in
 * vite.harness.config.ts), so no second server. The itch-iframe row is skipped:
 * the wrapper embeds the harness page, not the demo.
 */
import type { Page } from '@playwright/test';
import type { DemoApi, DemoState } from '../../demos/dungeon/main';
import { expect, test } from '../fixtures';
import { HARNESS_URL } from '../ports';

const DEMO_URL = `${HARNESS_URL}demos/dungeon/`;
const TILE = 32;
const PLAYER_HALF = 12;
/** The spawn room's west wall is tile x = 1, so the player stops on tile 2 (see demos/dungeon/map.ts). */
const WALL_TILE = { x: 1, y: 5 };
const STOP_TILE = { x: 2, y: 5 };

/** Read the state after a `requestAnimationFrame` settle, so the probe sees a whole frame's values. */
function readState(page: Page): Promise<DemoState> {
  return page.evaluate(
    () =>
      new Promise<DemoState>((resolve, reject) =>
        requestAnimationFrame(() => {
          const d = (window as unknown as { __demo?: DemoApi }).__demo;
          if (!d) return reject(new Error('window.__demo missing'));
          resolve(JSON.parse(JSON.stringify(d.state)) as DemoState);
        }),
      ),
  );
}

async function openDemo(page: Page, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(DEMO_URL);
  await expect
    .poll(async () => {
      const s = await readState(page).catch(() => null);
      if (s?.gpu === 'unsupported' && s.frame === 0) return -1;
      return s?.frame ?? -1;
    })
    .toBeGreaterThanOrEqual(10);
  const s = await readState(page);
  expect(s.gpu).toBe('ok');
}

test.describe('demo: dungeon', () => {
  test.beforeEach(({ wrapper }) => {
    test.skip(wrapper !== 'top', 'the demo runs as the page, not inside the itch wrapper');
  });

  test('boots to a steady state: 60 bats, one draw call, no console errors, fps', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    await expect.poll(() => readState(page).then((s) => s.frame)).toBeGreaterThan(60);
    const s = await readState(page);
    expect(s.bats).toBe(60);
    expect(s.drawCalls).toBe(1);
    expect(s.stats?.instances).toBeGreaterThan(1200);
    expect(s.coins).toBe(0);
    // Bats roam from boot, so health is anywhere in range; the bar is a `ui.meter` in the top region.
    expect(s.health).toBeGreaterThanOrEqual(0);
    expect(s.health).toBeLessThanOrEqual(10);
    expect(s.playerTile).toEqual({ x: 3, y: 5 });
    const meter = page.locator('#dungeon-health');
    await expect(meter).toHaveAttribute('role', 'meter');
    await expect(meter).toHaveAttribute('aria-valuemax', '10');
    if (testInfo.project.name.startsWith('desktop')) expect(s.fps).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  test('keys move the player into a wall and it stops flush on the tile', async ({ page }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    expect(
      await page.evaluate(
        ([w]) => (window as unknown as { __demo: DemoApi }).__demo.isSolid(w!.x, w!.y),
        [WALL_TILE],
      ),
    ).toBe(true);
    await page.keyboard.down('ArrowLeft');
    await expect.poll(() => readState(page).then((s) => s.playerTile.x)).toBe(STOP_TILE.x);
    // Flush against the wall: the box's left edge is the wall tile's right edge.
    await expect
      .poll(() => readState(page).then((s) => s.playerPos.x))
      .toBe(STOP_TILE.x * TILE + PLAYER_HALF);
    // Still held, still not moving: a few more frames at the same place.
    const frame = (await readState(page)).frame;
    await expect.poll(() => readState(page).then((s) => s.frame)).toBeGreaterThan(frame + 10);
    const s = await readState(page);
    expect(s.playerTile).toEqual(STOP_TILE);
    expect(s.playerPos.x).toBe(STOP_TILE.x * TILE + PLAYER_HALF);
    await page.keyboard.up('ArrowLeft');
    expect(errors).toEqual([]);
  });

  test('a picked-up coin is saved and survives a reload', async ({ page }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const floor = (await readState(page)).coinsOnFloor;
    await page.keyboard.down('ArrowRight');
    await expect.poll(() => readState(page).then((s) => s.coins)).toBe(1);
    await page.keyboard.up('ArrowRight');
    expect((await readState(page)).coinsOnFloor).toBe(floor - 1);
    expect(await page.locator('#dungeon-coins').textContent()).toBe('Coins: 1');

    await page.reload();
    await expect
      .poll(() =>
        readState(page)
          .then((s) => s.frame)
          .catch(() => -1),
      )
      .toBeGreaterThan(5);
    await expect.poll(() => readState(page).then((s) => s.coins)).toBe(1);
    expect(await page.locator('#dungeon-coins').textContent()).toBe('Coins: 1');
    expect(errors).toEqual([]);
  });

  test('the pause menu opens on Escape and walks with the arrow keys and the d-pad', async ({
    page,
  }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    await page.keyboard.press('Escape');
    await expect.poll(() => readState(page).then((s) => s.paused)).toBe(true);
    await expect.poll(() => readState(page).then((s) => s.focused)).toBe('Resume');

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => readState(page).then((s) => s.focused)).toBe('Fog: on');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => readState(page).then((s) => s.focused)).toBe('Reset coins');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readState(page).then((s) => s.focused)).toBe('Fog: on');

    // The d-pad (standard mapping: 12 up, 13 down, 0 = A) through the demo's fake pad. A press is
    // held until the focused label reads as expected (the demo latches it until its `PadNav` has
    // seen the edge, so one press is one step however the frames pace), then released and the
    // release given a frame to be observed before the next press.
    const pad = (b: number, pressed: boolean) =>
      page.evaluate(([i, p]) => (window as unknown as { __demo: DemoApi }).__demo.pad(i, p), [
        b,
        pressed,
      ] as const);
    const padPress = async (i: number, focused: string) => {
      await pad(i, true);
      await expect.poll(() => readState(page).then((s) => s.focused)).toBe(focused);
      await pad(i, false);
      const u = (await readState(page)).frame;
      await expect.poll(() => readState(page).then((s) => s.frame)).toBeGreaterThan(u + 2);
    };
    await padPress(13, 'Reset coins');
    await padPress(12, 'Fog: on');
    await padPress(0, 'Fog: off');
    await expect.poll(() => readState(page).then((s) => s.fog)).toBe(false);

    // The game is parked while the menu is up: the player ignores movement keys.
    const before = (await readState(page)).playerPos;
    await page.keyboard.down('ArrowLeft');
    const f = (await readState(page)).frame;
    await expect.poll(() => readState(page).then((s) => s.frame)).toBeGreaterThan(f + 10);
    await page.keyboard.up('ArrowLeft');
    expect((await readState(page)).playerPos).toEqual(before);

    await page.keyboard.press('Escape');
    await expect.poll(() => readState(page).then((s) => s.paused)).toBe(false);
    await expect.poll(() => readState(page).then((s) => s.focused)).toBe(null);
    expect(errors).toEqual([]);
  });
});
