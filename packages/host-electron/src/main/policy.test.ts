import { join, resolve } from 'node:path';
import { safeExternalUrl } from '@thunderclap/engine/platform';
import { describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  bundleFile,
  CSP,
  localDevUrl,
  mimeType,
  navigationAllowed,
  requestAllowed,
  safeExternalHttps,
} from './policy';
import { parseSwitches, webgpuSwitches } from './switches';

const URLS = [
  'https://example.com',
  ' https://example.com/a?b=1#c ',
  'HTTPS://EXAMPLE.COM/',
  'http://example.com',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'data:text/html,hi',
  'https://user:pw@example.com',
  'https://user@example.com',
  'https://exa mple.com',
  'https://',
  '',
  'mailto:a@b.c',
  '//example.com',
];

describe('safeExternalHttps', () => {
  it('agrees with the engine safeExternalUrl the page uses', () => {
    for (const u of URLS) expect(safeExternalHttps(u), u).toBe(safeExternalUrl(u));
  });

  it('rejects anything that is not a string', () => {
    for (const v of [undefined, null, 1, {}, ['https://example.com']]) {
      expect(safeExternalHttps(v)).toBeNull();
    }
  });
});

describe('bundleFile', () => {
  const root = resolve('/tmp/bundle');

  it('serves files under the root, and index.html for / and routes', () => {
    expect(bundleFile(root, `${APP_ORIGIN}/`)).toBe(join(root, 'index.html'));
    expect(bundleFile(root, `${APP_ORIGIN}/settings`)).toBe(join(root, 'index.html'));
    expect(bundleFile(root, `${APP_ORIGIN}/assets/a.js?v=1#x`)).toBe(join(root, 'assets/a.js'));
    expect(bundleFile(root, `${APP_ORIGIN}/a%20b.png`)).toBe(join(root, 'a b.png'));
  });

  it('never leaves the root', () => {
    for (const u of [
      `${APP_ORIGIN}/../secret.txt`,
      `${APP_ORIGIN}/%2e%2e/secret.txt`,
      `${APP_ORIGIN}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`,
      `${APP_ORIGIN}/..%5c..%5csecret.txt`,
      `${APP_ORIGIN}/%00.js`,
      `${APP_ORIGIN}/%E0%A4%A.js`,
    ]) {
      const f = bundleFile(root, u);
      if (f !== null) expect(f.startsWith(root + (root.endsWith('/') ? '' : '/')), u).toBe(true);
    }
    // The URL parser folds dot segments (also %2e%2e) at the root, so these stay inside.
    expect(bundleFile(root, `${APP_ORIGIN}/%2e%2e/secret.txt`)).toBe(join(root, 'secret.txt'));
    expect(bundleFile(root, `${APP_ORIGIN}/%E0%A4%A.js`)).toBeNull();
  });

  it('only answers app://bundle', () => {
    expect(bundleFile(root, 'app://other/index.html')).toBeNull();
    expect(bundleFile(root, 'file:///tmp/bundle/index.html')).toBeNull();
    expect(bundleFile(root, 'not a url')).toBeNull();
  });
});

describe('requests and navigation', () => {
  it('lets only the page origin and in-memory URLs through', () => {
    for (const u of [`${APP_ORIGIN}/a.js`, 'data:,x', 'blob:app://bundle/1', 'devtools://x']) {
      expect(requestAllowed(u, null), u).toBe(true);
    }
    for (const u of [
      'https://example.com/',
      'http://127.0.0.1:5173/',
      'ws://127.0.0.1:5173/',
      'file:///etc/passwd',
      'app://other/x',
      'ftp://example.com',
    ]) {
      expect(requestAllowed(u, null), u).toBe(false);
    }
  });

  it('with a dev server, allows exactly its host and port (HMR socket too)', () => {
    const dev = localDevUrl('http://127.0.0.1:5199/');
    expect(requestAllowed('http://127.0.0.1:5199/src/x.ts', dev)).toBe(true);
    expect(requestAllowed('ws://127.0.0.1:5199/', dev)).toBe(true);
    expect(requestAllowed('http://127.0.0.1:5200/', dev)).toBe(false);
    expect(requestAllowed('https://example.com/', dev)).toBe(false);
  });

  it('accepts only a dev server on this machine', () => {
    expect(localDevUrl('http://localhost:5173')?.port).toBe('5173');
    expect(localDevUrl('http://127.0.0.1:1')).not.toBeNull();
    expect(localDevUrl('http://[::1]:1')).not.toBeNull();
    expect(localDevUrl('https://example.com')).toBeNull();
    expect(localDevUrl('file:///x')).toBeNull();
    expect(localDevUrl(undefined)).toBeNull();
  });

  it('keeps navigation on the start origin (custom schemes have a "null" origin)', () => {
    expect(navigationAllowed(`${APP_ORIGIN}/x`, `${APP_ORIGIN}/`)).toBe(true);
    expect(navigationAllowed('app://evil/x', `${APP_ORIGIN}/`)).toBe(false);
    expect(navigationAllowed('other://bundle/', `${APP_ORIGIN}/`)).toBe(false);
    expect(navigationAllowed('https://example.com/', `${APP_ORIGIN}/`)).toBe(false);
    expect(navigationAllowed('http://127.0.0.1:5199/b', 'http://127.0.0.1:5199/')).toBe(true);
    expect(navigationAllowed('http://127.0.0.1:5200/', 'http://127.0.0.1:5199/')).toBe(false);
  });
});

describe('responses', () => {
  it('serves module scripts as JavaScript', () => {
    expect(mimeType('a/b.js')).toMatch(/^text\/javascript/);
    expect(mimeType('index.HTML')).toMatch(/^text\/html/);
    expect(mimeType('x.unknown')).toBe('application/octet-stream');
  });

  it('the CSP keeps every fetch on the page origin and runs no inline script', () => {
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe('WebGPU switches', () => {
  it('turn WebGPU on explicitly on every OS, plus Vulkan on Linux', () => {
    expect(webgpuSwitches('darwin')).toEqual([['enable-unsafe-webgpu']]);
    expect(webgpuSwitches('win32')).toEqual([['enable-unsafe-webgpu']]);
    expect(webgpuSwitches('linux')).toEqual([
      ['enable-unsafe-webgpu'],
      ['enable-features', 'Vulkan'],
    ]);
  });

  it('parse a TC_GPU_SWITCHES override', () => {
    expect(
      parseSwitches(' --enable-unsafe-webgpu  --use-webgpu-adapter=swiftshader use-angle=x '),
    ).toEqual([
      ['enable-unsafe-webgpu'],
      ['use-webgpu-adapter', 'swiftshader'],
      ['use-angle', 'x'],
    ]);
    expect(parseSwitches('')).toEqual([]);
  });
});
