# Status: thunderclap-engine

The PM keeps this current. Workstreams run on `ws/<name>` branches in their own worktrees and merge to `main` when green (E-001).

## Waves

| Wave | Workstream | Branch | Scope | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | One overlay | ws/one-overlay | Port last-rune's `ws/one-overlay`: `ctx.ui` in CSS px on every form factor; delete `legacyScale`, `createCssChrome`, `avoid()`, `ctx.chrome` (D-044 Phase 3 entry condition) | — | 🔄 |
| 1 | Camera | ws/camera | Matrix `Camera`, `mat4`, camera uniform block, `ortho2d`, `perspective`, `fitRect`, `worldToScreen`/`screenToWorld` | — | 🔄 |
| 1 | Transforms | ws/transforms | `Transform`, 28-float instance (3×4 matrix), `layers` mask + sort `order`, vertex layout per `Mesh`, depth-sorted lists | — | 🔄 |
| 1 | Electron host | ws/host-electron | Bring `@thunderclap/host-electron` from last-rune into `packages/host-electron`; repo becomes a pnpm workspace with the engine at the root | — | ✅ merged `dae37e8` (24 unit tests, Electron smoke 5/5; desktop CI job unverified on runners) |
| 1 | Analytics | ws/analytics | `@thunderclap/engine/analytics`: typed events, pluggable sink, lifecycle flush (E-002) | — | ✅ merged `0eb151e` (356 engine tests) |
| 1 | Foundation | ws/foundation | `scripts/check-boundaries.mjs` + `pnpm check:boundaries`; e2e in CI; stale `packages/`/`check-boundaries` refs; README links VISION | — | ✅ merged (24 relative `../src` imports in harness/e2e/examples rewritten to the public map; `scripts/release.mjs`) |
| 2 | Render call | ws/render-call | `Renderer.render(frame, camera, target)`; `Host.requestFrame`; `GameLoop` takes its frame source from the host | camera, transforms, one-overlay | ⏳ |
| 2 | Demo mesh | ws/demo-mesh | `?demo=mesh` harness page: perspective camera, depth, lit mesh, orbit by pointer and pad; e2e on the matrix | camera, transforms | ⏳ |
| 2 | Input rays | ws/input-rays | Pointer router (mouse, touch, pen, pad cursor → rays), `Hit` events, `{ xr }` binding kinds | camera | ⏳ |
| 2 | Client mode | ws/client-mode | `createGame` with opt-in fixed-step sim and save store, for server-authoritative clients | one-overlay | ⏳ |
| 2 | Puzzle template | ws/template-puzzle | `templates/puzzle`: `createGame`, a scene, `rules/`, save schema, layout spec, `CLAUDE.md` naming the engine concepts | camera, transforms, client-mode | ⏳ |

## Gates

- **Gate A (after wave 1):** `pnpm check` and the e2e matrix green on `main`; 2D harness pages pixel-identical before and after camera + transforms; `ARCHITECTURE.md` *Today* text matches the code.
- **Gate B (after wave 2):** `?demo=mesh` runs on the matrix; a template game boots from zero in under a day of agent time (timed); client mode runs the harness without a save store.
