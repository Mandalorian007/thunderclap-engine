# Brief: ws/lights

Read `docs/briefs/common.md`, then `docs/VISION.md` pillar 4, DECISIONS E-003, E-006, E-008, E-010; `ARCHITECTURE.md` *Camera*, *Transforms*, *Renderer*; `src/render/README.md`; `harness/mesh.ts` (the page you will light).

## Goal

A lighting block every material can read, the same way they read the camera block. Style comes from the game's WGSL; the engine supplies the uniforms. Named needs: Last Rune's candle point lights, Forgewilds' sun and dynamic lights.

STATUS row: `EngineLights` uniform at `@group(0) @binding(2)`: ambient, one directional, N point lights (position, colour, radius), read by game WGSL through `materialPrelude`; harness mesh page lit by it.

## Scope

- `src/render/lights.ts`: `Lights` (ambient rgb, `sun { dir, color }`, `points: PointLight[]` with position xyz, color rgb, radius; `MAX_POINT_LIGHTS` 16 or similar; `writeBlock(out)` into a preallocated `Float32Array`, no allocation). The frame or renderer carries one `Lights` per `render()` call: `frame.lights` set by the game, default an unlit block (ambient 1, no sun, no points) so every existing material renders identically.
- WGSL: `EngineLights` struct at `@group(0) @binding(2)` in `materialPrelude`, snake_case fields (E-006), plus helpers `engine_lambert(normal, world_pos) -> vec3f` and `engine_point_lights(...)` a game may call or ignore.
- Renderer: bind-group layout entry for binding 2, the uniform written beside camera/globals in the same upload (one buffer, offsets), per view.
- `harness/mesh.ts`: replace the page-side Lambert with the block (sun + one moving point light); update the e2e colour probes if thresholds move; keep the four tests green.
- Fake-GPU tests: block layout, default block, no steady-state allocation.

## Files owned

`src/render/lights.ts` (+ test), `src/render/wgsl.ts`, `src/render/renderer.ts` (all of it except the viewport/scissor/`view_index` lines inside `render()`, which `ws/two-views` may touch), `src/render/frame.ts` (adding `lights` only), `src/render/index.ts`, `src/render/README.md`, `src/render/renderer.test.ts`, `harness/mesh.ts`, `harness/mesh-state.ts`, `e2e/mesh.spec.ts`, `ARCHITECTURE.md` (a new **Lighting** paragraph only), `CHANGELOG.md`.

Alongside: `ws/mesh-stream` (`src/render/mesh.ts`, `harness/stream*`), `ws/two-views` (`harness/views*`, `e2e/views.spec.ts`), `ws/plumbing` (`src/core`, `src/input/gestures.ts`, `src/platform`, `src/render/camera.ts`, `templates/`), `ws/doc-sweep` (other ARCHITECTURE paragraphs, READMEs outside render).

## Must stay

2D harness pages pixel-identical (default block is unlit; `fs_main` contracts unchanged). Zero steady-state allocations.
