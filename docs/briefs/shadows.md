# Brief: ws/shadows

Read `docs/briefs/common.md` first, then `docs/VISION.md` (pillar 4; Forgewilds: baked and dynamic light, fog), DECISIONS E-008, E-010, E-012, E-013; `ARCHITECTURE.md` *Lighting*, *Renderer*, *Transforms*; `src/render/README.md`; `src/render/lights.ts`, `src/render/wgsl.ts`, `src/render/material.ts`, `src/render/renderer.ts` (the view loop and `writeView`), `harness/mesh.ts`.

## Goal

A sunlit world casts shadows and fades into distance fog through the lighting block, with the style still the game's WGSL. Forgewilds' overworld is the named need; The Last Rune ignores both (defaults are off and pixel-identical).

STATUS row, *done when*: sun shadow map rendered by the engine and sampled through `engine_shadow(world_pos)`; `engine_fog(color, world_pos)` with distance fog from the block; mesh page shows both; 2D harness pixel-identical.

## Scope

1. **Shadow map.** `Lights.sun` gains `shadow?: { size?: 1024 | 2048 | 4096; extent: number; near?: number; far?: number; bias?: number }` (ortho box centred on the camera position, `extent` world units half-width; null → no shadow pass). `render/shadow.ts` owns a `depth32float` texture, a comparison sampler and a depth-only pipeline per vertex layout (same `engine_vertex` path, no fragment). Per `render(frame, camera, target)` with a shadow-casting sun, the renderer encodes one shadow pass over the frame's opaque mesh draws (sprites with `VERTEX_LAYOUT_2D` are skipped unless `DrawParams.castShadow` is set) before the scene pass. Casting/receiving flags on `DrawParams` default so 2D is untouched.
2. **Block.** `EngineLights` gains `sun_view_proj: mat4x4f`, `shadow_params: vec4f` (bias, texel size, enabled, -) and `fog: vec4f` (rgb, density) + `fog_range: vec4f` (near, far, -, -). Update `LIGHTS_BLOCK_FLOATS` and the uniform buffer size; `writeBlock` stays allocation-free. The shadow map and comparison sampler bind at `@group(0) @binding(3)` and `(4)`; when there is no shadow a 1×1 depth texture is bound so every pipeline has one layout.
3. **Prelude.** `materialPrelude` gains `engine_shadow(world_pos) -> f32` (PCF 3×3, 1 outside the map or when disabled), `engine_fog(color: vec3f, world_pos) -> vec3f` (linear or exponential by density; identity when density 0), and `engine_lambert` multiplies the sun term by `engine_shadow`. Default block → every helper is the identity, so existing materials render identically (prove it: the e2e matrix and the E-008 probe).
4. **Harness.** `harness/mesh.ts` gets shadows under its cubes and fog on the ground quad, with a state flag the e2e can read; `e2e/mesh.spec.ts` adds one assertion that a pixel in the cube's shadow is darker than one beside it, and one that a far pixel moves toward the fog colour.

## Files owned

`src/render/lights.ts`, `src/render/shadow.ts` (new), `src/render/wgsl.ts` (lights section), `src/render/material.ts`, `src/render/renderer.ts` (the shadow pass call, `writeView`'s lights offset, bind group layout entries 3 and 4), `src/render/frame.ts` (`DrawParams.castShadow`/`receiveShadow` only), `src/render/index.ts` (append), `src/render/README.md` (Lighting section), `harness/mesh.ts` (scene setup only), `harness/mesh-state.ts` (append), `e2e/mesh.spec.ts` (append), `ARCHITECTURE.md` *Lighting*, `CHANGELOG.md`.

Running alongside: ws/cull owns the record/sort/cull code in `renderer.ts` and `frame.ts` (bounds on draws) and `camera.ts`; keep your `renderer.ts` edits to the shadow pass and bind layout and name their line ranges in your report. ws/prune removes exports from `render/index.ts` (merged first). ws/texture-array owns `texture.ts`. ws/particles-3d owns `src/fx/`; `WGSL_LIGHTS` is what it reads, so keep it exported and note its new fields in the README.
