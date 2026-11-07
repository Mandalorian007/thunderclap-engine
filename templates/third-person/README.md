# Ember Reach: the third-person template

A third-person action game: a skinned character on rolling ground with an orbit camera, an
attack whose lunge comes from the clip (root motion), feet planted by IK, a head that tracks the
nearest enemy, three swappable cosmetics and four roaming enemies with name plates and health
bars. The character is generated as a glb at startup, so no binary asset ships. Start here for
an action RPG, a brawler or anything with a character you see.

## Run

```sh
pnpm install
pnpm dev        # Vite at http://127.0.0.1:5173 (a WebGPU browser: Chrome, Edge or Safari 26+)
pnpm test       # Vitest: the rig, the controller, the enemies and the character on a fake GPU
pnpm check      # tsc, Biome, Vitest
pnpm build      # the static game in dist/ (pnpm preview serves it)
```

In the engine repo: `pnpm template:third-person` from the root.

WASD moves, Shift runs, Space or F attacks, drag to orbit, the wheel zooms, 1 / 2 / 3 swap cosmetics, R respawns.

## Edit these first

- `src/character/rig.ts`: the skeleton, mesh and clips. To use a real model, fetch a glb in `src/character/character.ts` instead of `buildCharacterGlb()` and keep the joint and clip names.
- `src/character/graph.ts`: the animation states and transitions (idle, walk and run, attack, hit).
- `src/character/character.ts`: the runtime character, posed with one `skinPose` call per frame. `src/character/character.test.ts` runs it on the engine's fake GPU and a fixed clock.
- `src/character/cosmetics.ts`: the cosmetics table; add a slot without touching the character.
- `src/enemies/enemies.ts` and `src/scenes/arena.ts`: the enemies and the arena.
- `CLAUDE.md`: the whole template and every engine noun it uses, for you or an agent.

## Engine guides

- [Getting started](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/getting-started.md)
- [Make a 3D game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/3d-game.md)
- [Animate a character](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/characters.md)
- [Input](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/input.md)
- [UI and HUD](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/ui-and-hud.md)
- [Testing your game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/testing-your-game.md)
