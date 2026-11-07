# `@thunderclap-engine/engine/nav`

Navigation on the CPU: grids with A*, flow fields, reachability and steering, and navmeshes baked from triangles with off-mesh links, an ORCA crowd and a byte format. It answers where an agent can go and how; what agents are, and how they move along a path, are the game's. No GPU, no imports from other engine modules, and no allocation per query after warm-up.

## Quick use

<!-- snippet:check -->
```ts
import { createNavGrid, createNavPath, findPath, followPath, smoothPath } from '@thunderclap-engine/engine/nav';

const grid = createNavGrid({ width: 64, height: 64, cellSize: 1, walkable: (x, y) => !(x === 10 && y < 40) });
const path = createNavPath();
if (findPath(grid, { x: 2, y: 3 }, { x: 40, y: 50 }, path)) smoothPath(grid, path);

const agent = { x: 2.5, z: 3.5 };
const vel = { x: 0, z: 0 };
function step(dt: number) {
  if (followPath(path, agent, 4, 0.3, vel) === 'moving') {
    agent.x += vel.x * dt;
    agent.z += vel.z * dt;
  }
}
step(1 / 60);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createNavGrid(opts)` | walkable cells with costs on the XZ plane |
| `findPath / smoothPath` | A* into a `NavPath`, then string pulling |
| `followPath(path, agent, speed, radius, out)` | steer one agent along a path |
| `createFlowField(grid)` | one build, a direction for every agent |
| `reachable(...)` | the cells or polygons in a move budget |
| `steer` | local separation and avoidance |
| `NavMesh / findMeshPath` | a baked navmesh and polygon A* with a funnel |
| `createCrowd(...)` | ORCA agents on a navmesh |

## Contents

- [Overview](#overview)
- [Quick start](#quick-start)
- [Grid](#grid)
- [Edge costs](#edge-costs)
- [Neighbourhood](#neighbourhood)
- [Paths](#paths)
- [Flow field](#flow-field)
- [Incremental edits](#incremental-edits)
- [Multi-goal fields](#multi-goal-fields)
- [Reachability](#reachability)
- [Steering](#steering)
- [Navmesh](#navmesh)
- [Off-mesh links](#off-mesh-links)
- [Crowd](#crowd)
- [Area types](#area-types)
- [Dynamic obstacles](#dynamic-obstacles)
- [Path queue](#path-queue)
- [Corridors and crowd on the mesh](#corridors-and-crowd-on-the-mesh)
- [Mesh flow field](#mesh-flow-field)
- [Serialisation](#serialisation)
- [Harness and tests](#harness-and-tests)

## Overview

Grid navigation on the XZ plane: a `NavGrid` of walkable cells with costs, A* with string
pulling into a reusable `NavPath`, a flow field that one build serves every agent with, a path
follower and local steering. For non-grid worlds, a `NavMesh` baked from triangle geometry
(*Navmesh*, below): polygon A* with a funnel, off-mesh links, a raycast and a height query, with
an ORCA crowd (*Crowd*), a move-range query with its outline (*Reachability on a mesh*) and a
byte format to ship baked meshes (*Serialisation*). Pure CPU, no GPU
and no import from any other engine module, and no allocation per query after warm-up: every call
writes into an `out` you own.

Grid navigation is 2D over world `x` and `z`. Height (`y`) is the game's business: sample it from
your terrain (for example `geom`'s `heightAt(x, z)`) when you place the agent. A navmesh carries
its own heights: its paths are 3D and `height(x, z)` reads the walkable surface.

## Quick start

```ts
import {
  createFlowField, createNavGrid, createNavPath, findPath, followPath, smoothPath, steer,
} from '@thunderclap-engine/engine/nav';

const grid = createNavGrid({
  width: 64, height: 64, cellSize: 1,
  walkable: (x, y) => !isWall(x, y),           // optional; default all walkable
  cost: (x, y) => (isMud(x, y) ? 3 : 1),       // optional multiplier; default 1
});

// One agent: A*, then string pulling, then follow it each step.
const path = createNavPath();
if (findPath(grid, { x: 2, y: 3 }, { x: 40, y: 50 }, path)) smoothPath(grid, path);
const vel = { x: 0, z: 0 };
function step(dt: number) {
  if (path.version !== grid.version) replan();   // a wall changed since the path was made
  if (followPath(path, agent, 4, 0.3, vel) === 'moving') {
    agent.x += vel.x * dt;
    agent.z += vel.z * dt;
    agent.y = heightAt(agent.x, agent.z);        // the game's own height sampler
  }
}

// A crowd: build one field for the goal, every agent reads its direction.
const field = createFlowField(grid);
field.build([{ x: 40, y: 50 }]);
const dir = { x: 0, z: 0 };
for (const a of agents) {
  field.directionAt(a.x, a.z, dir);
  steer.separate(a, agents, 0.8, vel);
  a.x += (dir.x * 4 + vel.x * 4) * dt;
  a.z += (dir.z * 4 + vel.z * 4) * dt;
}
```

## Grid

- `createNavGrid(opts: NavGridOptions): NavGrid` – `width`, `height`, `cellSize`, optional
  `origin: NavPoint` (world XZ of the grid's corner; default 0,0), `walkable(x, y)`, `cost(x, y)`,
  `edgeCost` (below) and `neighbours: 4 | 8` (below). Throws on an empty grid, a non-positive
  cell size or another neighbour count.
- `NavGrid` – `width`, `height`, `cellSize`, `origin`, `size`, `costs: Float32Array` (row-major
  cost multiplier, 0 = unwalkable; read it in hot loops), `edgeCost`, `neighbours` and `version`,
  which increments on every `setWalkable(x, y, w)` or `setCost(x, y, c)` that changes a cell, so
  a `NavPath`, `FlowField` or `Reach` whose `version` differs is stale. `isWalkable`, `costAt`,
  `inBounds`, `index`, `toCell(worldX, worldZ, out)` (clamped into the grid) and
  `toWorld(cx, cy, out)` (cell centre).
- `NavCell { x, y }` is a grid cell; `NavPoint { x, z }` is a world point on the XZ plane.
- `hasLineOfWalkable(grid, x0, y0, x1, y1)` – true when the supercover line between two cells
  crosses only walkable cells and never squeezes between two diagonal walls; string pulling uses
  it, and it serves as a cheap line-of-sight test.

## Edge costs

`createNavGrid({ edgeCost })` takes an `EdgeCost` hook, `(fromIndex, toIndex, grid) => number`,
called per step with the row-major indices of the two cells. Its value is added to the step's
`(1 | √2) × cost(dest)`; `Infinity` (or `NaN`) blocks that step in that direction only, a value
of zero or below adds nothing. A climb penalty is `elevation(to) - elevation(from)` when positive;
a one-way ledge returns `Infinity` for the upward pair. `findPath`, `createFlowField` (whose
goal-outward search asks the hook in the direction of travel, so the ledge is never pointed up)
and `reachable` all honour it; without a hook every number is what it was. The hook reads state
of its own, so after that state changes call `grid.touch()` to bump `version` and mark paths,
fields and reaches stale.

## Neighbourhood

`createNavGrid({ neighbours: 4 })` makes a grid whose steps are orthogonal only (the default is
8). `findPath` (its `diagonal` option defaults to the grid's neighbourhood and still overrides
it), `smoothPath` (on a 4-neighbour grid string pulling keeps every bend, so the path stays a
chain of orthogonal runs), `createFlowField` (`direction` is one of four), and `reachable` follow
it; `hasLineOfWalkable` is unchanged. The neighbourhood is fixed at creation: keep one grid per
mode when a page toggles between them.

## Paths

- `findPath(grid, from: NavCell, to: NavCell, out: NavPath, opts?: FindPathOptions): boolean` – A* with
  a binary heap and per-grid scratch arrays (allocated once per grid, in a `WeakMap`), octile
  heuristic (Manhattan on a 4-neighbour grid), step cost `(1 | √2) × cost(dest)` plus the edge
  cost. Writes cell centres in world XZ into `out`, resets `out.cursor`, stamps
  `out.version = grid.version` and returns false (with an empty path) when an endpoint is
  unwalkable, no route exists, `maxExpand` is exceeded or the cheapest route costs more than
  `maxCost`. `FindPathOptions`: `diagonal` (default: the grid's neighbourhood), `maxExpand`,
  `maxCost` (the search never expands past it, so a bounded query stays cheap),
  `heuristicWeight` (default 1; above 1 trades optimality for fewer expansions, 0 is Dijkstra),
  and `cutCorners: false`, which is the only value: a diagonal step needs both orthogonal
  neighbours walkable.
- `smoothPath(grid, path, opts?: LineOfWalkableOptions): NavPath` – string pulling in place:
  drops every waypoint the previous kept one can see (`hasLineOfWalkable(grid, ax, az, bx, bz,
  opts?)`), so a staircase becomes its two ends and a bend around a wall stays. Both honour the
  grid's `edgeCost` hook per cell pair the line crosses (ws/nav-4): a pair the hook blocks breaks
  the line, so a one-way ledge is never cut across; `LineOfWalkableOptions.edgeCost` swaps the
  hook or, as `null`, opts out (walkability only).
- `NavPath { points: Float32Array; length; cursor; version }` – `points` holds `x, z` pairs
  (`length` of them); `cursor` is the waypoint `followPath` heads for. `createNavPath(capacity?)`
  (default 64 points), `reservePath(path, count)` (grows 1.5×, keeps the data), `clearPath(path)`,
  `pathPoint(path, i, out)` and `pathDistance(path)` (world length).
- `followPath(path, position, speed, arriveRadius, outVelocity): FollowResult` – advances
  `cursor` past every waypoint within `arriveRadius`, writes a velocity of magnitude `speed`
  toward the current one and returns `'moving'`, or `'arrived'` with zero velocity at the last
  point (an empty path is arrived). The game integrates `position += velocity · dt` itself.

## Flow field

- `createFlowField(grid, opts?: FlowFieldOptions): FlowField` – `build(goals: NavCell[])` runs
  Dijkstra from the goals (unwalkable and out-of-grid goals are skipped) over the grid's
  neighbour graph with the same corner rule as A*, filling `distances` (cost-weighted, `Infinity`
  unreachable) and `directions` (unit `x, z` per cell toward the cheapest neighbour; zero at a
  goal or an unreachable cell). `direction(cx, cy, out)`, `directionAt(worldX, worldZ, out)` and
  `distance(cx, cy)` read it; `version` is the grid version it was built at (-1 before the first
  build). One build serves any number of agents.
- `FlowField.stepCosts` (ws/nav-4) – per cell, what `findPath` charges for the step `directions`
  points along (`(1 | √2) × cost(dest)` plus the edge cost; 0 at a goal, `Infinity` off the
  field); summed along a walk it equals `distances`. `direction` and `directionAt` fill a
  `FlowDirection` (`{ x, z, cost }`) when given one, so an agent can budget its move.

## Incremental edits

`grid.setCost(index, cost)` and `grid.setWalkable(index, walkable)` edit one cell by its
row-major index (the `x, y` forms stay), bounds-checked, and bump `version` on a real change;
`grid.touch()` bumps it alone. `field.stale` is true while the field's `version` lags the grid's,
and `field.update()` recomputes it in place from the goals it keeps, allocating nothing: a game
that edits a few cells a frame marks the field and rebuilds it once, in its own step. `Reach`
has the same `stale` flag.

## Multi-goal fields

`createFlowField(grid, { goals })` seeds the search from several goal cells at once (row-major
indices, `ArrayLike<number>`), as does `field.setGoals(goals)` afterwards, so every cell runs to
its nearest goal; `field.goals` (`Int32Array`, the first `goalCount` entries) are the goals it
keeps, out-of-grid and unwalkable ones skipped at each `update()`. `build(cells)` is the same
with `NavCell`s.

## Reachability

- `reachable(grid, start: number | number[], budget, out?: Reach): Reach` – bounded Dijkstra
  from one or more start cells (row-major indices; unwalkable or out-of-grid starts are skipped)
  over the grid's neighbourhood, cell costs and edge costs, stopping at `budget` inclusive (a
  cell at exactly the budget is in). It reuses one `Reach` per grid (a `WeakMap`) or the `out`
  given (`createReach(grid)` makes one; another grid's is refused), and allocates nothing after
  the first call. It is what a move-range query is: the cells a unit can step to this turn, with
  the route to each.
- `Reach` – `count` and `cells: Int32Array` (the reached indices in order of distance, the start
  first), `distances: Float32Array` and `parents: Int32Array` over the whole grid (`Infinity` /
  -1 off the reach; a start's parent is -1), `budget`, `version` (the grid version queried at, -1
  before the first) and `stale`. `has(index)`, `pathTo(index, path: NavPath): boolean` (walks the
  parents into world cell centres, start first, the same route `findPath` would give for the same
  costs; false with an empty path off the reach), and `forEach((index, distance) => void)`
  nearest first.

## Steering

All three write a velocity into `out` and return it. `steer` is `{ separate, arrive, avoidDisc }`.

- `separate(self, neighbours: NavPoint[], radius, out)` – the sum over neighbours closer than
  `radius` of the unit vector away from each, weighted `(radius - d) / radius`; a neighbour on the
  same spot (or `self` in its own list) adds nothing. Scale it by a speed and add it.
- `arrive(self, target, speed, slowRadius, out)` – full `speed` toward `target`, slowing
  linearly inside `slowRadius` and zero on it.
- `avoidDisc(self, velocity, disc: Disc, out)` – `velocity` unchanged when the `Disc { x, z,
  radius }` is behind, beside or out of reach; otherwise a sideways push away from the disc's
  centre, scaled by how deep the course cuts it. `out` may be `velocity`.

## Navmesh

A `NavMesh` is baked from triangles the way Recast does it: the geometry is voxelised into a
heightfield at `cellSize` × `cellHeight`, spans too steep, too low or too far from a floor are
dropped, the walkable area is eroded by the agent radius, cut into regions, traced into contours
and simplified, then triangulated and merged into convex polygons of up to `maxVertsPerPoly`
vertices. Vertices snap to cells, so a surface reads up to one `cellHeight` above the geometry
and boundaries are within `agentRadius + cellSize` of the true edge. Everything is `x, y, z` in
world units; polygons are counter-clockwise seen from above.

- `bakeNavMesh(input: NavBakeSource | NavBakeSource[], opts: NavBakeOptions): NavMesh` –
  `NavBakeSource { positions, indices, stride?, offset? }` reads world-space positions from any
  interleaved vertex buffer (`stride` floats per vertex, default 3; `offset` into each vertex,
  default 0), so a `geom` `Geometry` goes in as `{ positions: g.vertices, indices: g.indices,
  stride: 12 }`. `NavBakeOptions` needs only `cellSize`; every other option has a default
  derived from it (see *Baking* below), and a bad value throws a `NavBakeError`. Bake offline
  where you can (see *Serialisation*): a 64×64 m floor at `cellSize` 0.3 takes about 100 ms on a
  desktop.
- `NavMesh` – `verts: Float32Array` (`vertCount` × `x, y, z`), `polys: Int32Array`
  (`polyCount` × `maxVertsPerPoly` vertex indices, `-1` padded), `adjacency: Int32Array` (per
  polygon edge `k`, from vertex `k` to `k + 1`, the polygon across it or `-1`), `bounds:
  NavBounds { min, max }`, `cellSize`, `cellHeight`, and `version`, which increments when a link is
  added or removed, so a `NavPath3` whose `version` differs is stale. `polyVertexCount(p)`,
  `polyVertex(p, k, out)`, `polyCenter(p, out)`, `polyArea(p)`, `containsXZ(p, x, z)` and
  `polyHeight(p, x, z)` read one polygon.
- `findNearestPoly(x, y, z, out: NavPoint3, radius = Infinity): number` – the polygon whose
  closest point is nearest, within `radius` (3D), or -1; `out` gets that closest point.
  `closestPointOnPoly(p, x, y, z, out)` returns the squared distance for one polygon;
  `findPolyAt(x, y, z)` is the polygon containing `x, z` whose surface is nearest `y`, or -1.
- `height(x, z, poly?): number` – the surface height under `x, z` (the polygon's plane), `NaN`
  off the mesh.
- `findRandomPoint(out, rng = Math.random): number` – a point uniformly over the walkable area
  (polygons weighted by area); returns its polygon.
- `raycast(from, to, out, startPoly?): boolean` – walks the polygons along the segment; true
  when it meets a boundary edge (`out` is the hit point), false when `to` is reachable in a
  straight line (`out` is `to`). A `from` off the mesh hits at once.
- `NavPoint3 { x, y, z }` is a world point; `NavBounds { min: NavPoint3; max: NavPoint3 }`.

### Baking

`bakeNavMesh` never returns an empty mesh silently (ws/nav-6). Every option but `cellSize` has a
default derived from it, so `bakeNavMesh(src, { cellSize: 0.3 })` bakes a 2 m agent; every value
is checked before the bake starts.

| Option | Default | Valid |
| --- | --- | --- |
| `cellSize` | none (required) | finite, > 0 |
| `cellHeight` | `cellSize / 2` | finite, > 0 |
| `agentHeight` | 2 | finite, > 0 |
| `agentRadius` | `cellSize * 2` | finite, >= 0 |
| `agentMaxClimb` | `cellHeight * 2` | finite, >= 0 |
| `agentMaxSlope` | 45 (degrees) | 0..90 |
| `minRegionArea` | 8 (cells) | finite, >= 0 |
| `mergeRegionArea` | 20 (cells) | finite, >= 0 |
| `maxEdgeLength` | `cellSize * 12` (0 never splits) | finite, >= 0 |
| `maxSimplification` | `cellSize * 1.3` | finite, >= 0 |
| `maxVertsPerPoly` | 6 | integer 3..6 |

`minRegionArea` and `mergeRegionArea` are in cells: islands smaller than the first are dropped,
regions smaller than the second merge into a neighbour. `maxEdgeLength` and `maxSimplification`
are world units (the longest boundary edge, and how far a contour may stray). The heights and
radius quantise to cells (`ceil(agentHeight / cellHeight)`, `floor(agentMaxClimb / cellHeight)`,
`ceil(agentRadius / cellSize)`), so at `cellSize` 0.3 the defaults bake the arpg demo's
courtyard (`cellHeight` 0.1, a 1.8 m agent of radius 0.4, climb 0.3) and the `pnpm bake`
fixture (`cellHeight` 0.2, climb 0.4) to the same polygons: the same vertex indices and `x, z`,
with heights within half a cell of each other (`scripts/bake-nav.test.mjs`).

- `NavBakeOptions` – the bake settings above; only `cellSize` is required.
- `resolveNavBakeOptions(opts: NavBakeOptions): ResolvedNavBakeOptions` – fills the defaults and
  validates; `bakeNavMesh` and `pnpm bake:nav` call it. `ResolvedNavBakeOptions` is
  `Required<NavBakeOptions>`. `NAV_BAKE_DEFAULTS` holds the fixed defaults (`agentHeight`,
  `agentMaxSlope`, `minRegionArea`, `mergeRegionArea`, `maxVertsPerPoly`).
- `NavBakeError` – thrown for a missing `cellSize` or a value that is not a finite number in
  range (a string from JSON, `null`, NaN, a negative radius, a slope over 90, `maxVertsPerPoly`
  8). `option` names the option and `value` holds what was given; the message reads
  `bakeNavMesh: agentHeight must be a finite number > 0, got NaN`.
- An input with triangles that bakes to 0 polygons (all too steep, too low or eroded away)
  returns the empty mesh with one `console.warn` (`[nav] bakeNavMesh: 0 polygons from N
  triangles (…options…); nothing is walkable`). An input with no triangles returns the empty mesh
  quietly.

### Paths on a mesh

- `findMeshPath(mesh, from: NavPoint3, to: NavPoint3, out: NavPath3, opts?: FindMeshPathOptions):
  boolean` – snaps both ends to the mesh (`snapRadius`, default any distance), runs A* over the
  polygons (binary heap and per-mesh scratch in a `WeakMap`, portal midpoints as node positions,
  straight-line heuristic, off-mesh links as extra edges with their cost), then pulls the string
  taut through the portals (the funnel algorithm) in each stretch between links. Writes world
  `x, y, z` waypoints into `out`, resets `out.cursor`, stamps `out.version = mesh.version` and
  returns false (with an empty path) when an end is off the mesh, no route exists or `maxExpand`
  polygons were expanded. `stringPull: false` keeps the portal midpoints (for debugging).
- `NavPath3 { points: Float32Array; length; cursor; version; links: NavPathLink[]; linkCount }` –
  `points` holds `x, y, z` triples (`length` of them). `links` lists the off-mesh links taken, in
  order: `NavPathLink { index, id }` says the link starts at waypoint `index` and lands at
  `index + 1`, so a follower can play a jump between them. `createNavPath3(capacity?)` (default
  64 points), `reservePath3(path, count)` (grows 1.5×, keeps the data), `clearPath3(path)`,
  `pathPoint3(path, i, out)` and `pathDistance3(path)` (3D world length).
- `followPath3(path, position, speed, arriveRadius, outVelocity): FollowResult` – like
  `followPath`: advances `cursor` past every waypoint within `arriveRadius` (measured in XZ),
  writes a 3D velocity of magnitude `speed` toward the current one and returns `'moving'`, or
  `'arrived'` with zero velocity at the last point. The game integrates the position itself; to
  stick to the surface, set `y = mesh.height(x, z)` after the step.
- `NavPath3.cost` (ws/nav-5) – the search's priced cost of the route found: the legs between
  portal midpoints (the goal point last) times their polygon's `areaCost`, plus each link's cost;
  0 when both ends share a polygon or no route exists. It is the same quantity a mesh `reachable`
  measures, so a path and a range agree.
- `heuristicWeight` (ws/nav-5, `FindMeshPathOptions`) scales the straight-line heuristic; default
  1. A node's position is the portal it was entered through, so the default A* can settle a
  polygon through a costlier portal and its `cost` may exceed the cheapest; 0 turns the search
  into a Dijkstra whose `cost` is exactly the one `reachable(mesh, …)` gives the goal's polygon.

### Reachability on a mesh

The move-range query for a non-grid world (ws/nav-5): which polygons a unit at `from` reaches
within a movement budget, and the outline to draw around them.

- `reachable(mesh, from: NavPoint3, opts: MeshReachOptions, out?: MeshReach): MeshReach` – the
  mesh overload of `reachable`. It snaps `from` to its polygon (`snapRadius`, default any
  distance) and runs a Dijkstra over the polygons with the `findMeshPath` cost model (portal
  midpoints as node positions, each leg priced by its polygon's `areaCost`, off-mesh links with
  their cost), stopping at `opts.budget` inclusive. A polygon is in reach when its centre is: its
  cost is the cheapest route to the centre, the start polygon's is 0. It reuses one `MeshReach`
  per mesh (a `WeakMap`) or the `out` given (`createMeshReach(mesh)` makes one; another mesh's is
  refused) and allocates nothing after the first call. An empty mesh, a negative or NaN budget or
  a `from` off the mesh gives an empty reach.
- `MeshReachOptions { budget; areaCost?; areaMask?; maxPolys?; snapRadius? }` – `areaCost` and
  `areaMask` as for `findMeshPath` (*Area types*; `OBSTACLE_AREA` is never entered); `maxPolys`
  stops after that many polygons joined (the nearest, since they join in cost order).
- `MeshReach` – `count`, `polys: Int32Array` (the reached polygons in cost order, the start
  first), `costs: Float32Array` and `parents: Int32Array` over the whole mesh (`Infinity` / -1 off
  the reach), `startPoly`, `start` (the snapped point), `budget`, `version` (the mesh version
  queried at) and `stale`. `has(poly)`, `pathTo(poly, path: NavPath3): boolean` (the parents'
  corridor, string pulled to the polygon's centre, `path.cost` the reach cost; false with an empty
  path off the reach) and `forEach((poly, cost) => void)` cheapest first.
- `reachableOutline(reach, out?: ReachOutline): ReachOutline` – the boundary of the reach as
  closed loops of polygon edges: every edge of a reached polygon whose neighbour is a wall or
  unreached, chained at shared vertices. Outer loops run counter-clockwise seen from above, holes
  (a block inside the range) clockwise. One outline per reach is reused (a `WeakMap`) unless `out`
  is given (`createReachOutline(capacity?)`); its buffers grow on demand.
- `ReachOutline { points: Float32Array; pointCount; loopStart: Int32Array; loopCount }` – loop `k`
  is points `loopStart[k]` to `loopStart[k + 1] - 1`, world `x, y, z` triples.

On a 100×100 quad mesh (10 000 polygons), the whole-mesh reach takes 1.3 ms best and 3.4 ms
median on an M-series laptop under load (`mesh-reach-bench.test.ts`, which asserts the best of
101 runs under 4 ms, about 3× the unloaded time, so a loaded machine passes and a real regression
fails; ws/nav-6 measured best 1.1–2.6 ms and median up to 9.9 ms at load 25–29); a budget of 12 (401 polygons) takes 0.06 ms and its outline 0.004 ms.

## Off-mesh links

A link is a jump, ladder, teleport or door between two points of the mesh that no polygon joins.
The search takes it when `cost` beats the walk; the path then holds both ends as consecutive
waypoints and names the link in `path.links`.

- `addOffMeshLink(mesh, opts: OffMeshLinkOptions): number` – `from`, `to` (`NavPoint3`),
  `radius` (how far from an end an agent may stand to take it; each end snaps to the nearest
  polygon within it, and an end that finds none never connects), `bidirectional` (default false:
  `from` → `to` only), `cost` (world units; default the straight distance) and `userData` (yours,
  not serialised). Returns the link's id (never 0) and bumps `mesh.version`.
- `removeOffMeshLink(mesh, id): boolean` – true when a link was removed (bumps `version`).
- `getOffMeshLink(mesh, id): OffMeshLink | undefined` – `OffMeshLink { id, from, to, radius,
  bidirectional, cost, userData, fromPoly, toPoly }`; `mesh.links` lists them (removed slots are
  `null`).

## Crowd

`createCrowd(opts: CrowdOptions): Crowd` runs ORCA (RVO2) local avoidance over the XZ plane: each
step every agent picks, from the velocities that keep it clear of its neighbours over
`timeHorizon`, the one closest to its preferred velocity, through the three linear programs of
the reference implementation. Neighbours come from a uniform grid rebuilt per step, so a step
is linear in the agent count. Nothing is allocated per `update` after the first.

- `CrowdOptions { maxAgents, maxNeighbors? (10), timeHorizon? (2 s), neighborDist? (4) }` –
  `neighborDist` is how far an agent looks for others; make it at least the largest
  `maxSpeed × timeHorizon` you use.
- `Crowd.add(agent: CrowdAgentOptions): number` – `{ x, z, radius, maxSpeed, prefVelocity? }`;
  returns the agent's index, or -1 when the crowd is full (slots freed by `remove(index)` are
  reused). `setPrefVelocity(index, x, z)`, `setPosition(index, x, z)`.
- `Crowd.update(dt)` – computes every active agent's velocity, then moves it by `velocity × dt`.
  `agents: readonly CrowdAgent[]` (`maxAgents` of them; `active`, `x`, `z`, `vx`, `vz`,
  `radius`, `maxSpeed`, `prefX`, `prefZ`) is the state to read and draw.
- The crowd knows nothing about the mesh: feed each agent `followPath3`'s velocity as its
  preferred velocity, then after `update` clamp the position to the mesh (`findNearestPoly`) or
  read `height` for its `y`. Agents converging on one point should slow as they near it
  (`steer.arrive`); agents pushing into a jam at full speed may touch.

## Area types

Every polygon carries one byte, `mesh.area` (0 by default), that a query multiplies its step
cost by or filters on. Price mud, exclude water, keep a door open for one faction: the mesh is
baked once and the costs live with the query.

- `NavBakeAreaOptions { areas?: AreaStamp[] }` – `bakeNavMesh` takes stamps beside its
  `NavBakeOptions`; `AreaStamp { shape: AreaShape; area }` with `AreaShape` an `AreaBox`
  (`minX, minZ, maxX, maxZ`, an optional `minY`/`maxY` band) or an `AreaPolygon` (convex
  `points` as `x, z` pairs, the same band). `areaShapeContains(shape, x, y, z)` is the test.
- `markArea(mesh, shape, area): number` – stamps the polygons whose centre the shape holds at
  edit time (allocation-free, through `polysInBox`), bumps `mesh.version` when any changed and
  returns the count. The stamp is per polygon, so its edge is the polygon's edge: bake with the
  stamps for a sharp boundary, or mark a mesh baked with that boundary in mind.
- `AreaQueryOptions { areaCost?: Float32Array; areaMask?: Uint8Array }` – on `findMeshPath`
  (`FindMeshPathOptions` extends it), `createFlowField3` and a queued request. `areaCost` is 256
  multipliers (`createAreaCosts(fill = 1)`); a leg is priced by the area of the polygon it
  crosses (the current one, Recast's convention). `areaMask` is 256 bytes
  (`createAreaMask(allow = 1)`); 0 excludes an area, as does an `Infinity` cost.
  `areaAllowed(area, cost?, mask?)` is the rule, and `OBSTACLE_AREA` (255) is never allowed:
  a goal in it fails, a start in it is walked out of.
- `MeshSearch` – the resumable A* behind `findMeshPath` (`begin(from, to, opts?)`,
  `step(maxPops)`, `finish(out)`; `state: MeshSearchState` of `'idle' | 'running' | 'found' |
  'failed'`, `startPoly`, `endPoly`, `version`), one per mesh for the synchronous call and one
  per `PathQueue`. `NavPath3.polys` / `polyCount` (ws/nav-4) hold the polygon corridor a search
  crossed (`reservePolys3(path, count)` grows it); `pullString(mesh, polys, offset, count, from,
  to, out)` funnels any polygon list.

## Dynamic obstacles

`createObstacleSet(target: NavMesh | NavGrid, opts: ObstacleSetOptions): ObstacleSet` keeps
discs and boxes that move at runtime and stamps them onto the mesh or the grid in one `apply()`.

- `ObstacleSetOptions { maxObstacles, layer? }` – fixed capacity. `add(shape: ObstacleShape)`
  returns an id (or -1 when full), `move(id, x, z, yaw?)`, `remove(id)`, `get(id)` (an
  `Obstacle` with `active`, `kind`, `x`, `z`, `radius`, `w`, `d`, `yaw`); `ObstacleDisc { x, z,
  radius }`, `ObstacleBox { x, z, w, d, yaw }`. `obstacles`, `count`, `version`.
- `apply(): number` – stamps only what moved since the last apply and returns the polygons or
  cells it flipped. On a mesh every polygon the footprint overlaps (`polysInBox`, then a disc or
  SAT test) becomes `OBSTACLE_AREA`; a polygon under two obstacles stays blocked until both
  leave; the area it had is restored. The footprint is per polygon, so a small obstacle on a
  large polygon blocks the whole polygon; bake with a tile or a stamp where that matters.
  `mesh.version` moves only when a polygon changed. On a grid the set writes a cost `layer`
  (`grid.size` floats, `Infinity` under an obstacle) and calls `grid.touch()`; give the grid an
  `edgeCost` hook that reads `layer[to]`, or pass your own `layer`.
- Every corridor over a polygon the set stamps becomes invalid and replans
  (*Corridors and crowd on the mesh*); a `FlowField3` turns `stale`.

## Path queue

`createPathQueue(target: NavMesh | NavGrid, opts: PathQueueOptions): PathQueue` spreads searches
over frames: a request is a ticket, `update()` spends a fixed budget of A* pops and writes a
path only when it is finished, so sixty agents asking at once cost the same per frame as one.

- `PathQueueOptions { maxQueries, iterationsPerUpdate? (256) }` – fixed capacity, a fixed
  budget. `request(from, to, out, opts?: PathRequestOptions)` (points on a mesh, cells on a
  grid; `FindMeshPathOptions` and `FindPathOptions` apply, plus `smooth` for a grid) returns a
  ticket, or -1 when the queue is full. `status(ticket): PathStatus` is `'pending'`, `'done'`,
  `'failed'` or `'none'`; `cancel(ticket)` drops it and never writes `out`. `pending`,
  `finished`, `onDone(ticket, ok, out)` fire as tickets complete.
- `update(): number` – first in, first out with resumption: the search in flight continues, the
  budget left over flows to the next ticket, and a ticket whose target changed version under it
  (an obstacle applied, a cell toggled) restarts. Returns the pops spent. One search's scratch
  is shared by every ticket; nothing is allocated after creation.

## Corridors and crowd on the mesh

- `createCorridor(mesh, maxWaypoints = 64): Corridor` – the polygon list a path crossed, kept
  beside a moving agent. `set(path)` takes a `NavPath3` (its `polys` and last point as
  `target`); `advance(x, z, out)` drops the polygons the agent has left (looking a few ahead)
  and string-pulls the rest, writing the next corner to steer to: one funnel per frame, never a
  new search. `current()`, `polys`, `offset`, `count`, `path` (the pulled string), `version`.
  `valid(mesh)` is false once the mesh version moved or a remaining polygon after the agent's
  own is an obstacle: time to replan.
- `Crowd.attach(mesh, opts?: CrowdAttachOptions)` – every agent gets a corridor;
  `setTarget(index, x, y, z)` plans (through `opts.queue` when given, so the agent waits for its
  ticket, else synchronously), each `update` steers along the corridor (`steer.arrive` on the
  last leg inside `slowRadius`, default 1) and clamps the agent onto the mesh, reading `y` and
  `poly`. `arriveRadius` (default the agent's radius) sets `targetReached`; `maxWaypoints`
  sizes the corridors. A corridor that becomes invalid replans from where the agent stands;
  `replans` counts them. `obstacles(set)` adds the set's discs and boxes as static ORCA lines
  so agents also skirt the obstacle itself, not only its polygons.

## Mesh flow field

`createFlowField3(mesh, goals: NavPoint3[], opts?: FlowField3Options): FlowField3` runs one
Dijkstra from the goal polygons over the mesh (centre to portal midpoint to centre, priced by
area through `AreaQueryOptions`; `snapRadius` bounds the goal snap) so any number of agents read
a direction in O(1) with no search of their own.

- `direction3(x, y, z, out): number` – the unit direction toward the exit portal of the polygon
  under the point (toward the nearest goal inside a goal polygon; zero at a goal, off the mesh
  or where no goal is reachable), returning the polygon or -1. A point on a portal answers for
  the polygon downstream, so a walker standing on one is never sent back.
  `distanceAt(x, y, z)` is the cost-weighted distance along the field; `distances`, `next` and
  `portal` are the per-polygon tables, `reached` the polygons a goal reached.
- `stale` is true once `mesh.version` moved; `update(force?)` rebuilds in place (allocation-free)
  and returns whether it did. A walker's direction is a straight line inside a convex polygon,
  so a field follower needs no corridor; it is the cheap choice for a horde.

## Serialisation

Bake at build time, ship the bytes: a bake takes tens to hundreds of milliseconds and the result
is a few kilobytes per hundred polygons. `pnpm bake <config>` (`scripts/bake.mjs`, see the root
README's *Baking*) does it from the command line: a `bake.config.json` names the glTF or geometry
JSON sources and the `NavBakeOptions` per entry, and the script writes `<name>.navm` next to a
manifest that `--check` verifies in CI. `pnpm bake:nav <input> <output> [--options file.json]`
(`scripts/bake-nav.mjs`, ws/nav-5) is the single-file form: one glTF or geometry JSON in, read
the same way, baked with the `NavBakeOptions` in the options file (`cellSize` defaults to 0.3
there, every other field it leaves out takes the *Baking* default above, and a bad value exits 1
naming it), and one format-2 file out; no network, no manifest.

- `exportNavMesh(mesh): ArrayBuffer` – a little-endian, self-describing buffer (magic `NAVM`,
  format 2): the vertices, polygons, adjacency, the area byte per polygon (padded to four) and
  every off-mesh link (`from`, `to`, `radius`, `bidirectional`, `cost`, `id`; `userData` is not
  written).
- `importNavMesh(buffer: ArrayBuffer | ArrayBufferView): NavMesh` – rebuilds the mesh and its
  links with their ids (`version` starts at 0); throws on a buffer that is not a navmesh or has
  another format number. Format 1 (before ws/nav-4, no areas) still imports with every area 0.
  `exportNavMesh(importNavMesh(bytes))` is byte-equal to `bytes`.
- `loadNavMesh(bytes: ArrayBuffer | ArrayBufferView): NavMesh` (ws/nav-5) – the runtime loader
  for a shipped bake: `importNavMesh` plus validation, so a truncated or corrupt file throws a
  `loadNavMesh: …` error naming what is wrong (the byte length against the header, vertices per
  polygon outside 3..6, a non-finite vertex, a polygon under three vertices or naming a vertex out
  of range, a neighbour out of range) instead of yielding a mesh that fails later. A game fetches
  the `.navm` and passes the bytes.

## Harness and tests

`harness/nav.html` (no WebGPU) draws a 40×24 grid with a gapped wall: a click or tap sets the
goal, 32 agents flow to it with separation and the probe path from a fixed start is drawn after
string pulling. `window.__harnessNav` exposes `state` (`goal`, `agents`, `arrived`, `pathLength`,
`pathDistance`, `buildMs`, `gridVersion`, …), `setGoal`, `toggleWall`, `advance(steps)` (fixed
1/60 s steps, so `e2e/nav.spec.ts` measures sim time) and `reset`. `?reach` is a 32×32 grid with
a stepped plateau (climbs cost through `edgeCost`, its north edge a one-way cliff) and a wall:
the cells `reachable` from a start within the budget slider are painted, a button toggles 4 and
8 neighbours, and the hovered cell's path comes from the reach's parents (`state.reachCount`,
`neighbours`, `budget`, `hoverPathLength`, `queryMs`; `setBudget`, `setNeighbours`, `hover`).
`?multi` is the 40×24 grid with three goals in one flow field, every arrow drawn; a click toggles
a wall and leaves the field stale until the next step updates it in place (`state.goals`,
`fieldStale`; `fieldAt`). The spec checks the reach grows with the budget and shrinks on four
neighbours, and that the arrows from probe cells on either side of the wall run to their nearest
goal. Unit tests cover every export, including no-path, the corner rule, grid edits marking
paths stale, a one-way ledge, bounded and weighted searches and a reach matching A*.

`harness/navmesh.html` bakes a level of `geom` boxes and a ramp (a floor, four pillars, a raised
platform reached by the ramp) on the page, draws the polygons, a path and its follower with
`createDebugDraw`, and joins the platform's edge to the floor with an off-mesh "jump down" link
whose cost decides whether the path climbs the ramp or jumps. A click sets the goal; `?crowd=24`
adds a crowd converging on the pointer. `window.__harnessNavmesh` exposes `state` (`polyCount`,
`bakeMs`, `pathLength`, `pathPoints`, `linkUsed`, `crowdOverlaps`, …), `setGoal`, `setStart`,
`setLinkCost`, `probeNearest`, `probeHeight` and `setCrowdTarget`; `e2e/navmesh.spec.ts` checks
the bake leaves the pillars out, the path climbs the ramp or takes a cheaper link, and the crowd
never overlaps. Unit tests cover the hole a wall leaves, the slope filter, radius erosion, the
funnel beating portal midpoints, a link taken when cheaper, the raycast stopping at an edge, two
crowd agents passing head-on, a byte-equal round trip, 64 agents stepping without allocation and
the 64×64 m bake under 500 ms.

`harness/nav4.html` (ws/nav-4, no WebGPU) bakes a 20×20 floor with two pillars on the page and
draws it top-down on a canvas. `?crowd` (the default): 48 agents attached to the mesh walk the
floor on corridors; `&carve` drops a disc obstacle between the pillars at 2 s of sim time, which
invalidates every corridor through the gap and replans it around a pillar (`state.onMesh`,
`reached`, `replans`, `carved`, `meshVersion`). `?queue`: a 64×64 grid with scattered walls
takes 200 requests a second through a `PathQueue` (`requested`, `dropped`, `pending`,
`doneTotal`, `failedTotal`, `maxUpdateMs`). `?areas`: the floor between the pillars is baked as
mud and the probe path priced at 3× detours around a pillar while the plain one runs straight
(`lengthMud`, `lengthPlain`, `mudPolys`). `?flow3`: 48 walkers on a mesh flow field toward one
goal (`arrived`, `fieldReached`). `?still` parks the loop; `window.__harnessNav4.advance(steps)`
runs fixed 1/60 s steps, so `e2e/nav4.spec.ts` measures sim time and polls every moving value.
Unit tests cover areas priced and excluded on a bake and a stamp, the format-2 round trip and a
format-1 import, obstacles blocking and reopening a doorway (version only on change, footprints
bounded, a grid layer), 200 queued requests matching `findPath`, budget, cancel and restart, a
corridor advancing and invalidating, 48 corridor agents crossing a pillar floor, a queued
replan after an obstacle, and a mesh field monotone to its goal, within 10 % of `findMeshPath`,
walked by 48 starters through every portal, and rebuilt after an obstacle.

`harness/nav5.html` (ws/nav-5, no WebGPU) builds a 24×16 tactics board, one unit tile per
polygon with four blocks left out and two columns of mud priced at 3×, and draws it top-down on a
canvas. `?range` (the default): every fixed step recomputes a unit's movement range with
`reachable(mesh, …)` and `reachableOutline` into reused objects, fills the polygons in range and
strokes the outline loops; the unit patrols four tiles until parked. `window.__harnessNav5`
exposes `state` (`polys`, `outlineLoops`, `outlinePoints`, `ms`, `maxMs`, `polyCount`, `budget`,
`unit`, `queries`), `setBudget`, `moveUnit` and `advance(steps)`; `?still` parks the loop.
`e2e/nav5.spec.ts` checks the range covers part of the board with a hole around a block inside
it, grows with the budget to the whole board, and recomputes every frame. Unit tests cover reach
costs equal to a Dijkstra `findMeshPath` (and never above the default A*) on a baked level, mud
priced and masked, a link, `maxPolys`, reuse without allocation, `pathTo`, outlines with a hole,
the `loadNavMesh` round trip against an in-memory bake and its errors, and the 10k-polygon bench.
