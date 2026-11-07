// A game on a 0.x engine (scripts/check-deprecated-game.test.mjs): `Hit` is the engine's
// deprecated alias and is reported; the DOM's deprecated `execCommand` and the game's own
// deprecated `oldScore` are not engine names and are not.
import type { Hit } from '@thunderclap-engine/engine';

/** @deprecated The game's own: use `score`. */
export const oldScore = 0;

export function useOld(hit: Hit): number {
  document.execCommand('copy');
  return hit.t + oldScore;
}
