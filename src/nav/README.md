# `@thunderclap/engine/nav`

Grid navigation on the XZ plane: a `NavGrid` of walkable cells with costs, A* with string
pulling into a reusable `NavPath`, a flow field that one build serves every agent with, a path
follower and local steering. For non-grid worlds, a `NavMesh` baked from triangle geometry
(*Navmesh*, below): polygon A* with a funnel, off-mesh links, a raycast and a height query, with
an ORCA crowd (*Crowd*) and a byte format to ship baked meshes (*Serialisation*). Pure CPU, no GPU
and no import from any other engine module, and no allocation per query after warm-up: every call
writes into an `out` you own.

Grid navigation is 2D over world `x` and `z`. Height (`y`) is the game's business: sample it from
your terrain (for example `geom`'s `heightAt(x, z)`) when you place the agent. A navmesh carries
its own heights: its paths are 3D and `height(x, z)` reads the walkable surface.

## Quick start

```ts
import {
  createFlowField, createNavGrid, createNavPath, findPath, followPath, smoothPath, steer,
} from '@thunderclap/engine/nav';

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
  `origin: NavPoint` (world XZ of the grid's corner; default 0,0), `walkable(x, y)` and
  `cost(x, y)`. Throws on an empty grid or a non-positive cell size.
- `NavGrid` – `width`, `height`, `cellSize`, `origin`, `size`, `costs: Float32Array` (row-major
  cost multiplier, 0 = unwalkable; read it in hot loops) and `version`, which increments on every
  `setWalkable(x, y, w)` or `setCost(x, y, c)` that changes a cell, so a `NavPath` or `FlowField`
  whose `version` differs is stale. `isWalkable`, `costAt`, `inBounds`, `index`,
  `toCell(worldX, worldZ, out)` (clamped into the grid) and `toWorld(cx, cy, out)` (cell centre).
- `Cell { x, y }` is a grid cell; `NavPoint { x, z }` is a world point on the XZ plane.
- `hasLineOfWalkable(grid, x0, y0, x1, y1)` – true when the supercover line between two cells
  crosses only walkable cells and never squeezes between two diagonal walls; string pulling uses
  it, and it serves as a cheap line-of-sight test.

## Paths

- `findPath(grid, from: Cell, to: Cell, out: NavPath, opts?: FindPathOptions): boolean` – A* with
  a binary heap and per-grid scratch arrays (allocated once per grid, in a `WeakMap`), octile
  heuristic, step cost `(1 | √2) × cost(dest)`. Writes cell centres in world XZ into `out`,
  resets `out.cursor`, stamps `out.version = grid.version` and returns false (with an empty path)
  when an endpoint is unwalkable, no route exists or `maxExpand` is exceeded. `FindPathOptions`:
  `diagonal` (default true), `maxExpand`, and `cutCorners: false`, which is the only value: a
  diagonal step needs both orthogonal neighbours walkable.
- `smoothPath(grid, path): NavPath` – string pulling in place: drops every waypoint the previous
  kept one can see (`hasLineOfWalkable`), so a staircase becomes its two ends and a bend around a
  wall stays.
- `NavPath { points: Float32Array; length; cursor; version }` – `points` holds `x, z` pairs
  (`length` of them); `cursor` is the waypoint `followPath` heads for. `createNavPath(capacity?)`
  (default 64 points), `reservePath(path, count)` (grows 1.5×, keeps the data), `clearPath(path)`,
  `pathPoint(path, i, out)` and `pathDistance(path)` (world length).
- `followPath(path, position, speed, arriveRadius, outVelocity): FollowResult` – advances
  `cursor` past every waypoint within `arriveRadius`, writes a velocity of magnitude `speed`
  toward the current one and returns `'moving'`, or `'arrived'` with zero velocity at the last
  point (an empty path is arrived). The game integrates `position += velocity · dt` itself.

## Flow field

- `createFlowField(grid): FlowField` – `build(goals: Cell[])` runs Dijkstra from the goals
  (unwalkable and out-of-grid goals are skipped) over the eight-neighbour graph with the same
  corner rule as A*, filling `distances` (cost-weighted, `Infinity` unreachable) and
  `directions` (unit `x, z` per cell toward the cheapest neighbour; zero at a goal or an
  unreachable cell). `direction(cx, cy, out)`, `directionAt(worldX, worldZ, out)` and
  `distance(cx, cy)` read it; `version` is the grid version it was built at (-1 before the first
  build). One build serves any number of agents; rebuild when the goal or the grid changes.

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
  stride: 12 }`. `NavBakeOptions`: `cellSize`, `cellHeight`, `agentHeight`, `agentRadius`,
  `agentMaxClimb` (a step an agent walks over), `agentMaxSlope` (degrees), and optional
  `minRegionArea` / `mergeRegionArea` (cells; islands smaller than the first are dropped, regions
  smaller than the second are merged into a neighbour; defaults 8 and 20), `maxEdgeLength` (world
  units; default 12 cells), `maxSimplification` (world units the contour may stray; default 1.3
  cells) and `maxVertsPerPoly` (3..6, default 6). Bake offline where you can (see
  *Serialisation*): a 64×64 m floor at `cellSize` 0.3 takes about 100 ms on a desktop.
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

## Serialisation

Bake at build time, ship the bytes: a bake takes tens to hundreds of milliseconds and the result
is a few kilobytes per hundred polygons.

- `exportNavMesh(mesh): ArrayBuffer` – a little-endian, self-describing buffer (magic `NAVM`,
  format 1): the vertices, polygons, adjacency and every off-mesh link (`from`, `to`, `radius`,
  `bidirectional`, `cost`, `id`; `userData` is not written).
- `importNavMesh(buffer: ArrayBuffer | ArrayBufferView): NavMesh` – rebuilds the mesh and its
  links with their ids (`version` starts at 0); throws on a buffer that is not a navmesh or has
  another format number. `exportNavMesh(importNavMesh(bytes))` is byte-equal to `bytes`.

## Harness and tests

`harness/nav.html` (no WebGPU) draws a 40×24 grid with a gapped wall: a click or tap sets the
goal, 32 agents flow to it with separation and the probe path from a fixed start is drawn after
string pulling. `window.__harnessNav` exposes `state` (`goal`, `agents`, `arrived`, `pathLength`,
`pathDistance`, `buildMs`, `gridVersion`, …), `setGoal`, `toggleWall`, `advance(steps)` (fixed
1/60 s steps, so `e2e/nav.spec.ts` measures sim time) and `reset`. Unit tests cover every export,
including no-path, the corner rule and grid edits marking paths stale.

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
