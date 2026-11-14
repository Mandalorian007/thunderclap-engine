# Brief: ws/core-immediate (B2)

Read `common.md`, `wave-2.0-1.md`, `wave-2.0-2.md`, E-041, `docs/design/2.0/architecture.md` **§3.1–3.4, 3.9**, `src/render/core/README` (or B1's ARCHITECTURE paragraph), `src/render/renderer.ts`, and `src/testing/budget.ts` plus `src/render/baseline.budget.*` (the 1.3 counts you must beat or explain).

## Goal

There is one renderer. Today's immediate API (`frame.sprite`, `mesh`, `meshes`, `InstanceList`, `Drawable`) becomes transient sets on B1's retained core, and the per-mesh path is deleted. ROADMAP *done when*: "`snap:check` 0 px; e2e matrix green; call-trace diff for the 3D harness pages shows GPU calls no longer growing with visible meshes."

1. Immediate draws record into per-frame transient sets on the core's arenas. Draw order, blending and depth semantics stay exactly as today. The 2D path (sprites, tiles) must cost no more than today on the S1 counts.
2. Delete the old per-mesh draw path. Any public type that changes goes under CHANGELOG *Breaking* with a migration note. Source-compatible is the target, because The Last Rune must build unchanged.
3. Create the emissive and other optional targets only when they are used (D1 §3.7, §3.9).
4. `initGpu` requests `indirect-first-instance` and the multi-draw feature when the adapter has them (B1's ask).
5. Update the A2 baseline: rows that drop are wins (`TC_BUDGET=write`). List them in BENCH and your report. Any row that rises must be explained.
6. Run the full 3D and 2D spec set your change touches on Chromium and WebKit, and `snap:check` at 0 px.

## Size

L, and on the critical path. If it runs long, land meshes and InstanceList first, then sprites and Drawable.

## Gate

common.md. `snap:check` 0 px is non-negotiable.
