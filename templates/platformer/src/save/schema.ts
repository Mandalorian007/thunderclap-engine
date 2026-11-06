/**
 * The save record: best time and coins per level, plus lives carried between sessions. One
 * migration from the v1 shape (an array of `{ level, time }` entries without coins).
 */
import {
  createSaveStore,
  type Infer,
  type Migrations,
  type SaveStore,
  type SaveStoreOptions,
  s,
} from '@thunderclap/engine/save';

export const SAVE_GAME = 'platformer';
export const SAVE_VERSION = 2;

const levelRecordSchema = s.object({
  /** Best clear time in ms, or null before the first clear. */
  bestMs: s.nullable(s.number()),
  /** Most coins collected in one run. */
  coins: s.number(),
});

export const progressSchema = s.object({
  levels: s.record(levelRecordSchema),
  lives: s.number(),
});

export type LevelRecord = Infer<typeof levelRecordSchema>;
export type Progress = Infer<typeof progressSchema>;
export type ProgressStore = SaveStore<Progress>;

export const START_LIVES = 3;

export const defaultProgress = (): Progress => ({ levels: {}, lives: START_LIVES });

/** v1 stored `{ best: [{ level, time }] }` with times in seconds and no coins. */
interface ProgressV1 {
  best?: { level: string; time: number }[];
}

export const migrations: Migrations = {
  1: (old: unknown): Progress => {
    const v1 = (old ?? {}) as ProgressV1;
    const next = defaultProgress();
    for (const e of v1.best ?? []) {
      if (typeof e?.level !== 'string' || typeof e.time !== 'number') continue;
      next.levels[e.level] = { bestMs: Math.round(e.time * 1000), coins: 0 };
    }
    return next;
  },
};

export function createProgressStore(
  opts: Pick<
    SaveStoreOptions<Progress>,
    'host' | 'storage' | 'debounceMs' | 'autoFlush' | 'now'
  > = {},
): ProgressStore {
  return createSaveStore<Progress>({
    game: SAVE_GAME,
    slot: 'main',
    version: SAVE_VERSION,
    defaults: defaultProgress,
    schema: progressSchema,
    migrations,
    ...opts,
  });
}

/** Folds a finished run into the record; returns whether either stat improved. */
export function recordRun(p: Progress, levelId: string, ms: number, coins: number): boolean {
  const cur = p.levels[levelId] ?? { bestMs: null, coins: 0 };
  const bestMs = cur.bestMs === null ? ms : Math.min(cur.bestMs, ms);
  const best = { bestMs, coins: Math.max(cur.coins, coins) };
  const improved = best.bestMs !== cur.bestMs || best.coins !== cur.coins;
  p.levels[levelId] = best;
  return improved;
}
