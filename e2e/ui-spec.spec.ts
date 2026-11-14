/**
 * The UI spec harness (harness/ui-spec.html, ws/ui-spec): an RPG HUD written as data, drawn by the
 * DOM presenter in the overlay's layout regions, on every matrix row (top level only).
 *
 * - each panel sits in its region with real roles: two meters, a toolbar of slot buttons, a list;
 * - the bars move while the page drifts them (polled, E-017), and once parked a frame writes
 *   nothing (the frame counter moves, the write counter does not);
 * - a tap or a number key selects a slot, exactly one at a time;
 * - a new quest adds a row, a finished one moves to the end and dims;
 * - the dialog opens on the overlay's stack with focus on its answer, accepting adds a quest and
 *   closes it, Escape closes it.
 */
import type { Page } from '@playwright/test';
import type { HarnessUiSpecState } from '../harness/ui-spec-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

const errors: string[] = [];

function read(page: Page): Promise<HarnessUiSpecState> {
  return page.evaluate(() => {
    const s = window.__harnessUiSpec?.state;
    if (!s) throw new Error('window.__harnessUiSpec missing');
    return JSON.parse(JSON.stringify(s)) as HarnessUiSpecState;
  });
}

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'the UI spec harness runs top-level only');
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${HARNESS_URL}ui-spec.html`);
  await expect.poll(() => read(page).then((s) => (s.ready ? s.frames : -1))).toBeGreaterThan(2);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('each panel sits in its region with its roles', async ({ page }) => {
  const region = (id: string) =>
    page.evaluate(
      (id) =>
        document.getElementById(`tc-spec-${id}`)?.closest<HTMLElement>('.tc-region')?.dataset
          .region ?? null,
      id,
    );
  expect(await region('vitals')).toBe('left');
  expect(await region('hotbar')).toBe('bottom');
  expect(await region('quests')).toBe('right');
  await expect(page.locator('#tc-spec-vitals [role=meter]')).toHaveCount(2);
  await expect(page.locator('#tc-spec-hotbar [role=toolbar] button')).toHaveCount(6);
  await expect(page.locator('#tc-spec-quests [role=listitem]:not([data-off])')).toHaveCount(2);
  await expect(page.locator('#tc-spec-hotbar')).toBeVisible();
  const box = await page.locator('[data-tc-id="hotbar/hot.0"]').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40);
});

test('the bars move, and a parked frame writes nothing', async ({ page }) => {
  const now = () =>
    page.locator('#tc-spec-vitals [role=meter]').first().getAttribute('aria-valuenow');
  const first = await now();
  await expect.poll(now).not.toBe(first);
  await page.evaluate(() => window.__harnessUiSpec!.park(true));
  // Let the last drifted frame land, then count.
  await expect
    .poll(() => read(page).then((s) => s.frames))
    .toBeGreaterThan((await read(page)).frames + 2);
  const a = await read(page);
  await expect.poll(() => read(page).then((s) => s.frames)).toBeGreaterThan(a.frames + 10);
  const b = await read(page);
  expect(b.writes).toBe(a.writes);
  expect(b.applies).toBe(a.applies);
});

test('a tap or a number key selects one slot', async ({ page }) => {
  await page.evaluate(() => window.__harnessUiSpec!.park(true));
  await page.locator('[data-tc-id="hotbar/hot.2"]').click();
  await expect.poll(() => read(page).then((s) => s.selected)).toBe(2);
  await expect(page.locator('[data-tc-id="hotbar/hot.2"]')).toHaveAttribute('data-state', 'on');
  await page.keyboard.press('5');
  await expect(page.locator('[data-tc-id="hotbar/hot.4"]')).toHaveAttribute('data-state', 'on');
  await expect(page.locator('#tc-spec-hotbar [data-state=on]')).toHaveCount(1);
});

test('a new quest adds a row, a finished one moves to the end', async ({ page }) => {
  await page.evaluate(() => window.__harnessUiSpec!.park(true));
  const rows = page.locator('#tc-spec-quests [role=listitem]:not([data-off])');
  await page.evaluate(() => window.__harnessUiSpec!.addQuest('Light the beacon'));
  await expect(rows).toHaveCount(3);
  await page.evaluate(() => window.__harnessUiSpec!.finish('q0'));
  await expect(rows.last()).toHaveAttribute('data-state', 'done');
  await expect(rows.last()).toContainText('Cross the river');
  await expect(rows.first()).toContainText('Mend the fence');
});

test('the dialog opens on the stack, accepting adds a quest, Escape closes', async ({ page }) => {
  await page.evaluate(() => window.__harnessUiSpec!.park(true));
  await page.evaluate(() => window.__harnessUiSpec!.openDialog());
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('lantern');
  await expect(page.locator('[data-tc-id="talk/accept"]')).toBeFocused();
  await page.locator('[data-tc-id="talk/accept"]').click();
  await expect(dialog).toHaveCount(0);
  const s = await read(page);
  expect(s.quests).toBe(3);
  expect(s.last).toBe('talk/accept:tap');
  await page.evaluate(() => window.__harnessUiSpec!.openDialog());
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => read(page).then((s) => s.dialog)).toBe(false);
});
