# host

What the engine needs from the place it runs: open a link, copy text, fullscreen, save storage,
and where it is embedded. The web host is the only one today; an Electron host (Phase 4) fills the
same interface from a preload bridge. Nothing else in the engine touches `window.open`,
`navigator.clipboard` or `localStorage`.

```ts
import { createWebHost, defaultHost, setDefaultHost } from '@thunderclap/engine/host';

const host = createWebHost(); // or defaultHost(); setDefaultHost(electronHost) to replace it
host.kind; // 'web' | 'electron'
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

`createSaveStore`, `listSlots`, `persistMixer` and `externalLink` take `host` and default to
`defaultHost()`. Tests: `web.test.ts`, `web-links.test.ts`, and `e2e/host.spec.ts` on every row of
the engine matrix.
