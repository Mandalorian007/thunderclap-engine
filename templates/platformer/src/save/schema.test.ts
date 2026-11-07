import { MemoryStorage, saveKey } from '@thunderclap-engine/engine/save';
import { describe, expect, it } from 'vitest';
import {
  createProgressStore,
  defaultProgress,
  recordRun,
  SAVE_GAME,
  SAVE_VERSION,
  START_LIVES,
} from './schema';

describe('progress store', () => {
  it('starts from defaults with no save', () => {
    const store = createProgressStore({ storage: new MemoryStorage(), autoFlush: false });
    expect(store.get()).toEqual(defaultProgress());
    expect(store.get().lives).toBe(START_LIVES);
  });

  it('migrates the v1 array shape into the per-level record', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      saveKey(SAVE_GAME, 'main'),
      JSON.stringify({
        v: 1,
        t: 1,
        d: {
          best: [
            { level: 'meadow', time: 42.25 },
            { level: 'ruins', time: 90 },
            { level: 3, time: 'bad' },
          ],
        },
      }),
    );
    const store = createProgressStore({ storage, autoFlush: false });
    expect(store.status.loadResult).toBe('migrated');
    const p = store.get();
    expect(p.lives).toBe(START_LIVES);
    expect(p.levels).toEqual({
      meadow: { bestMs: 42250, coins: 0 },
      ruins: { bestMs: 90000, coins: 0 },
    });
    await store.flush();
    const raw = JSON.parse(storage.getItem(saveKey(SAVE_GAME, 'main'))!);
    expect(raw.v).toBe(SAVE_VERSION);
  });

  it('round-trips through storage', async () => {
    const storage = new MemoryStorage();
    const a = createProgressStore({ storage, autoFlush: false });
    a.update((p) => {
      recordRun(p, 'meadow', 30000, 7);
      p.lives = 2;
    });
    await a.flush();
    const b = createProgressStore({ storage, autoFlush: false });
    expect(b.status.loadResult).toBe('loaded');
    expect(b.get()).toEqual({ levels: { meadow: { bestMs: 30000, coins: 7 } }, lives: 2 });
  });
});

describe('recordRun', () => {
  it('keeps the best time and the most coins separately', () => {
    const p = defaultProgress();
    expect(recordRun(p, 'meadow', 50000, 3)).toBe(true);
    expect(recordRun(p, 'meadow', 60000, 5)).toBe(true);
    expect(p.levels.meadow).toEqual({ bestMs: 50000, coins: 5 });
    expect(recordRun(p, 'meadow', 70000, 1)).toBe(false);
    expect(recordRun(p, 'meadow', 40000, 1)).toBe(true);
    expect(p.levels.meadow).toEqual({ bestMs: 40000, coins: 5 });
  });
});
