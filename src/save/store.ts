import { defaultHost } from '../host/default';
import type { Host } from '../host/types';
import { decodeExport, type Envelope, encodeExport, isEnvelope } from './codec';
import { assertMigrationChain, type Migrations, runMigrations } from './migrate';
import type { Schema } from './schema';
import { isQuotaError, type StorageLike } from './storage';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** `thunderclap:<game>:<slot>` */
export function saveKey(game: string, slot: string): string {
  if (!NAME_RE.test(game)) throw new Error(`invalid save game id "${game}"`);
  if (!NAME_RE.test(slot)) throw new Error(`invalid save slot "${slot}"`);
  return `thunderclap:${game}:${slot}`;
}

/** Slot names that currently have data for `game` (excludes backups). */
export function listSlots(
  game: string,
  storage: StorageLike | null = defaultHost().storage.open(),
): string[] {
  if (!storage) return [];
  const prefix = `thunderclap:${game}:`;
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(prefix) && !k.endsWith(':backup')) out.push(k.slice(prefix.length));
    }
  } catch {
    return [];
  }
  return out.sort();
}

/**
 * How the initial load went:
 * - `fresh`: nothing stored; defaults used.
 * - `loaded`: stored data at the current version.
 * - `migrated`: stored data upgraded from an older version (written back on next flush).
 * - `recovered`: stored data was unreadable (corrupt, invalid, newer build, failed migration);
 *   the raw value was copied to `<key>:backup` and defaults were used. See `status.error`.
 */
export type LoadResult = 'fresh' | 'loaded' | 'migrated' | 'recovered';

export interface SaveStatus {
  /** True when the last read/write reached real storage. False means memory only: warn the player. */
  persistent: boolean;
  loadResult: LoadResult;
  /** Most recent problem (load, write or import), or null. */
  error: string | null;
  /** True while a debounced write is pending. */
  dirty: boolean;
}

export interface SaveStoreOptions<T> {
  /** Game id, e.g. `my-game`. Letters, digits, `-`, `_`. */
  game: string;
  /** Slot name. Default `main`. */
  slot?: string;
  /** Current data version (integer ≥ 1). */
  version: number;
  /** `migrations[n]` upgrades data from v`n` to v`n+1`. Must cover 1 → version. */
  migrations?: Migrations;
  /** Fresh data for a new player. Called whenever defaults are needed. */
  defaults: () => T;
  /** Runtime shape check applied after migration, on `set`, and on import. */
  schema: Schema<T> | ((value: unknown) => value is T);
  /** Debounce for writes, ms. Default 250. `0` writes synchronously on every `set`. */
  debounceMs?: number;
  /**
   * Where the storage comes from: `host.storage.open()`, re-tried on each write while it is
   * unavailable. Default: `defaultHost()` (the web host's `localStorage`).
   */
  host?: Pick<Host, 'storage'>;
  /**
   * A fixed backing storage instead of the host's. Pass `null` to force memory only.
   * Tests pass a `MemoryStorage` or a throwing stub.
   */
  storage?: StorageLike | null;
  /** Flush on `pagehide` / hidden `visibilitychange`. Default true when `window` exists. */
  autoFlush?: boolean;
  /** Clock for `savedAt`. Default `Date.now`. */
  now?: () => number;
}

export type ImportResult = { ok: true; migrated: boolean } | { ok: false; error: string };

export interface SaveStore<T> {
  readonly key: string;
  /** Shorthand for `status.persistent`. */
  readonly persistent: boolean;
  readonly status: Readonly<SaveStatus>;
  /** Timestamp of the data currently held (ms), or 0 if never saved. */
  readonly savedAt: number;
  /** Current data. Treat as read-only; change it via `set` or `update`. */
  get(): T;
  /** Replace the data and schedule a write. Returns false (and records `error`) if it fails the schema. */
  set(data: T): boolean;
  /** Mutate a structured clone of the data (or return a replacement), validate, schedule a write. */
  update(fn: (draft: T) => T | undefined): boolean;
  /** Write now if dirty. Returns `status.persistent`. */
  flush(): boolean;
  /** Replace with defaults and write. */
  reset(): void;
  /** Remove the stored value (and backup); in-memory data becomes defaults. */
  clear(): void;
  /** Portable string for the player to copy. Includes pending changes. */
  exportString(): string;
  /** Validate, migrate and adopt a string from `exportString`. Writes immediately on success. */
  importString(text: string): ImportResult;
  /** Called after every status or data change. Returns an unsubscribe function. */
  subscribe(fn: (status: Readonly<SaveStatus>) => void): () => void;
  /** Flush and remove listeners. */
  dispose(): void;
}

export function createSaveStore<T>(opts: SaveStoreOptions<T>): SaveStore<T> {
  const key = saveKey(opts.game, opts.slot ?? 'main');
  const backupKey = `${key}:backup`;
  const version = opts.version;
  if (!Number.isInteger(version) || version < 1)
    throw new Error('save version must be an integer ≥ 1');
  const migrations = opts.migrations ?? {};
  assertMigrationChain(version, migrations);
  const debounceMs = opts.debounceMs ?? 250;
  const now = opts.now ?? Date.now;
  const check: (v: unknown) => string | null =
    typeof opts.schema === 'function'
      ? (v) =>
          (opts.schema as (v: unknown) => boolean)(v) ? null : 'save data failed schema check'
      : (v) => (opts.schema as Schema<T>).validate(v);

  const source = opts.storage === undefined ? (opts.host ?? defaultHost()).storage : null;
  let storage: StorageLike | null = source ? source.open() : (opts.storage ?? null);
  const status: SaveStatus = {
    persistent: storage !== null,
    loadResult: 'fresh',
    error: storage === null ? 'storage unavailable; progress is kept in memory only' : null,
    dirty: false,
  };
  const listeners = new Set<(s: Readonly<SaveStatus>) => void>();
  let data: T;
  let savedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    for (const fn of listeners) fn(status);
  };

  /** Turn an envelope into current-version data, or throw with a reason. */
  const adopt = (env: Envelope): { value: T; migrated: boolean } => {
    const value = runMigrations(env.d, env.v, version, migrations);
    const err = check(value);
    if (err) throw new Error(err);
    return { value: value as T, migrated: env.v !== version };
  };

  const readRaw = (): string | null => {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch (err) {
      status.persistent = false;
      status.error = `storage read failed: ${String(err)}`;
      return null;
    }
  };

  const backup = (raw: string) => {
    try {
      storage?.setItem(backupKey, raw);
    } catch {
      // Best effort.
    }
  };

  // ---- initial load ----
  const raw = readRaw();
  data = opts.defaults();
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelope(parsed)) throw new Error('stored value has no version envelope');
      const { value, migrated } = adopt(parsed);
      data = value;
      savedAt = parsed.t;
      status.loadResult = migrated ? 'migrated' : 'loaded';
      status.dirty = migrated;
      // Keep the pre-migration bytes until the player has played on the new version a while.
      if (migrated) backup(raw);
    } catch (err) {
      backup(raw);
      status.loadResult = 'recovered';
      status.error = `could not load save (kept a backup): ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const write = (): boolean => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!status.dirty) return status.persistent;
    savedAt = now();
    const env: Envelope = { v: version, t: savedAt, d: data };
    if (!storage) {
      // Re-probe: storage may have become available (e.g. user changed a browser setting).
      if (source) storage = source.open();
    }
    if (storage) {
      try {
        storage.setItem(key, JSON.stringify(env));
        status.persistent = true;
        status.error = null;
      } catch (err) {
        status.persistent = false;
        status.error = isQuotaError(err)
          ? 'storage is full; progress is kept in memory only'
          : `storage write failed; progress is kept in memory only (${String(err)})`;
      }
    } else {
      status.persistent = false;
    }
    status.dirty = false;
    notify();
    return status.persistent;
  };

  const schedule = () => {
    status.dirty = true;
    if (debounceMs <= 0) {
      write();
      return;
    }
    if (timer === null) timer = setTimeout(write, debounceMs);
    notify();
  };

  const set = (next: T): boolean => {
    const err = check(next);
    if (err) {
      status.error = `rejected invalid save data: ${err}`;
      console.warn(`[save] ${status.error}`);
      notify();
      return false;
    }
    data = next;
    schedule();
    return true;
  };

  // ---- auto flush on page hide ----
  const autoFlush = opts.autoFlush ?? typeof window !== 'undefined';
  const onHide = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') write();
  };
  const onPageHide = () => write();
  if (autoFlush && typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onHide);
    // Chrome on Android freezes background tabs and may later discard them with no other event.
    document.addEventListener('freeze', onPageHide);
  }

  const store: SaveStore<T> = {
    key,
    get persistent() {
      return status.persistent;
    },
    get status() {
      return status;
    },
    get savedAt() {
      return savedAt;
    },
    get: () => data,
    set,
    update(fn) {
      const draft = structuredClone(data);
      const result = fn(draft);
      return set(result === undefined ? draft : (result as T));
    },
    flush: write,
    reset() {
      data = opts.defaults();
      status.dirty = true;
      write();
    },
    clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        storage?.removeItem(key);
        storage?.removeItem(backupKey);
      } catch {
        // ignore
      }
      data = opts.defaults();
      savedAt = 0;
      status.dirty = false;
      status.loadResult = 'fresh';
      notify();
    },
    exportString() {
      return encodeExport(opts.game, { v: version, t: status.dirty ? now() : savedAt, d: data });
    },
    importString(text) {
      const decoded = decodeExport(opts.game, text);
      if (!decoded.ok) return decoded;
      try {
        const { value, migrated } = adopt(decoded.envelope);
        data = value;
        status.dirty = true;
        write();
        return { ok: true, migrated };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      write();
      listeners.clear();
      if (autoFlush && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onHide);
        document.removeEventListener('freeze', onPageHide);
      }
    },
  };
  return store;
}
