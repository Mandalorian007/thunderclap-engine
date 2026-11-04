/**
 * The web host (engine/host, D-041) on every matrix entry, at top level and inside the
 * itch-style cross-origin iframe: what it detects, opening and copying through the D-036 link
 * service (granted, refused, missing, `execCommand` fallback, a blocked pad open), fullscreen,
 * and save storage (available, blocked, full, kept across a reload). Moved here from the game's
 * link-copy and smoke specs (docs/engine/test-split.md, P1 host), which now test product only.
 */
import type { BrowserContext, Frame, Locator, Page } from '@playwright/test';
import type { HarnessHostInfo } from '../harness/state';
import {
  expect,
  type HarnessOptions,
  harnessFrame,
  openHarness,
  test,
  waitForFrames,
} from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

/** harness/host-probe.ts PROBE_URL. */
const PROBE_URL = 'https://harness.example/thunderclap';

type Setup = {
  clipboard?: 'reject' | 'missing';
  exec?: 'fail';
  popup?: 'blocked';
  storage?: 'blocked' | 'quota';
};

/**
 * Stubs in every frame before any script runs, then opens the harness. The probe's URL is
 * fulfilled locally, so an opened tab makes no request off the machine.
 */
async function open(
  context: BrowserContext,
  page: Page,
  wrapper: HarnessOptions['wrapper'],
  setup: Setup = {},
): Promise<Frame> {
  for (const url of [HARNESS_URL, WRAPPER_URL]) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(url).origin,
    });
  }
  await context.route('https://harness.example/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }),
  );
  await page.addInitScript((s: Setup) => {
    const w = window as unknown as { __opened: string[]; __full?: boolean };
    w.__opened = [];
    const realOpen = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: [string?, string?]) => {
      w.__opened.push(String(url));
      return s.popup === 'blocked' ? null : realOpen(url, ...rest);
    }) as typeof window.open;
    if (s.clipboard === 'reject' && navigator.clipboard) {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    } else if (s.clipboard === 'missing') {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    }
    if (s.exec === 'fail') document.execCommand = () => false;
    if (s.storage === 'blocked') {
      // Third-party storage blocked: merely reading localStorage throws.
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    } else if (s.storage === 'quota') {
      // Full once `__full` is set; the host's tiny probe write still fits.
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (w.__full && !k.endsWith('__probe__')) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        real.call(this, k, v);
      };
    }
  }, setup);
  return openHarness(page, wrapper);
}

async function probeReady(frame: Frame): Promise<void> {
  await expect.poll(() => frame.evaluate(() => !!window.__host)).toBe(true);
}

function info(frame: Frame): Promise<HarnessHostInfo> {
  return frame.evaluate(() => {
    const h = window.__host;
    if (!h) throw new Error('window.__host missing');
    return h.info();
  });
}

async function mount(frame: Frame): Promise<void> {
  await probeReady(frame);
  await frame.evaluate(() => window.__host?.mount());
}

/** The fallback is shown, says `message`, holds the URL, focused and all selected. */
async function expectFallback(frame: Frame, message: string): Promise<Locator> {
  const fallback = frame.locator('[data-action="probe-link-fallback"]');
  await expect(fallback).toBeVisible();
  await expect(fallback.locator('label')).toHaveText(message);
  const field = fallback.locator('input');
  await expect(field).toHaveValue(PROBE_URL);
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toBeFocused();
  const sel = await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  expect(sel).toEqual([0, PROBE_URL.length]);
  return fallback;
}

/** The system clipboard, read from the top-level page (the iframe has no clipboard-read). */
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const opened = (frame: Frame) =>
  frame.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test('detects the embed, and has storage, fullscreen and the right clipboard policy', async ({
  context,
  page,
  wrapper,
}) => {
  let frame = await open(context, page, wrapper);
  await probeReady(frame);
  const i = await info(frame);
  expect(i.kind).toBe('web');
  expect(i.embed).toBe(wrapper === 'top' ? 'top' : 'cross-origin-frame');
  // Partitioned localStorage works inside itch's frame too.
  expect(i.storage).toBe(true);
  // itch's allow list has fullscreen, so its frame may go fullscreen.
  expect(i.fullscreenAvailable).toBe(true);
  // ...but not clipboard-write: the host knows not to try writeText there.
  expect(i.clipboardWriteAllowed).toBe(wrapper === 'top');

  // A save through the host's storage survives a reload.
  await frame.evaluate(() => window.__host?.clearSave());
  const saved = await frame.evaluate(() => window.__host?.save(7));
  expect(saved).toMatchObject({ persistent: true, error: null, n: 7 });
  await page.reload();
  frame = wrapper === 'top' ? page.mainFrame() : await harnessFrame(page);
  await probeReady(frame);
  expect(await frame.evaluate(() => window.__host?.load())).toMatchObject({
    persistent: true,
    loadResult: 'loaded',
    n: 7,
  });
  await frame.evaluate(() => window.__host?.clearSave());
});

test('the link opens only on a click; Copy link copies it', async ({ context, page, wrapper }) => {
  const frame = await open(context, page, wrapper);
  await mount(frame);
  const tabs: string[] = [];
  context.on('page', (p) => tabs.push(p.url()));
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  await page.waitForTimeout(500);
  // Nothing opens or copies before the player acts.
  expect(tabs).toEqual([]);
  expect(await opened(frame)).toEqual([]);
  expect(await clipboard(page)).toBe('untouched');

  const copy = frame.locator('[data-action="probe-link-copy"]');
  await copy.click();
  await expect(copy).toHaveText('Copied!');
  // At top level through the Clipboard API; in itch's frame through execCommand.
  expect(await clipboard(page)).toBe(PROBE_URL);
  expect((await info(frame)).copies).toEqual(['copied']);
  await expect(frame.locator('[data-action="probe-link-fallback"]')).toBeHidden();

  // A click on the link is a real gesture: a new tab, not window.open.
  const tab = context.waitForEvent('page');
  await frame.locator('a[data-action="probe-link"]').click();
  expect((await tab).url()).toBe(PROBE_URL);
  expect(await opened(frame)).toEqual([]);
});

test('a refused writeText still copies through execCommand', async ({ context, page, wrapper }) => {
  const frame = await open(context, page, wrapper, { clipboard: 'reject' });
  await mount(frame);
  const copy = frame.locator('[data-action="probe-link-copy"]');
  await copy.click();
  await expect(copy).toHaveText('Copied!');
  expect(await clipboard(page)).toBe(PROBE_URL);
  await expect(copy).toBeFocused();
  await expect(frame.locator('[data-action="probe-link-fallback"]')).toBeHidden();
});

test('a refused clipboard and a failed execCommand show the URL in a selected field', async ({
  context,
  page,
  wrapper,
}) => {
  const frame = await open(context, page, wrapper, { clipboard: 'reject', exec: 'fail' });
  await mount(frame);
  const copy = frame.locator('[data-action="probe-link-copy"]');
  await copy.click();
  const fallback = await expectFallback(frame, 'Copy blocked. Copy the link:');
  expect((await info(frame)).copies).toEqual(['manual']);
  // Close, or Escape, puts it away and gives focus back to Copy link.
  await frame.locator('[data-action="probe-link-close"]').click();
  await expect(fallback).toBeHidden();
  await expect(copy).toBeFocused();
  await copy.click();
  await expect(fallback).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fallback).toBeHidden();
  await expect(copy).toBeFocused();
});

test('no Clipboard API at all and a failed execCommand show the field', async ({
  context,
  page,
  wrapper,
}) => {
  const frame = await open(context, page, wrapper, { clipboard: 'missing', exec: 'fail' });
  await mount(frame);
  await frame.locator('[data-action="probe-link-copy"]').click();
  await expectFallback(frame, 'Copy blocked. Copy the link:');
});

test('a pad press with the new tab blocked shows the field', async ({ context, page, wrapper }) => {
  const frame = await open(context, page, wrapper, { popup: 'blocked' });
  await mount(frame);
  await frame.locator('a[data-action="probe-link"]').focus();
  // PadNav routes the pad's A through activateLink; a pad press is not a user gesture.
  expect(await frame.evaluate(() => window.__host?.activate('gamepad'))).toBe('blocked');
  expect(await opened(frame)).toEqual([PROBE_URL]);
  expect((await info(frame)).opens).toEqual(['blocked']);
  await expectFallback(frame, 'New tab blocked. Copy the link:');
});

test('blocked storage: saves stay in memory and say so', async ({ context, page, wrapper }) => {
  const frame = await open(context, page, wrapper, { storage: 'blocked' });
  await probeReady(frame);
  expect((await info(frame)).storage).toBe(false);
  const r = await frame.evaluate(() => window.__host?.save(3));
  expect(r?.persistent).toBe(false);
  expect(r?.error).toMatch(/memory/);
  expect(r?.n).toBe(3);
});

test('full storage: the save says so and keeps playing from memory', async ({
  context,
  page,
  wrapper,
}) => {
  const frame = await open(context, page, wrapper, { storage: 'quota' });
  await probeReady(frame);
  await frame.evaluate(() => window.__host?.clearSave());
  expect(await frame.evaluate(() => window.__host?.save(1))).toMatchObject({ persistent: true });
  await frame.evaluate(() => {
    (window as unknown as { __full: boolean }).__full = true;
  });
  const r = await frame.evaluate(() => window.__host?.save(2));
  expect(r?.persistent).toBe(false);
  expect(r?.error).toMatch(/full/);
  expect(r?.n).toBe(2);
  await frame.evaluate(() => {
    (window as unknown as { __full: boolean }).__full = false;
    window.__host?.clearSave();
  });
});

test('fullscreen from a click, and back', async ({ context, page, wrapper }) => {
  const frame = await open(context, page, wrapper);
  await mount(frame);
  const button = frame.locator('[data-action="probe-fullscreen"]');
  await button.click();
  await expect.poll(async () => (await info(frame)).fullscreenActive).toBe(true);
  await button.click();
  await expect.poll(async () => (await info(frame)).fullscreenActive).toBe(false);
  expect((await info(frame)).fullscreen).toEqual([true, false]);
});

test("itch's click-to-launch starts the harness at 960x540", async ({ page, wrapper }) => {
  test.skip(wrapper !== 'itch-iframe', 'itch wrapper only');
  await page.goto(`${WRAPPER_URL}?launch=1`);
  await page.waitForTimeout(500);
  expect(page.frames()).toHaveLength(1);
  await page.getByRole('button', { name: 'Run game' }).click();
  const frame = await harnessFrame(page);
  expect(await frame.evaluate(() => [innerWidth, innerHeight])).toEqual([960, 540]);
  const s = await waitForFrames(frame);
  expect(s.gpu).toBe('ok');
  expect((await info(frame)).storage).toBe(true);
});
