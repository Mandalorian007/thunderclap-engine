/**
 * The save: what survives a reload. One schema, one version number, and a migration for each
 * version that ever shipped. Bump `SAVE_VERSION` and add a `migrations[old]` entry whenever the
 * shape changes; the engine runs the chain, validates the result and backs up anything it cannot
 * read (see `@thunderclap/engine/save`).
 */
import {
  createSaveStore,
  type Infer,
  type Migrations,
  type SaveStore,
  type SaveStoreOptions,
  s,
} from '@thunderclap/engine/save';

export const SAVE_GAME = 'template-puzzle';
export const SAVE_VERSION = 2;

export const ProgressSchema = s.object({
  /** Boards solved. */
  wins: s.number({ min: 0, int: true }),
  /** Fewest moves to solve a board, or null before the first win (added in v2). */
  bestMoves: s.nullable(s.number({ min: 0, int: true })),
  /** The seed of the board in play, so a reload deals the same one. */
  seed: s.number({ int: true }),
});
export type Progress = Infer<typeof ProgressSchema>;

export const defaultProgress = (): Progress => ({ wins: 0, bestMoves: null, seed: 1 });

/**
 * v1 → v2: v1 stored only `wins`. The example every later migration copies: take the old data as
 * `unknown`, keep what still applies, fill the rest with defaults.
 */
export const migrations: Migrations = {
  1: (old) => {
    const o = old as { wins?: number };
    return { wins: o.wins ?? 0, bestMoves: null, seed: 1 };
  },
};

export type ProgressStore = SaveStore<Progress>;

/** Builds the store; `createGame` calls this with the host so storage comes from the page. */
export function createProgressStore(
  opts: Pick<SaveStoreOptions<Progress>, 'host' | 'storage' | 'debounceMs' | 'autoFlush' | 'now'>,
): ProgressStore {
  return createSaveStore<Progress>({
    game: SAVE_GAME,
    slot: 'main',
    version: SAVE_VERSION,
    migrations,
    defaults: defaultProgress,
    schema: ProgressSchema,
    ...opts,
  });
}

/** Folds a solved board into the progress: one more win, and the best move count so far. */
export const recordWin = (p: Progress, moves: number): Progress => ({
  ...p,
  wins: p.wins + 1,
  bestMoves: p.bestMoves === null ? moves : Math.min(p.bestMoves, moves),
});
