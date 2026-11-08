# @thunderclap-engine/host-capacitor

The ThunderClap mobile host. A game's web build runs unchanged inside a Capacitor WebView on
iOS or Android, and `createCapacitorHost()` fills the engine's `Host` interface
(`@thunderclap-engine/engine/host`, D-041) from the Capacitor plugins the app installs. The package
contains no game nouns, the engine never imports it, and it reaches the engine only through the
engine's exports map (`pnpm check:boundaries`).

It also never imports a `@capacitor/*` package. The plugins are the app's own: it installs the
ones it wants and hands them in through `plugins`. `src/plugins.ts` types the slices this host
calls by hand, so the package typechecks and tests without any plugin installed, and the real
plugin objects satisfy those types structurally.

## Install

```sh
pnpm add @thunderclap-engine/host-capacitor @thunderclap-engine/engine @capacitor/core
```

`@capacitor/core` is an *optional* peer at `^8.0.0`: it records the Capacitor major this host runs
inside, and a package manager flags an app on another major, but nothing is installed for
you and the host imports no `@capacitor/*` module, at runtime or in its types. The app owns
`@capacitor/core`, `@capacitor/cli` and each plugin it hands to `createCapacitorHost` (see
[Wrapping a game](#wrapping-a-game-ten-lines-of-config) for the full list).

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | What a game imports: `createCapacitorHost`, `CapacitorHost`, `CapacitorHostOptions`, `HostBack`, the three facet factories, the plugin types |
| `src/capacitor.ts` | `createCapacitorHost()` and `createAppLifecycle`, `createCapacitorHaptics`, `createPreferencesStorage` |
| `src/plugins.ts` | `CapacitorPlugins` and the per-plugin types (`AppPlugin`, `BrowserPlugin`, `ClipboardPlugin`, `HapticsPlugin`, `PreferencesPlugin`, `ScreenOrientationPlugin`, `PluginListenerHandle`, `ListenerResult`, `AppState`, `BackButtonEvent`, `ImpactStyle`, `NotificationType`, `OrientationLockType`) |
| `src/capacitor.test.ts` | Unit tests against fake plugins (Node, happy-dom) |

## Using it from a game

```ts
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Clipboard } from '@capacitor/clipboard';
import { Haptics } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { createWebHost, setDefaultHost } from '@thunderclap-engine/engine/host';
import { createCapacitorHost } from '@thunderclap-engine/host-capacitor';

const host = Capacitor.isNativePlatform()
  ? createCapacitorHost({ plugins: { App, Browser, Clipboard, Haptics, Preferences, ScreenOrientation } })
  : createWebHost();
setDefaultHost(host);
if ('ready' in host) await host.ready; // Preferences read into the mirror; saves can open
const ctx = await createGame({ root, title, host, save: (host) => createSaveStore({ ..., host }) });
```

Pass only the plugins the app installed; each missing one falls back to the `base` host (a web
host over the WebView's window by default) or to a no-op.

| `Host` member | With the plugin | Without it |
|---|---|---|
| `kind` | `'capacitor'` | |
| `requestFrame` / `cancelFrame`, `embed` | the WebView's `requestAnimationFrame`, via `base` | |
| `openExternal(url)` | `Browser.open` (an in-app sheet; every activation opens, `invalid` for a bad URL) | `base.openExternal` (`window.open`) |
| `copyText(text)` | `Clipboard.write` → `'copied'`, `'manual'` on a rejection | `base.copyText` |
| `clipboardWriteAllowed()` | `true` | `base`'s answer |
| `fullscreen` | `available()` and the `active` getter false, `toggle()` resolves false; `toggle({ lockLandscape: true })` calls `ScreenOrientation.lock({ orientation: 'landscape' })` | the same, without the lock |
| `storage` | `kind: 'preferences'`: a synchronous `StorageLike` over an in-memory mirror of `Preferences` (keys prefixed `tc:`), reads from the mirror, writes through in order; `open()` is null until `await host.ready` | `base.storage` (the WebView's `localStorage`) |
| `lifecycle` | `App` `appStateChange` / `pause` / `resume`; starts `active`, corrected from `App.getState()` | `base.lifecycle` (document visibility) |
| `haptics` | `Haptics.impact` (`LIGHT` / `MEDIUM` / `HEAVY`), `Haptics.notification`, `Haptics.vibrate`; `available()` true | `base.haptics` (`navigator.vibrate`) |
| `safeArea` | `base.safeArea`: `env(safe-area-inset-*)` from the WebView (needs `viewport-fit=cover` in the page's viewport meta) | |
| `window` | absent | |
| `back` (this host only) | `{ watch(fn: (e: { canGoBack }) => void): () => void }` over `App` `backButton` | absent |
| `ready` (this host only) | resolves when the Preferences mirror is loaded | resolves at once |

Why Preferences for saves: a WebView's `localStorage` can be evicted by the OS under storage
pressure and is not restored from a device backup; Preferences (`UserDefaults` / `SharedPreferences`)
survive both. The mirror keeps `StorageLike` synchronous, as the save store expects; a write that
the plugin rejects stays in the mirror and the next write still goes through.

## Wrapping a game: ten lines of config

```ts
// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.mygame',
  appName: 'My Game',
  webDir: 'dist', // the game's web build (vite build)
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' }, // the page reaches under the notch; the host's safeArea pads the UI
  android: { allowMixedContent: false },
  plugins: { SplashScreen: { launchAutoHide: true } },
};
export default config;
```

```sh
pnpm add @capacitor/core @capacitor/cli
pnpm add @capacitor/app @capacitor/browser @capacitor/clipboard @capacitor/haptics @capacitor/preferences @capacitor/screen-orientation
npx cap init                 # writes the config above if you do not already have one
pnpm build                   # the game's web build into webDir
npx cap add ios              # or: npx cap add android
npx cap sync                 # copies webDir and the plugins into the native project
npx cap open ios             # Xcode / Android Studio: run on a device
```

After each web build: `pnpm build && npx cap sync`. Keep `<meta name="viewport" content="...,
viewport-fit=cover">` on the page so `env(safe-area-inset-*)` reports the notch; the engine's
layout then pads its regions through `host.safeArea`.

## The Android back button

Registering any `backButton` listener turns off Capacitor's default (which leaves the app), so
decide once, in the game, what back means:

```ts
host.back?.watch(({ canGoBack }) => {
  if (ctx.stack.length > 1) ctx.stack.pop(); // close the top menu or panel first
  else if (ctx.ui.modal.open) ctx.ui.modal.close();
  else if (canGoBack) history.back(); // only if the game uses the WebView's history (most do not)
  else void App.minimizeApp(); // or App.exitApp(); the host.lifecycle flush has already run
});
```

On iOS there is no back button; the swipe-from-edge gesture is the WebView's history navigation,
which a single-page game never has, so nothing is needed. `host.back` is `undefined` when
`plugins.App` was not given.

## Lifecycle on a phone

`createGame` already watches `host.lifecycle`: on `background` it stops requesting frames and
flushes the save; on `active` it starts again, then calls `hooks.lifecycle(state)`. A game that
wants to autosave more than the store's debounced writes, or to pause its music, does it there:

```ts
ctx.hooks.lifecycle = (state) => {
  if (state === 'background') { ctx.save?.flush(); music.stop(); }
  else music.play('theme');
};
```

iOS may terminate a backgrounded app at any time, so treat `background` as "the last chance to
write"; the host's lifecycle fires it from `appStateChange`, which arrives before the WebView is
frozen.

## Checks

`pnpm check:host-capacitor` from the repo root (typecheck, Biome, Vitest), also run by `pnpm check`.
There is no e2e here: the facets are exercised against the web host on the engine's matrix
(`e2e/host.spec.ts`, `harness/host.html`), and this host's plugin mapping is covered by the unit
tests with fake plugins.
