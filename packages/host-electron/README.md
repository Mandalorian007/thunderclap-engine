# @thunderclap-engine/host-electron

The ThunderClap desktop shell. A game's web build runs unchanged inside Electron, and the `Host`
interface (`@thunderclap-engine/engine/host`) is the only seam between them (D-041, Phase 4). The package
contains no game nouns. The engine never imports it, and it reaches the engine only through the
engine's exports map (`pnpm check:boundaries` enforces both).

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | What a game imports: `createElectronHost`, `electronBridge`, `inElectronShell`, `ThunderclapBridge` |
| `src/renderer.ts` | `createElectronHost()`, which satisfies `Host` over the bridge |
| `src/bridge.ts` | The bridge type and its IPC channel names, shared by all three sides and importing nothing |
| `src/preload/preload.ts` | The sandboxed preload that exposes `window.thunderclap`; built to `out/preload.cjs` |
| `src/main/main.ts` | The main process: window, WebGPU switches, `app://` protocol, network block, IPC; built to `out/main.mjs` |
| `src/main/policy.ts`, `switches.ts` | The main process's rules as pure, unit-tested functions |
| `harness/` | A noun-free page: boots WebGPU, clears each frame, publishes `window.__desktop`. It is the default renderer |
| `e2e/shell.spec.ts` | The Playwright Electron-driver smoke on the built shell |
| `bin/thunderclap-desktop.mjs` | The published `thunderclap-desktop` command: a game's `dev` loop and `package` step (see *Desktop dev and packaging for a game*) |
| `bin/desktop-config.mjs` | The packaging rules (`builderConfig`) and the game's `thunderclap.desktop` field (`readDesktopConfig`), shared by the bin and this repo's build |
| `scripts/build.mjs`, `dev.mjs`, `dist.mjs` | This repo's build of `out/`, dev loop on the harness, and packaging |
| `electron-builder.config.mjs` | This repo's packaging config (from `builderConfig`): unsigned Windows, macOS and Linux into `dist/desktop/` at the repo root (gitignored) |

## Using it from a game

```ts
import { createWebHost, setDefaultHost } from '@thunderclap-engine/engine/host';
import { createElectronHost, inElectronShell } from '@thunderclap-engine/host-electron';

const host = inElectronShell() ? createElectronHost() : createWebHost();
setDefaultHost(host); // or pass it to createGame / the game's ctx
host.window?.close(); // a desktop-only Quit entry
```

A game does this in one boot file with a dynamic import, so its web build never loads this package, and shows Quit only when `host.window` exists. The Last Rune does exactly this.

## Desktop dev and packaging for a game

The package ships a `thunderclap-desktop` command (#2), so a game needs no launcher or packaging script of its own. It is a bin rather than an exported electron-builder config plus a staging helper because the game then writes no code at all: one `package.json` field and two scripts. Install the tools it drives as the game's dev dependencies; this package keeps no runtime dependencies and lists them only as optional peers:

```sh
npm i -D @thunderclap-engine/host-electron electron electron-builder
```

(`vite` too, which a ThunderClap game already has.) Then name the app in the game's `package.json`:

```json
{
  "scripts": {
    "desktop:dev": "thunderclap-desktop dev",
    "desktop:build": "vite build && thunderclap-desktop package"
  },
  "thunderclap": {
    "desktop": {
      "productName": "My Game",
      "appId": "com.example.mygame",
      "icon": "build/icon.png"
    }
  }
}
```

| Key | Meaning |
|---|---|
| `productName` | Required to package. Names the app and its `userData` folder, where saves live: never change it after a release |
| `appId` | Required to package. The reverse-DNS bundle id |
| `icon` | A PNG of at least 512x512, relative to the game's folder; electron-builder makes the `.icns` and `.ico`. Default: Electron's icon |
| `version` | Default: the game's `package.json` `version` |
| `executableName` | The Linux executable. Default: the product name in kebab case |
| `renderer` | The built web app. Default: `dist` |
| `output` | Where artefacts go. Default: `dist/desktop` |

Unknown keys are an error, so a typo does not silently ship the default identity.

Run it in the game's folder:

| Command | What it does |
|---|---|
| `thunderclap-desktop dev` | Starts the game's Vite dev server (its own `vite.config`) on 127.0.0.1:5198 and opens it in the shell, with hot reload in the window. `--port <n>` picks the port; `--url <url>` uses a dev server you already run on this machine; `--dist [dir]` opens a built web app instead (default: `renderer`) |
| `thunderclap-desktop package` | Stages an app folder in the OS temp folder (this package's `out/main.mjs` and `out/preload.cjs`, the built game as `out/renderer/`, and a dependency-free `package.json`) and runs electron-builder on it with the shipped config (see *Packaging*). Flags: `--mac`, `--win`, `--linux` (default: this OS); `--dir` (unpacked only); `--renderer <dir>`, `--out <dir>`; `--dry-run` (stage, print the file list and config, and stop; needs no Electron or electron-builder) |
| `thunderclap-desktop --help` | Usage |

`package` never packages an earlier `dist/desktop/` that sits inside the renderer folder. Run the game's build first: `vite build` empties `dist/`, desktop builds included. In `dev`, the shell runs unpackaged from this package's folder, so its `userData` is this package's (`ThunderClap`), shared by every game you run this way; packaged apps use their own `productName`.

**If you write your own electron-builder config** instead: electron-builder collects `node_modules` from the project and the folders above it, so when the game is a workspace root, `files` needs `!**/node_modules/**` (the shipped config has it, and also stages outside the game's folder).

## The bridge: `window.thunderclap`

The preload runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. The page gets no Node, no `require` and no `ipcRenderer`. It gets only these members:

| Member | Main process |
|---|---|
| `version` (1), `platform` | Read-only values |
| `openExternal(url): Promise<boolean>` | `shell.openExternal`, only after `safeExternalHttps` passes: plain `https:`, no credentials, no whitespace. This is the same rule as the engine's `safeExternalUrl` (a unit test keeps them equal) |
| `copyText(text): Promise<boolean>` | `clipboard.writeText` |
| `fullscreen.get()`, `set(on)`, `onChange(fn)` | `BrowserWindow` fullscreen; `set` waits (up to 2 s) for macOS's animation |
| `window.minimize()`, `toggleMaximize()`, `close()`, `setTitle(t)` | The caller's `BrowserWindow` |

Every handler checks that the call came from the main frame of the shell's window on the page's own origin, and it checks every argument's type.

`createElectronHost()` maps the bridge onto `Host`:

- `kind: 'electron'`; `embed` is detected, so it is `top` in the shell.
- `openExternal` returns `invalid` for a bad URL without calling the bridge. Otherwise it returns `opened` for every activation, because a desktop window has no popup blocker.
- `copyText` returns `copied` when the bridge succeeds, else `manual`. `clipboardWriteAllowed()` is `true`.
- `fullscreen.active` is a synchronous getter and kept up to date by the main process's change events.
- `window` exposes `close`, `minimize`, `toggleMaximize` and `setTitle`. `HostWindow.setTitle?` was added to the engine for it.

## WebGPU switches

These are set with `app.commandLine.appendSwitch` before `ready`, so the build does not depend on what this Electron's Chromium enables by default (`src/main/switches.ts`):

| OS | Switches | Dawn backend |
|---|---|---|
| macOS | `--enable-unsafe-webgpu` | Metal |
| Windows | `--enable-unsafe-webgpu` | D3D12 |
| Linux | `--enable-unsafe-webgpu`, `--enable-features=Vulkan` | Vulkan |

`enable-unsafe-webgpu` turns WebGPU on where Chromium has not shipped it (Linux) and skips Chromium's WebGPU adapter blocklist. The game is WebGPU-only, so on a blocklisted adapter the alternative is no game at all.

For unpackaged runs only, `TC_GPU_SWITCHES="--a --b=c"` replaces the switches, for example to use SwiftShader on a headless Linux runner.

Electron 45.2.2 (Chromium 156) was verified on macOS arm64: the e2e and the packaged app both reach `gpu: ok` with `bgra8unorm`. Windows and Linux are built in CI but have not been run on hardware yet.

## Storage

Storage is the renderer's `localStorage`: the same backend, probe (`probeStorage`) and save format as the web host. This was a PM call, because the user wants browser-only storage for now.

The shell serves the page from one fixed origin, `app://bundle` (a privileged `standard` and `secure` scheme), so saves stay put across launches and updates. The data lives in Electron's `userData` folder, which is named from the product name (`extraMetadata.productName`). For that reason the scheme, the host and the product name must never change after a release.

There is one instance per `userData` (`requestSingleInstanceLock`), because a second instance would find `localStorage` locked.

**Open question (for the user): a file backend.** A `StorageLike` over a JSON file in `app.getPath('userData')` would make saves visible, easy to back up and independent of Chromium's LevelDB. A design for it:

- Main process: one file per save key under `userData/saves/`, written atomically (write a temp file, then rename). Synchronous reads at start through a preloaded snapshot.
- Bridge: `storage.snapshot()` once at boot, then `storage.set(key, value)` and `storage.remove(key)` as fire-and-forget IPC.
- Renderer: an in-memory `StorageLike` seeded from the snapshot and written through. `kind: 'file'`.

The versioning stays `engine/save`'s, unchanged. Moving existing saves would be a one-time copy out of `localStorage` on first launch. Nothing of this is built. Decide before a desktop release whether saves should follow the player outside the app.

## Security and network

- **No network at runtime.** The session cancels every request that is not the page's own origin (`app://bundle`, or the local dev server and its HMR socket in `desktop:dev`), `data:`, `blob:` or `devtools:`. Every `app://` response also carries a CSP with `connect-src 'self'`, `script-src 'self'` and no inline script. Spellcheck is off, so no dictionaries are downloaded.
- **Local files only.** `app://bundle/<path>` serves files from `out/renderer` (inside the asar), with a path guard (`bundleFile`). Unknown routes fall back to `index.html`.
- **No new windows, webviews, or navigation away.** A new-window request for a plain https URL from the page itself opens in the system browser through `shell.openExternal`, under the same rule as the bridge. That covers a `target="_blank"` link, such as the engine's link widget on a click or Enter. Every other new-window request is refused. Permission prompts are denied, except HTML fullscreen.
- **DevTools only when unpackaged.** On macOS the app has a minimal menu (app, edit, window). Elsewhere there is no menu bar.
- `TC_RENDERER_URL`, `TC_RENDERER_DIR`, `TC_USER_DATA` and `TC_GPU_SWITCHES` are honoured only when unpackaged.

## Scripts

From this repo's root (a game uses `thunderclap-desktop`, above):

| Command | What it does |
|---|---|
| `pnpm desktop:dev` | Builds main and preload, serves `harness/` with Vite on 127.0.0.1:5199, and opens it in Electron with hot reload. `pnpm desktop:dev --url http://localhost:5173` uses a dev server you already run instead |
| `pnpm desktop:build` | This package's `dist`: builds `out/` and packages for this OS into `dist/desktop/` at the repo root (gitignored). Flags: `--mac`, `--win`, `--linux`; `--dir` (unpacked only); `--renderer <dir>` (package another built web app, such as a game's `dist/`, instead of the harness; any `dist/desktop/` inside it is skipped) |
| `pnpm test:e2e:desktop` | Builds `out/` and runs `e2e/shell.spec.ts` with Playwright's Electron driver, a Playwright run of the shell on the desktop harness page |
| `pnpm check:host-electron` | Typecheck, lint and unit tests (also part of `pnpm check`) |

Electron downloads its binary on first use, not at install. electron-builder downloads its own copy when packaging. Both downloads happen at build time only.

## Packaging

The build is unsigned: no certificate, key or notarisation credential is used or read, and `CSC_IDENTITY_AUTO_DISCOVERY` is forced off.

| OS | Outputs |
|---|---|
| macOS | `.dmg` and `.zip` for the host arch. Ad-hoc signed (`identity: '-'`), so Apple silicon runs it. Gatekeeper still warns on first open |
| Windows | NSIS installer (`.exe`) and `.zip` (x64). Unsigned, so SmartScreen warns |
| Linux | `.AppImage` and `.tar.gz` (x64) |

The config comes from `builderConfig` in `bin/desktop-config.mjs`, for a game's `thunderclap-desktop package` and this repo's `pnpm desktop:build` alike. Its `files` are `out/**/*`, `package.json` and `!**/node_modules/**`, with asar on and no native rebuild.

A game names its identity in `thunderclap.desktop` (above). This repo's `pnpm desktop:build` defaults to `ThunderClap` / `dev.thunderclap.shell` with Electron's default icon, and takes these variables instead:

- `TC_PRODUCT_NAME` and `TC_APP_ID`;
- `TC_APP_VERSION`;
- `TC_ICON`: an absolute path to a PNG of at least 512x512.

Artefacts are named `<product name, spaces as dashes>-<version>-<os>-<arch>.<ext>`.

The CI job `desktop` in `.github/workflows/ci.yml` builds the harness shell for all three OSes and uploads the artefacts. It is non-blocking.

## Open questions

- **Code signing and notarisation** (macOS Developer ID, Windows Authenticode). These wait until the user supplies certificates. The config has the hooks, but no material belongs in the repo; it would go in CI secrets.
- **A file storage backend** (see Storage).
- **Linux AppImage on Ubuntu 24.04+**, where AppArmor restricts unprivileged user namespaces that Chromium's sandbox uses. It may need `--no-sandbox` or a `.deb` with an AppArmor profile. Not yet tested on a machine.
- **Auto-update.** There is none, and it would mean a runtime network call. It is out of scope unless the user asks for it.
