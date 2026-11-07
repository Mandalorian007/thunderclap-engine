# Skyline: the platformer template

A 2D side-scroller with two levels: run, jump (coyote time, jump buffering, short hops), dash,
ride moving platforms, collect coins, dodge spikes and reach the door. Levels are text, the
physics is pure and tested, the world is one atlas drawn in a handful of calls with three
parallax layers, and the best times live in a versioned save. Start here for any 2D action game.

## Run

```sh
pnpm install
pnpm dev        # Vite at http://127.0.0.1:5173 (a WebGPU browser: Chrome, Edge or Safari 26+)
pnpm test       # Vitest: the level parser, the physics and the save
pnpm check      # tsc, Biome, Vitest
pnpm build      # the static game in dist/ (pnpm preview serves it)
```

In the engine repo: `pnpm template:platformer` from the root.

## Edit these first

- `src/levels/*.ts`: the levels, one string per row (`#` solid, `-` one-way, `^` hazard, `o` coin, `c` checkpoint, `p` spawn, `x` exit, `m` mover). Add one to `src/levels/index.ts`.
- `src/physics/player.ts`: the feel. `GRAVITY`, `JUMP_SPEED` and `RUN_SPEED` at the top; the tests are written against the constants, so `pnpm test` tells you what changed.
- `src/world/atlas.ts`: the art, painted in code into one atlas. Replace it with a texture at the same cell layout.
- `src/save/schema.ts`: best times, coins and lives. `src/save/host.test.ts` saves a run and reloads it on the engine's fake host.
- `CLAUDE.md`: the whole template and every engine noun it uses, for you or an agent.

## Engine guides

- [Getting started](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/getting-started.md)
- [Make a 2D game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/2d-game.md)
- [Input](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/input.md)
- [UI and HUD](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/ui-and-hud.md)
- [Testing your game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/testing-your-game.md)
