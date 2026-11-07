# Brief: ws/nav

Read `docs/briefs/common.md` first, then `docs/VISION.md`; DECISIONS E-015 (third-person characters: things that walk); `src/input/rays.ts` (house style for zero-allocation geometry code, scratch vectors); `docs/briefs/geom.md` (`Heightfield`, `heightAt`; ws/geom is landing on chain 4 and you may read its branch for types, but do not depend on it: nav takes plain callbacks); `scripts/check-boundaries.mjs`; `package.json` `exports`.

## Goal

Things move through a world without a game writing A* again. `@thunderclap-engine/engine/nav` gives a grid navigation field (walkable cells with cost), A* and a flow-field over it, string-pulled paths, a path follower that yields a desired velocity per tick, and simple local steering (separation from neighbours, arrive, avoid a disc). Pure CPU, no allocation per query after warm-up, no game nouns: cells, agents, goals.

STATUS row, *done when*: `createNavGrid({width, height, cellSize, origin?, walkable?: (x, y) => boolean, cost?: (x, y) => number})` → `NavGrid {width, height, cellSize, origin, setWalkable(x, y, w), setCost(x, y, c), isWalkable, toCell(worldX, worldZ, out), toWorld(cx, cy, out), version}`; `findPath(grid, from, to, out: NavPath, opts?: {diagonal?: boolean, cutCorners?: false, maxExpand?: number}): boolean` (A*, binary heap, reused open/closed arrays sized to the grid, octile heuristic); `smoothPath(grid, path)` (string pulling by line-of-walkable-cells); `createFlowField(grid)` + `field.build(goals: ArrayLike<cell>)` + `field.direction(cx, cy, out)` (Dijkstra from the goals, one build serves every agent); `NavPath {points: Float32Array, length, cursor}`; `followPath(path, position, speed, arriveRadius, outVelocity): 'moving' | 'arrived'`; `steer.separate(self, neighbours, radius, out)`, `steer.arrive(self, target, speed, slowRadius, out)`, `steer.avoidDisc(self, velocity, disc, out)`; `grid.version` increments on every edit so a cached path can tell it is stale; harness `nav.html` (click sets the goal, 32 agents flow to it around toggled walls; state exposes `goal`, `agents`, `pathLength`, `buildMs`); unit tests for every function incl. no-path, corner cutting off, grid edits invalidating; documented.

## Scope

- `src/nav/`: `grid.ts`, `astar.ts`, `flow.ts`, `path.ts`, `steer.ts`, `index.ts`, `README.md`, tests. Imports nothing from other engine modules; `platform` types allowed if needed. 2D over the XZ plane with `y` left to the game (heightfield lookups are the game's or geom's job; README shows `heightAt` from geom as the example).
- `package.json`: `"./nav": "./src/nav/index.ts"` (alphabetical after `./input`). `scripts/check-boundaries.mjs` if it lists modules.
- Harness `nav.html` + `nav.ts` + `nav-state.ts`, `e2e/nav.spec.ts`: path found around a wall; toggling a wall reroutes (poll state); flow field agents all arrive within N seconds of sim time (use the harness's fixed step, not wall clock).
- Docs: `ARCHITECTURE.md` new one-paragraph *Navigation* section after *Animation*; root `README.md` module row + harness list item; `CHANGELOG.md` one line.

## Files owned

`src/nav/**`, `harness/nav.*`, `e2e/nav.spec.ts`, `package.json` (one export line), `scripts/check-boundaries.mjs` (if needed), `ARCHITECTURE.md` (new section), root `README.md` (one row, one item), `CHANGELOG.md`.

Branch from `main` (5467912 or later). Running alongside: ws/i18n (adds `./i18n` export and its own ARCHITECTURE section after *UI*), ws/geom (`./geom` export; landing), ws/scaffold (`package.json` scripts), ws/retarget, ws/morph, ws/post-depth. Use `E2E_PORT_OFFSET=160`.
