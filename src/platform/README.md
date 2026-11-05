# engine/platform

The page the game runs in: the letterboxed canvas, WebGPU bring-up, DPR, page lifecycle,
fullscreen, device traits and the fatal screens. DOM only, no game nouns; every helper answers
"no" where an API is missing. `createGame` uses all of this for you; a game reaches for it when
it boots by hand or needs one helper. No dependencies.

```ts
import { boot } from '@thunderclap/engine/platform';

const res = await boot(document.getElementById('app')!, { title: 'My Game', logicalWidth: 1920, logicalHeight: 1080 });
if (!res.ok) return; // the unsupported screen is already shown (res.reason says why)
const { surface, gpu } = res;
res.onDeviceLost(() => loop.stop()); // after the reload screen is shown
surface.onResize(({ rect, backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));
const p = surface.clientToLogical(e.offsetX, e.offsetY); // design px
```

## Boot and GPU

- `boot(root, opts?: BootOptions): Promise<BootResult>`: mounts a surface and calls `initGpu`.
  `BootOptions` extends `SurfaceOptions` with `title` (eyebrow on fatal screens),
  `onDeviceLost` and `forceUnsupported` (dev aid). `BootResult` is `{ ok: true, surface, gpu,
  onDeviceLost(fn) }` or `{ ok: false, reason }`; on failure the canvas is removed and the
  unsupported screen shown.
- `initGpu(canvas, opts?: GpuInitOptions): Promise<GpuInitResult>`: requests adapter and device
  and configures the canvas; never throws. `GpuInitOptions` is `{ powerPreference?, onLost?,
  timestamps? }` (timestamps default true). `GpuContext` is `{ adapter, device, context, format,
  timestamps }`; a failure is `{ ok: false, reason: GpuFailureReason, detail? }` with
  `GpuFailureReason` `'no-api' | 'no-adapter' | 'no-device' | 'no-context'`.

## Surface and letterbox math

- `mountSurface(root, opts?: SurfaceOptions): Surface` (or `new Surface(root, opts)`).
  `SurfaceOptions`: `logicalWidth`/`logicalHeight` (1920×1080), `maxDpr` (2), `maxPixels`
  (2560×1440), `barColor`. A `Surface` owns `canvas` and exposes `rect` (the letterboxed
  `Letterbox`, CSS px relative to `root`), `fitRect` (the whole container's contain fit),
  `backbuffer` (`BackbufferSize`: device px and the `pixelRatio` used), `onResize(fn)` (called
  with a `SurfaceSize` `{ rect, backbuffer }`), `clientToLogical` / `logicalToClient`,
  `containsLogical`, `setFrame(rect | null)` (letterbox inside part of the container, e.g. the
  layout's `freeRect`), `setFill(opts | null)` (fill-width), `layout()` and `destroy()`.
- Pure math (no DOM, tested in Node): `computeLetterbox(containerW, containerH, logicalW,
  logicalH): Letterbox`, `computeFillWidth(...)` with `FillWidthOptions` (`minVisible`,
  `focusY`, `minVisibleWidth`, `focusX`), `computeBackbuffer(cssW, cssH, dpr, maxDpr?,
  maxPixels?)`, and `clientToLogical(box, logicalW, logicalH, cx, cy, out?)` /
  `logicalToClient(...)`. `Rect` is `{ x, y, width, height }`; `Letterbox` adds `scale` (CSS px per
  logical unit); `Vec2` is `{ x, y }`.
- `setFill`, `computeFillWidth` and `FillWidthOptions` have no engine caller since ws/render-call
  and are being deleted by ws/plumbing (E-010).

## Page, device and fullscreen

- `watchVisibility(fn)`, `watchLifecycle(h: LifecycleHandlers)` (`onHide('hidden' | 'pagehide' |
  'freeze')`, `onShow('visible' | 'pageshow' | 'resume')`), `prefersReducedMotion()`,
  `watchReducedMotion(fn)`, `blockBrowserZoom(doc?)` (double-tap, pinch, smart zoom and
  ctrl+wheel; keyboard zoom is left alone). Each `watch*` returns unsubscribe.
- `deviceTraits(): DeviceTraits` (`coarsePointer`, `shortSide`, `handheld`: coarse pointer and a
  short side at most `HANDHELD_SHORT_SIDE`, 600 CSS px).
- `isTouchOnly()`, `isPortrait(win?)`, `watchPointerKind(fn)` with `PointerKind` `'touch' |
  'mouse' | 'keyboard'` (the last device used anywhere on the page).
- `fullscreenAvailable()`, `isFullscreen()`, `toggleFullscreen(el?, { lockLandscape? })`,
  `watchFullscreen(fn)`. Games normally use `host.fullscreen`, which wraps these.

## Links

`safeExternalUrl(url)` (a plain absolute `https:` URL, else null) and `embedContext(win?):
EmbedContext` (`'top' | 'same-origin-frame' | 'cross-origin-frame'`), plus the result types of
the host's link services: `LinkActivation` (`pointer`, `keyboard`, `gamepad`, `script`),
`OpenResult` (`opened`, `blocked`, `invalid`) and `CopyResult` (`copied`, `manual`). Opening and
copying are `Host.openExternal` and `Host.copyText`.

## Fatal screens

`showMessageScreen(root, opts: MessageScreenOptions)` (`eyebrow`, `heading`, `body`, `list`,
`footer`, `actions: MessageScreenAction[]` of `{ label, onClick }`) returns a remover.
`showUnsupportedScreen(root, { title?, detail? })` lists where WebGPU runs, the visitor's
`platformFamily()` (`PlatformFamily`: `ios`, `android`, `desktop`) first.
`showDeviceLostScreen(root, { title?, detail?, onReload? })` offers a reload.

## Device mode (interim)

`createDeviceMode(root, opts?: DeviceModeOptions): DeviceModeController` sets `data-phone`,
`data-touch`, `data-fill` and `--tc-bar`, `--tc-third`, `--tc-crop-t/b` on an overlay root.
`DeviceMode` has `phone`, `touch`, `cssPx`, `bar`, `cropT`, `cropB` and `onChange`; the controller
adds `setScale(scale, barCss?, crop?: CropInfo)` and `destroy()`. `PHONE_SCALE` (0.45) is the
default `phoneScale`. Interim API: `ui/rotate-card.ts` and the harness still use it (E-010); the
layout's form factors replace it.

Tests: `letterbox.test.ts`, `surface.test.ts`, `device-mode.test.ts`, `links.test.ts`, and the
harness specs in `e2e/`.
