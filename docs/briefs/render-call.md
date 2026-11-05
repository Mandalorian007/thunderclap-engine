# Brief: ws/render-call

Read `docs/briefs/common.md` first, then DECISIONS E-003, E-006, E-007, E-008, E-009; `ARCHITECTURE.md` sections *Frame loop*, *Renderer*, *Host*, *Input*; `src/render/README.md`, `src/host/README.md`, `src/core/README.md`, `src/input/README.md`.

## Goal

The renderer stops owning the frame. A game (or a demo page) calls `renderer.render(frame, camera, target)` once per camera per frame; the host hands out frames; the fill-band code that padded the 2D viewport is deleted in favour of `layout.freeRect` + `Camera.fitRect`.

STATUS row, *done when*: `Renderer.render(frame, camera, target)`; `Host.requestFrame`; `GameLoop` takes its frame source from the host; deletes `device`/`setFill`/fill bands for `layout.freeRect` + `Camera.fitRect` (E-006); widens `ortho2d` depth range, drawable `depthStencil`, `ctx.pointers` wiring (E-009).

## Scope

1. **Render call.** `Renderer.render(frame: Frame, camera: Camera, target?: RenderTarget)` runs the draw lists recorded in `frame` for one camera into a target (default: the surface). `beginFrame`/`endFrame` stay as the single-camera convenience that `createGame` uses; they call `render` internally. Two cameras in one frame (split screen, or UI over world) must work and must not allocate in steady state.
2. **Host.requestFrame.** `Host` exposes `requestFrame(cb)`; `GameLoop` takes its frame source from the host instead of calling `requestAnimationFrame` itself. The browser host wraps rAF; the fake host used by tests steps manually. XR later supplies a session-driven frame source through the same seam; do not write any WebXR.
3. **Delete D-044 leftovers.** `renderer.device` mode, `setFill`, the fill bands, and everything that only served them. Layout exposes `freeRect` (CSS px rect clear of chrome); a 2D game frames it with `Camera.fitRect`. The harness pages keep their output: same pixels, now produced by `fitRect`.
4. **Depth follow-ups (E-009).** Widen `Camera.ortho2d` so world z in roughly ±1024 design units survives the near/far planes; x/y output unchanged. Drawables (`ParticleSystem` and the `Drawable` interface) get a `depthStencil` state when the frame has a depth attachment (`frame.depthFormat`); the particle pipeline is keyed on it like materials are.
5. **Pointer wiring (E-009).** In `createGame`: `const pointers = createPointerRouter({ camera: () => renderer.camera }); input.setPointers(pointers);` and `EngineCtx.pointers: PointerRouter<unknown>`. `ws/input-rays` landed `createPointerRouter`, `Input.setPointers` and the types in `src/input/`; read its `README.md`.

## Files owned

`src/render/renderer.ts`, `src/render/frame.ts`, `src/render/camera.ts` (ortho range only), `src/render/index.ts`, `src/render/README.md`, `src/fx/particles.ts`, `src/fx/particles-wgsl.ts`, `src/host/*`, `src/core/game.ts`, `src/core/loop.ts`, `src/core/index.ts`, `src/ui/layout*` (adding `freeRect` only), their tests, `harness/*` pages that call `setFill`/`device`, `ARCHITECTURE.md` (*Frame loop*, *Renderer*, *Host*, *Ctx*), `CHANGELOG.md`.

Running alongside: `ws/demo-mesh` (owns `harness/mesh.html`, `harness/mesh.ts`, `e2e/mesh.spec.ts`, `examples/`), `ws/template-puzzle` (owns `templates/`). Neither touches `src/`. If `demo-mesh` needs something from you, it will say so in its report; do not pre-build for it.

## Must stay

Every 2D harness page pixel-identical (E-008 tolerance). Zero steady-state allocations in `render`. `pnpm check` and `pnpm test:e2e` green on your final head.
