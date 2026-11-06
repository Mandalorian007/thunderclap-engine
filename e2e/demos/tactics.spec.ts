/**
 * demos/tactics on the engine matrix: boots clean, the iso inverse puts the cursor on the
 * right tile under every viewport and DPR (flat and raised tiles), a unit selects and moves
 * along a previewed path, an unreachable click does nothing, ending the turn runs the enemy
 * phase and comes back a turn later, the d-pad steps the cursor, and `?still&seed=1` fixes the
 * map.
 *
 * The demo is served by the harness Vite server at `/demos/tactics/` (the `serveDemos` plugin in
 * vite.harness.config.ts). The itch-iframe row is skipped: the wrapper embeds the harness page,
 * not the demo.
 */
import type { Page } from '@playwright/test';
import type { DemoApi, DemoState, UnitInfo } from '../../demos/tactics/main';
import { expect, test } from '../fixtures';
import { HARNESS_URL } from '../ports';

const DEMO_URL = `${HARNESS_URL}demos/tactics/?still&seed=1`;

// The projection constants, copied from demos/tactics/iso.ts: the spec computes a tile's screen
// point on its own so a projection bug cannot cancel out against the inverse.
const MAP = 24;
const TW = 64;
const TH = 32;
const EH = 16;
const DESIGN_W = 1920;
const DESIGN_H = 1080;
const ORIGIN_X = DESIGN_W / 2;
const ORIGIN_Y = (DESIGN_H - MAP * TH) / 2 + TH / 2 + EH;

function tileToDesign(tx: number, ty: number, elevation: number): { x: number; y: number } {
  return {
    x: ORIGIN_X + ((tx - ty) * TW) / 2,
    y: ORIGIN_Y + ((tx + ty) * TH) / 2 - elevation * EH,
  };
}

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

function units(page: Page): Promise<UnitInfo[]> {
  return page.evaluate(() => (window as unknown as { __demo: DemoApi }).__demo.unitList());
}

function tileInfo(page: Page, tx: number, ty: number) {
  return page.evaluate(
    ([x, y]) => (window as unknown as { __demo: DemoApi }).__demo.tileInfo(x, y),
    [tx, ty] as const,
  );
}

async function openDemo(page: Page, errors: string[], url = DEMO_URL): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
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

/** Client point of a tile's diamond centre: the canvas is the letterboxed design rect. */
async function tilePoint(page: Page, tx: number, ty: number): Promise<{ x: number; y: number }> {
  const info = await tileInfo(page, tx, ty);
  if (!info) throw new Error(`tile ${tx},${ty} off the map`);
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas has no box');
  const d = tileToDesign(tx, ty, info.elevation);
  return { x: box.x + (d.x / DESIGN_W) * box.width, y: box.y + (d.y / DESIGN_H) * box.height };
}

/** Put the pointer on a client point: a mouse move, or on touch rows a tap (touch has no hover). */
async function pointAt(page: Page, touch: boolean, p: { x: number; y: number }): Promise<void> {
  if (!touch) {
    await page.mouse.move(p.x, p.y);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  // Back to back, no runner round trip between: a starved runner must not stretch the tap past
  // the 450 ms long-press.
  await Promise.all([
    cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: p.x, y: p.y, id: 1 }],
    }),
    cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  ]);
  await cdp.detach();
}

async function clickAt(page: Page, touch: boolean, p: { x: number; y: number }): Promise<void> {
  if (!touch) {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    return;
  }
  await pointAt(page, touch, p);
}

/**
 * The first tile of elevation `elevation` scanning outward from the map's centre whose top
 * is not hidden: the three tiles in front of it (+x, +y, +x+y) are no higher, so its centre
 * is visible and the inverse must answer with it.
 */
async function findTile(page: Page, elevation: number): Promise<{ x: number; y: number }> {
  for (let r = 0; r < MAP / 2; r++) {
    for (let ty = 12 - r; ty <= 12 + r; ty++) {
      for (let tx = 12 - r; tx <= 12 + r; tx++) {
        const info = await tileInfo(page, tx, ty);
        if (!info || info.elevation !== elevation || info.terrain === 'water') continue;
        let hidden = false;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          const front = await tileInfo(page, tx + dx!, ty + dy!);
          if (front && front.elevation > elevation) hidden = true;
        }
        if (!hidden) return { x: tx, y: ty };
      }
    }
  }
  throw new Error(`no visible tile at elevation ${elevation}`);
}

test.describe('demo: tactics', () => {
  test.beforeEach(({ wrapper }) => {
    test.skip(wrapper !== 'top', 'the demo runs as the page, not inside the itch wrapper');
  });

  test('boots to a steady state: player phase, 4 vs 6, one sprite draw, no console errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    await expect.poll(() => readState(page).then((s) => s.frame)).toBeGreaterThan(30);
    const s = await readState(page);
    expect(s.phase).toBe('player');
    expect(s.turn).toBe(1);
    expect(s.units).toEqual({ player: 4, enemy: 6 });
    expect(s.selected).toBeNull();
    // The whole map, overlays and units are one material; the particle drawable is the other call.
    expect(s.drawCalls).toBeLessThanOrEqual(2);
    expect(s.stats?.instances).toBeGreaterThan(MAP * MAP);
    // fps is a moving average: polled (E-017).
    await expect.poll(() => readState(page).then((s) => s.fps)).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  test('the iso inverse: a pointer over a flat and a raised tile sets cursorTile', async ({
    page,
    hasTouch,
  }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const flat = await findTile(page, 0);
    const raised = await findTile(page, 2).catch(() => findTile(page, 1));
    for (const tile of [flat, raised, { x: 2, y: 21 }]) {
      await pointAt(page, hasTouch, await tilePoint(page, tile.x, tile.y));
      await expect.poll(() => readState(page).then((s) => s.cursorTile)).toEqual(tile);
    }
    expect(errors).toEqual([]);
  });

  test('select a unit, ignore an unreachable tile, then move along the previewed path', async ({
    page,
    hasTouch,
  }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const knight = (await units(page)).find((u) => u.name === 'Knight')!;
    expect(knight).toMatchObject({ tx: 2, ty: 21, side: 'player' });
    await clickAt(page, hasTouch, await tilePoint(page, knight.tx, knight.ty));
    await expect.poll(() => readState(page).then((s) => s.selected)).toBe(knight.id);

    // Far across the map: unreachable with 3 move points. Nothing happens.
    await clickAt(page, hasTouch, await tilePoint(page, 14, 10));
    await expect.poll(() => readState(page).then((s) => s.cursorTile)).toEqual({ x: 14, y: 10 });
    let s = await readState(page);
    expect(s.selected).toBe(knight.id);
    expect(s.busy).toBe(false);
    expect((await units(page)).find((u) => u.id === knight.id)).toMatchObject({
      tx: 2,
      ty: 21,
      moved: false,
    });

    // Two tiles away over the flattened spawn grass: a two-step path.
    const dest = { x: 1, y: 22 };
    const destPoint = await tilePoint(page, dest.x, dest.y);
    if (!hasTouch) {
      await pointAt(page, hasTouch, destPoint);
      await expect.poll(() => readState(page).then((s) => s.pathLength)).toBe(2);
    }
    await clickAt(page, hasTouch, destPoint);
    await expect
      .poll(() => units(page).then((list) => list.find((u) => u.id === knight.id)!), {
        timeout: 10_000,
      })
      .toMatchObject({ tx: dest.x, ty: dest.y, moved: true });
    await expect.poll(() => readState(page).then((s) => s.busy)).toBe(false);
    s = await readState(page);
    expect(s.lastPathLength).toBe(2);
    expect(errors).toEqual([]);
  });

  test('ending the turn runs the enemy phase and comes back to the player a turn later', async ({
    page,
  }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const before = await units(page);
    await page.keyboard.press('KeyE');
    await expect
      .poll(() => readState(page).then((s) => s.phase), { timeout: 20_000 })
      .toBe('player');
    const s = await readState(page);
    expect(s.turn).toBe(2);
    expect(s.busy).toBe(false);
    const after = await units(page);
    // Every raider closed on the squad.
    const moved = after.filter(
      (u, i) => u.side === 'enemy' && (u.tx !== before[i]!.tx || u.ty !== before[i]!.ty),
    );
    expect(moved.length).toBe(6);
    expect(errors).toEqual([]);
  });

  test('the d-pad steps cursorTile by one', async ({ page }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const press = (b: number) =>
      page.evaluate((i) => {
        const d = (window as unknown as { __demo: DemoApi }).__demo;
        d.pad(i, true);
        d.pad(i, false);
      }, b);
    // First press lands the pad cursor on the first player unit.
    await press(12);
    await expect.poll(() => readState(page).then((s) => s.cursorTile.x)).toBeGreaterThanOrEqual(0);
    const start = (await readState(page)).cursorTile;
    await press(15);
    await expect
      .poll(() => readState(page).then((s) => s.cursorTile))
      .toEqual({ x: start.x + 1, y: start.y });
    await press(12);
    await expect
      .poll(() => readState(page).then((s) => s.cursorTile))
      .toEqual({ x: start.x + 1, y: start.y - 1 });
    expect(errors).toEqual([]);
  });

  test('?still&seed=1 fixes the map; another seed changes it', async ({ page }) => {
    const errors: string[] = [];
    await openDemo(page, errors);
    const a = await readState(page);
    const unitsA = await units(page);
    await openDemo(page, errors);
    const b = await readState(page);
    expect(b.seed).toBe(1);
    expect(b.mapHash).toBe(a.mapHash);
    expect(await units(page)).toEqual(unitsA);
    await openDemo(page, errors, `${HARNESS_URL}demos/tactics/?still&seed=2`);
    const c = await readState(page);
    expect(c.seed).toBe(2);
    expect(c.mapHash).not.toBe(a.mapHash);
    expect(errors).toEqual([]);
  });
});
