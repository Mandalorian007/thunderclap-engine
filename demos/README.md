# Demos

Playable showcases of the engine (E-021). Each is one folder with an `index.html` and a `main.ts`
on the public API only (`@thunderclap/engine` and its subpaths; `scripts/check-boundaries.mjs`
enforces it), procedural content, no network assets, and a `window.__demo` state object its spec
under `e2e/demos/` asserts on. Run one with `pnpm demo <name>` (`pnpm demo` lists them); the
harness Vite server also serves them at `/demos/<name>/`, which is how the e2e matrix loads them.
Each demo README has *What to look at* and *Known limits*; `?still` parks time-driven motion for
probes where a demo has any. To start a game of your own, `pnpm create-game <dir>` scaffolds one
from `templates/` on the same public API.

| Demo | Shows | Spec |
| --- | --- | --- |
| [arena](arena/README.md) | Third-person skinned humanoid (anim mixer, hand socket, sub-stepped sword swing leaving a `Trail`), `Follow` camera on `Look` with its zoom axis, `geom` ground/pillars/orbs/sword, PBR stone, sun shadow, two coloured point lights, dust particles, fog, toasts; `?still` | `arena.spec.ts`: boot in the draw-call band, held key runs 2 s of sim, a click swings and `trailPeak` > 1; desktop fps > 20 |
| [dungeon](dungeon/README.md) | 2D top-down crawl at game scale: 40×30 tile map from a canvas atlas, 60 flipbook bats, wall collision, flickering emissive torches with bloom, fog-of-war layer, pad-navigated pause menu (latched fake pad), coins in `save`, `ui.meter` health bar, synthesised sounds; one draw call; `?still` | `dungeon.spec.ts`: 60 bats, one draw, meter present, wall stop, coin survives reload, menu walks by keys and polled pad presses |
| [showroom](showroom/README.md) | 7×7 PBR sphere grid (metalness × roughness) from `geom` builders, sun shadows, three moving point lights, emissive strip, canvas-textured floor, orbit camera (pan) with `Look` zoom, five post looks on keys 1–5; `?still` | `showroom.spec.ts`: 3 draw calls, lit middle sphere (rAF-settled screenshot), looks switch, parked lights, fps |
| [range](range/README.md) | First-person target range: pointer-lock look, `ui.reticle`, ray picks through `meshTester` over a `geom` cube, hinge tween, sparks, tracer, positioned chime, score anchor | `range.spec.ts`: boot clean; `aimAt(i)` + click hits `i`, scores, resets after 3 s; sky shot misses; tap fires on touch rows; desktop fps > 20 |
