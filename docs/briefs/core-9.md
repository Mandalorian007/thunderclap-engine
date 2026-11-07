# Brief: ws/core-9

Read `docs/briefs/common.md` first, especially the *Post-1.0 API changes* rule. Then read the ws/testing-2, ws/input-12 and ws/render-11 notes and wishes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* line.

## Goal

Run a game with no overlay or DOM as a real core mode, not through the testing stand-in.

STATUS row, *done when*:

- **Core option.** `createGame({ overlay: false })` (or the existing option name, if core has one) skips every DOM touch: overlay, pages, fullscreen, and DOM listeners on the canvas host.
  - Accessing `ctx.ui` throws a clear error in this mode.
  - Test it in a plain node environment against the headless `{ gpu, clock, host }` path.
- **Testing hookup.** `createTestGame({ overlay: false })` uses the core mode. Delete `src/testing/null-dom.ts` if nothing needs it anymore, or say what still does.
- **Docs.** Update the core README and `docs/guide/testing-your-game.md`. Add a CHANGELOG *Added* line and run `api:update`.

**Files owned:** `src/core/**`, `src/testing/{test-game.ts,null-dom.ts,test-game-node.test.ts}`, `src/testing/README.md`, that guide, `api/` and CHANGELOG.

Use `E2E_PORT_OFFSET=1420`. Gate: `pnpm check`, `snap:check`, then the replay and ui specs run alone.
