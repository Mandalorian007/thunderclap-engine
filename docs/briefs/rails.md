# Brief: ws/rails (A1)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/ROADMAP.md` (Phase A), `docs/design/2.0/bar.md` §2 (TC's own rails) and §1.2 (WebKit timer finding), `docs/releasing.md`, and `playwright.config.ts`.

## Goal

The engine verifies itself where its games run. STATUS row *done when*: "WebKit project green on the subset; `check:bundle` and `check:wgsl` in `pnpm check`; publish.yml tags `-` versions `next`."

1. **WebKit.** A Playwright WebKit project on the iPad Pro 11 landscape profile (`devices["iPad Pro 11 landscape"]`). Run a chosen subset of specs on it (the boot, mesh, views, stream, bench one-rung, ui specs are a good start; pick what proves WebGPU, input and layout). Anything WebKit-specific that fails: fix it if it's a real engine bug in a file no wave-1 stream owns, otherwise mark the spec `test.fixme` on WebKit with a one-line reason and list it in the report. Add it to `test:e2e` so the integration train runs it.
2. **`check:wgsl`.** Every WGSL string the engine ships (scan `src/**` for WGSL sources the way Forge's `FW:../test/shaders.test.ts` does) has no `override` declaration (iPad WebKit refuses them). In `pnpm check`.
3. **`check:bundle`.** Per subpath gzip budgets: build each `exports` entry alone with Vite/esbuild-from-node_modules (whatever the repo already has; no new dependency) and compare against a committed `scripts/bundle-budgets.json` (today's sizes + ~5%). Also a **tree-shaking check**: a consumer importing only `render` pulls no code from `ui`, `audio` or `voxel`; a consumer importing only `./input` pulls no renderer. Print a table; fail on a budget breach. In `pnpm check`.
4. **`next` publishing.** `publish.yml`: a version with a `-` (e.g. `2.0.0-next.0`) publishes with `--tag next`, never `latest`; `pnpm release` accepts such versions. Document in `docs/releasing.md` ("Prereleases").
5. Set the root `package.json` version to `2.0.0-next.0` and open the CHANGELOG `## Unreleased` section for 2.0 if the release script needs it (don't tag anything).

## Files owned

`playwright.config.ts`, new `scripts/check-wgsl.mjs`, `scripts/check-bundle.mjs`, `scripts/bundle-budgets.json`, `scripts/release.mjs`, `.github/workflows/*`, `package.json` (scripts, version), `docs/releasing.md`, specs only to add WebKit skips/fixmes.

## Gate

common.md, plus the WebKit project run on its subset, green.
