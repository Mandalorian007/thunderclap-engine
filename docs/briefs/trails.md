# Brief: ws/trails

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *FX*, *Transforms*, *Renderer*; `src/fx/README.md` (particles incl. world space), `src/fx/particles.ts` (how an FX system records draws into the frame, blend modes, `depthTarget` soft fade), `src/render/mesh.ts` (`Mesh.update`, capacity), `src/render/frame.ts`, `harness/weather.ts`.

## Goal

Ribbon trails: a strip that follows a moving point (weapon tip, wing tip, projectile) with width, colour and fade over age, camera-facing or fixed-axis, in world or 2D space. The trails in E-015's reference frame; the next game's projectiles.

STATUS row, *done when*: `Trail` (`TrailOptions { space: '2d' | 'world'; maxPoints; width | widthCurve; color | colorCurve; lifetime; minDistance; facing: 'camera' | 'up' | [x,y,z]; blend; texture?; uvMode: 'stretch' | 'tile' }`, `push(x, y, z?)`, `update(dt, camera?)`, `draw(frame)`, `clear()`), a ring buffer updating one `Mesh` range per frame with zero allocations, a lit-free unlit material with soft edge, harness `trails.html` on the matrix (a swinging arm with a trail and an orbiting emitter), documented.

## Scope

- `src/fx/trail.ts` + `trail-wgsl.ts`: geometry built on the CPU into a preallocated `Float32Array` (two verts per point) and uploaded through `Mesh.update` with a range, index buffer static. Camera facing uses the camera's view axes (`Camera` exposes its matrices; read, don't edit). Fade through vertex colour alpha and an optional age curve sampled from a small `Float32Array` table.
- `TrailBatch` optional: many trails in one mesh/draw (projectiles); if it fits in the time, else report.
- Tests: ring buffer wrap, `minDistance` rejects, age expiry, vertex count per frame, zero allocs in `update`/`draw` after warm-up (count via a fake mesh).
- Harness `trails.html` + `trails.ts` + `trails-state.ts`: probes at the trail's mid point; `e2e/trails.spec.ts`: boots, probe differs from clear colour while swinging, trail clears after `clear()`.
- `src/fx/index.ts` append; fx README *Trails* section; ARCHITECTURE *FX* one sentence; root README harness list item; CHANGELOG.

## Files owned

`src/fx/trail.ts`, `src/fx/trail-wgsl.ts`, `src/fx/trail.test.ts`, `src/fx/index.ts` (append), `src/fx/README.md` (one section), `harness/trails.*`, root `README.md` (harness list item), `e2e/trails.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`. Nothing under `src/render/`.

Branch from `main` (f6fa3ba or later). Running alongside: ws/pbr, ws/skinning, ws/anim, ws/follow, ws/gltf-anim, ws/xr, ws/template-first-person; integrators on shadows and gltf.
