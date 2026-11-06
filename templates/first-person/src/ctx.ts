/**
 * The game's ctx: the engine's `EngineCtx` plus this game's nouns. `createGame` returns the
 * engine part; `main.ts` widens the same object with `Object.assign`, so every scene sees one ctx.
 * This game is a client (`sim: false`, no save): `EngineCtx<Action, null, GameCtx>` types
 * `ctx.save` as `null`.
 */
import type { EngineCtx } from '@thunderclap/engine';
import type { Bindings, Look } from '@thunderclap/engine/input';
import type { Hud } from './ui/hud';
import type { Landmark, Terrain } from './world/terrain';

/**
 * The actions a scene reads. Walking and looking are not actions: `Look` turns the mouse, the
 * touch zones, the sticks and the move keys into `look` and `move` (see `main.ts`).
 */
export type Action = 'inspect' | 'sprint' | 'respawn';

/**
 * One binding list per action. `{ pointer: 'select' }` is any pointer's button (mouse click, a
 * tap, the pad cursor) and selects the pointer router's hit, so a tap on a landmark inspects it.
 */
export const bindings: Bindings<Action> = {
  inspect: [{ key: 'KeyE' }, { pointer: 'select' }, { padButton: 0 }],
  sprint: [{ key: 'ShiftLeft' }, { padButton: 10 }],
  respawn: [{ key: 'KeyR' }, { padButton: 3 }],
};

/** The world the client walks: generated from a seed here and in the mesher Worker. */
export interface World {
  readonly seed: number;
  readonly terrain: Terrain;
  readonly landmarks: readonly Landmark[];
}

/** The player: feet position (world units, y up), yaw (radians, 0 looks down -z) and pitch. */
export interface Player {
  readonly position: Float32Array;
  yaw: number;
  pitch: number;
}

export interface GameCtx extends EngineCtx<Action, null, GameCtx> {
  readonly look: Look;
  readonly world: World;
  readonly player: Player;
  readonly hud: Hud;
  /** Puts the player back on the spawn column, facing the summit. */
  respawn(): void;
}
