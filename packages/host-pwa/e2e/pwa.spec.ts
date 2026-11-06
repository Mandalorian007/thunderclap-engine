/**
 * PWA smoke: the built harness (harness/dist) under `vite preview`, in Chromium. The manifest is
 * served and parses, the worker registers and activates, the page reloads from the cache with
 * the network gone, `pwa.offline` follows the context, the runtime cache fills and trims, and
 * the precache counts the build's assets.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../harness/dist');

/** Files `vite build` emitted, recursively, as scope-relative paths. */
function builtFiles(dir = dist, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...builtFiles(p, r));
    else out.push(r);
  }
  return out;
}

const cache = (page: Page) => page.evaluate(() => window.__pwa!.cache());
const offline = (page: Page) => page.evaluate(() => window.__pwa!.offline);

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!window.__pwa)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__pwa!.workerState())).toBe('activated');
}

test('the manifest is served and the worker activates', async ({ page, request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({
    name: 'ThunderClap PWA harness',
    short_name: 'ThunderClap',
    display: 'standalone',
    start_url: '.',
  });
  expect(manifest.icons.map((i: { src: string }) => i.src)).toContain('icon.svg');
  expect((await request.get('/icon.svg')).headers()['content-type']).toContain('svg');

  await open(page);
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe(
    '/manifest.webmanifest',
  );
  const info = await page.evaluate(() => {
    const p = window.__pwa!;
    return {
      kind: p.kind,
      standalone: p.standalone,
      updateReady: p.updateReady,
      version: p.version,
    };
  });
  expect(info).toMatchObject({ kind: 'web', standalone: false, updateReady: false });
  expect(info.version).toMatch(/^[0-9a-f]{8}$/);
  expect(await page.evaluate(() => window.__pwa!.install())).toBe('unavailable');

  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toContain(`build ${info.version}`);
});

test('the precache holds every built asset and index.html', async ({ page }) => {
  await open(page);
  const files = builtFiles().filter(
    (f) =>
      !['sw.js', 'manifest.webmanifest', 'icon.svg'].includes(f) &&
      !f.endsWith('.html') &&
      !f.startsWith('data/'),
  );
  // Precache = hashed assets + index.html. The worker installs them in parallel; poll until the
  // count settles rather than reading it once.
  await expect
    .poll(async () => (await cache(page)).precached)
    .toBeGreaterThanOrEqual(files.length + 1);
  expect((await cache(page)).bytes).toBeGreaterThan(0);
});

test('a reload serves index.html from the cache with the network blocked', async ({
  page,
  context,
}) => {
  await open(page);
  await expect.poll(async () => (await cache(page)).precached).toBeGreaterThan(1);
  await context.setOffline(true);
  try {
    await expect.poll(() => offline(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__pwa!.offlineEvents)).toEqual([true]);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.__pwa)).toBe(true);
    await expect(page.locator('#status')).toContainText('offline true');
    expect(await page.evaluate(() => window.__pwa!.kind)).toBe('web');
  } finally {
    await context.setOffline(false);
  }
  await expect.poll(() => offline(page)).toBe(false);
});

test('the runtime cache fills stale-while-revalidate and trims to the cap', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__pwa!.clearCache());
  for (const n of [1, 2, 3, 4, 5, 6]) {
    expect(await page.evaluate((f) => window.__pwa!.fetchData(f), `${n}.json`)).toBe(200);
  }
  // The cap is 4 (harness/vite.config.ts); the oldest entries go. The put and trim run after the
  // response is returned, so poll.
  await expect.poll(async () => (await cache(page)).runtime).toBe(4);
  await page.evaluate(() => window.__pwa!.clearCache());
  expect(await cache(page)).toEqual({ precached: 0, runtime: 0, bytes: 0 });
});
