# Changelog: @thunderclap/engine

Versions follow semver from `engine-v1.0.0` (Phase 5). Until then, `0.x` releases are tagged `engine-v<version>` on the Last Rune repo. The tag `engine-v0.1` marks the last state with the engine at `engine/` (Last Rune v1.0).

## 0.2.0-dev (unreleased)

Phase 1 of the refactor plan (D-041). Every promoted module is listed here before Gate 1.

### Changed
- The engine is a pnpm workspace package, `@thunderclap/engine`, at `packages/engine/`, with its sources under `src/`. The move kept git history (`git log --follow`).
- The public API is the `exports` map: `./audio`, `./core`, `./fx`, `./input`, `./platform`, `./post`, `./render`, `./save`, `./ui`, and `./testing` (the recording fake `GPUDevice`, which was `render/fake-gpu`). Deep imports such as `@engine/render/renderer` are no longer reachable from a game.
- The `@engine/*` path alias is gone. Games import `@thunderclap/engine/<module>`; engine modules import each other by relative path.
- The package has its own `tsconfig.json`, `vitest.config.ts` and `typecheck`, `lint`, `test` and `check` scripts.

### Added
- `ARCHITECTURE.md`: the contracts (Surface, Camera, Frame loop, Host, Input, Layout, UI/Audio/Save/FX/Post, Scene and Ctx), each marked as existing today or planned.
- An import-boundary check (`scripts/check-boundaries.mjs` at the repo root, run by `pnpm check`).
- The engine e2e harness (D-041 addendum 2). `harness/` is a noun-free page that boots the platform layer and publishes `window.__harness`. `e2e/` holds the specs and `playwright.config.ts` holds the matrix: desktop 1280×720 and 1920×1080, iPad 1180×820, four phones and an itch-style cross-origin iframe (`e2e/wrapper.mjs`). Its seed spec, `smoke.spec.ts`, checks WebGPU init, surface letterbox and resize, and one tap. Run it with `pnpm test:e2e` in the package or `pnpm test:e2e:engine` from the repo root.

No runtime behaviour changed: Last Rune's production bundle is byte-identical to the one built from `engine/`.
