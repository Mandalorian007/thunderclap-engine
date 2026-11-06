# `@thunderclap/engine/nav`

Grid navigation on the XZ plane: a `NavGrid` of walkable cells with costs, A* with string
pulling into a reusable `NavPath`, a flow field that one build serves every agent with, a path
follower and local steering. Pure CPU, no GPU and no import from any other engine module, and no
allocation per query after warm-up: every call writes into an `out` you own.

Navigation is 2D over world `x` and `z`. Height (`y`) is the game's business: sample it from
your terrain (for example `geom`'s `heightAt(x, z)`) when you place the agent.

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

## Harness and tests

`harness/nav.html` (no WebGPU) draws a 40×24 grid with a gapped wall: a click or tap sets the
goal, 32 agents flow to it with separation and the probe path from a fixed start is drawn after
string pulling. `window.__harnessNav` exposes `state` (`goal`, `agents`, `arrived`, `pathLength`,
`pathDistance`, `buildMs`, `gridVersion`, …), `setGoal`, `toggleWall`, `advance(steps)` (fixed
1/60 s steps, so `e2e/nav.spec.ts` measures sim time) and `reset`. Unit tests cover every export,
including no-path, the corner rule and grid edits marking paths stale.
