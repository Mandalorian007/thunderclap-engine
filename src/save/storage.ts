/**
 * Storage backends. `localStorage` can be missing, throw on access (sandboxed or
 * cross-origin iframes with third-party storage blocked), throw on write (quota,
 * Safari private mode), or be silently partitioned. Everything here is defensive.
 */

/** The subset of the Web Storage API the save module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** In-memory `StorageLike`. Used as the fallback and in tests. */
export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

const PROBE_KEY = 'thunderclap:__probe__';

/**
 * Returns a working `localStorage`, or `null` if it is unavailable, throws, or
 * cannot round-trip a value. Never throws.
 *
 * @param get how to obtain the storage (defaults to `globalThis.localStorage`).
 *   Merely reading `window.localStorage` throws a SecurityError in some iframes,
 *   so the getter itself is guarded.
 */
export function probeStorage(
  get: () => StorageLike | undefined | null = () => globalThis.localStorage,
): StorageLike | null {
  try {
    const storage = get();
    if (!storage) return null;
    const token = String(Date.now());
    storage.setItem(PROBE_KEY, token);
    const ok = storage.getItem(PROBE_KEY) === token;
    storage.removeItem(PROBE_KEY);
    return ok ? storage : null;
  } catch {
    return null;
  }
}

/** True if `err` looks like a storage quota error across browsers. */
export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error) && !(typeof err === 'object' && err !== null)) return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}
