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
 *   button key from a focused button;
 * - (ws/ui-3, query modes) tooltips on hover, focus and a world point with an edge flip; the
 *   world cursor by arrows and polled pad presses in grid and targets modes; the loading screen's
 *   `done` and `aria-busy`; a notification's action by Enter.
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
  // Set the button and read the tick in one evaluate: read in a separate round trip, the ticks
  // that pass between the two under load would count as held ticks the pad never saw.
  const set = (pressed: boolean) =>
    page.evaluate(
      ([b, p]) => {
        window.__harnessUi?.pad(b, p);
        return window.__harnessUi?.state.ticks ?? 0;
      },
      [button, pressed] as [number, boolean],
    );
  const pressedAt = await set(true);
  await expect.poll(async () => (await read(page)).ticks).toBeGreaterThan(pressedAt + 2);
  const releasedAt = await set(false);
  await expect.poll(async () => (await read(page)).ticks).toBeGreaterThan(releasedAt + 2);
}

test('menuNav: the d-pad walks the menu and A clicks; arrows move, Enter clicks once', async ({
  page,
}) => {
  // Each focus step is polled: a press is read on a tick, and under load the tick after the
  // release can land after the read (E-017).
  await padPress(page, 13);
  await expect.poll(() => focusedLabel(page)).toBe('First');
  await padPress(page, 13);
  await expect.poll(() => focusedLabel(page)).toBe('Second');
  await padPress(page, 12);
  await expect.poll(() => focusedLabel(page)).toBe('First');
  await padPress(page, 12);
  await expect.poll(() => focusedLabel(page)).toBe('Third');
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
  test.fixme(
    test.info().project.use.browserName === 'webkit',
    'engine bug: the modal trap leans on native Tab, which skips buttons in WebKit (src/ui/stack.ts)',
  );
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

test('tooltip: hover shows it after the delay and leave hides it; focus shows it, flipped at the edge', async ({
  page,
}) => {
  await page.goto(`${HARNESS_URL}ui.html?tooltip`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
  const tip = page.locator('.tc-tooltip');
  // The world point's tooltip is up from the start, to the right of its anchor.
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('A world point');
  await expect.poll(async () => (await read(page)).tooltipPlacement).toBe('right');

  if (!test.info().project.use.hasTouch) {
    await page.locator('#tip-top').hover();
    await expect(tip).toHaveText('Above the button');
    await expect.poll(async () => (await read(page)).tooltipVisible).toBe(true);
    await expect.poll(async () => (await read(page)).tooltipPlacement).toBe('top');
    await expect(tip).toHaveAttribute('role', 'tooltip');
    await expect(page.locator('#tip-top')).toHaveAttribute(
      'aria-describedby',
      (await tip.getAttribute('id')) ?? '',
    );
    await page.mouse.move(4, 4);
    await expect(tip).toBeHidden();
    await expect.poll(async () => (await read(page)).tooltipVisible).toBe(false);
    await expect(page.locator('#tip-top')).not.toHaveAttribute('aria-describedby');
  }

  // Keyboard focus shows it at once on every row; the top-edge button flips below.
  await page.locator('#tip-edge').focus();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('Flipped below the edge');
  await expect.poll(async () => (await read(page)).tooltipPlacement).toBe('bottom');
  await page.locator('#tip-bottom').focus();
  await expect(tip).toHaveText('Below the button');
  await expect.poll(async () => (await read(page)).tooltipPlacement).toBe('bottom');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('cursor: grid mode steps by arrows and by polled pad presses, one step per press', async ({
  page,
}) => {
  await page.goto(`${HARNESS_URL}ui.html?cursor`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
  await expect(page.locator('.tc-cursor')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).cursorCell).toEqual([1, 0]);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await read(page)).cursorCell).toEqual([1, 1]);
  // The pad is polled with the same latch as menuNav: held over several ticks, one step.
  await padPress(page, 15);
  await expect.poll(async () => (await read(page)).cursorCell).toEqual([2, 1]);
  await padPress(page, 12);
  await expect.poll(async () => (await read(page)).cursorCell).toEqual([2, 0]);
  await padPress(page, 12);
  await expect.poll(async () => (await read(page)).cursorCell).toEqual([2, 0]); // clamped by the game
  await page.waitForTimeout(100);
  expect((await read(page)).cursorCell).toEqual([2, 0]);
});

test('cursor: targets mode picks the neighbour in the pressed direction', async ({ page }) => {
  await page.goto(`${HARNESS_URL}ui.html?cursor&mode=targets`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
  await expect.poll(async () => (await read(page)).cursorTarget).toBe('0,0');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).cursorTarget).toBe('1,0');
  await padPress(page, 13);
  await expect.poll(async () => (await read(page)).cursorTarget).toBe('1,1');
  await padPress(page, 14);
  await expect.poll(async () => (await read(page)).cursorTarget).toBe('0,1');
  await padPress(page, 14);
  await expect.poll(async () => (await read(page)).cursorTarget).toBe('0,1'); // nothing further left
});

test('loading: the bar reports progress, done removes the panel and clears aria-busy', async ({
  page,
}) => {
  await page.goto(`${HARNESS_URL}ui.html?loading&stall`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
  const panel = page.locator('.tc-loading');
  const root = page.locator('.tc-overlay');
  await expect(panel).toBeVisible();
  await expect(root).toHaveAttribute('aria-busy', 'true');
  await expect.poll(async () => (await read(page)).loadingProgress).toBe(0.4);
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '40%');
  await expect(panel.locator('.tc-loading-tip')).toHaveText(/Tip (one|two)/);
  // Keys are swallowed while it shows: the menu behind it does not move.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  expect((await read(page)).menu).toEqual([]);
  await page.evaluate(() => window.__harnessUi?.finishLoading());
  await expect.poll(async () => (await read(page)).loadingProgress).toBe(-1);
  await expect(panel).toHaveCount(0);
  await expect(root).not.toHaveAttribute('aria-busy');
});

test('notify: a notification stacks in a live region and its action fires by Enter', async ({
  page,
}) => {
  await page.goto(`${HARNESS_URL}ui.html?notify`);
  await expect.poll(() => read(page).then((s) => s.ready && s.ticks > 2)).toBe(true);
  const card = page.locator('.tc-notification');
  await expect(card).toBeVisible();
  await expect(card).toContainText('A notification');
  await expect(page.locator('.tc-notify')).toHaveAttribute('aria-live', 'polite');
  await expect.poll(async () => (await read(page)).notifications).toBe(1);
  await card.locator('.tc-notification-action').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).notifyActions).toEqual(['Act']);
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await read(page)).notifications).toBe(0);
});
