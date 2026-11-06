/**
 * The HUD demo (harness/hud.html) on every matrix row: the overlay's HUD widgets (ws/ui-hud)
 * over the lit mesh scene.
 *
 * - the widgets are present with their roles: a reticle on the hud layer, two `role="meter"`
 *   bars with aria values, a `listbox` of six `option`s with hint badges, a heading strip;
 * - the draining meter's `aria-valuenow` changes over time (polled, E-017);
 * - the selected slot changes (polled), and exactly one is selected at a time;
 * - the heading strip's transform follows the camera's yaw (polled against the page's offset);
 * - the reticle hides while a modal panel is open through the stack, and comes back on close.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessHudState } from '../harness/hud-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}hud.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('hud.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`hud demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessHudState> {
  return frame.evaluate(() => {
    const s = window.__harnessHud?.state;
    if (!s) throw new Error('window.__harnessHud missing');
    return JSON.parse(JSON.stringify(s)) as HarnessHudState;
  });
}

/** The `translate3d(calc(N * var(--tc-space-1) / 4), 0, 0)` the heading writes for `offset`. */
function headingTransform(offset: number): string {
  return `translate3d(calc(${offset} * var(--tc-space-1) / 4), 0, 0)`;
}

test('the HUD widgets are present with their roles', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const reticle = frame.locator('.tc-layer[data-layer="hud"] > .tc-reticle');
  await expect(reticle).toHaveCount(1);
  await expect(reticle).toHaveAttribute('data-style', 'cross');
  await expect(reticle).toBeVisible();
  // Centred on the frame (the canvas box), within a pixel.
  const [rb, cb] = await Promise.all([
    reticle.boundingBox(),
    frame.locator('canvas').first().boundingBox(),
  ]);
  if (!rb || !cb) throw new Error('no boxes');
  expect(Math.abs(rb.x + rb.width / 2 - (cb.x + cb.width / 2))).toBeLessThan(1.5);
  expect(Math.abs(rb.y + rb.height / 2 - (cb.y + cb.height / 2))).toBeLessThan(1.5);

  const meters = frame.locator('[role="meter"]');
  await expect(meters).toHaveCount(2);
  const steady = frame.locator('#meter-steady');
  await expect(steady).toHaveAttribute('aria-label', 'Steady');
  await expect(steady).toHaveAttribute('aria-valuemin', '0');
  await expect(steady).toHaveAttribute('aria-valuemax', '100');
  await expect(steady).toHaveAttribute('aria-valuenow', '100');
  await expect(steady).toBeVisible();
  // Meters sit in the left region, the strip in the bottom, the heading in the top.
  await expect(frame.locator('.tc-region[data-region="left"] [role="meter"]')).toHaveCount(2);
  const slots = frame.locator('.tc-region[data-region="bottom"] #slots');
  await expect(slots).toHaveAttribute('role', 'listbox');
  await expect(slots.locator('[role="option"]')).toHaveCount(6);
  await expect(slots.locator('.tc-slot-hint').nth(2)).toHaveText('3');
  await expect(slots.locator('.tc-slot-content').nth(0)).toHaveText('A');
  const heading = frame.locator('.tc-region[data-region="top"] #heading');
  await expect(heading).toHaveAttribute('role', 'img');
  await expect(heading.locator('.tc-heading-label').filter({ hasText: /^N$/ })).toHaveCount(2);
  await expect(heading.locator('.tc-heading-mark')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the draining meter changes value and the readout follows', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const draining = frame.locator('#meter-draining');
  const first = Number(await draining.getAttribute('aria-valuenow'));
  await expect
    .poll(async () => Number(await draining.getAttribute('aria-valuenow')))
    .not.toBe(first);
  const s = await read();
  expect(s.meterValue).toBeGreaterThanOrEqual(0);
  expect(s.meterValue).toBeLessThanOrEqual(100);
  await expect(draining.locator('.tc-meter-readout')).toHaveText(/^\d+ \/ 100$/);
  // Park the motion: the value then holds, and the DOM agrees with the page.
  await frame.evaluate(() => window.__harnessHud?.park(true));
  await expect.poll(async () => (await read()).parked).toBe(true);
  const held = await read();
  await expect(draining).toHaveAttribute('aria-valuenow', String(held.meterValue));
  const fill = draining.locator('.tc-meter-fill');
  await expect(fill).toHaveCSS('transform', /matrix\(/);
  expect(errors).toEqual([]);
});

test('the selected slot cycles with one highlight at a time', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const first = (await read()).selected;
  await expect.poll(async () => (await read()).selected).not.toBe(first);
  await frame.evaluate(() => window.__harnessHud?.park(true));
  await expect.poll(async () => (await read()).parked).toBe(true);
  const s = await read();
  const selectedEls = frame.locator('#slots [data-selected]');
  await expect(selectedEls).toHaveCount(1);
  await expect(selectedEls).toHaveAttribute('data-index', String(s.selected));
  await expect(selectedEls).toHaveAttribute('aria-selected', 'true');
  await expect(frame.locator('#slots [aria-selected="true"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the heading strip slides with the camera yaw', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const strip = frame.locator('#heading .tc-heading-strip');
  const before = await read();
  await expect.poll(async () => (await read()).yaw).toBeGreaterThan(before.yaw + 0.1);
  await frame.evaluate(() => window.__harnessHud?.park(true));
  await expect.poll(async () => (await read()).parked).toBe(true);
  const s = await read();
  // The page's offset is the pure function of its yaw, and the DOM carries that offset.
  const deg = ((((s.yaw * 180) / Math.PI) % 360) + 360) % 360;
  expect(s.headingOffset).toBeCloseTo(240 - deg * (480 / 90), 6);
  const inline = await strip.evaluate((el) => (el as HTMLElement).style.transform);
  expect(inline).toBe(headingTransform(s.headingOffset));
  // The computed transform moved the strip left as the yaw grew (a non-identity matrix).
  await expect(strip).toHaveCSS('transform', /matrix/);
  await expect(frame.locator('#heading')).toHaveAttribute(
    'aria-label',
    `Heading ${Math.round(deg)}°`,
  );
  expect(errors).toEqual([]);
});

test('a modal panel hides the reticle and closing it brings it back', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const reticle = frame.locator('.tc-reticle');
  await expect(reticle).toBeVisible();
  expect((await read()).reticleVisible).toBe(true);
  await frame.evaluate(() => window.__harnessHud?.openModal());
  await expect(frame.locator('[role="dialog"]')).toBeVisible();
  await expect(reticle).toBeHidden();
  await expect(reticle).toHaveAttribute('data-modal', '');
  await expect.poll(async () => (await read()).modal).toBe(true);
  await expect.poll(async () => (await read()).reticleVisible).toBe(false);
  // The hud layer is inert under the modal; the toasts stay out of it.
  await expect(frame.locator('.tc-layer[data-layer="hud"]')).toHaveAttribute('inert', '');
  await frame.evaluate(() => window.__harnessHud?.closeModal());
  await expect(reticle).toBeVisible();
  await expect.poll(async () => (await read()).reticleVisible).toBe(true);
  // A pulse flashes the class and drops it again.
  expect(await frame.evaluate(() => window.__harnessHud?.pulse())).toBe(true);
  await expect(reticle).not.toHaveClass(/tc-reticle-pulse/);
  expect(errors).toEqual([]);
});
