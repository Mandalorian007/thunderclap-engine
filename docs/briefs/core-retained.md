# Brief: ws/core-retained (B1)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P1–P3, P9 and **§3.1–3.4, 3.6, 3.7** (read carefully: this is the design you build), `docs/design/2.0/evidence/C-spike.md` (why), ARCHITECTURE render sections, `src/render/README.md`, `src/render/renderer.ts`, `src/render/fake-gpu.ts`. Forge's render model to generalize (read only): `FW:render/renderer/` (draw.ts, sections.ts), `FW:render/arena.ts`, `FW:render/visibility.ts` (its GPU cull), `FW:render/view.ts`.

## Goal

The bottom layer of the one renderer: retained, GPU-driven, ready for many views. STATUS *done when*: "A 6,000-set scene draws in a flat number of GPU calls (same at 1,500 and 6,000), 0 allocations a frame, on the fake GPU and in WebKit."

Build, as new code beside today's path (B2 later moves the immediate API onto it; don't change today's draw path's behaviour):

1. **Arenas.** Shared vertex and index arenas with free-range allocation (no per-mesh buffers), custom vertex layouts including packed integer formats (an 8-byte packed vertex must be expressible), a shared quad index buffer.
2. **DrawSets.** A pipeline + instance layout + instance source + cull mode. Static sets encode into render bundles; dynamic sets upload only dirty ranges; large sets cull on the GPU (compute: frustum per view, writes `drawIndexedIndirect` args), with a CPU path for small sets.
3. **Indirect.** Bundles of `drawIndexedIndirect` are the baseline (WebKit has no multi-draw); use multi-draw-indirect only when the device has the feature.
4. **Pass list and targets from use.** Named passes in a declared order; attachments and targets created only when something records into them.
5. **Views.** The API takes a list of views from the start (one view for now is fine; B3 does stereo), so the cull writes per-view args without a redesign.
6. **fake-gpu.ts** gains what you need (indirect draws, bundles, compute passes, dispatch, buffer copies) with counts.
7. A harness page `harness/core.html` (+ bench rung): thousands of procedural mesh sets (not voxels: e.g. a field of rocks or a city block of boxes) with a moving camera; a unit test proving flat GPU calls at 1,500 vs 6,000 sets and 0 allocations per frame.

Public API: put it under `@thunderclap-engine/engine/render` (e.g. `createDrawSet`, `createArena`, `PassList`); keep names style-neutral. Mark it *Today (preview)* in ARCHITECTURE until B2 lands.

## Files owned

New `src/render/core/**`, `src/render/renderer.ts` (only additive hooks to run the pass list), `src/render/fake-gpu.ts`, `src/render/index.ts`, `harness/core*`, its e2e spec.

## Size

This is the critical path; aim for a coherent first part in ~3 hours (arenas, sets, indirect, CPU+GPU cull, one view) and list what remains.

## Gate

common.md; the new spec on Chromium and WebKit (`--project` names from playwright.config.ts) green.
