/**
 * A whole game of Pairs played through the rules, saved the way `createGame` saves it
 * (`save: (host) => createProgressStore({ host })`) but on the engine's fake host instead of a
 * browser: a fixed clock stamps the writes, the win is folded in with `recordWin`, and a fresh
 * store opened on the same host reads it back as a reload would.
 */
import { createFakeHost, createFixedClock } from '@thunderclap/engine/testing';
import { describe, expect, it } from 'vitest';
import { createBoard, phase, reveal } from '../rules/board';
import { createProgressStore, recordWin } from './schema';

/** Solves a board perfectly: each pair found in one move. */
function solve(seed: number) {
  let b = createBoard(4, 3, seed);
  for (let face = 0; face < b.faces.length / 2; face++) {
    for (let i = 0; i < b.faces.length; i++) if (b.faces[i] === face) b = reveal(b, i);
  }
  return b;
}

describe('progress on the host', () => {
  it('a solved board is saved, and a reload from the same host keeps it', () => {
    const host = createFakeHost();
    const clock = createFixedClock();
    const open = () =>
      createProgressStore({ host, debounceMs: 0, autoFlush: false, now: () => clock.now() });

    const store = open();
    expect(store.persistent).toBe(true);
    const board = solve(store.get().seed);
    expect(phase(board)).toBe('won');
    expect(board.moves).toBe(6);
    expect(store.update((d) => recordWin(d, board.moves))).toBe(true);
    clock.step(30);
    expect(store.flush()).toBe(true);

    const reloaded = open();
    expect(reloaded.get()).toMatchObject({ wins: 1, bestMoves: 6 });
    // A worse game counts as a win but keeps the best.
    reloaded.update((d) => recordWin(d, 11));
    expect(reloaded.get()).toMatchObject({ wins: 2, bestMoves: 6 });
  });

  it('blocked storage: the game still counts wins, and says it cannot save', () => {
    const store = createProgressStore({
      host: createFakeHost({ storage: null }),
      debounceMs: 0,
      autoFlush: false,
    });
    expect(store.persistent).toBe(false);
    store.update((d) => recordWin(d, 8));
    expect(store.get().wins).toBe(1);
  });
});
