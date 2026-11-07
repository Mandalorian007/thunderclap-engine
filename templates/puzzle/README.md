# Pairs: the puzzle template

A memory game of pairs on a 4×3 board: tap two cards, keep them when they match. It is the
smallest complete game in the engine: pure rules with tests, one scene, a HUD that moves per
form factor (desktop, tablet, phone), a versioned save with a migration, and opt-in analytics.
Start here for a board game, a card game, a match-3 or anything turn-based.

## Run

```sh
pnpm install
pnpm dev        # Vite at http://127.0.0.1:5173 (a WebGPU browser: Chrome, Edge or Safari 26+)
pnpm test       # Vitest: the rules and the save
pnpm check      # tsc, Biome, Vitest
pnpm build      # the static game in dist/ (pnpm preview serves it)
```

In the engine repo: `pnpm template:puzzle` from the root.

## Edit these first

- `src/rules/board.ts`: the game. Pure functions over an immutable `Board` (`createBoard`, `reveal`, `settle`, `phase`); `src/rules/board.test.ts` drives them. Swap in your own rules and keep the shape.
- `src/scenes/board.ts`: turns taps into rule calls and draws the board. Change the look here.
- `src/save/schema.ts`: what survives a reload. Bump `SAVE_VERSION` and add a migration when the shape changes; `src/save/host.test.ts` plays a game and reloads it on the engine's fake host.
- `src/layout/spec.ts` and `src/ui/hud.ts`: where the HUD sits on each form factor.
- `CLAUDE.md`: the whole template and every engine noun it uses, for you or an agent.

## Engine guides

- [Getting started](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/getting-started.md)
- [Make a 2D game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/2d-game.md)
- [UI and HUD](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/ui-and-hud.md)
- [Input](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/input.md)
- [Testing your game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/testing-your-game.md)
