# Brief: ws/testing-2

Read `docs/briefs/common.md` first, then the ws/render-10, ws/core-8, ws/assets-4, ws/api-core and ws/src-v1 wish lines in `docs/STATUS.md`. **Post-v1 rule:** `api/` is frozen. Additions are allowed, but each changed module needs a CHANGELOG `## Unreleased` *Added* line, and `check:api` enforces it. No breaking changes.

## Goal

Games can test failure paths headlessly, and the migration tooling is useful to a game repo.

STATUS row, *done when*:

- **Device loss.** `FakeDevice` has a `lost` promise and a `loseDevice(reason)` method. `createTestGame` exposes it. Test: losing the device halts the loop the way a real device loss does, and `ctx` reports it through the documented path.
- **Headless overlay.** Document the DOM requirement for the headless overlay, and if it is cheap, make `createTestGame({ overlay: false })` run with no DOM at all. Test it in a plain node environment.
- **Game-side deprecation script.** The migration guide's find-your-uses command gets a filter so platform deprecations such as DOM `execCommand` drop out. It must still work after 1.0.0 against a game repo that's on 0.x names. Use a fixture test.
- **Docs.** Update the testing README, `docs/guide/testing-your-game.md` and `docs/guide/migrating-to-v1.md`, add CHANGELOG *Added* lines, and run `api:update`.

**Files owned:** `src/testing/**`, `scripts/check-deprecated*`, the two guides, `api/testing.api.txt` and CHANGELOG.

Branch from origin/main. Use `E2E_PORT_OFFSET=1410`. Gate: `pnpm check` and `snap:check`.
