/**
 * Numbered save slots with a metadata sidecar, for a load/save menu.
 *
 * Slot `n` (1-based) is the store `thunderclap:<game>:slot<n>`; its sidecar `<key>:meta`
 * (`StoredMeta`) is written in the same flush as the data, so `list()` reads only sidecars and
 * never parses save data. Slots saved before the sidecar existed are listed from the data key's
 * `v` and `t`.
 */
import { defaultHost } from '../host/default';
import type { Host } from '../host/types';
import { isEnvelope } from './codec';
import type { Migrations } from './migrate';
import type { Schema } from './schema';
import type { StorageLike } from './storage';
import { createSaveStore, type SaveStore, type SlotMeta, type StoredMeta, saveKey } from './store';

export interface SlotInfo {
  /** 1-based slot number. */
  slot: number;
  label: string;
  /** `savedAt` of the data in storage (ms). */
  savedAt: number;
  /** Version of the data in storage (before any migration `open` would run). */
  version: number;
  playMs?: number;
  thumbnail?: string;
  /** Length of the stored JSON text (UTF-16 code units). */
  size: number;
}

export interface SlotManagerOptions<T> {
  game: string;
  version: number;
  migrations?: Migrations;
  defaults: () => T;
  schema: Schema<T> | ((value: unknown) => value is T);
  /** Number of slots, `1..slots`. Default 3. */
  slots?: number;
  host?: Pick<Host, 'storage'>;
  storage?: StorageLike | null;
  /** Fills `label`, `playMs` and `thumbnail` for the sidecar on every flush. */
  meta?: (data: T) => SlotMeta;
  /** Passed to each store. Default 250. */
  debounceMs?: number;
  autoFlush?: boolean;
  now?: () => number;
}

export interface SlotManager<T> {
  /** Number of slots. */
  readonly slots: number;
  /** Slots that hold data, in slot order, from the sidecars; no save data is parsed. */
  list(): SlotInfo[];
  /** The store for slot `n`; the same instance while it stays open. Throws outside `1..slots`. */
  open(slot: number): SaveStore<T>;
  /** Copies data and sidecar from one slot to another, flushing `from` first. False if `from` is empty. */
  copy(from: number, to: number): boolean;
  /** Removes data, sidecar and backup. An open store for the slot is reset to defaults. */
  remove(slot: number): void;
  /**
   * Changes the label in the sidecar (writing one if the slot predates sidecars) and keeps it
   * through later flushes of an open store unless `meta` returns its own label. False if empty.
   */
  rename(slot: number, label: string): boolean;
  /** The slot with the latest `savedAt`, or null. */
  mostRecent(): SlotInfo | null;
}

export function slotName(slot: number): string {
  return `slot${slot}`;
}

function readMeta(storage: StorageLike, key: string): StoredMeta | null {
  const raw = storage.getItem(`${key}:meta`);
  if (raw !== null) {
    try {
      const m = JSON.parse(raw) as Partial<StoredMeta> | null;
      if (
        typeof m === 'object' &&
        m !== null &&
        typeof m.v === 'number' &&
        typeof m.t === 'number' &&
        typeof m.size === 'number'
      )
        return m as StoredMeta;
    } catch {
      // Fall through to the data key.
    }
  }
  const data = storage.getItem(key);
  if (data === null) return null;
  try {
    const env: unknown = JSON.parse(data);
    if (!isEnvelope(env)) return null;
    return { v: env.v, t: env.t, size: data.length };
  } catch {
    return null;
  }
}

export function createSlotManager<T>(opts: SlotManagerOptions<T>): SlotManager<T> {
  const count = opts.slots ?? 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('slots must be an integer ≥ 1');
  const userMeta: (data: T) => SlotMeta = opts.meta ?? (() => ({}));
  /** Labels set by `rename`, so an open store's next flush keeps them. */
  const labels = new Map<number, string>();
  const metaFor =
    (slot: number) =>
    (data: T): SlotMeta => {
      const m = userMeta(data);
      const label = labels.get(slot);
      return label !== undefined && m.label === undefined ? { ...m, label } : m;
    };
  const source = opts.storage === undefined ? (opts.host ?? defaultHost()).storage : null;
  const storageNow = (): StorageLike | null => (source ? source.open() : (opts.storage ?? null));
  const open = new Map<number, SaveStore<T>>();

  const check = (slot: number): string => {
    if (!Number.isInteger(slot) || slot < 1 || slot > count)
      throw new RangeError(`slot ${slot} is outside 1..${count}`);
    return saveKey(opts.game, slotName(slot));
  };

  const info = (storage: StorageLike, slot: number): SlotInfo | null => {
    let m: StoredMeta | null;
    try {
      m = readMeta(storage, check(slot));
    } catch {
      return null;
    }
    if (!m) return null;
    const out: SlotInfo = {
      slot,
      label: m.label ?? `Slot ${slot}`,
      savedAt: m.t,
      version: m.v,
      size: m.size,
    };
    if (m.playMs !== undefined) out.playMs = m.playMs;
    if (m.thumbnail !== undefined) out.thumbnail = m.thumbnail;
    return out;
  };

  const list = (): SlotInfo[] => {
    const storage = storageNow();
    if (!storage) return [];
    const out: SlotInfo[] = [];
    for (let n = 1; n <= count; n++) {
      const i = info(storage, n);
      if (i) out.push(i);
    }
    return out;
  };

  return {
    slots: count,
    list,
    open(slot) {
      const key = check(slot);
      let store = open.get(slot);
      if (store) return store;
      store = createSaveStore<T>({
        game: opts.game,
        slot: slotName(slot),
        version: opts.version,
        migrations: opts.migrations,
        defaults: opts.defaults,
        schema: opts.schema,
        debounceMs: opts.debounceMs,
        host: opts.host,
        storage: opts.storage,
        autoFlush: opts.autoFlush,
        now: opts.now,
        meta: metaFor(slot),
      });
      if (store.key !== key) throw new Error('slot key mismatch');
      open.set(slot, store);
      return store;
    },
    copy(from, to) {
      const fromKey = check(from);
      const toKey = check(to);
      if (from === to) return false;
      open.get(from)?.flush();
      const storage = storageNow();
      if (!storage) return false;
      try {
        const data = storage.getItem(fromKey);
        if (data === null) return false;
        const target = open.get(to);
        if (target) {
          target.dispose();
          open.delete(to);
        }
        storage.setItem(toKey, data);
        labels.delete(to);
        const m = storage.getItem(`${fromKey}:meta`);
        if (m !== null) storage.setItem(`${toKey}:meta`, m);
        else storage.removeItem(`${toKey}:meta`);
        return true;
      } catch {
        return false;
      }
    },
    remove(slot) {
      const key = check(slot);
      const store = open.get(slot);
      if (store) store.clear();
      labels.delete(slot);
      const storage = storageNow();
      if (!storage) return;
      try {
        storage.removeItem(key);
        storage.removeItem(`${key}:meta`);
        storage.removeItem(`${key}:backup`);
      } catch {
        // Nothing to do: the slot is unreadable anyway.
      }
    },
    rename(slot, label) {
      const key = check(slot);
      const storage = storageNow();
      if (!storage) return false;
      try {
        const m = readMeta(storage, key);
        if (!m) return false;
        storage.setItem(`${key}:meta`, JSON.stringify({ ...m, label }));
        labels.set(slot, label);
        return true;
      } catch {
        return false;
      }
    },
    mostRecent() {
      let best: SlotInfo | null = null;
      for (const i of list()) if (!best || i.savedAt > best.savedAt) best = i;
      return best;
    },
  };
}
