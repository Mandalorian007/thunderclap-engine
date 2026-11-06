/**
 * The second widget set (ws/ui-widgets) on every top-level matrix row, against the widgets
 * harness page (harness/widgets.html, no WebGPU):
 *
 * - ArrowRight on the segmented choice moves its value and the roving tabindex;
 * - ArrowUp on the stepper's spinbutton steps it;
 * - `bar.set` updates `aria-valuenow` and `aria-valuetext`;
 * - the cooldown's `ready` flips at 1;
 * - the reticle's spread lands in its custom property and its lines open.
 *
 * The itch-iframe row is skipped: the wrapper embeds the WebGPU harness page, and the widgets do
 * not depend on the frame.
 */
import type { Page } from '@playwright/test';
import type { HarnessWidgetsState } from '../harness/widgets-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'widgets harness runs top-level only');
  await page.goto(`${HARNESS_URL}widgets.html`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
});

function read(page: Page): Promise<HarnessWidgetsState> {
  return page.evaluate(() => {
    const s = window.__harnessWidgets?.state;
    if (!s) throw new Error('window.__harnessWidgets missing');
    return JSON.parse(JSON.stringify(s)) as HarnessWidgetsState;
  });
}

test('ArrowRight moves the segmented value and the roving tabindex', async ({ page }) => {
  const group = page.locator('.tc-ui-segmented[role=radiogroup]');
  await expect(group).toHaveAttribute('aria-label', 'Segment');
  const checked = group.locator('[role=radio][aria-checked=true]');
  await expect(checked).toHaveText('Mid');
  await expect(checked).toHaveAttribute('tabindex', '0');
  await checked.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => read(page).then((s) => s.segment)).toBe('high');
  await expect(group.locator('[role=radio][aria-checked=true]')).toHaveText('High');
  await expect(group.locator('[role=radio]').nth(1)).toHaveAttribute('tabindex', '-1');
  await expect(group.locator('[role=radio]').nth(2)).toHaveAttribute('tabindex', '0');
  await expect(group.locator('[role=radio]').nth(2)).toBeFocused();
  // Wraps.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => read(page).then((s) => s.segment)).toBe('low');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => read(page).then((s) => s.segment)).toBe('high');
  expect((await read(page)).changes).toEqual(['segment:high', 'segment:low', 'segment:high']);
});

test('ArrowUp steps the stepper; Home and End jump to the bounds', async ({ page }) => {
  const field = page.locator('.tc-ui-stepper [role=spinbutton]');
  await expect(field).toHaveAttribute('aria-valuenow', '3');
  await field.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => read(page).then((s) => s.stepper)).toBe(4);
  await expect(field).toHaveAttribute('aria-valuenow', '4');
  await expect(field).toHaveText('4');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => read(page).then((s) => s.stepper)).toBe(3);
  await page.keyboard.press('End');
  await expect.poll(() => read(page).then((s) => s.stepper)).toBe(10);
  await expect(page.locator('.tc-ui-stepper .tc-button').nth(1)).toBeDisabled();
  await page.keyboard.press('Home');
  await expect.poll(() => read(page).then((s) => s.stepper)).toBe(0);
  await expect(page.locator('.tc-ui-stepper .tc-button').nth(0)).toBeDisabled();
  // The + button steps too.
  await page.locator('.tc-ui-stepper .tc-button').nth(1).click();
  await expect.poll(() => read(page).then((s) => s.stepper)).toBe(1);
});

test('bar.set updates aria-valuenow and aria-valuetext', async ({ page }) => {
  const b = page.locator('.tc-ui-bar[role=progressbar]');
  await expect(b).toHaveAttribute('aria-valuenow', '60');
  await expect(b).toHaveAttribute('aria-valuetext', '60%');
  await expect(b).toHaveAttribute('aria-valuemax', '100');
  await page.evaluate(() => window.__harnessWidgets?.set.bar(25));
  await expect(b).toHaveAttribute('aria-valuenow', '25');
  await expect(b).toHaveAttribute('aria-valuetext', '25%');
  expect(await b.evaluate((el) => el.style.getPropertyValue('--tc-ui-fill'))).toBe('0.25');
  await page.evaluate(() => window.__harnessWidgets?.set.bar(500));
  await expect(b).toHaveAttribute('aria-valuenow', '100');
  // The fill is a scaleX transform of the track's width (it transitions, so poll); the gap is
  // the track's border.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const track = document.querySelector('.tc-ui-bar-track') as HTMLElement;
        const fill = document.querySelector('.tc-ui-bar-fill') as HTMLElement;
        const t = track.getBoundingClientRect().width;
        return t > 0 ? Math.abs(fill.getBoundingClientRect().width - t) : 1e9;
      }),
    )
    .toBeLessThanOrEqual(6);
});

test('cooldown ready flips at 1', async ({ page }) => {
  const cd = page.locator('.tc-ui-cooldown');
  await expect(cd).toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => window.__harnessWidgets?.set.cooldown(0.5));
  expect((await read(page)).cooldownReady).toBe(false);
  expect(await cd.evaluate((el) => el.hasAttribute('data-ready'))).toBe(false);
  expect(await cd.evaluate((el) => el.style.getPropertyValue('--tc-ui-sweep'))).toBe('0.5');
  await page.evaluate(() => window.__harnessWidgets?.set.cooldown(1));
  await expect.poll(() => read(page).then((s) => s.cooldownReady)).toBe(true);
  expect(await cd.evaluate((el) => el.hasAttribute('data-ready'))).toBe(true);
  await page.evaluate(() => window.__harnessWidgets?.set.cooldown(0));
  await expect.poll(() => read(page).then((s) => s.cooldownReady)).toBe(false);
});

test('the reticle sits on the frame centre and opens with the spread', async ({ page }) => {
  const r = page.locator('.tc-ui-reticle');
  const right = r.locator('[data-side=right]');
  const hud = page.locator('.tc-layer[data-layer=hud]');
  const hudBox = await hud.boundingBox();
  const box = await r.boundingBox();
  if (!hudBox || !box) throw new Error('no reticle');
  expect(Math.abs(box.x + box.width / 2 - (hudBox.x + hudBox.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - (hudBox.y + hudBox.height / 2))).toBeLessThanOrEqual(1);
  const closed = await right.boundingBox();
  await page.evaluate(() => window.__harnessWidgets?.set.reticle(1));
  await expect.poll(() => read(page).then((s) => s.reticleSpread)).toBe(1);
  expect(await r.evaluate((el) => el.style.getPropertyValue('--tc-ui-spread'))).toBe('1');
  await expect
    .poll(async () => {
      const open = await right.boundingBox();
      return open && closed ? open.x - closed.x : 0;
    })
    .toBeGreaterThan(2);
  // `hit()` sets `data-hit` synchronously and `animationend` clears it, so read it in the same
  // evaluate: a second round trip can land after the animation on a slow row.
  const hit = await r.evaluate((el) => {
    window.__harnessWidgets?.hit();
    return el.hasAttribute('data-hit');
  });
  expect(hit).toBe(true);
});
