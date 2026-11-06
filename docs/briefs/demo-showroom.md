# Brief: ws/demo-showroom

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md`, then `examples/hello/main.ts`, `harness/pbr.ts`/`pbr.html` and `harness/mesh.ts` (PBR material, lights, shadows, fog), `harness/skybox` or `harness/sky.*` if landed, `src/render/README.md` (materials, texture arrays, instance params, `RenderStats`), `src/post/README.md` (bloom, god rays, tone mapping, `blendTo`), `src/input/README.md` (`Look`, orbit, pointer router).

## Goal

`demos/showroom`: a material and lighting showroom. Validates rendering quality in one view: a 7×7 grid of spheres sweeping roughness × metalness under a sun with shadows, three moving point lights, an emissive strip, a procedurally textured floor (checker albedo + roughness map via canvas), orbit camera with wheel zoom, keys 1–5 switching post looks through `post.blendTo` (neutral, warm bloom, god rays, high contrast, off), and an on-screen readout (`ui`) of draw calls and GPU ms. A `?still` query parks all motion for stable measurements.

STATUS row, *done when*: `pnpm demo showroom` runs; `__demo` exposes `fps`, `gpuMs` (when the timer exists), `drawCalls`, `look` (current post look), `lightPositions`; `e2e/demos/showroom.spec.ts` with `?still`: reads a centre pixel from a middle sphere and asserts it is lit (not black, not blown out), switches looks with keys and asserts `look` changes and the frame still renders, asserts `drawCalls` equals the expected count; `demos/showroom/README.md` lists the expected visual per look; `pnpm check` and `pnpm test:e2e` green at `E2E_PORT_OFFSET=210` except E-017.

## Files owned

`demos/showroom/**`, `e2e/demos/showroom.spec.ts`, `demos/README.md` (one row), `CHANGELOG.md` (one line under *Demos*). Nothing under `src/`.

E2E server route: same rule as ws/demo-dungeon (mirror ws/demo-arena's config without committing it, or a spec-local `webServer`, and say which). Running alongside: ws/demo-arena, ws/demo-dungeon, ws/demo-range.
