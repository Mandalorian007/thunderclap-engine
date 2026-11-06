# Brief: ws/demo-polish

Read `docs/briefs/common.md` first, then `docs/briefs/demos-common.md`, DECISIONS E-021, E-015 (quality bar), E-017/E-023/E-024 (what counts as flake); `demos/README.md`, each demo's README and `main.ts`, `e2e/demos/*.spec.ts`, `docs/STATUS.md` *Backlog* lines that name a demo (the arena trail miss; the wishes are for the engine, not you); `src/ui/README.md` (ui-widgets and ui-hud are on main: `createReticle`, `bar`, widgets), `src/fx/README.md` (billboards, debug draw; water and decals if landed), `src/tween/README.md` if on main, `src/geom/README.md`.

## Goal

The four demos were written in parallel against an engine that has since grown. Make them the quality validation they are meant to be: deterministic specs that never need the E-017 list, visuals at the E-015 bar, and the copied helper code replaced by the engine features that now exist. No new demo; no engine change.

STATUS row, *done when*:

- **arena**: the sword swing sub-steps (or the trail is pushed along the arc every frame) so a stalled frame cannot leave `trailPoints` at 1; `arena.spec` polls for the trail instead of a fixed wait; skinned PBR uses `createStandardMaterial({ skinned })` if ws/ergo-3d has landed, else stays; enemies get name plates and health bars through fx billboards; hit decals on the floor if ws/decals has landed (else skip and say so).
- **dungeon**: torches use `PanelStack` focus walking if ergo-2d landed; the fog-of-war and bat flipbooks stay; add a HUD through ui-hud (`createReticle` is not for this one; use the bar for health).
- **showroom**: the "first sample ready" wait uses `renderer.timing.ready()` if ergo-3d landed; copied cube/sphere helpers replaced by `geom` builders where vertex-identical or the probe tolerances allow; the orbit camera uses look-zoom's `zoom` axis.
- **range**: the reticle is `ui.reticle` / `createReticle` from ui-hud; the hinge uses `tween` if landed; the geom cube helper replaces the local one; muzzle decal on hit if decals landed.
- All four: a `?still` or equivalent that freezes time for probes (where missing), probes read after a `requestAnimationFrame` settle, no `waitForTimeout` without a polled condition; each demo README gains a *What to look at* list (five bullets, the visual features a reviewer should see) and a *Known limits* line.
- `demos/README.md` table refreshed; `e2e/demos/*.spec.ts` pass on all rows of the matrix with the full run on your final head; nothing on the E-017 list involves a demo.
- Timing: list, per demo, what engine feature replaced copied code, and what still had to be hand-written (those are ws/ergo-3d or ergo-2d wishes).

## Files owned

`demos/**`, `e2e/demos/**`, `CHANGELOG.md` (one line under Demos). Nothing under `src/`, `harness/`, `templates/`.

Branch from `main` (4e82662 or later). Check main for which of ws/ergo-3d, ws/ergo-2d, ws/tween, ws/decals, ws/billboards, ws/water, ws/ui-widgets have landed before you start each item (`git log --oneline main | head -40`); skip items whose feature is absent and say so. Nothing else in flight touches `demos/`. Use `E2E_PORT_OFFSET=420`.
