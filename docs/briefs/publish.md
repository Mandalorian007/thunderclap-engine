# Brief: ws/publish

Read `docs/briefs/common.md` first, then E-037 and E-036 in `docs/DECISIONS.md`, your row in `docs/STATUS.md`, `package.json`, `packages/*/package.json`, `scripts/release.mjs` and `.github/workflows/ci.yml`. Read the root README's install and subpath sections.

## Goal

Make `@thunderclap-engine/engine` and the three host packages installable from the public npm registry. Publishing happens from a GitHub Action on a version tag, using npm trusted publishing (OIDC, no stored token). The user does the first publish by hand; this branch makes that a one-command job and makes every later release automatic.

STATUS row, *done when*:

- **Build.** `pnpm build` emits ESM JavaScript and `.d.ts` files to `dist/` for every subpath in `exports`. Use `tsc` with a `tsconfig.build.json`; no bundler is needed, because the engine has zero runtime dependencies. The output must run without Vite. Check for `?raw`/`?url` imports, `import.meta.env`, `.ts`-extension imports and anything else that only works under Vite or vitest. If any is found, fix it in the smallest way and list each fix in your report.
- **Published manifest.** The workspace keeps its `./src/*.ts` exports, so the harness, templates and tests don't change. The published package points at `dist/` through pnpm's `publishConfig` overrides (`exports`, and `types` and `main` if needed), with `types` before `import` in each condition. Set `files` to `dist`, `README.md`, `LICENSE` and `CHANGELOG.md`. Remove `"private": true`. Set `publishConfig.access: "public"` and `provenance: true`. Set `sideEffects` only to what is true; check for module-level side effects first and report what you find. Add `homepage`, `bugs` and `keywords`.
- **WebGPU types.** If the emitted `.d.ts` files reference `GPU*` types, a consumer needs `@webgpu/types`. Choose between an optional peer dependency and a documented install step, and say why in your report.
- **Host packages.** `@thunderclap-engine/host-electron`, `host-capacitor` and `host-pwa` get the same treatment at version `0.1.0`:
  - `@thunderclap-engine/engine` is a peer dependency (`^1.0.0`), not `workspace:*`, in the published manifest. Check how pnpm rewrites `workspace:` ranges at pack time.
  - Capacitor and Electron are peers, optional where a host works without them.
  - host-electron's `out/` shell bundle is included if consumers need it.
- **Pack smoke.** Add `scripts/pack-smoke.mjs` and `pnpm check:pack`. The script must:
  - `pnpm pack` all four packages;
  - install the tarballs into a fresh temp project outside the workspace;
  - typecheck and Vite-build a minimal file that imports `createGame` from the root and one value from each of `/render`, `/input`, `/ui` and `/voxel`, plus each host's create function;
  - fail if any file outside `files` is in a tarball, or if a tarball holds `src/` or tests.

  Add a `pack` job to `ci.yml`, appended only, that runs it.
- **Publish workflow.** Add `.github/workflows/publish.yml`:
  - Trigger on pushed tags `v*`.
  - Permissions: `id-token: write`, `contents: read`.
  - Use Node 24 and npm 11.5 or later, which trusted publishing needs.
  - Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `pnpm check:pack`.
  - Then `npm publish` for each of the four packages. Skip a package whose exact version is already on npm, so a tag that bumps only the engine still succeeds.
  - Fail if the tag's version doesn't match the root `package.json` version.
  - Use no secrets.
- **Releasing doc.** Add a `docs/releasing.md`, linked from the README, covering:
  - the one-time setup the user does: `npm login`, the first manual `pnpm build && npm publish` of each package from a clean `main`, then adding a trusted publisher on npmjs.com for each package (repository `Mandalorian007/thunderclap-engine`, workflow `publish.yml`), then turning on "require 2FA and disallow tokens";
  - the routine: `pnpm release <version> --tag`, then push the tag;
  - how to bump a host package.

  Update the README and `docs/guide/getting-started.md` install sections to `pnpm add @thunderclap-engine/engine`. `scripts/release.mjs` changes only if the docs need it, for example to print the tag push command.
- **Changelog.** Add a CHANGELOG `## Unreleased` *Added* line covering the build, the npm packages and `check:pack`.

## Files owned

`package.json` (manifest fields, plus new `build` and `check:pack` scripts), `packages/*/package.json`, `tsconfig.build.json` (and per-package ones), `scripts/pack-smoke.mjs`, `scripts/release.mjs`, `.github/workflows/publish.yml`, `.github/workflows/ci.yml` (append the `pack` job), `docs/releasing.md`, the README install and release sections, the `docs/guide/getting-started.md` install section, CHANGELOG.

`src/` is not yours except for the portability fixes the build needs; list each one. No public API changes, so `api/*.api.txt` must not change. Nothing else is running alongside.

## Not in scope

Running `npm publish`, `npm login` or pushing a tag; those are the user's. Moving Last Rune onto the package is a later stream in that repo.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px, and `pnpm check:pack` green. The 2D harness stays pixel-identical. Use `E2E_PORT_OFFSET=1470` for any spec you run. In your report, add the tarball file lists and sizes, plus `npm publish --dry-run` output for each package.
