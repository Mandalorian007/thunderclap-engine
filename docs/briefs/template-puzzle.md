# Brief: ws/template-puzzle

Read `docs/briefs/common.md` first, then `docs/VISION.md` (a template game should boot from zero in under a day of agent time; Gate B), DECISIONS E-001, E-007, E-009; `ARCHITECTURE.md` *Ctx*, *Scene*, *Save*, *UI*, *Input*; `src/core/README.md`, `src/save/README.md`, `src/ui/README.md`, `src/input/README.md`; `examples/` for how a game is wired today.

## Goal

A copyable starting point for a 2D puzzle game that uses the engine the way the next game should: `createGame`, one scene, pure rules, a versioned save schema, a layout spec, and a `CLAUDE.md` that teaches an agent the engine's nouns so it can extend the template without reading the engine.

STATUS row, *done when*: `templates/puzzle`: `createGame`, a scene, `rules/`, save schema, layout spec, `CLAUDE.md` naming the engine concepts.

## Scope

- `templates/puzzle/` as a pnpm workspace package (`@thunderclap-engine/template-puzzle`, private) depending on `@thunderclap-engine/engine` via `workspace:*`; add it to `pnpm-workspace.yaml` if `packages/*` does not already cover `templates/*` (if you must change `pnpm-workspace.yaml`, that is your one edit outside `templates/`).
- A small but real puzzle (a sliding-tile or match-the-pairs board is enough): `rules/` is pure TypeScript with unit tests, no engine imports; the scene renders state with `frame.sprite` and `Transform`, reads `ctx.pointers` if it exists on `main` when you start (it lands with `ws/render-call`), else `ctx.input` with a tap gesture; the save store uses the engine's schema/versioning with one migration as an example; layout spec places a HUD on every form factor through `ctx.ui`.
- `CLAUDE.md` in the template: the engine concepts by name (`createGame`, `EngineCtx`, `Frame`, `Transform`, `Camera`, `DrawParams.layers/order`, `Input` bindings, `ctx.ui.layout`, save schema), the rules of the house (rendering not mechanics, rules pure, no network), and the commands.
- Scripts: `dev`, `typecheck`, `test`. Root `pnpm check` must include the template's typecheck and tests (add a `check:template-puzzle` script and chain it, mirroring `check:host-electron`).
- Timing for Gate B: record in your report how long the template took you from empty directory to green, and what you would cut.

## Files owned

`templates/**`, `pnpm-workspace.yaml` (one line), root `package.json` scripts (`check:template-puzzle` and its place in `check`), root `README.md` (one row/line pointing at the template), `CHANGELOG.md` (one line). Nothing under `src/`.

Running alongside: `ws/render-call` (owns `src/`, harness 2D pages, `core/game.ts`), `ws/demo-mesh` (owns `harness/mesh*`, `e2e/mesh.spec.ts`, `examples/`). What you wish the engine offered goes in report item 5, not in `src/`.
