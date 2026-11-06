# Brief: ws/follow

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/input/README.md` (*Look*), `src/input/look.ts` (the shape to match), `src/render/camera.ts` (`Camera.perspective`, `lookAt` or the view-matrix setters), `harness/look.ts`.

## Goal

A third-person camera that follows a target, orbits from the same inputs `Look` reads, swings in on obstacles, and switches to first person with one call. Characters with cosmetics are viewed from behind (E-015); the next game needs it too.

STATUS row, *done when*: `Follow` controller (target, orbit yaw/pitch, distance, shoulder offset, pitch limits, smoothing, obstacle callback, `mode: 'first' | 'third'`) drives a `Camera` each frame with zero allocations; reads `Look` output; harness `follow.html` on the matrix; documented.

## Scope

- `src/input/follow.ts`: `class Follow { constructor(camera: Camera, opts?: FollowOptions); target: { position: [x,y,z]; yaw?: number }; yaw; pitch; distance; mode; setLook(look: Look | null); update(dt); }` with `FollowOptions { distance?; minDistance?; maxDistance?; shoulder?: [x,y]; pitchMin?; pitchMax?; smoothing?; eyeHeight?; zoomStep?; obstacle?: (from, to, outHit) => boolean }`. The obstacle callback belongs to the game (the engine has no world); when it reports a hit the camera moves to the hit point minus a margin. Scroll/pad right stick vertical zooms when `Look` offers a zoom input; if `Look` does not, add nothing to `Look` (report it). `mode: 'first'` places the camera at target + eyeHeight using the same yaw/pitch, so a game toggles views with one assignment.
- Orientation math in `camera.ts` is off-limits (ws/xr appends there): compute the view matrix in `follow.ts` and hand it to the camera through whatever `Camera` already exposes (`lookAt`, `setViewMatrix` if present on main, else position + target setters).
- Harness `follow.html` + `follow.ts` + `follow-state.ts`: a capsule on a ground grid with a few walls, moves on WASD/stick through `Look.move`, camera follows; key `V` toggles mode; state exposes `mode`, camera position, distance, `instances + culled`. `e2e/follow.spec.ts`: boots, mode toggles, distance shrinks when a wall sits behind the target.
- Tests: `follow.test.ts` on a fake `Look`: smoothing converges, pitch clamps, obstacle shortens, first-person placement.
- Docs: input README *Follow* section, ARCHITECTURE *Input* one sentence, CHANGELOG entry.

## Files owned

`src/input/follow.ts`, `src/input/follow.test.ts`, `src/input/index.ts` (append), `src/input/README.md`, `harness/follow.*`, root `README.md` (harness list item), `e2e/follow.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Running alongside: ws/xr appends to `src/input/index.ts` and `camera.ts`; ws/skinning, ws/pbr, ws/anim, ws/gltf, ws/template-first-person. Branch from `main`.
