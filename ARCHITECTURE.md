# ThunderClap engine: architecture and contracts

`@thunderclap/engine` is the WebGPU engine The Last Rune is built on. It knows nothing about any game. This file is the target the PM reviews promotions and public API changes against (D-041, [refactor plan](../../docs/engine/refactor-plan.md)). Each contract says what exists **today** (0.2.0-dev) and what is **planned**, with the phase that delivers it.

## Package shape

```
packages/engine/
  package.json        # @thunderclap/engine; the "exports" map is the public API
  src/
    audio/  core/  fx/  input/  platform/  post/  render/  save/  ui/
  ARCHITECTURE.md     # this file
  CHANGELOG.md
```

Games import only the exports map: `@thunderclap/engine/<module>` for `audio`, `core`, `fx`, `input`, `platform`, `post`, `render`, `save` and `ui`, plus `@thunderclap/engine/testing` (the recording fake `GPUDevice`, for unit tests only). Each subpath is that module's `index.ts`; anything not re-exported there is internal. `pnpm check:boundaries` (`scripts/check-boundaries.mjs`, part of `pnpm check`) fails if a game, test or script imports a path outside the map or reaches into `packages/engine/` by a relative path, or if anything under `src/` imports a game. Inside the package, modules import each other by relative path.

The package ships TypeScript source; the game's Vite build compiles it. There is no separate engine build until Phase 5 (extraction and publishing).

## Ground rules

1. **Promotion rule.** Code enters the engine only if Last Rune uses it, the next game plausibly would, and its API has zero game nouns.
2. **Dependency direction.** `games/*` imports `@thunderclap/engine`; the engine never imports a game. A game's `rules/` imports nothing from the engine or the DOM.
3. **No runtime dependencies** without a DECISIONS entry (D-008). WebGPU is the only renderer.
4. **Seams, not features.** 3D content and XR are out of scope until after Gate 5. The engine grows the three seams they would plug into (`Surface`, `Camera`, the frame loop) and nothing else on speculation.

## Contracts

**Surface.** Owns the canvas, the swapchain, DPR, the backbuffer size and the letterbox or fill-width fit. It exposes `rect` (CSS px), `size` (device px), `clientToLogical` and `onResize`. Later an `XRSurface` provides a target per eye per frame through the same interface. *Today:* `Surface` / `mountSurface` in `platform/surface.ts` exposes `rect`, `backbuffer` (device px; the planned name is `size`), `clientToLogical`, `logicalToClient`, `onResize` and `setFill` (fill-width), over the pure letterbox math in `platform/letterbox.ts`; `initGpu` configures the swapchain. *Planned:* the `size` rename and the target-per-frame shape arrive with Phase 3's `render(camera, target)`; `XRSurface` is after Gate 5.

**Camera.** A view-projection matrix plus `worldToScreen` and `screenToWorld` (the inverse projection; touch aiming uses it). Presets: `ortho2d(designW, designH)`, where 1 unit = 1 design px, and `fitRect(rect, viewport)`, which generalises the game's `zoom.ts`. Depth test and depth write are camera-preset flags; the 2D preset leaves both off. *Today:* `render/renderer.ts` has a 2D `Camera` (`x`, `y`, `zoom`, `rotation` over the logical space) read from `renderer.camera`; draw order is submission order with no depth. *Planned:* Phase 1 (ws/promote-ui) promotes the altar's pure camera functions as `render/camera2d.ts`; Phase 3 (ws/camera) adds the matrix `Camera`, `mat4` in `core/math.ts` and the camera uniform block.

**Frame loop.** `GameLoop` as today (fixed 60 Hz update, variable render), but `render(camera, target, alpha)` takes the camera and the target as inputs instead of reading them from the renderer. The host decides who schedules frames (rAF, Electron, later `XRSession.requestAnimationFrame`). *Today:* `GameLoop` and `FixedStepper` in `core/loop.ts` (fixed step, `maxFps` cap, pause) call `render(alpha, time)` from `requestAnimationFrame`; `Scene<Ctx, Frame>` and `SceneStack` in `core/scene.ts`. *Planned:* the `render(camera, target, alpha)` signature in Phase 3 (ws/render-call); host-owned scheduling with the host layer.

**Host.** `interface Host { kind; openExternal; copyText; fullscreen; storage; window?; embed }`. Implementations: `web` (detects iframe vs top and wraps today's D-036 link service) and `electron` (preload bridge). After Phase 1 the engine never calls `window.open`, `navigator.clipboard` or `localStorage` directly. *Today:* no `Host` type. The pieces exist separately: `embedContext`, `openExternal`, `copyText`, `clipboardWriteAllowed` and `safeExternalUrl` in `platform/links.ts`; fullscreen helpers in `platform/device.ts`; `localStorage` access with quota and blocked-storage handling in `save/storage.ts`. *Planned:* Phase 1 (ws/host) adds `host/` with `createWebHost()`, and `save` and the `externalLink` widget take the host; Phase 4 adds `createElectronHost()` in `packages/host-electron`.

**Input.** The action map is unchanged. A new `Gestures(target, opts)` adds tap, double-tap, long-press, pan and drag with thresholds in CSS px, reporting in the same tick model as `Input`. Gestures feed actions where a game binds them. *Today:* `input/` has the action map for keyboard, mouse, touch, pen and gamepad, `blocked()`, `lastDevice`, queued taps, iframe-safe `preventDefault`, injectable pads and public feed methods for tests; `ui/padnav.ts` drives modal panels from the pad. *Planned:* Phase 1 (ws/promote-ui) promotes the game's `menu-nav` for non-modal menus; Phase 2 (ws/gestures) adds `input/gestures.ts` and the `{ gesture }` binding kind.

**Layout.** `createOverlay` laid out in CSS px, not design px. A `LayoutSpec` names regions (`top`, `left`, `right`, `bottom`, `cardLane`, `captionLane`, `modal`) per form factor (`phone`, `tablet`, `desktop`, each in `landscape` or `portrait`), with safe areas. Games register widgets against regions and the engine places them with CSS grid. The layout reports the free rect to the camera, so the world frames into what the UI leaves. Density tokens `--tc-text-min`, `--tc-tap-min` and `--tc-text-scale` replace the game's `--lr-*` variables. *Today:* `createOverlay` in `ui/overlay.ts` is a 1920×1080 design canvas shrunk by one CSS `scale()` transform, with layers for hud, captions, panels and toasts; phone layout lives in the game (`device-mode.ts`, `phone-styles.ts`, `text-scale.ts`). *Planned:* Phase 1 (ws/promote-ui) promotes `device-mode`, the rotate card and the text-scale tokens as interim API; Phase 2 (ws/layout) adds `ui/layout.ts` and stops the overlay scaling.

**UI, Audio, Save, FX, Post.** The APIs are unchanged; the overlay's scaling model is the one change inside UI. *Today:* `ui/` (overlay stack, panels, widgets, toasts, captions, loupe, external-link widget, theme tokens), `audio/` (WebAudio buses, synth, recipes, mixer persistence), `save/` (versioned slots, migrations, quota- and blocked-storage-safe), `fx/` (GPU particles, flicker) and `post/` (bloom, god rays, fog, vignette, grade, quality tiers). Each module has a README with usage. *Planned:* `save` takes its storage from the host (Phase 1).

**Scene and Ctx.** `Scene<Ctx, Frame>` stays. `Ctx` gains `host`, `camera`, `layout` and `gestures`; the game's `GameCtx` wraps it with game nouns as today. *Today:* `Scene` and `SceneStack` are in `core/`, but there is no engine `Ctx`: the game builds its own in `games/last-rune/game/ctx.ts`. *Planned:* Phase 1 (ws/create-game) adds `createGame(opts): EngineCtx` in `core/game.ts`, and `GameCtx` wraps `EngineCtx`.
