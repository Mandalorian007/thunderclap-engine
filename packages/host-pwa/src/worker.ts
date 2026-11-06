/**
 * The service worker source. It is assembled, not compiled: the pure functions of sw-logic.ts are
 * pasted in through `Function.prototype.toString()` (one source of truth, unit-tested as
 * imports), followed by a body with four placeholders the plugin fills per build. The package
 * ships TypeScript source through its exports map, like host-electron, so a worker kept as a
 * separate TS file would need its own build step or a second copy of the routing; this needs
 * neither. Every function pasted here must stay self-contained (see sw-logic.ts).
 *
 * Every cache lookup passes `ignoreVary`: the caches are keyed by URL, and a server that answers
 * with `Vary: Origin` (vite preview, most CDNs) would otherwise make a module-script request
 * (mode `cors`) miss the copy the worker stored from its own plain fetch.
 */
import { routeFor, staleCacheNames, trimPlan } from './sw-logic.ts';

export interface WorkerConfig {
  /** The build's version stamp. */
  version: string;
  /** Scope-relative paths to precache (hashed assets, plus `index.html`). */
  precache: string[];
  /** Scope-relative path prefixes served stale-while-revalidate from the runtime cache. */
  runtimePrefixes: string[];
  /** Most entries the runtime cache keeps; the oldest go first. */
  maxRuntimeEntries: number;
}

/** The message a page posts to make a waiting worker take over. */
export const SKIP_WAITING = 'tc-pwa:skip-waiting';

const BODY = `
const VERSION = __VERSION__;
const PRECACHE = new Set(__PRECACHE__);
const RUNTIME_PREFIXES = __RUNTIME_PREFIXES__;
const MAX_RUNTIME = __MAX_RUNTIME__;
const PRECACHE_NAME = 'tc-pwa-precache-' + VERSION;
const RUNTIME_NAME = 'tc-pwa-runtime';
const scope = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME).then((cache) =>
      Promise.all(
        [...PRECACHE].map((rel) =>
          fetch(new Request(scope + rel, { cache: 'reload' })).then((res) => {
            if (res.ok) return cache.put(scope + rel, res);
          }),
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(staleCacheNames(names, VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === ${JSON.stringify(SKIP_WAITING)}) self.skipWaiting();
});

async function trimRuntime(cache) {
  const keys = await cache.keys();
  const drop = trimPlan(keys.map((k) => k.url), MAX_RUNTIME);
  await Promise.all(drop.map((url) => cache.delete(url)));
}

async function fromPrecache(request) {
  const cache = await caches.open(PRECACHE_NAME);
  const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function indexNetworkFirst() {
  const key = scope + 'index.html';
  const cache = await caches.open(PRECACHE_NAME);
  try {
    const res = await fetch(new Request(key, { cache: 'no-cache' }));
    if (res.ok) {
      cache.put(key, res.clone());
      return res;
    }
    const hit = await cache.match(key, { ignoreVary: true });
    return hit || res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_NAME);
  const hit = await cache.match(request, { ignoreVary: true });
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        await cache.put(request, res.clone());
        await trimRuntime(cache);
      }
      return res;
    })
    .catch((err) => {
      if (hit) return hit;
      throw err;
    });
  return hit || refresh;
}

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request, PRECACHE, RUNTIME_PREFIXES, scope);
  if (route === 'precache') event.respondWith(fromPrecache(event.request));
  else if (route === 'index') event.respondWith(indexNetworkFirst());
  else if (route === 'runtime') event.respondWith(staleWhileRevalidate(event.request));
});
`;

/** The complete `sw.js` for one build. */
export function workerSource(cfg: WorkerConfig): string {
  const fns = [routeFor, trimPlan, staleCacheNames].map((f) => f.toString());
  const body = BODY.replace('__VERSION__', JSON.stringify(cfg.version))
    .replace('__PRECACHE__', JSON.stringify(cfg.precache))
    .replace('__RUNTIME_PREFIXES__', JSON.stringify(cfg.runtimePrefixes))
    .replace('__MAX_RUNTIME__', String(Math.max(0, Math.floor(cfg.maxRuntimeEntries))));
  return `/* @thunderclap/host-pwa service worker, build ${cfg.version} */\n'use strict';\n${fns.join('\n')}\n${body}`;
}
