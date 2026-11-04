# Changelog: @thunderclap/engine

Versions follow semver from `engine-v1.0.0` (Phase 5). Until then, `0.x` releases are tagged `engine-v<version>` on the Last Rune repo. The tag `engine-v0.1` marks the last state with the engine at `engine/` (Last Rune v1.0).

## 0.2.0-dev (unreleased)

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

No runtime behaviour changed: Last Rune's production bundle is byte-identical to the one built from `engine/`.
