# Brief: ws/plumbing

Read `docs/briefs/common.md`, then DECISIONS E-007, E-009, E-010 and the STATUS backlog section; `ARCHITECTURE.md` *Scene and Ctx*, *Input*, *Layout*, *Analytics*, *Surface*; `src/core/README.md`, `src/input/README.md`, `src/analytics/README.md`, `templates/puzzle/CLAUDE.md`.

## Goal

The small things three engineers asked for, batched into one step so the template boots with nothing hand-wired.

STATUS row: `createGame` wires gestures and pointers; `layout.freeRect` → design px helper for `Camera.fitRect`; `Gestures.pan` ignores multi-pointer; template `sendBeacon` sink + `level_start`/`level_complete`; layout README rows note; delete `Surface.setFill`/`computeFillWidth`; `Scene.render(frame, camera, alpha)`.

## Scope

1. `createGame` builds `Gestures` (with the existing `magnify` option plumbed through `CreateGameOptions`) and calls `input.setGestures`; `EngineCtx.gestures`. `templates/puzzle` stops building its own.
2. `Camera.fitFreeRect(layout.freeRect, surface)` (or a `ui`-side `freeRectDesign()`; pick one, name it in the report) does the CSS-px → design-px conversion the template did by hand; the template uses it.
3. `Gestures.pan` and `drag` ignore the frame while two or more pointers are down (pinch wins); tests.
4. `Scene.render(frame, camera, alpha)` so scenes stop reading `renderer.camera`; `createGame` passes `ctx.camera` (`EngineCtx.camera`, the renderer's default camera) and calls `renderer.render(frame, camera)`; `SceneStack` forwards. Harness pages and the template follow.
5. Delete `Surface.setFill`, `computeFillWidth`, `FillWidthOptions` and their tests (no engine caller after E-010). `platform/device-mode.ts` stays.
6. `templates/puzzle`: an analytics `sendBeacon` sink (`createBeaconSink(url)` in the template, not the engine), events `level_start` / `level_complete` documented in `src/analytics/README.md` as the convention.
7. `src/ui/README.md`: `top`/`bottom` regions are flex rows, `left`/`right` columns.

## Files owned

`src/core/*`, `src/input/gestures.ts` (+ test), `src/input/README.md`, `src/render/camera.ts` (the helper only; `ws/two-views` may add a `viewIndex` field; nothing else), `src/platform/surface.ts`, `src/platform/letterbox.ts` (fill-width parts), their tests, `src/analytics/README.md`, `src/ui/README.md`, `templates/**`, `harness/game.ts`, `harness/index.ts` (whatever harness pages call `Scene.render`; not `harness/mesh*`, `stream*`, `views*`), `ARCHITECTURE.md` *Scene and Ctx*, *Input* and *Surface* paragraphs, `CHANGELOG.md`.

Alongside: `ws/lights` (`renderer.ts`, `wgsl.ts`, `frame.ts`), `ws/mesh-stream` (`mesh.ts`), `ws/two-views` (`harness/views*`), `ws/doc-sweep` (ARCHITECTURE *Layout*, *Analytics*, *Host*, module READMEs it names). Keep scene-signature changes minimal in files you do not own: list them.
