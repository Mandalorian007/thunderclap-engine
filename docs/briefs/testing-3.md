# Brief: ws/testing-3

Read `docs/briefs/common.md` first, especially the *Post-1.0 API changes* rule. Then read the ws/testing-2, ws/input-12 and ws/render-11 notes and wishes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* line.

## Goal

The game-side tooling covers what it misses today.

STATUS row, *done when*:

- **Script coverage.** `scripts/check-deprecated-game.mjs` maps removed names that fail with errors other than TS6385:
  - a method that became a getter, such as `cache.stats()`
  - a call that became a read, such as `fullscreen.active()`
  - any other removed member whose error is TS2339 or TS2349 on an engine type

  Each one maps to its row in the migration guide. Add fixture tests for each.
- **Typed pointers in tests.** `TestGameOptions` gains a `P` type parameter, so `createTestGame` infers it from `pointers.testers` the way `createGame` does. It defaults to `any`, which is additive. Add a type test.

**Files owned:** `scripts/check-deprecated-game*`, `scripts/fixtures/deprecated-game/**`, `docs/guide/migrating-to-v1.md`, `src/testing/test-game.ts` (only the `TestGameOptions` generics; ws/core-9 owns the rest of the file, so keep your diff small), `api/testing.api.txt` and CHANGELOG.

Use `E2E_PORT_OFFSET=1430`. Gate: `pnpm check` and `snap:check`.
