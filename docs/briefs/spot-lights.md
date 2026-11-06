# Brief: ws/spot-lights

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015, E-016; `src/render/README.md` (Lighting incl. shadows, fog, block layout); `src/render/lights.ts`, `src/render/wgsl.ts` (`WGSL_LIGHTS`, `engine_lambert`), `src/render/lights.test.ts`, `src/render/frame.ts` (`InstanceParams`, the `layers` mask), `harness/mesh.ts`.

## Goal

Spot lights and per-light layer masks in the lights block: a torch cone, a character rim light that lights only the character, a UI-layer light that ignores the world. The next PBR material (ws/pbr) and the current Lambert helper both read them.

STATUS row, *done when*: `SpotLight { position; direction; color; radius; innerAngle; outerAngle; layers? }` with `Lights.spots` (up to `MAX_SPOT_LIGHTS` 8), `PointLight.layers?` (mask, default all), `DirectionalLight.layers?`; block grows by the spot array and per-light masks; `engine_lambert` (and a new `engine_light_accum(world_pos, N, layer_mask)` helper usable by custom WGSL) honour cone falloff and masks against the instance's layer bits; harness `lights.html` on the matrix with a sweeping spot and a masked light; documented.

## Scope

- `lights.ts`: append the spot array and the masks after the existing fields so every existing offset (`SUN_VIEW_PROJ_OFFSET_FLOATS`, `SHADOW_PARAMS_OFFSET_FLOATS`, `FOG_OFFSET_FLOATS`) stays unchanged; bump `LIGHTS_BLOCK_FLOATS`; `writeBlock` writes them. Masks as u32 through the same `Uint32Array` trick the block uses for `point_count`.
- `wgsl.ts`: `WGSL_LIGHTS` struct gains the fields; a `engine_light_accum` function; `engine_lambert` calls it. The instance layer bits must reach the fragment stage: check how `layers` travels today (instance float or flags); if a `VSOut` field is needed add it after `flags` (`@location(10)`), flat. Keep the 2D prelude byte-identical (the particles test hashes shader text).
- Tests: block offsets golden-tabled; spot cone math in a pure helper tested; masked light excluded in a fake-GPU render (assert via the block bytes, not pixels).
- Harness `lights.html` + `lights.ts` + `lights-state.ts`: ground + two cubes on different layers, one spot sweeping, one point light masked to one cube; probes under the spot and on each cube. `e2e/lights.spec.ts`: boots; spot probe brighter inside the cone than outside; masked cube darker than the lit one.
- Docs: render README Lighting (spots, masks, the helper); ARCHITECTURE *Lighting* one sentence; CHANGELOG; root README harness list item.

## Files owned

`src/render/lights.ts`, `src/render/lights.test.ts`, `src/render/wgsl.ts` (`WGSL_LIGHTS` block and the `engine_lambert`/`engine_light_accum` text only; ws/skinning edits `materialPrelude`'s layout branch in the same file: stay out of it), `src/render/index.ts` (append), `src/render/README.md` (Lighting section), `harness/lights.*`, root `README.md` (harness list item), `e2e/lights.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`. Not `renderer.ts` (ws/shadow-cull, ws/xr-post), not `shadow.ts`.

Branch from `main` (24aa230 or later). Running alongside: ws/pbr (reads `WGSL_LIGHTS` on ws/shadows; the integrator merges you first if you are green first, else pbr adopts your helper in a follow-up), ws/skinning, ws/shadow-cull, ws/xr-post, ws/trails, ws/anim, ws/follow, ws/gltf-anim, ws/template-first-person, ws/doc-sweep-3.
