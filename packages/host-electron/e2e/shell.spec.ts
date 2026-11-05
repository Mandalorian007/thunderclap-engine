/**
 * Electron smoke: the built shell (out/) on the desktop harness page, through Playwright's
 * Electron driver. WebGPU comes up with the shell's own switches, the page sees the Electron
 * host, links and the clipboard go through the bridge to the main process (with
 * `shell.openExternal` stubbed, so no browser opens), saves survive a relaunch, and nothing
 * leaves the machine.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { DesktopState } from '../harness/state';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

let userData = '';
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'tc-desktop-'));
});
test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [pkg],
    cwd: pkg,
    env: { ...process.env, TC_USER_DATA: userData } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await expect
    .poll(async () => {
      const s = await page.evaluate(() => window.__desktop?.state).catch(() => undefined);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`WebGPU: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThan(3);
  return { app, page };
}

const state = (page: Page) =>
  page.evaluate(() => window.__desktop?.state as DesktopState | undefined);

test('WebGPU renders and the page gets the Electron host', async () => {
  const { app, page } = await launch();
  try {
    const s = await state(page);
    expect(s?.gpu).toBe('ok');
    expect(s?.format).toMatch(/^(bgra8unorm|rgba8unorm)$/);
    expect(page.url()).toBe('app://bundle/');
    // The shell set WebGPU on itself (src/main/switches.ts), not left it to Chromium.
    expect(
      await app.evaluate(({ app: a }) => a.commandLine.hasSwitch('enable-unsafe-webgpu')),
    ).toBe(true);
    await page.screenshot({
      path: join(pkg, '../../screens/host-electron-harness.png'),
    });

    const info = await page.evaluate(() => window.__desktop?.info());
    expect(info).toMatchObject({
      kind: 'electron',
      embed: 'top',
      bridgeVersion: 1,
      storageKind: 'local',
      storage: true,
      clipboardWriteAllowed: true,
      fullscreenAvailable: true,
      fullscreenActive: false,
      hasWindow: true,
    });

    // The page has no Node and no Electron modules, only the bridge.
    const globals = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      bridgeKeys: Object.keys(
        (window as unknown as { thunderclap: Record<string, unknown> }).thunderclap,
      ).sort(),
    }));
    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridgeKeys: ['copyText', 'fullscreen', 'openExternal', 'platform', 'version', 'window'],
    });

    // The window title through the host.
    await page.evaluate(() => window.__desktop?.setTitle('Harness title'));
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()))
      .toBe('Harness title');
  } finally {
    await app.close();
  }
});

test('links open through the bridge; only plain https leaves', async () => {
  const { app, page } = await launch();
  try {
    // Stub shell.openExternal in the main process: record instead of opening a browser.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => {
        g.__opened.push(url);
      };
    });
    const opened = () =>
      app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

    const url = 'https://example.com/thunderclap?x=1';
    for (const a of ['pointer', 'keyboard', 'gamepad', 'script'] as const) {
      expect(
        await page.evaluate(([u, act]) => window.__desktop?.open(u, act), [url, a] as const),
      ).toBe('opened');
    }
    await expect.poll(opened).toEqual([url, url, url, url]);

    // Rejected in the renderer...
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://u:p@example.com']) {
      expect(await page.evaluate((u) => window.__desktop?.open(u, 'pointer'), bad)).toBe('invalid');
    }
    // ...and again in the main process when the bridge is called directly.
    const direct = await page.evaluate(async () => {
      const b = (
        window as unknown as { thunderclap: { openExternal(u: unknown): Promise<boolean> } }
      ).thunderclap;
      return [
        await b.openExternal('file:///etc/passwd'),
        await b.openExternal('javascript:alert(1)'),
        await b.openExternal('https://ok.example/'),
      ];
    });
    expect(direct).toEqual([false, false, true]);
    await expect.poll(opened).toEqual([url, url, url, url, 'https://ok.example/']);

    // No new windows from the page: an https new-window request (a target=_blank link) goes to
    // the system browser instead; anything else is just refused.
    expect(await page.evaluate(() => window.open('https://example.com') === null)).toBe(true);
    expect(await page.evaluate(() => window.open('http://example.com') === null)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect
      .poll(opened)
      .toEqual([url, url, url, url, 'https://ok.example/', 'https://example.com/']);
  } finally {
    await app.close();
  }
});

test('copy goes through the bridge to the system clipboard', async () => {
  const { app, page } = await launch();
  const before = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const text = `thunderclap-e2e-${Date.now()}`;
    expect(await page.evaluate((t) => window.__desktop?.copy(t), text)).toBe('copied');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
  } finally {
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), before);
    await app.close();
  }
});

test('saves round-trip in localStorage and survive a relaunch', async () => {
  let { app, page } = await launch();
  const saved = await page.evaluate(() => window.__desktop?.save(7));
  expect(saved).toMatchObject({ persistent: true, error: null, n: 7 });
  expect(await page.evaluate(() => window.__desktop?.load())).toMatchObject({
    loadResult: 'loaded',
    n: 7,
  });
  await app.close();

  ({ app, page } = await launch());
  try {
    expect(await page.evaluate(() => window.__desktop?.load())).toMatchObject({
      persistent: true,
      loadResult: 'loaded',
      n: 7,
    });
  } finally {
    await app.close();
  }
});

test('nothing leaves the machine', async () => {
  const { app, page } = await launch();
  try {
    const results = await page.evaluate(async () => {
      const tryFetch = async (u: string) => {
        try {
          await fetch(u);
          return 'fetched';
        } catch {
          return 'blocked';
        }
      };
      return [
        await tryFetch('https://example.com/'),
        await tryFetch('http://127.0.0.1:9/'),
        await tryFetch('./index.html'),
      ];
    });
    expect(results).toEqual(['blocked', 'blocked', 'fetched']);

    // Navigation away is refused.
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(300);
    expect(page.url()).toBe('app://bundle/');
  } finally {
    await app.close();
  }
});
