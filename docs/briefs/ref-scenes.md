# Brief: ws/ref-scenes (A4)

Read `common.md`, `wave-2.0-1.md` (you join it; E2E_PORT_OFFSET 190), E-041, `docs/design/2.0/bar.md` **§3 (the reference scenes S1–S6)** and §1 (gates), `docs/BENCH.md` (including "Counted work, 1.3 baseline"), `src/testing/budget.ts` (A2's meter, now on main), `harness/bench*`.

## Goal

The scenes every engine change is measured on. ROADMAP *done when*: "Six pages on the matrix; each has a counted budget."

1. Six harness pages + bench rungs, as bar.md §3 defines them: **S1 2D board** (a guard built from the 2D harness and sprite rungs; The Last Rune's own perf scenes stay in its repo), **S2 characters** (many animated figures; use today's skinning/instancing until C4), **S3 lit arena** (PBR, lights, shadows, post), **S4 voxel world** (today's `voxel` module at its best settings; C2 will move it to the new path and must keep the page), **S5 XR stereo** (two views / fake XR), **S6 idle HUD** (today's `ui`/HUD widgets: 0 DOM writes or reads idle).
2. Each has a counted budget test with the A2 meter (fake GPU), pinned at today's numbers, plus a bench rung measuring CPU/GPU on the real device the way `pnpm bench` already does.
3. Deterministic: fixed seed, fixed camera path, fixed clock; no art beyond procedural.
4. A `docs/BENCH.md` section "Reference scenes" listing each scene's counted budget and today's timings (from one Chromium run; WebKit if A1's project has landed on main when you finish).

## Files owned

New `harness/ref-*.html` + `harness/ref-*.ts`, `harness/bench-state.ts` (adding rungs only), new `src/**/ref-*.budget.test.ts`, `e2e/ref-scenes.spec.ts`, `docs/BENCH.md` (the new section only).

## Gate

common.md, plus the new spec green.
