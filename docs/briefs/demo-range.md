# Brief: ws/demo-range

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md`, then `examples/hello/main.ts`, `harness/look.ts`/`look.html` (first-person `Look`, pointer lock), `harness/pick.ts` (`meshTester`, pointer router hits), `harness/particles-3d` or `fx` 3D particles pages, `harness/trails.ts`, `src/input/README.md` (*Look*, *Rays*, bindings), `src/fx/README.md`, `src/audio/README.md` (spatial voices), `src/ui/README.md` (toasts, anchors; reticle if ws/ui-hud has landed, else a CSS dot).

## Goal

`demos/range`: a first-person target range. Validates look + pick + fx + spatial audio together: a courtyard with 12 targets on posts, mouse/touch/pad look with pointer lock on click, a shot on click/tap/trigger that ray-picks the targets via `meshTester`, a hit knocks the target over (tween the rotation by hand), spawns a spark burst and a tracer trail, plays a positioned synthesised sound, and increments a score shown in a `ui` anchor; targets reset after 3 s. Touch rows: a tap shoots, drag looks.

STATUS row, *done when*: `pnpm demo range` runs; `__demo` exposes `fps`, `score`, `shots`, `targetsUp`, `lastHit` (target index or null), `aimDir`; `e2e/demos/range.spec.ts` aims at a known target by setting look state through a `__demo.aimAt(index)` helper, fires with a click, asserts `lastHit` and `score`, waits past 3 s sim and asserts the target reset, asserts a miss on sky leaves `score` unchanged, touch row: tap fires; no console errors; `demos/range/README.md`; `pnpm check` and `pnpm test:e2e` green at `E2E_PORT_OFFSET=220` except E-017.

## Files owned

`demos/range/**`, `e2e/demos/range.spec.ts`, `demos/README.md` (one row), `CHANGELOG.md` (one line under *Demos*). Nothing under `src/`.

E2E server route: same rule as ws/demo-dungeon. Running alongside: ws/demo-arena, ws/demo-dungeon, ws/demo-showroom.
