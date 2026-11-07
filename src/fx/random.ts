/**
 * The fx module's default randomness (ws/fx-4). Every random draw in `src/fx` goes through a
 * core `Random`; an object built without one forks its own stream from one module default,
 * seeded once with `FX_DEFAULT_SEED`. Forks are named by kind and creation index
 * (`particles#0`, `decals#1`, …), so a page that builds the same objects in the same order gets
 * the same numbers on every load. Pass `random` (`createRandom(seed)` or a fork of a game's
 * own stream) to make an object independent of construction order.
 */
import { createRandom, type Random } from '../core/random';

/** The seed of the fx module's default stream. */
export const FX_DEFAULT_SEED = 'thunderclap-fx';

/** Largest particle spawn seed (exactly representable in a `f32`). */
export const SPAWN_SEED_MAX = 16777214;

let root: Random | null = null;
let forks = 0;

/** A fork of the module default (`FX_DEFAULT_SEED`) for one object of `kind`. */
export function defaultFxRandom(kind: string): Random {
  root ??= createRandom(FX_DEFAULT_SEED);
  return root.fork(`${kind}#${forks++}`);
}
