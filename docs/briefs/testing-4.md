# Brief: ws/testing-4

Read `docs/briefs/common.md` first, especially *Post-1.0 API changes*. Then read the ws/core-9, ws/testing-3 and ws/render-12 notes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* or *Fixed* line.

## Goal

The game-side deprecation script and the snippet checker lose their last gaps.

STATUS row, *done when*:

- **Paren receivers.** `scripts/check-deprecated-game.mjs` resolves receivers wrapped in parentheses or assertions, such as `(x as T).m()`, `(<T>x).m()` and `x!.m()`, to the engine type, and reports them. Add a fixture test.
- **Getter rows.** `scripts/check-snippets.test.mjs` exempts the migration guide's getter-table rows the way it exempts overload rows, so their *Module* cells can carry backticks again. Restore the backticks.

**Files owned:** `scripts/check-deprecated-game*`, `scripts/check-snippets*`, `scripts/fixtures/deprecated-game/**`, `docs/guide/migrating-to-v1.md` and CHANGELOG.

Use `E2E_PORT_OFFSET=1470`. Gate: `pnpm check`.
