# Brief: ws/anchors

Read `docs/briefs/common.md` first, then `docs/VISION.md` (pillar 5: world-anchored labels, in-world panels), DECISIONS E-013; `ARCHITECTURE.md` *UI*, *Layout*, *Camera*; `src/ui/README.md`; `src/ui/overlay.ts`, `src/ui/layout.ts`, `src/render/camera.ts` (`worldToScreen`, `screen`), `src/platform/surface.ts` (`logicalToClient`).

## Goal

A DOM element follows a world position: a name over a character, a damage number, a hint on a tile, an in-world panel on a wall. The game gives a world point and an element; the engine keeps it placed every frame in CSS px, hidden when behind the camera or outside the viewport.

STATUS row, *done when*: `overlay.anchors` places DOM nodes at world points through a camera each frame with clamping, occlusion-by-frustum and optional distance scale; harness `anchors.html` on the matrix.

## Scope

1. **`ui/anchor.ts`.** `class Anchors { constructor(opts: { root: HTMLElement; surface: SurfaceLike; camera: () => Camera }); add(el, world: [x,y,z], opts?: AnchorOptions): AnchorHandle; update(); }`. `AnchorOptions`: `offset` (CSS px), `clamp` (keep on screen with an edge margin, for off-screen markers; default false), `scale` (`'none' | 'distance'`, with `min`/`max`), `hideBehind` (default true: when the point is behind the camera or outside clip, `hidden` attribute), `layer` (which overlay layer). `AnchorHandle`: `set(world)`, `el`, `visible`, `remove()`. Positions are written as `transform: translate3d(x, y, 0)` on the element so layout does not reflow; `update()` allocates nothing (reuse one `Float32Array(4)` for the projection).
2. **Math.** world → clip through `camera.viewProjection`; clip → `camera.screen` units → CSS px through the surface (`logicalToClient` or the equivalent on the overlay's frame). Handle the two-view case: anchors take the camera given; a stereo UI is not this step.
3. **Overlay.** `createOverlay` exposes `overlay.anchors(camera)` (lazily built, one per overlay) so `ctx.ui.anchors` is reachable; the game calls `ui.anchors.update()` in `afterRender` or the engine does it when it exists (pick the engine doing it in `createGame`'s `afterRender` if that is a one-line hook; otherwise document the call). Nothing in `core/game.ts` beyond that one line.
4. **Harness.** `harness/anchors.html` + `anchors.ts`: the mesh-page cube field with a label over each cube and one clamped off-screen marker; state exposes each label's rect. `e2e/anchors.spec.ts`: a label sits within a few px of its cube's projected position (compute it from the state's camera matrices), a label behind the camera is hidden, the clamped marker stays inside the viewport when its cube leaves it.

## Files owned

`src/ui/anchor.ts` (new), `src/ui/anchor.test.ts`, `src/ui/overlay.ts` (the `anchors` accessor), `src/ui/index.ts` (append), `src/ui/README.md` (an *Anchors* section), `src/core/game.ts` (one `afterRender` line, if you take that option; name the line in your report), `harness/anchors.html`, `harness/anchors.ts`, `harness/anchors-state.ts`, harness page list (one line), `e2e/anchors.spec.ts`, `ARCHITECTURE.md` *UI* (one sentence), `CHANGELOG.md`.

Running alongside: ws/xr edits `core/game.ts` (an `xr` option) and ws/look does not touch it; keep your line at the `afterRender` call site and name it. No one else is in `src/ui/`.
