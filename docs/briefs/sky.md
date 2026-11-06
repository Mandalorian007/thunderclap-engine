# Brief: ws/sky

Read `docs/briefs/common.md` first, then `docs/VISION.md` (style comes from shaders, not assets), DECISIONS E-013, E-015 (quality bar); `ARCHITECTURE.md` *FX*, *Lighting*, *Renderer* (pass order, depth); `src/fx/README.md` (how `ParticleSystem` is a `Drawable` with its own material), `src/fx/particles.ts` (constructor/`draw(pass, frame)` shape, `Drawable`), `src/render/material.ts` (`DepthMode`, `materialPrelude`, camera block access), `src/render/lights.ts` (`Lights.sun`, `fog`), `src/render/README.md` (Materials, camera block fields: inverse view-projection or view direction availability), `harness/mesh.ts`.

## Goal

A sky that makes a 3D scene look finished with no asset: a procedural gradient dome with a sun disc and glow that follows `Lights.sun`, horizon haze that matches `Lights.fog.color`, an optional night mode with stars. One object, drawn first, depth write off.

STATUS row, *done when*: `Sky(renderer, opts?: SkyOptions)` in `@thunderclap/engine/fx` is a `Drawable` with `draw(frame)`; `SkyOptions { zenith?, horizon?, ground?, sunSize?, sunGlow?, stars?: boolean | { density; seed }, exposure? }` with live fields; reads the frame's `Lights` (sun direction and colour, fog colour) through the lights block, no per-frame uniform upload of its own beyond one small params buffer; depth-tested against nothing and writes no depth (`DepthMode` 0 or whatever means test-only-never-write: pick and document); harness `sky.html` on the matrix; documented.

## Scope

- `src/fx/sky.ts` + `sky-wgsl.ts`: draw as one fullscreen triangle (`pass.draw(3)`, like the particles' soft-depth pass) that reconstructs the view ray per pixel from the camera block (inverse projection + view rotation; if the block lacks an inverse, compute the four frustum corner directions on the CPU per frame and interpolate them: 12 floats in the params buffer, zero allocations). Colour: zenith→horizon→ground gradient in linear space, sun disc (`sunSize` radians) and a `sunGlow` falloff tinted by `sun.color`, horizon band towards `fog.color` so distant ground meets the sky, stars from a hash of the direction when `stars` is on (dim them when the sun is above the horizon). Writes the emissive target too (sun disc and stars go to emissive so bloom-style post picks them up) if the material path writes two targets; say so.
- Draw order: the game calls `sky.draw(frame)` first; `depthTest` off or test-only so later geometry overwrites. Must work with `Camera.cull` on (not an instance; nothing to cull).
- Tests `src/fx/sky.test.ts`: fake-GPU draw emits one 3-vertex draw, params layout golden, frustum corner math against `Camera.screenToWorld` for the four corners, zero allocations per `draw`.
- Harness `harness/sky.html|ts|-state.ts`: the mesh page's ground + two cubes under a sky, sun animating through a day (time-driven; `?still` parks it at noon for the spec), fog on; state exposes `sunElevation`, probes `zenith`, `horizon`, `sunDisc`, `ground`. `e2e/sky.spec.ts` with `?still`: zenith bluer than horizon, sun disc brighter than zenith, ground probe still the ground colour (sky never overwrote it); all polled per E-017.
- Docs: `src/fx/README.md` *Sky*, ARCHITECTURE *FX* one sentence, CHANGELOG, README harness list.

## Files owned

`src/fx/sky.ts`, `src/fx/sky-wgsl.ts`, `src/fx/sky.test.ts`, `src/fx/index.ts` (append), `src/fx/README.md` (*Sky*), `harness/sky.*`, `e2e/sky.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness list item).

Nothing under `src/render/`; if the camera block lacks what you need, use the CPU corner path and report it. Branch from `main` (7574107 or later). Running alongside: ws/spot-lights (`lights.ts`, `wgsl.ts`), ws/skinning (`mesh.ts`, `wgsl.ts` prelude), integrators landing trails (`src/fx/index.ts`, `src/fx/README.md`: append after their sections; a trivial conflict is expected), pbr, xr-post, shadow-cull.
