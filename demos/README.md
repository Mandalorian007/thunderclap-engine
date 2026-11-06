# Demos

Playable showcases of the engine (E-021). Each is one folder with an `index.html` and a `main.ts`
on the public API only (`@thunderclap/engine` and its subpaths; `scripts/check-boundaries.mjs`
enforces it), procedural content, no network assets, and a `window.__demo` state object its spec
under `e2e/demos/` asserts on. Run one with `pnpm demo <name>` (`pnpm demo` lists them); the
harness Vite server also serves them at `/demos/<name>/`, which is how the e2e matrix loads them.

| Demo | Shows | Spec |
| --- | --- | --- |
| [arena](arena/README.md) | Third-person skinned humanoid (anim mixer, hand socket, sword trail), Follow camera on Look, PBR ground and pillars, sun shadow, two coloured point lights, dust particles, fog, toasts | `e2e/demos/arena.spec.ts` |
| [dungeon](dungeon/README.md) | 2D top-down crawl at game scale: 40×30 tile map from a canvas atlas, 60 flipbook bats, wall collision, flickering emissive torches with bloom, fog-of-war layer, pad-navigated pause menu, coins in `save`, synthesised sounds; one draw call | `e2e/demos/dungeon.spec.ts` |
