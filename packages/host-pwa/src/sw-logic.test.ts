import { describe, expect, it } from 'vitest';
import { isNewVersion, routeFor, staleCacheNames, trimPlan } from './sw-logic';
import { SKIP_WAITING, workerSource } from './worker';

const scope = 'https://game.example/play/';
const pre = new Set(['assets/main-abc123.js', 'assets/style-def456.css', 'index.html']);
const prefixes = ['data/', 'levels/'];
const get = (url: string, mode?: string) => ({ url, method: 'GET', mode });

describe('routeFor', () => {
  it('serves hashed assets from the precache', () => {
    expect(routeFor(get(`${scope}assets/main-abc123.js`), pre, prefixes, scope)).toBe('precache');
    expect(routeFor(get(`${scope}assets/main-abc123.js?v=1`), pre, prefixes, scope)).toBe(
      'precache',
    );
  });
  it('treats navigations, the scope root and index.html as the page', () => {
    expect(routeFor(get(`${scope}anything`, 'navigate'), pre, prefixes, scope)).toBe('index');
    expect(routeFor(get(scope), pre, prefixes, scope)).toBe('index');
    expect(routeFor(get(`${scope}index.html`), pre, prefixes, scope)).toBe('index');
  });
  it('sends runtime prefixes to the runtime cache', () => {
    expect(routeFor(get(`${scope}data/world.json`), pre, prefixes, scope)).toBe('runtime');
    expect(routeFor(get(`${scope}levels/1/map.bin`), pre, prefixes, scope)).toBe('runtime');
    expect(routeFor(get(`${scope}datafile`), pre, prefixes, scope)).toBe('network');
  });
  it('passes everything else to the network', () => {
    expect(routeFor(get(`${scope}unknown.png`), pre, prefixes, scope)).toBe('network');
    expect(routeFor(get('https://cdn.example/x.js'), pre, prefixes, scope)).toBe('network');
    expect(routeFor(get('https://game.example/other/index.html'), pre, prefixes, scope)).toBe(
      'network',
    );
    expect(routeFor({ url: `${scope}index.html`, method: 'POST' }, pre, prefixes, scope)).toBe(
      'network',
    );
    expect(routeFor(get('not a url'), pre, prefixes, scope)).toBe('network');
  });
  it('matches relative to a scope without a trailing slash', () => {
    expect(
      routeFor(get(`${scope}assets/main-abc123.js`), pre, prefixes, 'https://game.example/play'),
    ).toBe('precache');
  });
});

describe('trimPlan', () => {
  it('evicts the oldest entries beyond the cap', () => {
    expect(trimPlan(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['a', 'b']);
    expect(trimPlan(['a', 'b'], 3)).toEqual([]);
    expect(trimPlan(['a', 'b'], 0)).toEqual(['a', 'b']);
    expect(trimPlan([], 0)).toEqual([]);
    expect(trimPlan(['a'], -1)).toEqual([]);
  });
});

describe('staleCacheNames', () => {
  it('names the other precache versions only', () => {
    expect(
      staleCacheNames(
        ['tc-pwa-precache-old', 'tc-pwa-precache-new', 'tc-pwa-runtime', 'other-app-cache'],
        'new',
      ),
    ).toEqual(['tc-pwa-precache-old']);
  });
});

describe('isNewVersion', () => {
  it('is true for a different, non-empty stamp', () => {
    expect(isNewVersion('a', 'b')).toBe(true);
    expect(isNewVersion('a', 'a')).toBe(false);
    expect(isNewVersion('a', '')).toBe(false);
  });
});

describe('workerSource', () => {
  const src = workerSource({
    version: 'v1',
    precache: ['index.html', 'assets/a-1.js'],
    runtimePrefixes: ['data/'],
    maxRuntimeEntries: 7,
  });
  it('stamps the build and fills every placeholder', () => {
    expect(src).toContain('build v1');
    expect(src).toContain('const VERSION = "v1";');
    expect(src).toContain('new Set(["index.html","assets/a-1.js"])');
    expect(src).toContain('const RUNTIME_PREFIXES = ["data/"];');
    expect(src).toContain('const MAX_RUNTIME = 7;');
    expect(src).toContain(JSON.stringify(SKIP_WAITING));
    expect(src).not.toMatch(/__[A-Z_]+__/);
  });
  it('pastes the routing functions and parses as a script', () => {
    expect(src).toMatch(/function routeFor\(/);
    expect(src).toMatch(/function trimPlan\(/);
    expect(src).toMatch(/function staleCacheNames\(/);
    // A syntax check: compile without running (the body needs `self`).
    expect(() => new Function(src)).not.toThrow();
  });
});
