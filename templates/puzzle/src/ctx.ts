/**
 * The game's ctx: the engine's `EngineCtx` plus this game's nouns. `createGame` returns the
 * engine part; `main.ts` widens the same object with `Object.assign`, so every scene sees one ctx.
 */
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { Analytics } from '@thunderclap-engine/engine/analytics';
import type { Bindings } from '@thunderclap-engine/engine/input';
import type { Events } from './analytics';
import type { Board } from './rules/board';
import type { ProgressStore } from './save/schema';

/** The actions a scene reads. Devices never leak past the bindings below. */
export type Action = 'select' | 'confirm' | 'left' | 'right' | 'up' | 'down' | 'newGame';

/**
 * One binding list per action. A tap (touch, pen or mouse click) selects the cell under it; the
 * keyboard and the pad move a cursor and confirm. `select` and `confirm` are separate actions
 * because one carries a position and the other does not.
 */
export const bindings: Bindings<Action> = {
  select: [{ gesture: 'tap' }],
  confirm: [{ key: 'Enter' }, { key: 'Space' }, { padButton: 0 }],
  left: [{ key: 'ArrowLeft' }, { key: 'KeyA' }, { padButton: 14 }, { padAxis: 0, dir: -1 }],
  right: [{ key: 'ArrowRight' }, { key: 'KeyD' }, { padButton: 15 }, { padAxis: 0, dir: 1 }],
  up: [{ key: 'ArrowUp' }, { key: 'KeyW' }, { padButton: 12 }, { padAxis: 1, dir: -1 }],
  down: [{ key: 'ArrowDown' }, { key: 'KeyS' }, { padButton: 13 }, { padAxis: 1, dir: 1 }],
  newGame: [{ key: 'KeyN' }, { padButton: 3 }],
};

/** The game's state the scenes and the HUD share. */
export interface Game {
  board: Board;
  /** Keyboard and pad cursor, a cell index. */
  cursor: number;
  /** `Date.now()` when the board was dealt (for `level_complete.ms`). */
  dealtAt: number;
}

export interface GameCtx extends EngineCtx<Action, ProgressStore, GameCtx> {
  readonly game: Game;
  /** The game's events (`level_start`, `level_complete`), or `null` when `COLLECT_URL` is unset. */
  readonly analytics: Analytics<Events> | null;
  /** Deals a fresh board (new seed) and tells the HUD. */
  newGame(): void;
  /** The HUD re-reads the game state. Call after every move. */
  refreshHud(): void;
}
