/**
 * The game fit hooks (ws/ui-fit) against harness/ui-fit.html: one spec panel on the page (the DOM
 * presenter) and on a world surface made on a bare device (the world presenter), top level only.
 *
 * - one layout: a word's box is the same on the page and on the surface;
 * - the stack's aim, the icon's ring and the game's class name are on the page;
 * - the windowed list binds only rows near its view, and both presenters reveal a far row;
 * - a row moved to the top slides there;
 * - type-ahead: a letter typed with nothing focused goes into the search field; its close key in
 *   the empty field closes the panel (it slides out), on the page and through the surface's keys;
 * - the held slot says down and up (no tap) on the page and on the surface;
 * - the panel gives way while a sheet is open on a small screen.
 */
import type { Page } from '@playwright/test';
import type { UiFitState } from '../harness/ui-fit-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

const errors: string[] = [];

function read(page: Page): Promise<UiFitState> {
  return page.evaluate(() => {
    const s = window.__harnessUiFit?.state;
    if (!s) throw new Error('window.__harnessUiFit missing');
    return JSON.parse(JSON.stringify(s)) as UiFitState;
  });
}

const events = (page: Page) => read(page).then((s) => s.events);

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'the UI fit harness runs top-level only');
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${HARNESS_URL}ui-fit.html`);
  await expect
    .poll(async () => {
      const s = await page.evaluate(() => window.__harnessUiFit?.state ?? null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`ui-fit: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThan(2);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('one layout on the page and on the surface; aim, ring and class names', async ({ page }) => {
  for (const id of ['grab', 'find', 'cool', 'things']) {
    const { dom, world } = await page.evaluate((id) => window.__harnessUiFit!.boxes(id), id);
    expect(dom, id).not.toBeNull();
    expect(world, id).not.toBeNull();
    for (const k of ['x', 'y', 'w', 'h'] as const)
      expect(Math.abs(dom![k] - world![k]), `${id}.${k}`).toBeLessThan(1);
  }
  await expect(page.locator('#page [data-id="head"]')).toHaveAttribute('data-aim', 'down');
  await expect(page.locator('[data-tc-id="fit/grab"]')).toHaveClass(/fit-slot/);
  const ring = await page
    .locator('#page [data-id="cool"] .tcs-ring')
    .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--tcs-ring'));
  expect(ring).toBe('0.25');
  const s = await read(page);
  expect(s.uploads).toBeGreaterThan(0);
});

test('a windowed list binds rows near its view; both presenters reveal a far one', async ({
  page,
}) => {
  const s = await read(page);
  expect(s.domRows[0]).toBe('r0');
  expect(s.domRows.length).toBeLessThan(20);
  expect(s.worldRows[0]).toBe('r0');
  expect(s.domRows).not.toContain('r300');
  expect(await page.evaluate(() => window.__harnessUiFit!.reveal('r300'))).toBe(true);
  await expect.poll(() => read(page).then((s) => s.domRows.includes('r300'))).toBe(true);
  await expect.poll(() => read(page).then((s) => s.worldRows.includes('r300'))).toBe(true);
  await expect(page.locator('#page [data-id="things"]')).toContainText('thing 300');
  expect((await read(page)).domRows).not.toContain('r0');
});

test('a row moved to the top slides there; the top row in view keeps its place', async ({
  page,
}) => {
  await page.evaluate(() => window.__harnessUiFit!.toTop('r5'));
  await expect.poll(() => read(page).then((s) => s.domRows[0])).toBe('r5');
  // r0 was the top row in view: both views scroll a row, so it stays where it was.
  await expect.poll(() => read(page).then((s) => s.worldRows.slice(0, 2))).toEqual(['r0', 'r1']);
  await expect
    .poll(() => page.locator('#page [data-id="things"]').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(20);
  await page.evaluate(() => window.__harnessUiFit!.reveal('r5'));
  await expect.poll(() => read(page).then((s) => s.worldRows[0])).toBe('r5');
});

test('type-ahead fills the search field; its close key closes the panel', async ({ page }) => {
  const find = page.locator('#page input[data-id="find"]');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('s');
  await expect(find).toHaveValue('s');
  await expect(find).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(find).toHaveValue('');
  await page.keyboard.press('e');
  await expect.poll(() => events(page)).toContain('find:close:null');
  await expect(find).toBeHidden();
  await page.evaluate(() => window.__harnessUiFit!.open(true));
  await expect(find).toBeVisible();
});

test('the surface’s keys: type-ahead and the close key', async ({ page }) => {
  expect(await page.evaluate(() => window.__harnessUiFit!.worldKey('t', 'KeyT'))).toBe(true);
  await expect.poll(() => read(page).then((s) => s.find)).toBe('t');
  await page.evaluate(() => window.__harnessUiFit!.worldKey('Backspace'));
  await page.evaluate(() => window.__harnessUiFit!.worldKey('e', 'KeyE'));
  await expect.poll(() => events(page)).toContain('find:close:null');
});

test('the held slot says down and up, never tap', async ({ page }) => {
  const box = (await page.locator('[data-tc-id="fit/grab"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => events(page)).toContain('grab:down:null');
  await page.mouse.up();
  await expect.poll(() => events(page)).toContain('grab:up:null');
  await page.evaluate(() => window.__harnessUiFit!.worldPress('grab', 50));
  const grab = (await events(page)).filter((e) => e.startsWith('grab:'));
  expect(grab).toEqual(['grab:down:null', 'grab:up:null', 'grab:down:null', 'grab:up:null']);
});

test('it gives way while a sheet is open on a small screen', async ({ page }) => {
  await page.evaluate(() => window.__harnessUiFit!.giveWay(true, false));
  await expect.poll(() => read(page).then((s) => s.given)).toBe(false);
  await page.evaluate(() => window.__harnessUiFit!.giveWay(true, true));
  await expect.poll(() => read(page).then((s) => s.given)).toBe(true);
  const host = page.locator('#page');
  await expect(host).toHaveAttribute('data-given', '');
  await expect(host).toHaveCSS('opacity', '0');
  await expect(host).toHaveCSS('pointer-events', 'none');
  await page.evaluate(() => window.__harnessUiFit!.giveWay(false, true));
  await expect(host).toHaveCSS('opacity', '1');
  await expect(host).not.toHaveAttribute('data-given');
});
