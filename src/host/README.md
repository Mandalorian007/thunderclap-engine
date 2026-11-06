# host

What the engine needs from the place it runs: frames, open a link, copy text, fullscreen, save
storage, and where it is embedded. The web host is here; the Electron host, `createElectronHost()` in
`@thunderclap/host-electron` (packages/host-electron), fills the same interface from a preload
bridge and adds `window` (close, minimize, toggleMaximize, setTitle). Nothing else in the engine touches `window.open`,
`navigator.clipboard` or `localStorage`.

## Exports

| Name | What it is |
| --- | --- |
| `Host` | The interface: `FrameSource` plus `kind`, `embed`, `openExternal`, `copyText`, `clipboardWriteAllowed`, `fullscreen`, `storage` and an optional `window` |
| `HostKind` | `'web' \| 'electron' \| 'xr'` |
| `FrameSource` | `requestFrame(cb: (timeMs) => void): number` and `cancelFrame(handle)`; what `GameLoop` schedules through |
| `HostFullscreen` | `available()`, `active()`, `toggle({ lockLandscape? }): Promise<boolean>`, `watch(fn): () => void` |
| `HostStorage` | `kind` (`'local'` on the web host) and `open(): StorageLike \| null`, probed on every call |
| `HostWindow` | Desktop window controls: `close()`, optional `minimize`, `toggleMaximize`, `setTitle` |
| `createWebHost(opts?: WebHostOptions)` | The browser host; `WebHostOptions` is `{ win?: Window }` (tests pass a stub) |
| `defaultHost()` / `setDefaultHost(host \| null)` | The shared host the engine falls back to; `null` resets it to a fresh web host |
| `createXrHost(session, base)` | The host of an immersive session (ws/xr): frames come from `XRSession.requestAnimationFrame`, everything else is `base`'s |
| `XrHost` | What it returns: `Host` with `kind: 'xr'`, `session`, `base` and `frame` (the current `XRFrame` for the length of a frame callback, else `null`) |

```ts
import { createWebHost, defaultHost, setDefaultHost } from '@thunderclap/engine/host';

const host = createWebHost(); // or defaultHost(); setDefaultHost(electronHost) to replace it
host.kind; // 'web' | 'electron' | 'xr'
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
```

`GameLoop` schedules its frames through `FrameSource` (`requestFrame` / `cancelFrame`; a test
passes a stub it steps by hand), never through the globals, so an XR session is a host, not a
redesign: `createXrHost(session, pageHost)` wraps `session.requestAnimationFrame` and keeps the
`XRFrame` it was called with on `frame` while the callback runs (`xr-surface.ts` reads the eyes
from it, `XrPointerSource` the controllers). `createGame({ xr })` swaps the loop onto it with
`loop.setFrames(xrHost)` on `ctx.xr.enter()` and back on exit. `createSaveStore`, `listSlots`, `persistMixer` and `externalLink` take `host` and
default to `defaultHost()`. Tests: `web.test.ts`, `web-links.test.ts`, `xr.test.ts`, and `e2e/host.spec.ts` on every row of
the engine matrix.

The installable web shell is a package, not a host kind: `createPwaHost()` in `@thunderclap/host-pwa`
(packages/host-pwa) wraps `createWebHost()`, keeps `kind: 'web'`, and adds `host.pwa` (the deferred
install prompt, `updateReady` / `applyUpdate()` for a waiting service worker, `offline`,
`standalone`, `cacheStatus()`, `clearCache()`), every method a no-op where the browser lacks the
feature. The manifest and service worker come from the package's vite plugin at build time; `storage`
is the web host's, so saves never enter the cache. The engine never imports it.
