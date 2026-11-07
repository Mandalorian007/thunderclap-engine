import { MemoryStorage, saveKey } from '@thunderclap-engine/engine/save';
import { describe, expect, it } from 'vitest';
import {
  createProgressStore,
  defaultProgress,
  migrations,
  ProgressSchema,
  SAVE_GAME,
  SAVE_VERSION,
} from './schema';

const open = (storage: MemoryStorage) =>
  createProgressStore({ storage, debounceMs: 0, autoFlush: false, now: () => 1000 });

describe('progress save', () => {
  it('starts from defaults that pass the schema', () => {
    expect(ProgressSchema.validate(defaultProgress())).toBeNull();
    const store = open(new MemoryStorage());
    expect(store.status.loadResult).toBe('fresh');
    expect(store.get()).toEqual(defaultProgress());
  });

  it('has a migration for every version before the current one', () => {
    for (let v = 1; v < SAVE_VERSION; v++) expect(migrations[v]).toBeTypeOf('function');
  });

  it('migrates a v1 save: wins kept, new fields defaulted', () => {
    const storage = new MemoryStorage();
    storage.setItem(saveKey(SAVE_GAME, 'main'), JSON.stringify({ v: 1, t: 1, d: { wins: 3 } }));
    const store = open(storage);
    expect(store.status.loadResult).toBe('migrated');
    expect(store.get()).toEqual({ wins: 3, bestMoves: null, seed: 1 });
  });

  it('rejects an update that breaks the schema and keeps the data', () => {
    const store = open(new MemoryStorage());
    expect(store.update((d) => ({ ...d, wins: -1 }))).toBe(false);
    expect(store.get().wins).toBe(0);
    expect(store.update((d) => ({ ...d, wins: 1, bestMoves: 12 }))).toBe(true);
    expect(store.get()).toEqual({ wins: 1, bestMoves: 12, seed: 1 });
  });

  it('round-trips through storage at the current version', () => {
    const storage = new MemoryStorage();
    const a = open(storage);
    a.update((d) => ({ ...d, wins: 2, seed: 99 }));
    a.flush();
    const b = open(storage);
    expect(b.status.loadResult).toBe('loaded');
    expect(b.get()).toEqual({ wins: 2, bestMoves: null, seed: 99 });
  });
});
