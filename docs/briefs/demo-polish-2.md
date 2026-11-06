# Brief: ws/demo-polish-2

Read `docs/briefs/common.md` and `docs/briefs/demos-common.md` first, then the ws/demo-polish row in `docs/STATUS.md` and the backlog line *ws/demo-polish second pass* (the list this brief executes), `demos/README.md`, the four demos it touches (`demos/arena`, `demos/dungeon`, `demos/range`, `demos/showroom`: `main.ts`, `README.md`) and their specs under `e2e/demos/`, and the engine features that landed since the first polish pass, through their READMEs only: `src/core` (`timing.ready()`), `src/render/standard.ts` (`createStandardMaterial({ skin })`), `src/fx/decals.ts`, `src/fx/billboard.ts`, `src/tween`, `src/ui` (`PanelStack`, `widgets` `bar`), `src/render/renderer.ts` *Hooks* section in the render README (ws/render-hooks: same-frame after-opaque depth for decals and soft particles). Do not read engine source beyond what a README points you at; if a feature is missing or mis-documented, that is a wish, not a change.

## Goal

The four 3D/2D demos use the engine features that replaced their copied helpers, so each demo is the shortest honest example of its genre on the public API, and every removed helper is one fewer thing a game author copies. Specs stay deterministic on every row.

STATUS row, *done when*:

- **arena**: `timing.ready()` replaces the hand-rolled warm-up; the humanoid uses `createStandardMaterial({ skin })` instead of the demo's skinned material copy; a sword hit on a pillar or orb stamps a decal through `src/fx/decals` (same-frame depth via the render hook, no second view); the HUD health bar is the ui-widgets `bar`. The swing stays sub-stepped; `trailPeak` spec unchanged.
- **dungeon**: `PanelStack` arrow walking replaces the demo's keydown handler for the pause menu (pad path through the same stack); the health meter becomes the widgets `bar` if `ui.meter` is the older primitive (keep `meter` if the README says it is the right one and say so); the pad-walk spec stays polled and must pass on every row (E-028).
- **range**: the target hinge is a `tween` (spring or eased), the muzzle flash stamps a decal on the backstop, the score anchor is a billboard name plate if it is not already.
- **showroom**: `timing.ready()` replaces the warm-up; the five looks are applied with `applyPostPatch` if the demo still spreads settings by hand.
- **Lines removed**: report the per-demo line count before and after; a demo that grew needs a sentence why.
- **Specs**: all four specs green on every row in one full matrix at offset 590; no new E-017 entries; `?still` still parks each demo; `pnpm snap:check` 0 px.
- **Docs**: each demo README *What to look at* names the features now used; `demos/README.md` rows updated; CHANGELOG one line per demo under *Demos*.

## Files owned

`demos/arena/**`, `demos/dungeon/**`, `demos/range/**`, `demos/showroom/**`, `e2e/demos/{arena,dungeon,range,showroom}.spec.ts`, `demos/README.md` (those four rows), `CHANGELOG.md` (*Demos*).

Do not edit `src/**`, `harness/**`, `demos/tactics/**`, `demos/voxel/**` (landing), `templates/**`. Branch from `main` (ad9fe38 or later). Running alongside: ws/voxel-render, ws/nav-3, ws/ergo-2d-2, ws/collide, ws/gltf-materials, ws/post-3, ws/input-3, ws/ui-world-panel. Use `E2E_PORT_OFFSET=590`.
