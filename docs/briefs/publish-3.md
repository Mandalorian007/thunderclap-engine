# Brief: ws/publish-3

Read `docs/briefs/common.md`, E-037 and E-038 in `docs/DECISIONS.md`, `docs/releasing.md`, `packages/host-electron/README.md`, `scripts/pack-smoke.mjs`, and the "Publishing follow-ups" entry in `docs/IDEAS.md`. GitHub issue #2 (`gh issue view 2`) is the ask.

Read the game-side workaround without checking anything out: `git -C /Users/matthewfontana/repos/last-rune show origin/main:scripts/desktop/build.mjs` and `…:scripts/desktop/dev.mjs`. The Last Rune should be able to delete both and call the package instead.

## Goal

A game gets a working desktop dev loop and a packaged app from `@thunderclap-engine/host-electron` on npm alone, and the published packages stay safe for consumers on current TypeScript.

STATUS row, *done when*:

- **Desktop entry points (#2).** The published `host-electron` carries a `bin` (for example `thunderclap-desktop dev` and `thunderclap-desktop package`) or an exported electron-builder config plus a staging helper, whichever is simpler for a game; say why. `dev` launches Electron on the game's Vite dev server or built `dist/`; `package` stages the game's build and runs electron-builder with the shipped config. The game names its app id, product name and icons through a small config (`package.json` field or a file); nothing names a game. electron-builder stays a dependency the *game* installs (a peer or documented dev dependency), so the host keeps no runtime dependencies. The package README documents it, including that `files` needs `!**/node_modules/**` when the game is a workspace root.
- **Proof.** `check:pack` installs the packed host into its consumer project and runs the bin's `--help` (or a dry-run staging step) successfully. The repo's own `pnpm desktop:dev` / `desktop:build` keep working.
- **WebXR types (IDEAS).** `check:pack` adds a consumer with `@types/webxr` installed and `skipLibCheck: false` that imports the engine. If it clashes with `src/platform/xr-types.d.ts`, **stop and report** the errors and a proposed fix (a renamed or module-scoped declaration is an API question for the PM); don't change `src/`.
- **Stale docs.** The root README *Status* section says the current version (1.1.0 published to npm, not "1.0.0"), and ARCHITECTURE *Package shape* and *Workspace* describe today: a `dist/` build published to npm, the three host packages, no "not on npm yet" or "until Phase 5".
- CHANGELOG `## Unreleased` *Added* line for the host's entry points, citing `(#2)`; the host's own version stays as is (the PM bumps at release).

## Files owned

`packages/host-electron/**` (scripts, `package.json`, README, any new `bin/`), `scripts/pack-smoke.mjs`, the root `package.json` scripts only, root README *Status* section and the Packages paragraph, ARCHITECTURE *Package shape* and *Workspace* paragraphs, `docs/releasing.md`, CHANGELOG. Leave `src/` and `api/` alone.

Running alongside: ws/surface-fill (`platform/surface.ts`, `core/game.ts`, `ui/styles.ts`, ARCHITECTURE *Surface* / *Layout*) and ws/xr-fixes (`core/loop.ts`, XR, post, renderer, world panels). Don't edit their files.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px, `pnpm check:pack`, and `pnpm test:e2e:desktop` green.
