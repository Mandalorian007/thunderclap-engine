/**
 * The game's ctx: the engine's `EngineCtx` plus this game's nouns. `createGame` returns the
 * engine part; `main.ts` widens the same object with `Object.assign`, so every scene sees one ctx.
 * This game is a client (`sim: false`, no save): `EngineCtx<Action, null, GameCtx>` types
 * `ctx.save` as `null`.
 */
import type { EngineCtx } from '@thunderclap/engine';
import type { Bindings, Follow, Look } from '@thunderclap/engine/input';
import type { Hud } from './ui/hud';

/**
 * The actions a scene reads. Moving and orbiting are not actions: `Look` turns the mouse, the
 * touch zones, the sticks and the move keys into `look`, `move` and `zoom` (see `main.ts`).
 */
export type Action =
  | 'attack'
  | 'sprint'
  | 'cosmeticHead'
  | 'cosmeticBack'
  | 'cosmeticHand'
  | 'respawn';

/**
 * One binding list per action. `{ gesture: 'tap' }` is a tap anywhere on the canvas, so a phone
 * attacks without a button; the HUD's cosmetic buttons are plain DOM buttons, so they need none.
 */
export const bindings: Bindings<Action> = {
  attack: [{ key: 'Space' }, { key: 'KeyF' }, { padButton: 0 }, { gesture: 'tap' }],
  sprint: [{ key: 'ShiftLeft' }, { padButton: 10 }],
  cosmeticHead: [{ key: 'Digit1' }, { padButton: 2 }],
  cosmeticBack: [{ key: 'Digit2' }, { padButton: 3 }],
  cosmeticHand: [{ key: 'Digit3' }, { padButton: 1 }],
  respawn: [{ key: 'KeyR' }, { padButton: 9 }],
};

/** The player as the HUD sees it; the scene owns the character and writes these. */
export interface Player {
  health: number;
  readonly maxHealth: number;
  kills: number;
}

export interface GameCtx extends EngineCtx<Action, null, GameCtx> {
  readonly look: Look;
  readonly follow: Follow;
  readonly player: Player;
  readonly hud: Hud;
}
