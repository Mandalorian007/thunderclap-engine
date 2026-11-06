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
| [showroom](showroom/README.md) | 7×7 PBR sphere grid (metalness × roughness), sun shadows, three moving point lights, emissive strip, canvas-textured floor, orbit camera, five post looks on keys 1–5 (platform, render, post, input, ui, core) | `showroom.spec.ts`: 3 draw calls, lit middle sphere, looks switch, parked lights, fps |
| [range](range/README.md) | First-person target range: pointer-lock look, ray picks through `meshTester`, hinge tween, sparks, tracer, positioned chime, score anchor (input, render, fx, audio, ui, platform, core) | boot clean; `aimAt(i)` + click hits `i`, scores, resets after 3 s; sky shot misses; tap fires on touch rows; desktop fps > 20 |
