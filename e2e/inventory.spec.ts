/**
 * The inventory set (ws/ui-inventory) on every top-level matrix row, against the inventory
 * harness page (harness/inventory.html, no WebGPU):
 *
 * - a pointer drag moves an item between the two grids (the mouse on desktop rows, a CDP touch
 *   after the long press on the touch rows);
 * - a drop the right grid refuses snaps the ghost back and leaves both grids unchanged;
 * - the pad picks up with `select`, `right` at the edge crosses into the other grid, `select` drops;
 * - focus shows the card, placed right of the left grid and left of the right one;
 * - the radial highlights the east sector for `aim(1, 0)` and `pick` fires;
 * - the secondary button opens the context list and Escape returns the focus to the cell.
 *
 * The itch-iframe row is skipped: the wrapper embeds the WebGPU harness page.
 */
import type { CDPSession, Locator, Page } from '@playwright/test';
import type { HarnessInventoryState } from '../harness/inventory-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}

const touchRow = () => test.info().project.use.hasTouch === true;

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'inventory harness runs top-level only');
  await page.goto(`${HARNESS_URL}inventory.html`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
});

function read(page: Page): Promise<HarnessInventoryState> {
  return page.evaluate(() => {
    const s = window.__harnessInventory?.state;
    if (!s) throw new Error('window.__harnessInventory missing');
    return JSON.parse(JSON.stringify(s)) as HarnessInventoryState;
  });
}

const cell = (page: Page, grid: 'Backpack' | 'Equipment', col: number, row: number): Locator =>
  page.locator(`[role=grid][aria-label="${grid}"] .tc-cell[data-col="${col}"][data-row="${row}"]`);

async function centre(l: Locator): Promise<Pt> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count;
        const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** One real pointer: CDP touch (with the long press) on the touch rows, the mouse elsewhere. */
class Finger {
  private cdp: CDPSession | null = null;
  constructor(
    private readonly page: Page,
    private readonly touch: boolean,
  ) {}

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
    });
  }

  /** Down at `from`, the long press on touch, move in `steps` to `to`, then up. */
  async drag(from: Pt, to: Pt, steps = 8): Promise<void> {
    if (this.touch) {
      await this.send('touchStart', [from]);
      // The touch drag starts after the 160 ms hold; a pan before that scrolls.
      await expect.poll(() => read(this.page).then((s) => s.dragging)).not.toBeNull();
    } else {
      await this.page.mouse.move(from.x, from.y);
      await this.page.mouse.down();
    }
    for (let i = 1; i <= steps; i++) {
      const p = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      if (this.touch) await this.send('touchMove', [p]);
      else await this.page.mouse.move(p.x, p.y);
      await frames(this.page, 1);
    }
    await expect.poll(() => read(this.page).then((s) => s.dragging)).not.toBeNull();
    if (this.touch) await this.send('touchEnd', []);
    else await this.page.mouse.up();
  }
}

test('a pointer drag moves an item from the left grid into the right one', async ({ page }) => {
  const s0 = await read(page);
  expect(s0.items.backpack).toContain('alpha@0,0');
  expect(s0.items.equipment).toEqual(['ring@0,0']);
  const finger = new Finger(page, touchRow());
  await finger.drag(
    await centre(cell(page, 'Backpack', 0, 0)),
    await centre(cell(page, 'Equipment', 1, 1)),
  );
  await expect
    .poll(() => read(page).then((s) => s.items.equipment))
    .toEqual(['ring@0,0', 'alpha@1,1']);
  // `dragging` is sampled per frame; the items sync in `onMove`.
  await expect.poll(() => read(page).then((s) => s.dragging)).toBeNull();
  const s1 = await read(page);
  expect(s1.items.backpack).not.toContain('alpha@0,0');
  expect(s1.moves).toEqual(['backpack:alpha:0,0>1,1', 'equipment:alpha:0,0>1,1']);
  await expect(page.locator('.tc-drag-ghost')).toHaveCount(0);
  await expect(cell(page, 'Equipment', 1, 1)).toHaveAttribute('aria-label', 'Alpha');
  await expect(cell(page, 'Equipment', 1, 1)).not.toHaveAttribute('data-over');
});

test('a refused drop snaps the ghost back and changes nothing', async ({ page }) => {
  const before = await read(page);
  const finger = new Finger(page, touchRow());
  // Beta has no tone: the right grid refuses it.
  await finger.drag(
    await centre(cell(page, 'Backpack', 1, 0)),
    await centre(cell(page, 'Equipment', 0, 1)),
  );
  await expect.poll(() => read(page).then((s) => s.dragging)).toBeNull();
  await expect(page.locator('.tc-drag-ghost')).toHaveCount(0);
  const after = await read(page);
  expect(after.items).toEqual(before.items);
  expect(after.moves).toEqual([]);
  await expect(cell(page, 'Equipment', 0, 1)).not.toHaveAttribute('data-reject');
});

test('the pad picks up, crosses into the right grid at the edge and drops', async ({ page }) => {
  await page.evaluate(() => window.__harnessInventory?.focus('backpack', 5, 0));
  await expect(cell(page, 'Backpack', 5, 0)).toBeFocused();
  const pad = (a: 'select' | 'right' | 'left' | 'back') =>
    page.evaluate((action) => window.__harnessInventory?.pad(action), a);
  await pad('select');
  await expect.poll(() => read(page).then((s) => s.dragging)).toBe('delta');
  await expect(cell(page, 'Backpack', 5, 0)).toHaveAttribute('aria-grabbed', 'true');
  await pad('right');
  await expect
    .poll(() => read(page).then((s) => s.focused))
    .toEqual({ grid: 'equipment', col: 0, row: 0 });
  await expect(cell(page, 'Equipment', 0, 0)).toBeFocused();
  // Over the ring: refused (the span's cell is taken). One right: free.
  await expect(cell(page, 'Equipment', 0, 0)).toHaveAttribute('data-reject');
  await pad('right');
  await expect(cell(page, 'Equipment', 1, 0)).toHaveAttribute('data-over');
  await expect(cell(page, 'Equipment', 1, 0)).not.toHaveAttribute('data-reject');
  await pad('select');
  await expect
    .poll(() => read(page).then((s) => s.items.equipment))
    .toEqual(['ring@0,0', 'delta@1,0']);
  await expect.poll(() => read(page).then((s) => s.dragging)).toBeNull();
  const s = await read(page);
  expect(s.items.backpack).not.toContain('delta@5,0');
  expect(s.moves).toEqual(['backpack:delta:5,0>1,0', 'equipment:delta:5,0>1,0']);
});

test('focus shows the card beside the cell and flips it near the right edge', async ({ page }) => {
  await page.evaluate(() => window.__harnessInventory?.focus('backpack', 1, 0));
  await expect.poll(() => read(page).then((s) => s.cardVisible)).toBe(true);
  expect((await read(page)).cardPlacement).toBe('right');
  const card = page.locator('.tc-inv-card[role=tooltip]');
  await expect(card).toBeVisible();
  await expect(card.locator('.tc-inv-card-title')).toHaveText('Beta');
  await expect(cell(page, 'Backpack', 1, 0)).toHaveAttribute(
    'aria-describedby',
    (await card.getAttribute('id')) ?? '',
  );
  await page.evaluate(() => window.__harnessInventory?.focus('equipment', 1, 0));
  await expect.poll(() => read(page).then((s) => s.cardVisible)).toBe(false);
  await page.evaluate(() => window.__harnessInventory?.focus('equipment', 0, 0));
  await expect.poll(() => read(page).then((s) => s.cardPlacement)).toBe('left');
  await expect(card.locator('.tc-inv-card-title')).toHaveText('Ring');
  await page.keyboard.press('Escape');
  await expect.poll(() => read(page).then((s) => s.cardVisible)).toBe(false);
});

test('the radial highlights the east sector for aim(1, 0) and pick fires', async ({ page }) => {
  await page.goto(`${HARNESS_URL}inventory.html?radial`);
  await expect.poll(() => read(page).then((s) => s.ready && s.radialActive)).toBe(true);
  const menu = page.locator('.tc-radial[role=menu]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role=menuitem]')).toHaveCount(6);
  await page.evaluate(() => window.__harnessInventory?.radial.aim(1, 0));
  await expect.poll(() => read(page).then((s) => s.radialHighlighted)).toBe(0);
  await expect(menu.locator('[role=menuitem][data-active]')).toHaveAttribute('aria-label', 'One');
  await page.evaluate(() => window.__harnessInventory?.radial.aim(0, 1));
  await expect.poll(() => read(page).then((s) => s.radialHighlighted)).toBe(2);
  await page.evaluate(() => window.__harnessInventory?.radial.aim(0.1, 0.1));
  await expect.poll(() => read(page).then((s) => s.radialHighlighted)).toBe(-1);
  await page.evaluate(() => window.__harnessInventory?.radial.aim(1, 0));
  await page.evaluate(() => window.__harnessInventory?.radial.pick());
  await expect.poll(() => read(page).then((s) => s.picks)).toEqual(['radial:one']);
  await expect.poll(() => read(page).then((s) => s.radialActive)).toBe(false);
});

test('the secondary button opens the context list; Escape returns the focus to the cell', async ({
  page,
}) => {
  const target = cell(page, 'Backpack', 1, 0);
  await target.click({ button: 'right' });
  await expect.poll(() => read(page).then((s) => s.contextOpen)).toBe(true);
  const menu = page.locator('.tc-context[role=menu]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role=menuitem]').first()).toBeFocused();
  await expect(menu.locator('[role=menuitem]').nth(1)).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('[role=menuitem]').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => read(page).then((s) => s.contextOpen)).toBe(false);
  await expect(menu).toHaveCount(0);
  await expect(target).toBeFocused();
  expect((await read(page)).picks).toEqual([]);
  // Picking an entry.
  await target.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => read(page).then((s) => s.picks)).toEqual(['context:use']);
  await expect(target).toBeFocused();
});
