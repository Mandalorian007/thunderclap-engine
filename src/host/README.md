# host

What the engine needs from the place it runs: frames, links, the clipboard, fullscreen, storage, embedding, and optionally lifecycle, haptics and the safe area. The web host is here; the Electron and Capacitor hosts fill the same `Host` interface from their own packages, and a game picks one. Nothing else in the engine touches `window.open`, `navigator.clipboard`, `navigator.vibrate` or `localStorage`.

## Quick use

<!-- snippet:check -->
```ts
import { createWebHost } from '@thunderclap/engine/host';

const host = createWebHost();
const store = host.storage.open(); // null when storage is blocked (an itch.io iframe can do that)
store?.setItem('k', 'v');
if (host.fullscreen.available()) await host.fullscreen.toggle();
host.openExternal('https://example.com', { activation: 'pointer' });
```

## Entry points

| Name | What it is for |
| --- | --- |
| `Host` | the interface every host fills |
| `createWebHost(opts?)` | the browser host |
| `createXrHost(...)` | frames from a WebXR session |
| `defaultHost / setDefaultHost` | the host the engine uses when none is passed |
| `HostStorage` | `open()` a `StorageLike`, probed on every call |
| `HostFullscreen` | `available`, `active`, `toggle`, `watch` |
| `HostLifecycle / HostHaptics / HostSafeArea` | the optional mobile facets |

## Overview

What the engine needs from the place it runs: frames, open a link, copy text, fullscreen, save
storage, where it is embedded, and (optionally) the app's lifecycle, haptics and the safe area.
The web host is here; the Electron host, `createElectronHost()` in `@thunderclap/host-electron`
(packages/host-electron), fills the same interface from a preload bridge and adds `window`
(close, minimize, toggleMaximize, setTitle); the Capacitor host, `createCapacitorHost()` in
`@thunderclap/host-capacitor` (packages/host-capacitor), fills it from Capacitor's plugins for an
iOS or Android store app. Nothing else in the engine touches `window.open`, `navigator.clipboard`,
`navigator.vibrate` or `localStorage`.

## Exports

| Name | What it is |
| --- | --- |
| `Host` | The interface: `FrameSource` plus `kind`, `embed`, `openExternal`, `copyText`, `clipboardWriteAllowed`, `fullscreen`, `storage` and the optional `window`, `lifecycle`, `haptics` and `safeArea` |
| `HostKind` | `'web' \| 'electron' \| 'xr' \| 'capacitor'` |
| `FrameSource` | `requestFrame(cb: (timeMs) => void): number` and `cancelFrame(handle)`; what `GameLoop` schedules through |
| `HostFullscreen` | `available()`, `active()`, `toggle({ lockLandscape? }): Promise<boolean>`, `watch(fn): () => void` |
| `HostStorage` | `kind` (`'local'` on the web host) and `open(): StorageLike \| null`, probed on every call |
| `HostWindow` | Desktop window controls: `close()`, optional `minimize`, `toggleMaximize`, `setTitle` |
| `HostLifecycle` / `HostLifecycleState` | `state(): 'active' \| 'background'` and `watch(fn)` (called on each change). `createGame` stops frames and flushes the save on `background`, restarts on `active`, and calls `hooks.lifecycle(state)` |
| `HostHaptics` / `HapticImpact` / `HapticNotification` | `available()`, `impact('light' \| 'medium' \| 'heavy')`, `notification('success' \| 'warning' \| 'error')`, `vibrate(ms)`; every call is a no-op when unavailable |
| `HostSafeArea` / `HostInsets` | `insets(): { top, right, bottom, left }` in CSS px (the object is reused) and `watch(fn)`; `createGame` feeds it to `ui.layout` through `followSafeArea` |
| `createWebHost(opts?: WebHostOptions)` | The browser host; `WebHostOptions` is `{ win?: Window }` (tests pass a stub). Fills all three facets |
| `createWebLifecycle(win)` | The page's lifecycle: `background` on a hidden document, `pagehide` or `freeze`; `active` on `visibilitychange`, `pageshow` or `resume` |
| `createWebHaptics(win)` | `navigator.vibrate` as haptics: impact 10/20/35 ms, notification patterns, `available()` false without it |
| `createWebSafeArea(win)` | `env(safe-area-inset-*)` (or the `--tc-safe-*` overrides) read through a probe element, cached until `resize` / `orientationchange` |
| `defaultHost()` / `setDefaultHost(host \| null)` | The shared host the engine falls back to; `null` resets it to a fresh web host |
| `createXrHost(session, base)` | The host of an immersive session (ws/xr): frames come from `XRSession.requestAnimationFrame`, everything else (the facets too) is `base`'s |
| `XrHost` | What it returns: `Host` with `kind: 'xr'`, `session`, `base` and `frame` (the current `XRFrame` for the length of a frame callback, else `null`) |

```ts
import { createWebHost, defaultHost, setDefaultHost } from '@thunderclap/engine/host';

const host = createWebHost(); // or defaultHost(); setDefaultHost(electronHost) to replace it
host.kind; // 'web' | 'electron' | 'xr' | 'capacitor'
const h = host.requestFrame((timeMs) => {}); // the window's requestAnimationFrame
host.cancelFrame(h);
host.embed; // 'top' | 'same-origin-frame' | 'cross-origin-frame' (detected)
host.openExternal(url, { activation: 'gamepad' }); // 'opened' | 'blocked' | 'invalid'
await host.copyText(url); // 'copied' | 'manual' (show the URL in a field)
host.clipboardWriteAllowed(); // false in itch's iframe: copy goes through execCommand
host.fullscreen.available(); host.fullscreen.active();
await host.fullscreen.toggle({ lockLandscape: true });
const off = host.fullscreen.watch((on) => {});
host.storage.open(); // a StorageLike, or null (missing, blocked, or a write throws); probes each call
host.window?.close(); // desktop shells only
host.lifecycle?.state(); // 'active' | 'background'
host.lifecycle?.watch((state) => {}); // createGame does this; games use hooks.lifecycle
host.haptics?.available(); host.haptics?.impact('light'); host.haptics?.notification('success');
host.safeArea?.insets(); // { top, right, bottom, left } CSS px; copy it to keep it
```

`GameLoop` schedules its frames through `FrameSource` (`requestFrame` / `cancelFrame`; a test
passes a stub it steps by hand), never through the globals, so an XR session is a host, not a
redesign: `createXrHost(session, pageHost)` wraps `session.requestAnimationFrame` and keeps the
`XRFrame` it was called with on `frame` while the callback runs (`xr-surface.ts` reads the eyes
from it, `XrPointerSource` the controllers). `createGame({ xr })` swaps the loop onto it with
`loop.setFrames(xrHost)` on `ctx.xr.enter()` and back on exit. `createSaveStore`, `listSlots`, `persistMixer` and `externalLink` take `host` and
default to `defaultHost()`.

## Lifecycle, haptics, safe area (ws/host-mobile)

The three optional facets are what a phone shell adds and the browser can also answer. A host
without one leaves it `undefined` and the engine does nothing for it.

- **Lifecycle.** `createGame` watches `host.lifecycle`: on `background` it stops the loop (no
  frames are requested) and flushes the save if the loop was running; on `active` it starts the
  loop again unless the game was halted (a lost device). Either way it then calls
  `hooks.lifecycle(state)`, where a game autosaves or pauses its music. On the web the page's
  own events (`hide` / `show` in `createGame`) run first, so nothing is flushed twice. Audio
  follows the document's visibility in `AudioEngine.attach`.
- **Haptics.** Fire-and-forget; call them from a press or a landing without checking
  `available()` first.
- **Safe area.** `createGame` calls `followSafeArea(ui.layout, host.safeArea)` (`ui/layout`), so
  the layout's regions keep clear of a notch and a home indicator. The web host reads
  `env(safe-area-inset-*)`; a page can override with `--tc-safe-top/right/bottom/left` on
  `:root`. A host is free to answer from somewhere else (a native inset API).

Tests: `web.test.ts`, `web-links.test.ts`, `xr.test.ts`, and `e2e/host.spec.ts` on every row of
the engine matrix (the facets through `harness/host.html`: `?safe=44,0,34,0` pads the layout, a
hidden document stops frames within 200 ms).

The installable web shell is a package, not a host kind: `createPwaHost()` in `@thunderclap/host-pwa`
(packages/host-pwa) wraps `createWebHost()`, keeps `kind: 'web'`, and adds `host.pwa` (the deferred
install prompt, `updateReady` / `applyUpdate()` for a waiting service worker, `offline`,
`standalone`, `cacheStatus()`, `clearCache()`), every method a no-op where the browser lacks the
feature. The manifest and service worker come from the package's vite plugin at build time; `storage`
is the web host's, so saves never enter the cache. The engine never imports it.
