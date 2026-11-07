# @thunderclap-engine/host-pwa

The installable web shell for a ThunderClap game: a vite plugin that turns a build into an
installable, offline-capable app (manifest, icons, service worker), and a `Host` that surfaces the
install prompt, the update prompt and the offline state through `host.pwa`. No dependencies, no
workbox: the worker is written here. The engine itself stays network-free; the worker and the
manifest are this package's and the game's.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Exports: `createPwaHost`, `inStandalone`, `pwaPlugin` and the types |
| `src/host.ts` | `createPwaHost(opts)`: `createWebHost()` plus `host.pwa`; `inStandalone()` |
| `src/vite.ts` | `pwaPlugin(opts)`: the build-only vite plugin (`@thunderclap-engine/host-pwa/vite`, so a vite config never loads the host) |
| `src/manifest.ts` | The manifest, the icon file names, the tags injected into the page, the precache list and the version stamp |
| `src/worker.ts` | The `sw.js` body with the per-build placeholders, and `workerSource(cfg)` that fills them |
| `src/sw-logic.ts` | The worker's decisions as pure functions (`routeFor`, `trimPlan`, `staleCacheNames`, `isNewVersion`) |
| `harness/` | A noun-free page built with the plugin, publishing `window.__pwa` |
| `e2e/pwa.spec.ts` | The smoke on the built preview (Chromium, port 4551) |

## Usage

```ts
// vite.config.ts
import { pwaPlugin } from '@thunderclap-engine/host-pwa/vite';

export default defineConfig({
  plugins: [
    pwaPlugin({
      manifest: { name: 'Pairs', theme_color: '#0b0d14', background_color: '#0b0d14', svg: ICON_SVG },
      runtimeCache: ['levels/', 'audio/'], // stale-while-revalidate, capped
      maxRuntimeEntries: 60,
    }),
  ],
});
```

```ts
// main.ts
import { createPwaHost } from '@thunderclap-engine/host-pwa';

const host = createPwaHost(); // a web Host (kind 'web') with host.pwa
const ctx = await createGame({ host, ... });

host.pwa.onInstallable(() => showInstallButton(() => host.pwa.install())); // 'accepted' | 'dismissed' | 'unavailable'
host.pwa.onUpdateReady(() => toast('Update ready', () => host.pwa.applyUpdate())); // skip-waiting, then reload
host.pwa.onOffline((off) => hint(off ? 'Offline: playing from the cache' : ''));
host.pwa.standalone; // launched from the home screen or the dock
await host.pwa.cacheStatus(); // { precached, runtime, bytes }
await host.pwa.clearCache(); // drops every tc-pwa-* cache; saves are untouched
```

`pwaPlugin` runs on `vite build` only; `vite dev` is unchanged. At `generateBundle` it reads the
bundle's hashed file names, stamps the version (fnv1a of the sorted precache list, or
`opts.version`), and emits `manifest.webmanifest`, `icon.svg`, `sw.js` and, when `OffscreenCanvas`
exists in the build process, `icon-192.png` and `icon-512.png` (Node has none, so the package's own
tests and harness take the SVG-only path; a game can list ready-made PNGs in `manifest.icons`
instead). Its post `transformIndexHtml` hook then injects `<link rel="manifest">`,
`<meta name="theme-color">` and a registration snippet that also sets `window.__tcPwa = { sw, version }`,
which is how `createPwaHost()` finds the worker (`opts.swUrl` overrides it; `register: false` leaves
registration to the page). `inStandalone()` reads the `display-mode` media query.

`createPwaHost` is guarded: in a browser without `serviceWorker`, `caches` or
`beforeinstallprompt`, `install()` resolves `'unavailable'`, `applyUpdate()` and `clearCache()` do
nothing, `cacheStatus()` reports zeros, and the host is otherwise the plain web host.

## Routing

The worker (`sw.js`, scope = where the game is served) decides per `GET` on its own origin, in order:

| Request | Route | Strategy |
| --- | --- | --- |
| A navigation, the scope root, or `index.html` | `index` | Network-first (`cache: 'no-cache'`); the cached copy on failure |
| A path in the precache set (the build's hashed assets) | `precache` | Cache-first; a miss is fetched and stored |
| A path starting with one of `runtimeCache` | `runtime` | Stale-while-revalidate into `tc-pwa-runtime`, the oldest dropped past `maxRuntimeEntries` |
| Anything else (other origins, non-GET, unknown paths) | `network` | Untouched |

Cache names: `tc-pwa-precache-<version>` and `tc-pwa-runtime`. On activate the worker deletes the
precache caches of other versions and claims the open pages. Lookups ignore `Vary` (the caches
are keyed by URL; a server answering `Vary: Origin` would otherwise make module scripts miss) and
the query string on precached assets. A page posts `{ type: 'tc-pwa:skip-waiting' }` to make a
waiting worker take over; `applyUpdate()` does that and reloads on `controllerchange`.

### What is cached, and what never is

- **Cached**: the bundle's emitted assets (hashed JS, CSS, images, fonts, anything vite emits,
  minus `.map` files), `index.html`, and the `runtimeCache` prefixes a game opts into.
- **Never cached**: the game's saves (they live in the host's `storage`, `localStorage` on the web;
  `clearCache()` does not touch them), anything the game fetches outside the prefixes, other
  origins, `POST`s, the worker and manifest themselves.

An update is a new version stamp: the new worker installs its own precache beside the old one,
reaches `installed`, and `host.pwa.updateReady` flips (`onUpdateReady` fires); nothing changes
until `applyUpdate()` or the next full navigation. `index.html` is network-first, so an online
load always gets the new page, which registers the new worker.

## Commands

From the repo root: `pnpm pwa:dev` (harness dev server on 5198), `pnpm pwa:build`,
`pnpm check:host-pwa` (part of `pnpm check`). In this folder: `pnpm test` (Vitest: the routing,
the plugin's hooks, the host with a fake worker container under happy-dom), `pnpm test:e2e`
(builds the harness, serves it with `vite preview` on 4551 and runs `e2e/pwa.spec.ts`: manifest,
activation, an offline reload, `offline` following the context, the precache count, the runtime
cache filling and trimming).
