# Brief: ws/flake-client

Read `docs/briefs/common.md` first, then DECISIONS E-011 (the e2e determinism rule), E-013; `e2e/client.spec.ts`, `e2e/fixtures.ts` (`openGameHarness`), `harness/game.ts`, `harness/game-state.ts`.

## Goal

`e2e/client.spec.ts` "the full mode reads storage through the host" never races the game loop again. Observed once on `desktop-1280`: `expect(s.updates).toBeGreaterThan(0)` got 0; `openGameHarness` waits for three rendered frames, and in fixed-step mode frames can render before a 1/60 s update has run.

STATUS row, *done when*: client spec waits for the condition it asserts (poll `updates > 0`, or the fixture waits for one update), no other spec reads a loop counter once without polling; matrix green.

## Scope

- Make the assertion wait for the state it needs (`expect.poll` or a `waitForFunction` on the harness state), or make `openGameHarness` wait for an update when the page runs fixed-step. Prefer the fixture fix if several specs read counters the same way; grep `e2e/*.spec.ts` for `updates`, `frames`, `ticks` read once and fix each the same way.
- Do not slow the matrix with fixed sleeps.
- No code under `src/`, no harness code change unless the state object lacks a field you need (then add the field, name it in the report).

## Files owned

`e2e/client.spec.ts`, `e2e/fixtures.ts`, `e2e/*.spec.ts` for the same pattern only, `harness/game-state.ts` (a field, if needed), `CHANGELOG.md` (one line).

Running alongside: wave 4 engineers each add their own `e2e/<page>.spec.ts` and do not touch `client.spec.ts` or `fixtures.ts`; ws/prune touched `e2e/mesh.spec.ts` comments only.
