/**
 * The arena-2d-server template (E7): its Rust server and its Vite client, both started here (the
 * server with `--port 0`, the client on a free port), and two browser pages that join, move, and
 * see each other move. Desktop only (the device matrix is e2e/templates.spec.ts's job); skipped
 * where cargo is missing.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const DIR = join(process.cwd(), 'templates/arena-2d-server');

interface ArenaProbe {
  status: string;
  player: number;
  me: { x: number; y: number };
  others: { id: number; name: string; x: number; y: number; it: boolean }[];
  it: number;
  frames: number;
}

const hasCargo = (() => {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A free local port. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** Starts `cmd` in its own process group and resolves with the first match of `ready`. */
function start(
  cmd: string,
  args: string[],
  ready: RegExp,
  timeoutMs: number,
): Promise<{ child: ChildProcess; match: RegExpMatchArray }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: DIR,
      detached: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let out = '';
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error(`${cmd} not ready in ${timeoutMs} ms:\n${out.slice(-2000)}`));
    }, timeoutMs);
    const scan = (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(ready);
      if (match) {
        clearTimeout(timer);
        resolve({ child, match });
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} exited (${code}):\n${out.slice(-2000)}`));
    });
  });
}

/** Stops a process group started by `start`. */
function stop(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGINT');
  } catch {
    // Already gone.
  }
}

const probe = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__arena ?? null)) as ArenaProbe | null);

test.describe('arena-2d-server', () => {
  test.skip(!hasCargo, 'cargo is missing');

  let server: ChildProcess | undefined;
  let client: ChildProcess | undefined;
  let serverUrl = '';
  let clientUrl = '';

  test.beforeAll(async ({ browserName }, info) => {
    test.skip(
      browserName !== 'chromium' || info.project.name !== 'desktop-1280',
      'one desktop chromium row',
    );
    // The first build of the server takes a while.
    test.setTimeout(600_000);
    const s = await start(
      'cargo',
      ['run', '--quiet', '--manifest-path', 'server/Cargo.toml', '--', '--port', '0'],
      /listening on (ws:\/\/[\d.]+:\d+)/,
      540_000,
    );
    server = s.child;
    serverUrl = s.match[1]!;
    const port = await freePort();
    const c = await start(
      join(DIR, 'node_modules/.bin/vite'),
      ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/,
      60_000,
    );
    client = c.child;
    clientUrl = c.match[1]!;
  });

  test.afterAll(() => {
    stop(client);
    stop(server);
  });

  test('two players join, see each other move, and nobody errors', async ({ browser }) => {
    const errors: string[] = [];
    const open = async (name: string) => {
      const page = await (await browser.newContext()).newPage();
      page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${name} console.error: ${m.text()}`);
      });
      await page.goto(`${clientUrl}?server=${encodeURIComponent(serverUrl)}&name=${name}`);
      return page;
    };
    const ada = await open('ada');
    const bo = await open('bo');
    for (const page of [ada, bo]) {
      await expect
        .poll(async () => (await probe(page))?.frames ?? 0, { timeout: 30_000 })
        .toBeGreaterThan(10);
      await expect.poll(async () => (await probe(page))?.others.length ?? 0).toBe(1);
    }
    const adaId = (await probe(ada))!.player;
    const boId = (await probe(bo))!.player;
    expect(adaId).toBeGreaterThan(0);
    expect(boId).not.toBe(adaId);
    // Two here: one of them is it, and both pages agree.
    await expect.poll(async () => (await probe(ada))?.it).toBeGreaterThan(0);
    await expect.poll(async () => (await probe(bo))?.it).toBe((await probe(ada))!.it);

    // Ada holds down; she moves at once on her page and, a moment later, on Bo's.
    const adaStart = (await probe(ada))!.me.y;
    const seenStart = (await probe(bo))!.others[0]!.y;
    await ada.bringToFront();
    await ada.keyboard.down('ArrowDown');
    await expect.poll(async () => (await probe(ada))!.me.y).toBeGreaterThan(adaStart + 60);
    await expect.poll(async () => (await probe(bo))!.others[0]!.y).toBeGreaterThan(seenStart + 60);
    await ada.keyboard.up('ArrowDown');

    // And the other way: Bo holds left, Ada sees him go.
    const boStart = (await probe(bo))!.me.x;
    const seenBo = (await probe(ada))!.others[0]!.x;
    await bo.bringToFront();
    await bo.keyboard.down('ArrowLeft');
    await expect.poll(async () => (await probe(bo))!.me.x).toBeLessThan(boStart - 60);
    await expect.poll(async () => (await probe(ada))!.others[0]!.x).toBeLessThan(seenBo - 60);
    await bo.keyboard.up('ArrowLeft');

    // Where Bo's page says Ada is matches where her own page put her, once she stops.
    await expect.poll(async () => (await probe(bo))!.others[0]!.y).toBe((await probe(ada))!.me.y);
    expect(errors).toEqual([]);
  });
});
