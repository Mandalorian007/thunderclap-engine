/**
 * Engine layout regions (D-041 Phase 2, ws/layout) on every top-level matrix row, including the
 * upright phone and tablet rows, against the layout harness page (harness/layout.html: a CSS-px
 * overlay with a widget in every region, no WebGPU).
 *
 * - The form factor per row, and the DOM grid matching the pure region maths.
 * - Every widget inside its region, no two regions' widgets overlapping, nothing outside the safe
 *   area, no page scroll and no clipped region content.
 * - Safe-area insets emulated for real (`env(safe-area-inset-*)` via CDP) on the notched phones.
 * - Tap targets at least 44 CSS px on touch rows (`--tc-tap-min`), text at least 12 px on phones.
 * - The caption card docked in `captionLane`; the `'free'` escape hatch inside `freeRect`.
 * - Widgets move when a phone turns upright and back.
 * - One overlay: crossing the phone/desktop line keeps the same root, layers and open panel.
 * - Spamming a panel open (real taps, then many opens in one tick) leaves at most one panel.
 * - A modal panel at 150% text fits the modal region (inside the safe area) or scrolls to its
 *   last control, and focus goes home when it closes.
 *
 * The itch-iframe row is skipped: the UI layer does not depend on the frame.
 */
import type { CDPSession, Page } from '@playwright/test';
import type { Insets } from '@thunderclap/engine/ui';
import type { HarnessLayoutState } from '../harness/layout-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

const FORM: Record<string, string> = {
  'desktop-1280': 'desktop',
  'desktop-1920': 'desktop',
  ipad: 'tablet',
  'tablet-port': 'tablet',
  'phone-se': 'phone-landscape',
  'phone-iphone': 'phone-landscape',
  'phone-promax': 'phone-landscape',
  'phone-android': 'phone-landscape',
  'phone-port': 'phone-portrait',
};
const LANDSCAPE_PHONES = new Set(['phone-se', 'phone-iphone', 'phone-promax', 'phone-android']);

/** Safe-area insets per row (landscape notch both sides plus the home bar; upright: top + bar). */
const INSETS: Record<string, { land: Insets; port: Insets }> = {
  'phone-iphone': {
    land: { top: 0, right: 47, bottom: 21, left: 47 },
    port: { top: 47, right: 0, bottom: 34, left: 0 },
  },
  'phone-promax': {
    land: { top: 0, right: 59, bottom: 21, left: 59 },
    port: { top: 59, right: 0, bottom: 34, left: 0 },
  },
  'phone-port': {
    land: { top: 0, right: 47, bottom: 21, left: 47 },
    port: { top: 47, right: 0, bottom: 34, left: 0 },
  },
};
const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** One CDP session per page: detaching it drops the override. */
const sessions = new WeakMap<Page, CDPSession>();
async function setInsets(page: Page, insets: Insets): Promise<void> {
  let cdp = sessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    sessions.set(page, cdp);
  }
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
}

function read(page: Page): Promise<HarnessLayoutState> {
  return page.evaluate(() => {
    const s = window.__harnessLayout?.state;
    if (!s) throw new Error('window.__harnessLayout missing');
    return JSON.parse(JSON.stringify(s)) as HarnessLayoutState;
  });
}

test.beforeEach(async ({ page, wrapper }) => {
  test.skip(wrapper !== 'top', 'layout harness runs top-level only');
  const project = test.info().project.name;
  const ins = INSETS[project];
  if (ins) await setInsets(page, project === 'phone-port' ? ins.port : ins.land);
  await page.goto(`${HARNESS_URL}layout.html`);
  await expect.poll(() => read(page).then((s) => s.ready)).toBe(true);
});

interface Box {
  id: string;
  region: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Visible widgets (and the caption) with their region and client rect. */
async function widgets(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const s = window.__harnessLayout!.state;
    const els = [...document.querySelectorAll<HTMLElement>('.probe-widget, .tc-caption')];
    return els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const id = el.classList.contains('tc-caption') ? 'caption' : el.id;
        return {
          id,
          region: s.placed[id] ?? '?',
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      });
  });
}

const overlap = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;

/** Every layout invariant at the current viewport. */
async function checkLayout(page: Page, insets: Insets, touch: boolean, form: string) {
  const s = await read(page);
  expect(s.formFactor).toBe(form);
  expect(s.safeArea).toEqual(insets);
  const vp = page.viewportSize()!;

  // The DOM grid draws the regions the pure maths reports.
  const dom = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.tc-layout > .tc-region:not([hidden])')].map(
      (el) => {
        const r = el.getBoundingClientRect();
        return {
          name: el.dataset.region!,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
        };
      },
    ),
  );
  for (const d of dom) {
    const want = s.regions[d.name as keyof typeof s.regions];
    expect(want, d.name).not.toBeNull();
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(d[k] - want![k]), `${d.name}.${k}`).toBeLessThanOrEqual(1);
    }
    expect(d.clipped, `${d.name} content clipped or scrolling`).toBe(false);
  }

  const boxes = await widgets(page);
  // All twelve probes are visible in every form factor.
  expect(boxes.map((b) => b.id).sort()).toEqual(
    [
      'caption',
      'w-back',
      'w-card',
      'w-free',
      'w-help',
      'w-menu',
      'w-options',
      'w-slider',
      'w-title',
      'w-toggle',
      'w-undo',
    ].sort(),
  );
  for (const b of boxes) {
    // Inside its region (the escape hatch: inside freeRect).
    const r = b.region === 'free' ? s.freeRect! : s.regions[b.region as keyof typeof s.regions];
    expect(r, `${b.id} region ${b.region}`).toBeTruthy();
    expect(b.x, b.id).toBeGreaterThanOrEqual(r!.x - 0.5);
    expect(b.y, b.id).toBeGreaterThanOrEqual(r!.y - 0.5);
    expect(b.x + b.width, b.id).toBeLessThanOrEqual(r!.x + r!.width + 0.5);
    expect(b.y + b.height, b.id).toBeLessThanOrEqual(r!.y + r!.height + 0.5);
    // Inside the safe area and on screen.
    expect(b.x, b.id).toBeGreaterThanOrEqual(insets.left - 0.5);
    expect(b.y, b.id).toBeGreaterThanOrEqual(insets.top - 0.5);
    expect(b.x + b.width, b.id).toBeLessThanOrEqual(vp.width - insets.right + 0.5);
    expect(b.y + b.height, b.id).toBeLessThanOrEqual(vp.height - insets.bottom + 0.5);
    for (const o of boxes) {
      if (o.id < b.id) expect(overlap(b, o), `${b.id} × ${o.id}`).toBe(false);
    }
  }

  // Tap targets and text floors.
  const taps = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.tc-layout .tc-button, .tc-layout .tc-field')].map(
      (el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.getAttribute('aria-label') ?? el.textContent,
          w: r.width,
          h: r.height,
          button: el.matches('.tc-button'),
        };
      },
    ),
  );
  const min = touch ? 44 : 32;
  for (const t of taps) {
    expect(t.h, `${t.label} height`).toBeGreaterThanOrEqual(min - 0.01);
    if (t.button) expect(t.w, `${t.label} width`).toBeGreaterThanOrEqual(min - 0.01);
  }
  if (form.startsWith('phone')) {
    const smallest = await page.evaluate(() =>
      Math.min(
        ...[...document.querySelectorAll<HTMLElement>('.tc-overlay *')]
          .filter((el) => el.getClientRects().length > 0 && el.textContent?.trim())
          .map((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
      ),
    );
    expect(smallest).toBeGreaterThanOrEqual(12);
  }

  // No page scroll.
  const scroll = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  }));
  expect(scroll.w).toBeLessThanOrEqual(vp.width);
  expect(scroll.h).toBeLessThanOrEqual(vp.height);
}

test('regions per form factor: in place, inside the safe area, no overlap, 44 px taps on touch', async ({
  page,
}) => {
  const project = test.info().project;
  const insets = INSETS[project.name];
  const portrait = project.name === 'phone-port';
  await checkLayout(
    page,
    insets ? (portrait ? insets.port : insets.land) : NONE,
    !!project.use.hasTouch,
    FORM[project.name]!,
  );
  const s = await read(page);
  expect(s.placed.caption).toBe('captionLane');
  expect(s.freeUses).toEqual([
    { id: 'w-free', reason: 'harness: escape-hatch probe pinned to the corner of freeRect' },
  ]);
  // The world's frame is the fill region.
  expect(s.freeRect).toEqual(s.regions.fill);
  expect(await page.locator('[data-tc-layout-hidden]').count()).toBe(0);
  await expect(page.locator('.tc-overlay')).toHaveAttribute(
    'data-form-factor',
    FORM[project.name]!,
  );
  if (process.env.LAYOUT_SHOTS) {
    await page.screenshot({ path: `screens/layout-${project.name}.png` });
  }
});

test('turning a phone upright moves the widgets and back again', async ({ page }) => {
  const project = test.info().project.name;
  test.skip(!LANDSCAPE_PHONES.has(project), 'landscape phone rows');
  const land = page.viewportSize()!;
  const ins = INSETS[project];
  const before = await read(page);
  expect(before.placed['w-help']).toBe('right');

  if (ins) await setInsets(page, ins.port);
  await page.setViewportSize({ width: land.height, height: land.width });
  await expect.poll(() => read(page).then((s) => s.formFactor)).toBe('phone-portrait');
  await page.evaluate(() => window.__harnessLayout!.refresh());
  const up = await read(page);
  expect(up.placed['w-help']).toBe('top');
  expect(up.placed['w-back']).toBe('left');
  expect(up.freeRect).not.toEqual(before.freeRect);
  await checkLayout(page, ins?.port ?? NONE, true, 'phone-portrait');
  if (process.env.LAYOUT_SHOTS) {
    await page.screenshot({
      path: `screens/layout-${project}-upright.png`,
    });
  }

  if (ins) await setInsets(page, ins.land);
  await page.setViewportSize(land);
  await expect.poll(() => read(page).then((s) => s.formFactor)).toBe('phone-landscape');
  await page.evaluate(() => window.__harnessLayout!.refresh());
  expect((await read(page)).placed['w-help']).toBe('right');
  await checkLayout(page, ins?.land ?? NONE, true, 'phone-landscape');
});

test('one overlay: a phone and a desktop share one root, and nothing moves between layers', async ({
  page,
}) => {
  const project = test.info().project.name;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.__harnessLayout!.openPanel(2));
  await expect(page.locator('.tc-panel')).toBeVisible();
  // Tag every layer and the open panel, then cross the phone/desktop line and back.
  const tag = () =>
    page.evaluate(() => {
      const roots = document.querySelectorAll('.tc-overlay');
      const root = roots[0] as HTMLElement;
      for (const l of root.querySelectorAll<HTMLElement>(':scope > [data-layer]')) {
        l.dataset.probe = l.dataset.layer;
      }
      const panel = document.querySelector<HTMLElement>('.tc-panel')!;
      panel.dataset.probe = 'panel';
      // A HUD element with a huge z-index: it must stay under the panels layer.
      const high = document.createElement('div');
      high.dataset.probe = 'high';
      Object.assign(high.style, {
        position: 'absolute',
        inset: '0',
        zIndex: '99999',
        pointerEvents: 'auto',
      });
      root.querySelector('[data-layer="hud"]')!.append(high);
      return roots.length;
    });
  const check = () =>
    page.evaluate(() => {
      const roots = document.querySelectorAll('.tc-overlay');
      const root = roots[0] as HTMLElement;
      const layers = [...root.querySelectorAll<HTMLElement>(':scope > [data-layer]')].map(
        (l) => `${l.dataset.layer}=${l.dataset.probe ?? '?'}`,
      );
      const panel = document.querySelector<HTMLElement>('[data-probe="panel"]');
      // Hit testing follows paint order; the HUD is inert under the modal, so lift that to look.
      const r = panel!.getBoundingClientRect();
      const hud = root.querySelector<HTMLElement>('[data-layer="hud"]')!;
      const inert = hud.inert;
      hud.inert = false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hud.inert = inert;
      return {
        onTop: top?.closest<HTMLElement>('[data-layer]')?.dataset.layer ?? null,
        roots: roots.length,
        units: root.dataset.units,
        layers,
        panelLayer: panel?.closest<HTMLElement>('[data-layer]')?.dataset.layer ?? null,
      };
    });
  expect(await tag()).toBe(1);
  const was = page.viewportSize()!;
  const phone = FORM[project]!.startsWith('phone');
  await page.setViewportSize(phone ? { width: 1280, height: 720 } : { width: 460, height: 320 });
  await expect.poll(() => read(page).then((s) => !!s.formFactor?.startsWith('phone'))).toBe(!phone);
  const other = await check();
  await page.setViewportSize(was);
  await expect.poll(() => read(page).then((s) => s.formFactor)).toBe(FORM[project]);
  const back = await check();
  for (const c of [other, back]) {
    expect(c.roots).toBe(1);
    expect(c.layers).toEqual([
      'hud=hud',
      'captions=captions',
      'layout=layout',
      'panels=panels',
      'toasts=toasts',
    ]);
    expect(c.panelLayer).toBe('panels');
    expect(c.onTop, 'a z-index in the HUD lifts it over the panel').toBe('panels');
  }
});

test('a panel at 150% text fits the modal region or scrolls to its last control', async ({
  page,
}) => {
  const project = test.info().project;
  // No rise animation: measure the panel where it settles.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    window.__harnessLayout!.setTextScale(1.5);
    window.__harnessLayout!.openPanel(14);
  });
  const panel = page.locator('.tc-panel');
  await expect(panel).toBeVisible();
  const s = await read(page);
  const modal = s.regions.modal!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(modal.x - 0.5);
  expect(box.y).toBeGreaterThanOrEqual(modal.y - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(modal.x + modal.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(modal.y + modal.height + 0.5);
  // The last control can be reached and is then fully inside the panel.
  const last = panel.getByRole('button', { name: 'Last' });
  await last.scrollIntoViewIfNeeded();
  const lb = (await last.boundingBox())!;
  const pb = (await panel.boundingBox())!;
  expect(lb.y).toBeGreaterThanOrEqual(pb.y - 0.5);
  expect(lb.y + lb.height).toBeLessThanOrEqual(pb.y + pb.height + 0.5);
  if (project.use.hasTouch) expect(lb.height).toBeGreaterThanOrEqual(44);
  // Text at 150% on the CSS-px overlay: body 16 → 24 px.
  const fs = await last.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(fs).toBeCloseTo(24, 0);

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('home');
});

test('panel-stack spam leaves at most one panel', async ({ page }) => {
  const touch = !!test.info().project.use.hasTouch;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const panels = () => page.evaluate(() => window.__harnessLayout!.panels());
  // Real taps (or clicks) on ⚙, as fast as the input goes. The first opens Options; its
  // backdrop takes the next (a dismiss), so the count alternates, but never exceeds one.
  const b = (await page.locator('#w-options').boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  for (let i = 0; i < 9; i++) {
    if (touch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    const n = await panels();
    expect(n.dom).toBeLessThanOrEqual(1);
    expect(n.stack).toBe(n.dom);
  }
  // Settle with exactly one open, whatever the last tap did.
  if ((await panels()).dom === 0) await page.evaluate(() => window.__harnessLayout!.spamOptions(1));
  await expect(page.locator('.tc-panel')).toHaveCount(1);
  expect(await panels()).toEqual({ stack: 1, dom: 1 });
  // Opening it again in one tick, many times over, still leaves one.
  await page.evaluate(() => window.__harnessLayout!.spamOptions(20));
  await expect(page.locator('.tc-panel')).toHaveCount(1);
  expect(await panels()).toEqual({ stack: 1, dom: 1 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.tc-panel')).toHaveCount(0);
  expect(await panels()).toEqual({ stack: 0, dom: 0 });
});
