# Brief: ws/xr-types

Read `docs/briefs/common.md`, E-036, E-037 and E-039 in `docs/DECISIONS.md`, `docs/releasing.md`, the ARCHITECTURE *Package shape* and the platform part of **UI, Audio, Save, FX, Post, Platform**, and `src/platform/README.md`.

## Goal

A game can install `@types/webxr` (or get WebXR from a future lib.dom) beside the engine and typecheck with `skipLibCheck` off. Releases can be cut from an integrator's worktree.

STATUS row, *done when*:

- **Engine-owned XR types (E-039).** `src/platform/xr-types.d.ts` declares nothing global. Turn it into a module (for example `src/platform/xr-types.ts` with exported interfaces and types) that `xr-surface.ts`, `xr-fake.ts`, `host/xr.ts`, `input/xr-source.ts`, `core/game.ts` and the rest import from. `navigator.xr` and the `XRGPUBinding` global are read through typed casts of `globalThis`, never through a `Navigator` or `var` augmentation. Every engine XR type stays a structural subset of `@types/webxr`'s, so a value typed by `@types/webxr` is assignable to every engine parameter. Fix the `build.mjs` / `preserve="true"` handling that existed only for the ambient file.
- **Proof.** `--webxr` folds into `pnpm check:pack`, and the consumer passes with and without `@types/webxr` (`skipLibCheck: false`). With `@types/webxr`, the consumer passes a `@types/webxr` `XRSession` and `XRFrame` into the engine's public XR entry points (whatever `createGame({ xr })` / `XrSurface` / `host/xr` take). It needs the registry or npm's cache today; vendor a pinned `@types/webxr` tarball under `scripts/fixtures/` if that is what keeps `check:pack` offline-safe, and say which you chose. `xr.spec.ts` and the XR unit tests stay green.
- **Release from a worktree (E-039).** `scripts/release.mjs` accepts HEAD on `main` or a detached HEAD equal to `main`'s commit, and its release commit message ends with the project's attribution line. A unit test covers both.
- **Scaffold.** `scripts/create-game.mjs` `PUBLISHED = true`, so a new game depends on `@thunderclap-engine/engine` `^<version>` from npm. Fix its stale "not on npm yet" comment and the ARCHITECTURE sentence that describes it. Its tests are updated.
- `api/*.api.txt` via `pnpm api:update`. The type names may now print from the module; the diff must show no member removed or narrowed. CHANGELOG `## Unreleased` *Fixed* lines name each change (the XR one names the `@types/webxr` clash), plus the platform README and ARCHITECTURE.

## Files owned

`src/platform/xr-types.*`, the XR type imports (only) in `src/platform/xr-surface.ts`, `xr-fake.ts`, `src/host/xr.ts`, `src/input/xr-source.ts`, `src/core/game.ts` and any other file that names an XR type; `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `scripts/release.mjs` (+ tests), `scripts/create-game.mjs` (+ tests), the root `package.json` scripts, `docs/releasing.md`, READMEs, ARCHITECTURE lines for these, CHANGELOG, `api/`.

## Rules

If keeping the subset relation forces a breaking change to an engine signature, stop and report the signature and the error; don't write it.

## Gate

`pnpm check`, `pnpm snap:check` at 0 px, `pnpm check:pack` (now with the webxr consumer), and `e2e/xr.spec.ts` green on its own.
