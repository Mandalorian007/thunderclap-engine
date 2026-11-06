/**
 * The asset cache: one place that knows what a game has loaded and what it costs. Entries are
 * keyed (a uri, usually), loaded once however many callers ask at the same time, refcounted,
 * and sized by the caller (`size(value)`: bytes of GPU memory, of decoded data, whatever the
 * budget counts). Once the total passes `budgetBytes`, unreferenced, unpinned entries go,
 * least recently used first, through `onEvict` so the game frees what the value holds
 * (`scene.destroy()`, `texture.destroy()`).
 *
 * The cache never fetches: `load` is the caller's, typically over the bundle's `read`
 * (`() => read(uri).then(decode)`).
 */

export interface AssetCacheOptions<T> {
  /** Total `size` the cache may hold before it evicts unreferenced entries. */
  budgetBytes: number;
  /** Called once per entry that leaves the cache (eviction or `dispose`): free it here. */
  onEvict?: (key: string, value: T) => void;
}

/** Counters since the cache was made; `bytes` and `entries` are what it holds now. */
export interface AssetCacheStats {
  /** Sum of `size` over loaded entries. */
  bytes: number;
  /** Entries held, loading ones included. */
  entries: number;
  /** `acquire` calls that found the key (loaded or loading). */
  hits: number;
  /** `acquire` calls that started a load. */
  misses: number;
  /** Entries the budget pushed out (not counting `dispose`). */
  evictions: number;
}

export interface AssetCache<T = unknown> {
  /**
   * The value for `key`, loading it with `load` when the cache has none (concurrent calls for
   * one key share one load). Each call holds one reference until `release(key)`; a held entry
   * is never evicted. A load that rejects leaves nothing behind and rejects every waiter.
   */
  acquire<V extends T>(key: string, load: () => Promise<V>, size: (value: V) => number): Promise<V>;
  /** Drop one reference taken by `acquire`. Throws for a key with none. */
  release(key: string): void;
  /** Keep `key` past the budget even when unreferenced (a loading or loaded key). */
  pin(key: string): void;
  unpin(key: string): void;
  /** Whether `key` is loaded or loading. */
  has(key: string): boolean;
  /** References `acquire` holds on `key` (0 when unknown). */
  refs(key: string): number;
  /**
   * Remove an unreferenced, loaded entry now (pinned or not), through `onEvict`. False when
   * the key is unknown or still loading; throws when references are held.
   */
  dispose(key: string): boolean;
  stats(): AssetCacheStats;
}

interface Entry<T> {
  promise: Promise<T>;
  value: T | undefined;
  loaded: boolean;
  size: number;
  refs: number;
  pinned: boolean;
}

/** Make an asset cache (`AssetCache`); see the module comment. */
export function createAssetCache<T = unknown>(opts: AssetCacheOptions<T>): AssetCache<T> {
  if (!(opts.budgetBytes >= 0))
    throw new Error(`asset cache: budgetBytes ${opts.budgetBytes} must be >= 0`);
  // Map order is recency: a touched entry is moved to the end, eviction walks from the start.
  const entries = new Map<string, Entry<T>>();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  const touch = (key: string, e: Entry<T>): void => {
    entries.delete(key);
    entries.set(key, e);
  };
  const remove = (key: string, e: Entry<T>): void => {
    entries.delete(key);
    bytes -= e.size;
    opts.onEvict?.(key, e.value as T);
  };
  const trim = (): void => {
    if (bytes <= opts.budgetBytes) return;
    for (const [key, e] of entries) {
      if (bytes <= opts.budgetBytes) break;
      if (e.refs > 0 || e.pinned || !e.loaded) continue;
      evictions++;
      remove(key, e);
    }
  };
  const entry = (key: string, op: string): Entry<T> => {
    const e = entries.get(key);
    if (!e) throw new Error(`asset cache: ${op}("${key}"): key not in the cache`);
    return e;
  };

  return {
    acquire<V extends T>(
      key: string,
      load: () => Promise<V>,
      size: (value: V) => number,
    ): Promise<V> {
      const found = entries.get(key);
      if (found) {
        hits++;
        found.refs++;
        touch(key, found);
        return found.promise as Promise<V>;
      }
      misses++;
      const e: Entry<T> = {
        promise: undefined as unknown as Promise<T>,
        value: undefined,
        loaded: false,
        size: 0,
        refs: 1,
        pinned: false,
      };
      e.promise = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            e.value = value;
            e.size = Math.max(0, size(value));
            e.loaded = true;
            if (entries.get(key) === e) {
              bytes += e.size;
              trim();
            }
            return value;
          },
          (err: unknown) => {
            if (entries.get(key) === e) entries.delete(key);
            throw err;
          },
        );
      entries.set(key, e);
      return e.promise as Promise<V>;
    },

    release(key: string): void {
      const e = entry(key, 'release');
      if (e.refs === 0) throw new Error(`asset cache: release("${key}"): no reference held`);
      e.refs--;
      if (e.refs === 0) {
        touch(key, e);
        trim();
      }
    },

    pin(key: string): void {
      entry(key, 'pin').pinned = true;
    },

    unpin(key: string): void {
      entry(key, 'unpin').pinned = false;
      trim();
    },

    has(key: string): boolean {
      return entries.has(key);
    },

    refs(key: string): number {
      return entries.get(key)?.refs ?? 0;
    },

    dispose(key: string): boolean {
      const e = entries.get(key);
      if (!e?.loaded) return false;
      if (e.refs > 0) {
        throw new Error(`asset cache: dispose("${key}"): ${e.refs} reference(s) still held`);
      }
      remove(key, e);
      return true;
    },

    stats(): AssetCacheStats {
      return { bytes, entries: entries.size, hits, misses, evictions };
    },
  };
}
