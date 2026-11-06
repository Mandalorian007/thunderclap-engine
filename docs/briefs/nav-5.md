# Brief: ws/nav-5

Read `docs/briefs/common.md` first. Then read:
- The rows in `docs/STATUS.md` for ws/nav-2, ws/nav-3 and ws/nav-4.
- The ws/nav-4 notes line (budget-bounded `reachable`).
- The ws/nav-2 wish (a build-time navmesh bake script).
- `src/nav/README.md` end to end, then `src/nav/**`, with `serialize.ts` in particular for navmesh format 2.
- `scripts/` for how existing bake scripts (`pnpm bake`) are shaped.
- `demos/arpg/` (read only), which bakes its navmesh at boot.

## Goal

Two changes:
- A game can ask "where can this unit get to with N metres of movement" cheaply every frame.
- A game can ship a baked navmesh instead of building it at boot.

STATUS row, *done when*:

- **Budget-bounded reachability.**
  - `reachable(mesh, from, { budget, areaCosts?, maxPolys? }, out?)` returns the polys within path cost `budget` with their cost-to-reach. It is a Dijkstra over the poly graph, stops at the budget, and reuses its heap and buffers so steady state allocates nothing.
  - `reachableOutline(result)` returns the boundary loops, for drawing a movement range.
  - Tests:
    - It agrees with `findMeshPath` cost for every returned poly within 1e-3.
    - The budget is respected.
    - Area costs apply.
    - 10k-poly meshes finish in under 2 ms in the bench, recorded in the README.
- **Bake script.**
  - `pnpm bake:nav <input> <output>` (`scripts/bake-nav.mjs`) reads a geometry file (the engine's baked mesh format, or a glTF via `parseGltf`, whichever the scripts already load), bakes with the given `NavMeshOptions` JSON, and writes format 2.
  - `loadNavMesh(bytes)` is round-trip tested against an in-memory bake.
  - The script is offline and touches no network.
- **Harness.**
  - Add a `?range` variant to a new `harness/nav5.html`, `nav5.ts` and `nav5-state.ts`.
  - The variant is a unit on a tactics-like mesh with its range outline drawn. State: `polys`, `outlineLoops`, `ms`.
  - Add `e2e/nav5.spec.ts`.
  - Existing nav specs stay green.
- **Docs.**
  - Update the nav README.
  - Add a scripts README line.
  - Add a CHANGELOG block.
  - Add the page to the root README harness list.

## Files owned

You own:
- `src/nav/**` and its tests
- new `scripts/bake-nav.mjs` and a `package.json` script entry (one line)
- new `harness/nav5*`
- `e2e/nav5.spec.ts`
- `CHANGELOG.md`
- the root `README.md` harness list

Do not edit `demos/**` or `templates/**` (ws/adopt-sweep may adopt `reachable` in tactics later), or other `scripts/*`.

Branch from `main` (e23be4d or later). Use `E2E_PORT_OFFSET=820`. Gate per E-031.
