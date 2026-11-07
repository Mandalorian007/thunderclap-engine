# Brief: ws/demo-arena

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md` (you own the shared infrastructure it names), then `examples/hello/main.ts`, `harness/skin.ts` and `harness/skin.html` (procedural skinned character), `harness/follow.ts` (third-person follow camera, `Look`), `src/anim/README.md` (clips, mixer, sockets), `src/render/README.md` (PBR `standard` material, shadows, lights, fog), `src/fx/README.md` (particles, trails), `vite.harness.config.ts`, `scripts/check-boundaries.mjs`, `playwright.config.ts`, `e2e/mesh.spec.ts` (how specs reach harness state).

## Goal

`demos/arena`: a third-person character runs around a lit arena. Validates the whole 3D character stack together: a skinned procedural humanoid with idle/run clips blended by speed, a sword attached to a hand socket leaving a trail when it swings, a follow camera driven by `Look`, PBR ground and pillars with sun shadows and two coloured point lights, dust particles at the feet, fog, and a toast on tap. WASD/left stick moves, mouse/right stick looks, click/tap swings. Procedural everything.

STATUS row, *done when*: `pnpm demo arena` runs; `__demo` exposes `fps`, `speed`, `swinging`, `drawCalls`, `shadowDraws`, `triangles`; `e2e/demos/arena.spec.ts` drives the character for 2 s of sim with a synthetic key, asserts it moved, a swing starts on click, `drawCalls` within an expected band, and no console errors; infrastructure landed: `pnpm demo <name>` script (`scripts/demo.mjs`: lists demos without an argument), `demos/README.md` table, root `README.md` *Demos* paragraph, `check:boundaries` covering `demos/`, e2e config serving `demos/` on the existing harness server (`vite.harness.config.ts` `publicDir`/`root` change or a second `server` entry in `playwright.config.ts`: smallest change that works), `demos/arena/README.md`; `pnpm check` and `pnpm test:e2e` green at `E2E_PORT_OFFSET=190` except E-017 flakes.

## Files owned

`demos/arena/**`, `demos/README.md`, `e2e/demos/arena.spec.ts`, `scripts/demo.mjs`, root `package.json` (one `demo` script line), root `README.md` (*Demos* paragraph after *Templates*), `scripts/check-boundaries.mjs` (one glob), `vite.harness.config.ts` and/or `playwright.config.ts` (serving `demos/`), `CHANGELOG.md` (*Demos* heading + one line). Nothing under `src/`.

Running alongside: ws/demo-dungeon, ws/demo-showroom, ws/demo-range (each adds a `demos/README.md` row and a CHANGELOG line, nothing else shared), and the engine streams in STATUS. If `@thunderclap-engine/engine/geom`, sky, or anim-graph land on main while you work, you may rebase onto main and use them; not required.
