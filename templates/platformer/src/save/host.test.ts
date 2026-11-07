/**
 * The save as `createGame` builds it (`save: (host) => createProgressStore({ host })`), on the
 * engine's fake host instead of a browser: a finished run survives a reload, and a host whose
 * storage is blocked keeps the game playable in memory (the title shows a "not saved" toast).
 */
import { createFakeHost, createFixedClock } from '@thunderclap-engine/engine/testing';
import { describe, expect, it } from 'vitest';
import { createProgressStore, recordRun, START_LIVES } from './schema';

describe('progress on the host', () => {
  it('a finished run survives a reload from the same host', () => {
    const host = createFakeHost();
    const clock = createFixedClock();
    const open = () =>
      createProgressStore({ host, debounceMs: 0, autoFlush: false, now: () => clock.now() });

    const first = open();
    expect(first.persistent).toBe(true);
    let improved = false;
    first.update((p) => {
      improved = recordRun(p, 'meadow', 41_250, 7);
      return p;
    });
    expect(improved).toBe(true);
    clock.step(60);
    expect(first.flush()).toBe(true);

    const reloaded = open();
    expect(reloaded.status.loadResult).not.toBe('fresh');
    expect(reloaded.get().levels.meadow).toEqual({ bestMs: 41_250, coins: 7 });
    expect(reloaded.get().lives).toBe(START_LIVES);

    // A slower run with more coins keeps the best time and raises the coin record.
    reloaded.update((p) => {
      improved = recordRun(p, 'meadow', 50_000, 9);
      return p;
    });
    expect(improved).toBe(true);
    expect(reloaded.get().levels.meadow).toEqual({ bestMs: 41_250, coins: 9 });
  });

  it('a host with no storage still plays, in memory only', () => {
    const host = createFakeHost({ storage: null });
    const store = createProgressStore({ host, debounceMs: 0, autoFlush: false });
    expect(store.persistent).toBe(false);
    const ok = store.update((p) => {
      recordRun(p, 'ruins', 30_000, 2);
      return p;
    });
    expect(ok).toBe(true);
    expect(store.flush()).toBe(false);
    expect(store.get().levels.ruins).toEqual({ bestMs: 30_000, coins: 2 });
  });
});
