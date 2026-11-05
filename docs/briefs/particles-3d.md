# Brief: ws/particles-3d

Read `docs/briefs/common.md` first, then `docs/VISION.md` (pillar 4: GPU particles and weather-class FX; Forgewilds: weather, emissive FX), DECISIONS E-008, E-010, E-013; `ARCHITECTURE.md` *Transforms*, *Renderer*, *Lighting*; `src/fx/README.md`; `src/fx/particles.ts`, `src/fx/particles-wgsl.ts`, `src/render/frame.ts` (`Drawable`), `src/render/wgsl.ts` (`WGSL_LIGHTS`, camera block names).

## Goal

Rain, snow, sparks, dust and smoke in a 3D world: particles live in world space, billboard toward any camera, respect depth, and read the lighting block, while every 2D emitter today renders pixel-identically.

STATUS row, *done when*: `ParticleSystem` in world space with camera billboarding, depth, soft fade and lit/emissive modes; `EmitParams` gains 3D position, velocity, gravity, wind; weather page on the matrix; 2D particles pixel-identical.

## Scope

1. **World-space mode.** `ParticleSystemOptions.space: '2d' | 'world'` (default `'2d'`, current behaviour untouched). In world space the vertex shader builds a camera-facing quad from `camera.view` (right/up from the view rows) with `size` in world units; `EmitParams` gains `z`, `vz`, `gravity: [x,y,z]`, `wind: [x,y,z]`, `drag`, and `shape` gets a `box` and `sphere` 3D emit volume. Simulation stays on the GPU in the same compute path, extended to 3 components.
2. **Depth and fade.** Depth test on, write off (already there); add a soft-particle fade against the scene depth when the frame has a depth attachment (sample `frame.depth` through a `texture_depth_2d` binding; skip when no depth). A `fade: { near, far }` range by distance to the camera.
3. **Light.** `ParticleSystemOptions.lit: boolean` samples `engine_lambert` on a sphere normal (uses `WGSL_LIGHTS`); `emissive` writes to the emissive target as sprites do.
4. **Harness.** `harness/weather.html` + `weather.ts`: rain and snow over the mesh-page cube field under a perspective camera, dust motes near a point light; `e2e/weather.spec.ts`: page boots, particles alive count > 0, a pixel in the rain column differs from the clear sky, and the 2D particle page (whichever harness page already uses particles) stays pixel-identical: the matrix proves that.

## Files owned

`src/fx/**`, `harness/weather.html`, `harness/weather.ts`, `harness/weather-state.ts`, harness page list (one line), `e2e/weather.spec.ts`, `ARCHITECTURE.md` *FX* paragraph (one sentence), `CHANGELOG.md`.

Running alongside: ws/shadows changes `WGSL_LIGHTS` fields (append-only: the names you use today keep working) and the per-view uniform buffer; read it through the existing binding and do not copy its text. ws/cull owns `frame.ts`. If you need a `frame.depth` view the renderer does not expose, add a getter to `SceneTarget` (`src/render/scene-target.ts`, which nobody else owns) and name it in your report.
