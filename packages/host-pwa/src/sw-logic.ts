/**
 * The service worker's decisions as pure functions. They run in two places: in Vitest, as
 * ordinary imports, and inside the emitted `sw.js`, where worker.ts pastes their
 * `Function.prototype.toString()` ahead of the worker body. That is why every function here is
 * self-contained: no imports, no closures over module state, no TS-only syntax that leaves a
 * runtime trace (enums, parameter properties). Types are erased and leave plain JavaScript.
 */

/** Cache names. The precache cache carries the build version; the runtime cache is shared. */
export const CACHE_PREFIX = 'tc-pwa-';
export const PRECACHE_PREFIX = 'tc-pwa-precache-';
export const RUNTIME_CACHE = 'tc-pwa-runtime';

/** What the worker does with a fetch. */
export type Route = 'precache' | 'index' | 'runtime' | 'network';

/** The parts of a `Request` the routing reads, so a test can pass a plain object. */
export interface RouteRequest {
  url: string;
  method: string;
  /** `'navigate'` for a page load. */
  mode?: string;
}

/**
 * Which cache strategy a request takes.
 *
 * - `precache`: a GET for a path in the precache set (the build's hashed assets): cache-first.
 * - `index`: a navigation, or a GET for the scope root or `index.html`: network-first with the
 *   cached copy as the fallback.
 * - `runtime`: a GET whose path starts with one of `runtimePrefixes`: stale-while-revalidate
 *   into the runtime cache.
 * - `network`: everything else (other origins, non-GET, unknown paths): straight through.
 *
 * `scope` is the worker's scope URL (`self.registration.scope`), so paths are matched relative
 * to where the game is served, not to the origin root.
 */
export function routeFor(
  request: RouteRequest,
  precache: Set<string>,
  runtimePrefixes: string[],
  scope: string,
): Route {
  if (request.method !== 'GET') return 'network';
  let url: URL;
  let scopeUrl: URL;
  try {
    url = new URL(request.url);
    scopeUrl = new URL(scope);
  } catch {
    return 'network';
  }
  if (url.origin !== scopeUrl.origin) return 'network';
  const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
  if (!url.pathname.startsWith(scopePath)) return 'network';
  const rel = url.pathname.slice(scopePath.length);
  if (request.mode === 'navigate' || rel === '' || rel === 'index.html') return 'index';
  if (precache.has(rel)) return 'precache';
  for (const p of runtimePrefixes) {
    if (rel.startsWith(p)) return 'runtime';
  }
  return 'network';
}

/**
 * Which runtime-cache entries to evict so that at most `max` remain, oldest first. `keys` is the
 * cache's key list in insertion order (what `cache.keys()` returns).
 */
export function trimPlan(keys: string[], max: number): string[] {
  if (max < 0 || keys.length <= max) return [];
  return keys.slice(0, keys.length - max);
}

/**
 * Which caches an activating worker of `version` deletes: every cache of this package whose
 * name is a precache of another version. The runtime cache and caches of other software stay.
 */
export function staleCacheNames(names: string[], version: string): string[] {
  const keep = `tc-pwa-precache-${version}`;
  return names.filter((n) => n.startsWith('tc-pwa-precache-') && n !== keep);
}

/** True when `incoming` is a build other than `current`; empty stamps never count as new. */
export function isNewVersion(current: string, incoming: string): boolean {
  return incoming !== '' && incoming !== current;
}
