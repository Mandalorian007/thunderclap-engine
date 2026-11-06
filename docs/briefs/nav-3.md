# Brief: ws/nav-3

Read `docs/briefs/common.md` first, then `docs/VISION.md` pillar 3 (mechanics stay in the game; the engine ships the maths), the ws/nav and ws/nav-2 rows in `docs/STATUS.md` and the ws/demo-tactics wishes in its backlog (nav edge costs, 4-neighbour flow fields, budget-bounded reachability: this brief closes those three and what a tactics or roguelike game needs next to them); `src/nav/README.md` end to end; `src/nav/grid.ts` (`NavGrid`, `createNavGrid`, cell cost model, `hasLineOfWalkable`), `astar.ts` (`findPath`, `smoothPath`, heuristics), `flow.ts` (`createFlowField`, `direction()`: 8-neighbour today), `path.ts`, `heap.ts` (`CellHeap`: reuse it), `crowd.ts`, `steer.ts`; `src/nav/mesh/**` (the navmesh side: read, do not change); `demos/tactics/rules.ts` (the demo's own Dijkstra and climb cost: the shape your `reachable` replaces; do not edit the demo), `harness/nav*.ts`, `e2e/nav.spec.ts`.

## Goal

The nav grid grows the queries a turn-based or tile game asks that only a flow field or A* answered before: an edge-cost hook, 4-neighbour movement, bounded reachability with parents, incremental cost edits that do not rebuild the grid, and a cached multi-goal field. Zero allocation per query after warm-up; results in reusable buffers like `NavPath`.

STATUS row, *done when*:

- **Edge costs**: `NavGridOptions.edgeCost?: (fromIndex, toIndex, grid) => number` (added to the destination cell cost; `Infinity` blocks the edge: one-way ledges, climb penalties). Honoured by `findPath`, `createFlowField` and the new `reachable`; absent means today's behaviour and today's numbers (the existing nav tests stay byte-identical). Tests: a climb term makes the path go around; `Infinity` one way only.
- **Neighbourhood**: `NavGridOptions.neighbours?: 4 | 8` (default 8, today's). `findPath`, `smoothPath` (no diagonal cuts in 4 mode), `createFlowField`, `direction()` and `reachable` respect it; `hasLineOfWalkable` is unchanged. Tests on a corridor where 4 and 8 give different lengths.
- **Reachability**: `reachable(grid, start, budget, out?) → Reach` where `Reach` holds `count`, typed arrays `cells`, `distances`, `parents` sized to the grid (allocated once in `createReach(grid)` and reused), `has(index)`, `pathTo(index, path: NavPath)` walking parents into a `NavPath`, and `forEach(fn)`. Dijkstra with the shared heap, honouring edge costs and the neighbourhood; multiple starts allowed (`start: number | number[]`). Tests: budget boundary inclusive, parents reconstruct the same path `findPath` returns for the same costs, zero allocation on the second call (assert with a counting allocator stub or a `Reach` identity check).
- **Incremental costs**: `grid.setCost(index, cost)` and `grid.setWalkable(index, bool)` already exist or get added (read what is there), plus `grid.version` bumping on every edit; `FlowField.stale` becomes true when the grid version moved since the field was computed, and `field.update()` recomputes in place (no reallocation). Tests.
- **Multi-goal field**: `createFlowField(grid, { goals: number[] })` (and `field.setGoals(goals)`) seeds from every goal at once so "move toward the nearest player" is one field instead of N; the tactics demo's raiders would use it. Test: the nearest goal wins per cell.
- **Path options**: `findPath(grid, from, to, path, { maxCost?, heuristicWeight? })`: a cost cap that returns `false` without exploring the whole grid, and a weighted heuristic for speed; tests on both.
- **Harness** `harness/nav.html` gains `?reach` (a 32×32 grid with ramps, a budget slider, 4/8 toggle, reach painted, hovered cell's path drawn) and `?multi` (three goal cells, field arrows); state exposes `reachCount`, `neighbours`, `fieldStale`, `goals`, `queryMs`. `e2e/nav.spec.ts` adds: `?reach` count changes with the budget and with the 4/8 toggle; `?multi` arrows point to the nearest goal at two probe cells; existing nav tests green; `pnpm snap:check` 0 px.
- **Docs**: nav README sections *Edge costs*, *Neighbourhood*, *Reachability*, *Incremental edits*, *Multi-goal fields*; CHANGELOG block; ARCHITECTURE Nav clause (one sentence); root README count line.

## Files owned

`src/nav/{grid,astar,flow,path,heap,index}.ts` + tests, new `src/nav/reach.ts` + test, `src/nav/README.md`, `harness/nav*`, `e2e/nav.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (count line).

Do not edit `src/nav/mesh/**`, `src/nav/crowd.ts`, `src/nav/steer.ts`, `demos/**`, `src/render/**`, `src/ui/**`. Branch from `main` (c36a06a or later). Running alongside: ws/ergo-2d-2 (`src/geom/iso.ts`, `src/render/tile-layer.ts`), ws/collide (`src/geom/collide`), ws/demo-voxel, ws/post-3, ws/input-3, ws/ui-world-panel, ws/gltf-materials, ws/host-pwa. Use `E2E_PORT_OFFSET=560`.
