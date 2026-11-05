# host

What the engine needs from the place it runs: frames, open a link, copy text, fullscreen, save
storage, and where it is embedded. The web host is here; the Electron host, `createElectronHost()` in
`@thunderclap/host-electron` (packages/host-electron), fills the same interface from a preload
bridge and adds `window` (close, minimize, toggleMaximize, setTitle). Nothing else in the engine touches `window.open`,
`navigator.clipboard` or `localStorage`.

```ts
import { createWebHost, defaultHost, setDefaultHost } from '@thunderclap/engine/host';

const host = createWebHost(); // or defaultHost(); setDefaultHost(electronHost) to replace it
host.kind; // 'web' | 'electron'
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
redesign. `createSaveStore`, `listSlots`, `persistMixer` and `externalLink` take `host` and
default to `defaultHost()`. Tests: `web.test.ts`, `web-links.test.ts`, and `e2e/host.spec.ts` on every row of
the engine matrix.
