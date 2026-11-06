# Brief: ws/template-first-person

Read `docs/briefs/common.md` first, then `docs/VISION.md` (a template game boots from zero in under a day; Forgewilds is the style), DECISIONS E-013, E-014; `ARCHITECTURE.md` *Camera*, *Transforms*, *Lighting*, *Input* (Look), *UI* (Anchors), *Scene and Ctx*; `templates/puzzle/**` (the shape to copy: package, `CLAUDE.md`, `rules/`, scripts); `src/input/README.md` *Look*, `src/render/README.md` (bounds, shadows, texture arrays), `src/ui/README.md` *Anchors*, `src/fx/README.md` (world-space particles), `harness/look.ts`, `harness/stream.ts`, `harness/weather.ts` for working examples.

## Goal

A copyable first-person 3D game that uses wave 4 the way the next game should: `createGame`, a perspective camera driven by `Look`, a chunked world from a Worker with bounds and a texture array, sun shadows and fog, weather particles, world-anchored labels, pad and touch and pointer lock from one `Look`, client mode (no save). An agent can extend it without reading the engine.

STATUS row, *done when*: `templates/first-person`: `createGame({ sim: false })` or fixed-step as fits, `Look`, Worker-built chunk meshes with bounds and a texture array, sun shadow + fog, one weather emitter, anchors over points of interest, a `CLAUDE.md` naming the concepts; `check:template-first-person` in `pnpm check`; timed.

## Scope

- `templates/first-person/` as a private workspace package `@thunderclap/template-first-person` depending on `@thunderclap/engine` via `workspace:*`. `templates/*` is already in the workspace.
- A small but real world: a `world/` folder with a pure, engine-free height-field or box-stack generator and a mesher that runs in a Worker and posts `MeshUpdate`-shaped buffers with bounds and a per-face layer index in vertex colour alpha (the convention `harness/stream-worker.ts` uses). Unit tests on the generator and mesher. No game nouns reach the engine; "chunk", "block", "voxel" are the template's words, fine inside `templates/`.
- Scene: `Look` for yaw/pitch/move with pointer lock requested on click, touch zones on phones, sticks on pad; walking on the height field (a tiny collision in the template, not the engine); sun with `shadow`, fog on; rain or snow through a world-space `ParticleSystem`; three anchored labels on landmarks; a HUD through `ctx.ui.layout` with a crosshair and a "click to look" prompt that hides when locked.
- `CLAUDE.md`: the engine concepts by name (`createGame`, `EngineCtx`, `Camera.perspective`, `Look`, `Mesh.update`/`bounds`, `loadTextureArray`, `Lights.sun.shadow`, `engine_fog`, `ParticleSystem space: 'world'`, `ui.anchors`, `ctx.pointers` hits), the rules of the house, the commands.
- Scripts `dev`, `typecheck`, `test`; root `check:template-first-person` chained into `check` after `check:template-puzzle`; root `template:first-person` dev script.
- Timing: record minutes from empty directory to green and what you would cut.

## Files owned

`templates/first-person/**`, root `package.json` scripts (the two lines), root `README.md` (one row), `CHANGELOG.md` (one line). Nothing under `src/`. What you wish the engine offered goes in report item 5.

Stack on `ws/shadows` (head `2696952`): `git reset --hard ws/shadows` then `git checkout -b ws/template-first-person`; ws/shadows is merging into main as you start, so `git merge main` once early if it has landed. Running alongside: ws/doc-sweep-3 (docs only, `src/*/README.md`, `ARCHITECTURE.md`, root `README.md` tables: coordinate on the README by adding your row at the end of the templates list), ws/xr-post (`src/post`, `src/core/game.ts`).
