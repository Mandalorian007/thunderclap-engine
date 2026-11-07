// Old names on receivers wrapped in parentheses or assertions (ws/testing-4,
// scripts/check-deprecated-game.test.mjs). A removed member on the game's wrapped `Stack`
// (TS2339) resolves only through the receiver's type, which the checker takes from `T` in
// `(x as T)` and `(<T>x)` and from `x` in `x!`. The game's own wrapped value is not reported.
import type { AssetCache } from '@thunderclap/engine/assets';
import type { SceneStack } from '@thunderclap/engine/core';
import type { Host } from '@thunderclap/engine/host';

type Stack = SceneStack & { extra: number };

export function wrapped(
  value: unknown,
  maybe: Stack | undefined,
  cache: AssetCache | undefined,
  host: Host,
  stack: Stack,
  own: { count: number },
): unknown {
  return [
    (value as Stack).list(),
    (<Stack>value).list(),
    maybe!.list(),
    (maybe as Stack | undefined)!.list(),
    (stack satisfies SceneStack).list(),
    ((value as Host).fullscreen as Host['fullscreen']).active(),
    (cache as AssetCache).stats(),
    (host.lifecycle as Host['lifecycle'])?.state(),
    (own as { count: number }).count(),
  ];
}
