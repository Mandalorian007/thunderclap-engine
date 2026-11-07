# Brief: ws/platform-surface

Read `docs/briefs/common.md` first, especially *Post-1.0 API changes*. Then read the ws/core-9, ws/testing-3 and ws/render-12 notes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* or *Fixed* line.

## Goal

A public `Surface` interface lets core's detached surface and any game-made surface type-check without casts.

STATUS row, *done when*:

- **The interface.** Export `Surface` as an interface: the members core and render actually use, such as size, dpr, letterbox, and `root` and `canvas`. The existing class implements it. This is additive; existing exports keep their types.
- **No cast.** `src/core/detached-surface.ts` implements `Surface` with no `as unknown as` cast. A type test shows a minimal game-made surface type-checks.
- **Name check.** Run the common.md collision check against `api/`.
- **Docs.** Update the platform README, add a CHANGELOG *Added* line and run `api:update`.

**Files owned:** `src/platform/surface*`, `src/platform/index.ts` (append only), `src/core/detached-surface.ts`, `api/` and CHANGELOG.

Use `E2E_PORT_OFFSET=1460`. Gate: `pnpm check` and `snap:check`.
