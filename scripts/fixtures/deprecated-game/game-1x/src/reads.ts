// Old names whose error does not print the engine type (ws/testing-3,
// scripts/check-deprecated-game.test.mjs): reads that became getters, called as methods
// (TS2349), and a removed member on a type the game wraps (TS2339). The game's own
// not-callable value and a missing member with no row are not reported.
import type { AssetCache } from '@thunderclap/engine/assets';
import type { SceneStack } from '@thunderclap/engine/core';
import type { Host } from '@thunderclap/engine/host';

type Stack = SceneStack & { extra: number };
interface Cache extends AssetCache {
  label: string;
}

export function reads(
  cache: AssetCache,
  host: Host,
  stack: Stack,
  mine: Cache,
  own: { count: number },
): unknown {
  const stats = cache.stats();
  const full = host.fullscreen.active();
  const state = host.lifecycle?.state();
  const scenes = stack.list();
  const viaOwnType = mine.stats();
  const count = own.count();
  const nothing = stack.nothing;
  return [stats, full, state, scenes, viaOwnType, count, nothing];
}
