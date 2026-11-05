/**
 * Engine UI platform, on every top-level matrix row (playwright.config.ts), against the UI
 * harness page (harness/ui.html, no WebGPU):
 *
 * - the text-scale density tokens at 100/125/150 on base widgets and a design-px sheet
 *   (`scaleFontSizes`, `toFrameUnits`) on the frame, in CSS px, with the `--tc-text-min` floor
 *   on phones;
 * - the device-mode flags `data-phone` and `data-touch`;
 * - the rotate card on upright phones;
 * - `menuNav` from a gamepad and the arrows;
 * - panel focus (trap, restore to the opener, home for `NO_RESTORE_FOCUS_ATTR`) and Escape as a
 *   button key from a focused button.
 *
 * The itch-iframe row is skipped here: the wrapper embeds the WebGPU harness page, and the UI
 * layer does not depend on the frame.
 */
import type { Page } from '@playwright/test';
import type { HarnessUiState } from '../harness/ui-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

const PHONES = new Set(['phone-se', 'phone-iphone', 'phone-promax', 'phone-android']);
const DESKTOPS = new Set(['desktop-1280', 'desktop-1920']);

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'UI harness runs top-level only');
  await page.goto(`${HARNESS_URL}ui.html`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
});

function read(page: Page): Promise<HarnessUiState> {
  return page.evaluate(() => {
    const s = window.__harnessUi?.state;
    if (!s) throw new Error('window.__harnessUi missing');
    return JSON.parse(JSON.stringify(s)) as HarnessUiState;
  });
}

/** Computed font size, CSS px. */
function fontPx(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return Number.parseFloat(getComputedStyle(el).fontSize);
  }, selector);
}

async function focusedLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? a.id || a.textContent : null;
  });
}

test('text-scale tokens at 100/125/150 on base widgets, floored by text-min on phones', async ({
  page,
}) => {
  const project = test.info().project.name;
  const { scale, units } = await read(page);
  const phone = PHONES.has(project);
  // Phones are in CSS units (the theme's sizes are CSS px) and floor every size at 12 CSS px.
  expect(units).toBe(phone ? 'css' : 'frame');
  const floor = phone ? 12 : 0;
  const cases = [
    // [factor, body 20 px, display 40 px, engine button (font-size-m: 30 design px, 16 CSS px)]
    [1, 20, 40, phone ? 16 : 30],
    [1.25, 25, 40, phone ? 20 : 38],
    [1.5, 30, 45, phone ? 24 : 45],
  ] as const;
  // The sheet is design px on the frame, so its sizes are `scale` CSS px each everywhere; the
  // theme's are frame px off phones and CSS px on them.
  const k = phone ? 1 : scale;
  for (const [factor, design, designDisplay, buttonPx] of cases) {
    const body = design * scale;
    const display = designDisplay * scale;
    await page.evaluate((f) => window.__harnessUi?.setTextScale(f), factor);
    const root = page.locator('.tc-overlay');
    if (factor === 1) await expect(root).not.toHaveAttribute('data-text-scale');
    else await expect(root).toHaveAttribute('data-text-scale', String(Math.round(factor * 100)));
    expect(
      await root.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--tc-text-scale')),
    ).toBe(String(factor));
    expect(await fontPx(page, '#probe-text')).toBeCloseTo(Math.max(body, floor), 0);
    expect(await fontPx(page, '#probe-title')).toBeCloseTo(Math.max(display, floor), 0);
    expect(await fontPx(page, '.probe-menu .tc-button')).toBeCloseTo(
      Math.max(buttonPx * k, floor),
      0,
    );
    if (phone) {
      // Nothing renders under 12 CSS px.
      for (const sel of ['#probe-text', '.probe-menu .tc-button', '.tc-caption-text']) {
        expect(await fontPx(page, sel), sel).toBeGreaterThanOrEqual(11.9);
      }
    }
  }
});

test('device mode: data-phone on phones only, data-touch follows the last input', async ({
  page,
}) => {
  const project = test.info().project;
  const root = page.locator('.tc-overlay');
  const phone = PHONES.has(project.name);
  expect((await read(page)).phone).toBe(phone);
  if (phone) await expect(root).toHaveAttribute('data-phone', '');
  else await expect(root).not.toHaveAttribute('data-phone');

  // Empty overlay space: the root lets the pointer through to the page.
  if (project.use.hasTouch) {
    await page.touchscreen.tap(8, 8);
    await expect(root).toHaveAttribute('data-touch', '');
    expect((await read(page)).touch).toBe(true);
  } else {
    await page.mouse.click(8, 8);
    await expect(root).not.toHaveAttribute('data-touch');
    expect((await read(page)).touch).toBe(false);
  }
});

test('rotate card: shown on an upright phone, gone when it turns back', async ({ page }) => {
  const project = test.info().project.name;
  const card = page.locator('.tc-rotate');
  const landscape = page.viewportSize();
  if (!landscape) throw new Error('no viewport');
  await expect(card).toBeHidden();
  await page.setViewportSize({ width: landscape.height, height: landscape.width });
  if (PHONES.has(project)) {
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAccessibleName('Rotate your device');
    await expect(card.locator('h2')).toHaveText('Rotate your device');
    await expect(card).toContainText('This page plays in landscape.');
    // It covers the whole upright viewport.
    const box = await card.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: landscape.height, height: landscape.width });
    await page.setViewportSize(landscape);
    await expect(card).toBeHidden();
  } else if (DESKTOPS.has(project)) {
    // A narrow desktop window is never told to turn the phone.
    await page.waitForTimeout(200);
    await expect(card).toBeHidden();
  }
  // `RotateCard.visible` agrees with the DOM (the page mirrors it on its next tick).
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harnessUi?.state.rotate ===
          !document.querySelector('.tc-rotate')?.hasAttribute('hidden'),
      ),
    )
    .toBe(true);
});

async function padPress(page: Page, button: number): Promise<void> {
  const before = (await read(page)).ticks;
  await page.evaluate((b) => window.__harnessUi?.pad(b, true), button);
  await expect.poll(async () => (await read(page)).ticks).toBeGreaterThan(before + 2);
  const held = (await read(page)).ticks;
  await page.evaluate((b) => window.__harnessUi?.pad(b, false), button);
  await expect.poll(async () => (await read(page)).ticks).toBeGreaterThan(held + 2);
}

test('menuNav: the d-pad walks the menu and A clicks; arrows move, Enter clicks once', async ({
  page,
}) => {
  await padPress(page, 13);
  expect(await focusedLabel(page)).toBe('First');
  await padPress(page, 13);
  expect(await focusedLabel(page)).toBe('Second');
  await padPress(page, 12);
  await padPress(page, 12);
  expect(await focusedLabel(page)).toBe('Third');
  await padPress(page, 0);
  await expect.poll(async () => (await read(page)).clicks).toEqual(['Third']);

  // Arrow keys reach menuNav on a focused button (button keys); Enter is the button's own.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedLabel(page)).toBe('First');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).clicks).toEqual(['Third', 'First']);
  await page.waitForTimeout(100);
  expect((await read(page)).clicks).toEqual(['Third', 'First']);
});

test('panel focus: trapped while open, back to the opener, or home for a HUD opener', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog', { name: 'Panel' });
  const inDialog = () =>
    page.evaluate(() => !!document.activeElement?.closest('[role=dialog]:not(.tc-rotate)'));

  await page.locator('#open-panel').click();
  await expect(dialog).toBeVisible();
  expect(await inDialog()).toBe(true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  expect(await inDialog()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await focusedLabel(page)).toBe('open-panel');
  // Escape closed the panel; the blocked input never saw it as `back`.
  expect((await read(page)).backs).toBe(0);

  await page.locator('#open-hud').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await focusedLabel(page)).toBe('home');
});

test('Escape from a focused button still reaches the game as a button key', async ({ page }) => {
  await page.locator('#open-panel').focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).backs).toBe(1);
  expect(await focusedLabel(page)).toBe('open-panel');
  await expect(page.getByRole('dialog', { name: 'Panel' })).toHaveCount(0);
});
