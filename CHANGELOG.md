# Changelog: @thunderclap/engine

Versions follow semver from `engine-v1.0.0`. Entries before this repo existed were written while the engine lived in [The Last Rune](https://github.com/Mandalorian007/last-rune) (`packages/engine`); their decision numbers (`D-0xx`) and paths refer to that repo.

## Next (unreleased)

### Repository
- The engine has its own repo, `Mandalorian007/thunderclap-engine`, with the `packages/engine` history from The Last Rune. It adds a standalone pnpm setup, CI (`pnpm check`), a README and a runnable example (`examples/hello`, `pnpm example`). The Last Rune keeps its in-repo copy for now.

### Added
- `HostWindow.setTitle?(title)`: optional, for hosts with a window of their own. The Electron host (`@thunderclap/host-electron`, ws/host-electron) implements it.
- Layout regions (D-041 Phase 2, ws/layout): `createLayout(overlay, spec?)` in `./ui`, with `LayoutSpec`, `FormFactor`, `RegionName`, `classifyFormFactor`, `resolveLayout`, `resolveTracks`, `parseAreas`, `effectiveInsets`, `readSafeArea` and `defaultForms`.
  - Four form factors (`phone-landscape`, `phone-portrait`, `tablet`, `desktop`), each with px/fraction/fill tracks and grid areas for `top`, `left`, `right`, `bottom`, `cardLane`, `captionLane` and `fill`, plus a `modal` rect. All of them sit inside the safe area.
  - Widgets register once with a region per form factor and move when it changes. The escape hatch `{ region: 'free', rect, reason }` is logged and listed in `layout.freeUses`.
  - `layout.freeRect` (the `fill` region, CSS px) and `onChange` are there for the camera. Tracks with no widgets collapse.
  - `layout.dockCaption()` places the caption card in `captionLane`. `caption.dock(host)` is new, and `avoid()` is unchanged.
- `createOverlay({ legacyScale: false })`, a CSS-px overlay mode (`data-units="css"`, `cssPxTheme`, `overlay.onRect`). `legacyScale: true` stays the default, so existing scenes are unchanged.
- In CSS-px mode, buttons, toggles and sliders honour `--tc-tap-min` (44 on touch forms), and panels and toasts honour the safe area and the modal region. `textScaleTokens` takes a base size table (`DESIGN_FONT_PX`, `CSS_FONT_PX`).
- The engine e2e has a layout harness page (`harness/layout.html`) and `e2e/layout.spec.ts`. It checks every matrix row plus two new upright rows (`phone-port` 390×844 and `tablet-port` 820×1180) for region placement, no overlap, the safe area (insets emulated through CDP), 44 px taps on touch, rotation and the modal at 150% text.

- Two overlays (ws/port-chrome): `createCssChrome({ parent, legacy, forms?, layout?, focusHome? })` in `./ui` (`CssChrome`, `CssChromeOptions`, `PHONE_FORMS`), a CSS-px overlay with layout regions beside the legacy scaled one. While `chrome.active` (form factor in `forms`), the legacy `panels` and `toasts` layers move into it; otherwise it is hidden and the legacy overlay is untouched. See ARCHITECTURE.md, "Two overlays".
- `createGame({ overlay: { layout?, cssForms? } })` builds it, and `EngineCtx.chrome` is the `CssChrome` (null without the option). `data-touch` is mirrored on both roots and `chrome.resize()` runs on every resize.
- `Surface.setFrame(rect | null)`: the canvas letterboxes inside a part of the container (CSS px), so a scene can frame the world into `layout.freeRect`; `null` restores the whole container. `clientToLogical` follows it.
- Height fill (ws/chrome-polish-3): `FillWidthOptions.minVisibleWidth` and `focusX`. Where a frame is too narrow to show `minVisibleWidth` of the design at full height, the fit fills the frame's height and crops the sides about `focusX`, the same way `minVisible`/`focusY` crops top and bottom. `computeFillWidth` covers both; `surface.setFill` compares the new fields. Tests are in `platform/letterbox.test.ts`.
- Engine e2e: "panel-stack spam leaves at most one panel" in `e2e/layout.spec.ts` (real taps on the harness ⚙, then 20 `stack.replace` opens in one tick).

### Changed
- `platform/device-mode.ts` no longer writes the density tokens on a CSS-px overlay root, because the layout owns them there.
- `WidgetHandle.remove()` returns the element to where it was before `layout.add()` (its old parent and position); an element added detached is removed, as before.

### Magnify (ws/port-altar)
- `GestureOptions.magnify` (`MagnifyOptions`: `pitch`, `below` 44, `size` 128, `zoom` 2.5, `lift` 56, `when`, `snap`, `over`, `toClient`, `source`, `className`, `parent`) and `Gestures.setMagnify()`. Each tick a touch pointer is down, `gestures.aim` (`Aim`) holds the aim point (lifted while dragging), the snapped `target` (`MagnifyTarget`, with `data` for the game's cell), and whether the loupe shows; the aim the finger lifted at comes once more with `ended` on the drag's `end` tick. With a `source` canvas the gestures draw a `Loupe` (`gestures.loupeElement`); `destroy()` removes it.
- `snapToGrid(grid, x, y, ok?)` and `loupeSpot(finger, aim, size, view)` in `./input`.
- `MagnifyOptions.clear(target)` (ws/dense-board-3): areas the loupe must leave in sight (`keep`, for example the target and its neighbours) and should rather not cover (`avoid`), client px (`Rect`). With it the loupe goes where `loupeClear(finger, aim, size, view, keep, avoid?)` puts it: the free spot nearest the aim, clear of `keep` and the fingertip, never below the finger, on screen.
- `MagnifyOptions.clear` may also return `spare` (ws/polish-9): areas the loupe should leave in sight when it can, for example labels. They rank below `keep` and the fingertip and above `avoid`: the loupe takes the spot covering the fewest `spare` rects, then one covering no `avoid` rect, then the nearest. With `spare` given, `loupeClear(finger, aim, size, view, keep, avoid?, spare?)` also tries a coarse grid over the view, so it finds a clear spot when there is one. Unit-tested in `magnify.test.ts`.
- Engine tests: `src/input/magnify.test.ts`, the loupe element in `gestures.dom.test.ts`, and two `e2e/gestures.spec.ts` cases on every row (snap off a refused cell, loupe only below 44 CSS px, mouse never aims; a drag aims 56 px up and lands there). The game's `scenes/altar/snap` test moved here.
- dense-board-4: `MagnifyOptions.size` may be a function, read each tick (the loupe is rebuilt when it changes), so a game can use a smaller lens where targets are dense; `magnifySize(m)` reads it. `MagnifyOptions.clear(target, aim)` now also gets the game-space aim point, so the loupe can keep clear of the spot under the finger when nothing snapped. `MagnifyOptions.leader` draws a thin line from the loupe's rim to the snapped target: `LoupeView.leader`, `Loupe.leaderEl` (`tc-loupe-leader`, plus `<className>-leader`) and `loupeLeader(at, size, spot)` in `./ui`. Unit-tested in `magnify.test.ts`.

### Gestures (ws/gestures)
- `Gestures` in `@thunderclap/engine/input` (`input/gestures.ts`): `tap`, `doubleTap`, `longPress` (default 450 ms), `pan` (threshold default 10 CSS px, with `dx`, `dy` in game space and `pointers` 1 or 2), `drag` (`start`, `move`, `end`, `cancel`, with the `origin`) and `pinch` (`scale` and per-tick `delta`). Thresholds are CSS px; positions are game space through the same `PointerTransform` as `Input` (`inside: false` in the letterbox bars). Options: `panThreshold`, `longPressMs`, `doubleTapMs` (300), `doubleTapDistance` (24 CSS px), `blocked`, `now`. Public feed methods for tests: `pointerDown`, `pointerMove`, `pointerUp`, `pointerCancel`, `cancelAll`. Types `TapGesture`, `PanGesture`, `DragGesture`, `PinchGesture`, `GesturePoint`, `GesturePhase`, `GestureDevice`, `GestureKind`, `GestureOptions`, `GestureAttachOptions`.
- `Input.setGestures(g)` (or the `gestures` option) links gestures to an input: they share `blocked()` and the pointer transform, attach and detach with `Input.attach`, and advance in `Input.update()`.
- New binding kind `{ gesture: GestureKind }`: `tap` and `doubleTap` press for one tick, `longPress` holds until the pointer lifts, `pan`, `drag` and `pinch` hold from start to end. It reads inactive with no gestures linked.
- Engine e2e: `harness/gestures.html` (no WebGPU; a 4:3 stage letterboxed so every row has bars) and `e2e/gestures.spec.ts` on the whole matrix with real CDP touch on the iPad and phone rows and the mouse on desktop and in the itch iframe: tap position and binding, the 10 CSS px tap-versus-pan boundary, long-press timing, double tap, drag origin and drag-off into the bar, `blocked()` and its cancel, and a two-finger pinch.
- No change for games that don't link gestures; Last Rune does not use them yet.

## 0.2.0-alpha.1 (2026-11-04)

Phase 1 of the refactor plan (D-041). Every promoted module is listed here before Gate 1.

### Changed
- The engine is a pnpm workspace package, `@thunderclap/engine`, at `packages/engine/`, with its sources under `src/`. The move kept git history (`git log --follow`).
- The public API is the `exports` map: `./audio`, `./core`, `./fx`, `./input`, `./platform`, `./post`, `./render`, `./save`, `./ui`, and `./testing` (the recording fake `GPUDevice`, which was `render/fake-gpu`). Deep imports such as `@engine/render/renderer` are no longer reachable from a game.
- The `@engine/*` path alias is gone. Games import `@thunderclap/engine/<module>`; engine modules import each other by relative path.
- The package has its own `tsconfig.json`, `vitest.config.ts` and `typecheck`, `lint`, `test` and `check` scripts.
- The game's CSS variables became engine tokens: `--lr-text-scale` → `--tc-text-scale`, `--lr-text-min` → `--tc-text-min`, `--lr-tap` → `--tc-tap-min`, `--lr-css-px` → `--tc-css-px`, `--lr-bar` → `--tc-bar`, `--lr-third` → `--tc-third`, `--lr-crop-t`/`-b` → `--tc-crop-t`/`-b`. There are no `--lr-*` aliases: it is a rename with the same values, so layout does not change.

### Added
- `ARCHITECTURE.md`: the contracts (Surface, Camera, Frame loop, Host, Input, Layout, UI/Audio/Save/FX/Post, Scene and Ctx), each marked as existing today or planned.
- An import-boundary check (`scripts/check-boundaries.mjs` at the repo root, run by `pnpm check`).
- The engine e2e harness (D-041 addendum 2). `harness/` is a noun-free page that boots the platform layer and publishes `window.__harness`. `e2e/` holds the specs and `playwright.config.ts` holds the matrix: desktop 1280×720 and 1920×1080, iPad 1180×820, four phones and an itch-style cross-origin iframe (`e2e/wrapper.mjs`). Its seed spec, `smoke.spec.ts`, checks WebGPU init, surface letterbox and resize, and one tap. Run it with `pnpm test:e2e` in the package or `pnpm test:e2e:engine` from the repo root.

- `ui/menu-nav` (from the game's `ui/menu-nav.ts`, ws/promote-ui): `menuNav(input, root, actions?)` moves focus through a non-modal menu with up/down and clicks on a gamepad confirm. The action names are options (default `up`, `down`, `confirm`).
- `ui/text-scale` (from the game's `ui/text-scale.ts`): the density tokens `--tc-text-scale` and `--tc-text-min` (`TEXT_SCALE_VAR`, `TEXT_MIN_VAR`), `scaleFontSizes(css)`, `scalePxCss`, `scaledPx`, `textScaleTokens` and `applyTextScale(root, factor, setTheme?)`. The factor is 1 for 100%. The game keeps its 100/125/150 setting values (`TEXT_SCALES`, `toTextScale`).
- `platform/device-mode` (from the game's `ui/device-mode.ts`, interim until Phase 2's layout): `createDeviceMode(root, opts?)` with `phone`, `touch`, `onChange`, `setScale` and crop info; it sets `data-phone`, `data-touch`, `data-fill` and the tokens `--tc-text-min`, `--tc-tap-min`, `--tc-css-px`, `--tc-bar`, `--tc-third`, `--tc-crop-t` and `--tc-crop-b`. `PHONE_SCALE`, `PHONE_TEXT_MIN` and `PHONE_TAP_MIN` are exported; `DeviceModeOptions` overrides them.
- `ui/rotate-card` (from the rotate card in the game's `ui/phone-chrome.ts`, interim until Phase 2's portrait regions): `createRotateCard({ title, lines?, note?, ariaLabel?, device?, colors? })`. Every word and colour is an option.
- The UI harness page `harness/ui.html` (no WebGPU) and `e2e/ui.spec.ts`: the text-scale tokens at 100/125/150 with the phone floor, the device-mode flags, the rotate card on upright phones, `menuNav` from a pad and the arrows, panel focus trap and restore (to the opener, or home for `NO_RESTORE_FOCUS_ATTR`), and Escape from a focused button as a button key.

### Host (ws/host)
- New module `@thunderclap/engine/host` (`"./host"` in the exports map): `interface Host { kind; embed; openExternal; copyText; clipboardWriteAllowed; fullscreen; storage; window? }`, `createWebHost({ win? })`, and `defaultHost()` / `setDefaultHost(host)`. The web host wraps the D-036 link service, the fullscreen helpers in `platform/device.ts`, and `localStorage` behind `storage.open()` (probed on every call: `null` when missing, blocked or failing a write). `kind: 'electron'` and the optional `window` are the seam for `createElectronHost()` (Phase 4).
- `createSaveStore`, `listSlots` and `persistMixer` take their storage from the host: new option `host?: Pick<Host, 'storage'>`, default `defaultHost()`. `storage:` still overrides it (tests). Keys and format are unchanged, so v1.0 saves (`thunderclap:<game>:<slot>`) load as before.
- `externalLink` takes `host?: Pick<Host, 'openExternal' | 'copyText'>`, default `defaultHost()`.
- **Breaking:** `openExternal`, `copyText`, `clipboardWriteAllowed` and `execCopy` are no longer exported from `./platform`; use `host.openExternal`, `host.copyText` and `host.clipboardWriteAllowed()`. `safeExternalUrl` and `embedContext` stay in `./platform`. `probeStorage(get)` now needs its getter (it no longer defaults to `globalThis.localStorage`).
- After this, `window.open`, `navigator.clipboard`, `execCommand` and `localStorage` appear only in `src/host/web.ts` and `src/host/web-links.ts`.
- Engine e2e: a host probe in the harness (`harness/host-probe.ts`, `window.__host`) and `e2e/host.spec.ts` on the whole matrix: embed detection, clipboard policy, copy (granted, refused, missing, `execCommand` fallback, the selected fallback field), open only on a click, a blocked pad open, storage blocked, full and kept across a reload, fullscreen in and out, and itch's click-to-launch (`e2e/wrapper.mjs?launch=1`). The matching game e2e checks were trimmed.


### createGame (ws/create-game)
- New root entry `@thunderclap/engine` (`"."` in the exports map, `src/index.ts`): `createGame(opts): Promise<EngineCtx | null>` and the types `CreateGameOptions`, `EngineCtx`, `GameHooks` and `FlushableSave`. It is the noun-free half of Last Rune's old `game/ctx.ts`: surface, renderer, post, particles, input, pad nav, audio, overlay, save, host, device mode, fill bands, the loop, lifecycle and device loss. Last Rune's `GameCtx` now extends `EngineCtx`, and its `main.ts` is `createGame(...)` then the title. See ARCHITECTURE.md, "Scene and Ctx".
- `platform/blockBrowserZoom(doc?)`: stops double-tap, pinch and ctrl+wheel page zoom (keyboard zoom stays). `createGame` installs it before boot; it was an inline script in the game's `index.html`.
- Engine e2e: `harness/game.html` boots through `createGame` and publishes `window.__harnessGame` (frames, loop, audio, hides, device loss, backbuffer, a save that only a flush stores). `e2e/lifecycle.spec.ts` (hidden, pagehide and freeze flush the save and stop frames and audio, show resumes; audio unlocks on the first gesture; zoom blocking) and `e2e/surface.spec.ts` (resize and DPR mid-scene keep canvas, overlay and backbuffer in step; device loss shows the reload screen on top and halts frames, audio and timers; ten orientation flips leak no GPU textures or buffers). `e2e/wrapper.mjs?page=` embeds another harness page. The game's `tests/e2e/lifecycle.spec.ts` and robustness :91, :133 and :164 were removed; play time while hidden is a `game/flow` unit test.
- Unit tests for `createGame` (`core/game.test.ts`): boot failure, one ctx for every scene, hook order, lifecycle, device loss, fill bands, input blocked under a modal.
- Behaviour change (PM-approved): Last Rune's settings export copies through `ctx.host.copyText`, so a page without the Clipboard API falls back to `execCommand` or tells the player to copy by hand.

Apart from the createGame changes above (a reordered device-loss teardown, the zoom block moved into the bundle, the settings export through the host), no runtime behaviour changed.
