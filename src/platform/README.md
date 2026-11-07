# engine/platform

The page the game runs in: the letterboxed canvas, WebGPU bring-up, DPR, page lifecycle, fullscreen, device traits, WebXR surfaces and the fatal screens. `createGame` does all of this for you; a game reaches for it when it boots by hand or needs one helper. DOM only, no dependencies, and every helper answers "no" where an API is missing.

## Quick use

<!-- snippet:check -->
```ts
import { boot } from '@thunderclap/engine/platform';

const res = await boot(document.getElementById('app')!, { title: 'My Game' });
if (res.ok) {
  const { surface, gpu } = res; // gpu goes to new Renderer(gpu)
  surface.onResize(({ backbuffer }) => console.log(backbuffer.width, backbuffer.height));
  res.onDeviceLost(() => console.log('lost')); // after the reload screen is shown
  console.log(gpu.format);
}
```

## Entry points

| Name | What it is for |
| --- | --- |
| `boot(root, opts?)` | mount the surface and bring up WebGPU, or show why not |
| `mountSurface / Surface` | the letterboxed canvas and its resize events |
| `initGpu(canvas, opts?)` | WebGPU device and context on their own |
| `clientToLogical / computeLetterbox` | letterbox math between CSS px and design px |
| `deviceTraits()` | touch, handheld, reduced motion and friends |
| `watchLifecycle(handlers)` | hide, show and freeze events |
| `toggleFullscreen()` | fullscreen where the page allows it |
| `XrSurface` | WebXR with the WebGPU binding |

## Overview

The page the game runs in: the letterboxed canvas, WebGPU bring-up, DPR, page lifecycle,
fullscreen, device traits and the fatal screens. DOM only, no game nouns; every helper answers
"no" where an API is missing. `createGame` uses all of this for you; a game reaches for it when
it boots by hand or needs one helper. It imports only `render` (formats, `Camera`, `SceneTarget`
for XR and the compression feature list); no runtime dependencies.

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
  timestamps?, compression? }` (timestamps default true; `compression?: boolean`, default true,
  asks for the adapter's texture-compression features so `renderer.caps.compressed` reports
  them). `GpuContext` is `{ adapter, device, context, format,
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
  layout's `freeRect`), `layout()` and `destroy()`.
- Pure math (no DOM, tested in Node): `computeLetterbox(containerW, containerH, logicalW,
  logicalH): Letterbox`, `computeBackbuffer(cssW, cssH, dpr, maxDpr?,
  maxPixels?)`, and `clientToLogical(box, logicalW, logicalH, cx, cy, out?)` /
  `logicalToClient(...)`. `LetterboxRect` is `{ x, y, width, height }`; `Letterbox` adds `scale` (CSS px per
  logical unit); `Vec2` is `{ x, y }`.

## Page, device and fullscreen

- `watchVisibility(fn)`, `watchLifecycle(h: LifecycleHandlers)` (`onHide('hidden' | 'pagehide' |
  'freeze')`, `onShow('visible' | 'pageshow' | 'resume')`), `isReducedMotion()`,
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

## XR (WebXR with the WebGPU binding)

`XrSurface` (ws/xr) is the per-eye counterpart of `Surface`: `new XrSurface(session, device,
opts: XrSurfaceOptions)` makes an `XRGPUBinding` and one projection layer in the scene format
(`colorFormat` `SCENE_FORMAT`, `depthStencilFormat` `depth24plus` or `null` for none, `textureType`
`'texture'` (one texture, eyes side by side) or `'texture-array'` (one layer per eye)) and installs
it with `session.updateRenderState({ layers, depthNear, depthFar })`. `XrSurfaceOptions` needs the
`referenceSpace`; `depthNear` (0.1) and `depthFar` (1000) are optional. `aux` (`SceneTargetAux`,
ws/render-11) gives the eyes' scene pass the same aux attachments (rough-metal, velocity) as an
aux `renderer.target`: on `scene` in scene mode, on each eye's external target (at the eye's size)
in direct mode; `createGame({ aux, xr })` passes its own. Each eye camera keeps its own
`previousViewProj`, so velocity is per eye. Per frame `views(frame)`
returns the `XrEyeView[]` for `frame.getViewerPose(referenceSpace)` (empty while tracking is
lost): `index` (= `camera.viewIndex`, 0 left, 1 right), `eye`, `camera` (a depth-on `Camera` with the
view's projection and inverse pose, `screen` the viewport as a fraction of the target) and
`target`, a `SceneTarget.external` over the layer's `getViewSubImage` colour and depth textures
(eyes on one texture share one target, so the first eye clears and the second loads), plus the
`viewport` in px. The array and the views are reused; nothing is allocated per frame once the
layer's textures settle. `head` is a camera between the eyes (eye 0's projection, the viewer
pose) for a single `Scene.render` record. `XrSurface.supported()` says whether `XRGPUBinding`
exists; the constructor throws without it. `destroy()` frees the eye targets and the layer.
With `scene: true` (ws/xr-post) the eyes go through the post stack: the surface keeps `scene`, one
HDR `SceneTarget` the size of an eye (made on the first frame with a pose, resized when the eye
size changes, freed by `destroy`), every eye camera's `screen` is the whole unit square, the layer
takes `colorFormat` (pass `renderer.format`, what the post stack writes) and no depth unless
`depthStencilFormat` says so, and the caller renders each eye into `scene` and resolves it into
`eye.target` at `eye.viewport`. `createGame({ xr })` builds one that way on `ctx.xr.enter()` and
renders every eye with `renderer.render(frame, eye.camera, surface.scene)` then
`renderer.resolve(surface.scene, eye.target.color.view, eye.viewport)`, and ends the frame with
`renderer.endFrame({ present: false })`. The ambient WebXR and WebXR/WebGPU-binding declarations are
`xr-types.d.ts` (`navigator.xr` and `XRGPUBinding` optional, so nothing here assumes they exist);
`xr-fake.ts` is the in-repo fake (`installFakeXr`) the unit tests drive, not an export.

## Device mode (interim)

`createDeviceMode(root, opts?: DeviceModeOptions): DeviceModeController` sets `data-phone`,
`data-touch`, `data-fill` and `--tc-bar`, `--tc-third`, `--tc-crop-t/b` on an overlay root.
`DeviceMode` has `phone`, `touch`, `cssPx`, `bar`, `cropT`, `cropB` and `onChange`; the controller
adds `setScale(scale, barCss?, crop?: CropInfo)` and `destroy()`. `PHONE_SCALE` (0.45) is the
default `phoneScale`. Interim API: `ui/rotate-card.ts` and the harness still use it (E-010); the
layout's form factors replace it.

Tests: `letterbox.test.ts`, `surface.test.ts`, `device-mode.test.ts`, `links.test.ts`,
`xr-surface.test.ts`, and the harness specs in `e2e/`.
