# Brief: ws/pbr-lights

Read `docs/briefs/common.md` first, then DECISIONS E-015; `src/render/README.md` (*Lights*, *Spots and masks*, *Materials*, *Instance format*, default textures), `src/render/wgsl.ts` (the standard material light loop: sun, points, spots, layer masks, shadows, fog), `src/render/standard.ts` (`WGSL_PBR`, its own sun + point loop, `defaultsFor(renderer)`), `src/render/lights.ts` (the 316-float lights block), `src/render/textures.ts` or wherever `defaultTextures(device)` lives, `src/render/renderer.ts` (`Renderer.white`), `harness/pbr.ts`, `harness/lights.ts`, `e2e/pbr.spec.ts`, `e2e/lights.spec.ts`.

## Goal

One light loop. PBR materials see every light the standard material sees: sun with shadows, points, spots with cones and masks, layer bits, fog; the lighting WGSL becomes a shared function both materials call with their own BRDF. Default textures come from one registry.

STATUS row, *done when*: `WGSL_LIGHT_LOOP` (name as fits) exported from `wgsl.ts` as a function `accumulateLights(P, N, V, layerBits, shadowFactor) -> {diffuse, specular}` or an equivalent that takes a BRDF callback by code generation (WGSL has no function pointers: generate the loop body once with a `brdf(...)` call the material prelude defines; document the pattern); the standard material and `WGSL_PBR` both use it; `harness/pbr.html` gains a spot light and a masked light and `e2e/pbr.spec.ts` asserts the spot's cone is visible on the PBR floor (probe inside vs outside the cone) and the mask hides a light from a masked sphere; `standard.ts` `defaultsFor` and `Renderer.white` both delegate to `defaultTextures(device)` (keep `Renderer.white` as a getter alias); 2D goldens pixel-identical (`pnpm snap:check` delta 0; the 2D path uses neither loop: prove it); mesh/lights specs unchanged in outcome; `RenderStats` unchanged; documented in the render README (*Materials* and *Lights* say the loop is shared; *Instance format* reserved-bits sentence fixed as noted in STATUS backlog).

## Scope

- `wgsl.ts`: extract the loop; keep the standard material's output bit-identical where possible (compare the harness `mesh.html` and `lights.html` probes before/after in your report with numbers; small float reordering differences under tolerance are acceptable, document them).
- `standard.ts`: delete the private loop; add spot + mask support through the shared one; `defaultsFor` → `defaultTextures`.
- `renderer.ts`: `white` getter delegates; nothing else.
- Tests: a WGSL unit test that both generated shaders contain exactly one copy of the loop and compile under the fake GPU; e2e as above.
- Docs: render README, `ARCHITECTURE.md` *Materials* one clause, `CHANGELOG.md` *Fixed* (PBR ignored spots and layers) + *Changed*.

## Files owned

`src/render/wgsl.ts`, `src/render/standard.ts`, `src/render/renderer.ts` (the `white` getter only), `src/render/*.test.ts` for those, `harness/pbr.ts`/`pbr.html`, `e2e/pbr.spec.ts`, `src/render/README.md` (*Materials*, *Lights*, *Instance format* sentence), `ARCHITECTURE.md` (one clause), `CHANGELOG.md`.

Branch from `main` (42969a8 or later: spot-lights and texture-registry are on main). Running alongside: ws/batch-submit (`renderer.ts` frame submission path and `frame.ts`: stay out of those functions), ws/post-depth (`PostInputs` in `renderer.ts`, lands soon), ws/geom landing (`harness/mesh.ts` later). Use `E2E_PORT_OFFSET=230`.
