/**
 * Localisation (`@thunderclap/engine/i18n`) on every top-level matrix row, against
 * harness/i18n.html (no WebGPU): the negotiated locale, plural forms in `en`, `ru` and `ar`
 * through the browser's `Intl.PluralRules`, a lazily loaded table, RTL direction reaching the
 * DOM, and `subscribe` driving the re-render.
 *
 * The itch-iframe row is skipped: the wrapper embeds the WebGPU harness page, and string tables
 * do not depend on the frame.
 */
import type { Page } from '@playwright/test';
import type { HarnessI18nState } from '../harness/i18n-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'i18n harness runs top-level only');
  await page.goto(`${HARNESS_URL}i18n.html`);
  await expect.poll(() => read(page).then((s) => s.ready)).toBe(true);
});

function read(page: Page): Promise<HarnessI18nState> {
  return page.evaluate(() => {
    const s = window.__harnessI18n?.state;
    if (!s) throw new Error('window.__harnessI18n missing');
    return JSON.parse(JSON.stringify(s)) as HarnessI18nState;
  });
}

const setLocale = (page: Page, locale: string) =>
  page.evaluate((l) => window.__harnessI18n?.setLocale(l), locale);
const setCount = (page: Page, n: number) =>
  page.evaluate((c) => window.__harnessI18n?.setCount(c), n);

/** The browser's own digits for `n` in `locale`, so the assertion follows its ICU. */
const digits = (page: Page, locale: string, n: number) =>
  page.evaluate(([l, v]) => new Intl.NumberFormat(l as string).format(v as number), [locale, n]);

test('starts in English, negotiates the browser locale, counts plurals', async ({ page }) => {
  const s = await read(page);
  expect(s.locale).toBe('en');
  expect(s.direction).toBe('ltr');
  expect(s.negotiated).toBe('en');
  expect(s.renders).toBe(1);
  await expect(page.locator('#sample')).toHaveText('1 item');
  await expect(page.locator('#title')).toHaveText('Localisation');
  await setCount(page, 0);
  await expect(page.locator('#sample')).toHaveText('No items');
  await page.locator('#count-inc').click();
  await page.locator('#count-inc').click();
  await expect(page.locator('#sample')).toHaveText('2 items');
  expect((await read(page)).sample).toBe('2 items');
  await expect(page.locator('#rtl')).toHaveAttribute('dir', 'ltr');
});

test('Russian: one, few and many through Intl.PluralRules; subscribe re-renders', async ({
  page,
}) => {
  await page.locator('#loc-ru').click();
  await expect(page.locator('#title')).toHaveText('Локализация');
  const s = await read(page);
  expect(s.locale).toBe('ru');
  expect(s.renders).toBe(2);
  await setCount(page, 1);
  await expect(page.locator('#sample')).toHaveText('1 предмет');
  await setCount(page, 2);
  await expect(page.locator('#sample')).toHaveText('2 предмета');
  await setCount(page, 5);
  await expect(page.locator('#sample')).toHaveText('5 предметов');
  await setCount(page, 21);
  await expect(page.locator('#sample')).toHaveText('21 предмет');
  await expect(page.locator('#count-inc')).toHaveText('Больше');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');
});

test('Arabic: lazy table, RTL direction in the DOM, English fallback for missing keys', async ({
  page,
}) => {
  await setLocale(page, 'ar');
  const s = await read(page);
  expect(s.locale).toBe('ar');
  expect(s.direction).toBe('rtl');
  await expect(page.locator('#rtl')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#root')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#title')).toHaveText('الترجمة');
  // Keys `ar` lacks come from the `en` fallback.
  await expect(page.locator('#count-inc')).toHaveText('More');
  await setCount(page, 1);
  await expect(page.locator('#sample')).toHaveText('عنصر واحد');
  await setCount(page, 2);
  await expect(page.locator('#sample')).toHaveText('عنصران');
  await setCount(page, 3);
  await expect(page.locator('#sample')).toHaveText(`${await digits(page, 'ar', 3)} عناصر`);
  await setCount(page, 11);
  await expect(page.locator('#sample')).toHaveText(`${await digits(page, 'ar', 11)} عنصرًا`);

  // Back to English: direction flips back and the sample re-renders.
  await page.locator('#loc-en').click();
  await expect(page.locator('#rtl')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#sample')).toHaveText('11 items');
});
