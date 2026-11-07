# Brief: ws/nav-6

Read `docs/briefs/common.md` first, then the ws/nav-4 and ws/nav-5 rows and notes in `docs/STATUS.md`. Then read:
- `src/nav/mesh/navmesh.ts` (`bakeNavMesh`, `NavBakeOptions`)
- `src/nav/README.md`, *Baking*
- `scripts/bake-nav.mjs`
- the root README *Baking* section and its `bake.config.json` example

## Goal

`bakeNavMesh` never silently returns nothing. Today, leaving out `agentHeight`, climb or slope gives NaN cells and 0 polys with no error.

STATUS row, *done when*:

- **Defaults.** Every numeric option in `NavBakeOptions` gets a documented default derived from `cellSize`:
  - `cellHeight = cellSize / 2`
  - `agentHeight = 2`
  - `agentRadius = cellSize * 2`
  - `maxClimb = cellHeight * 2`
  - `maxSlopeDeg = 45`

  Pick the values that make the nav5 and arpg bakes unchanged. Check this with a test that bakes those sources both with explicit options and with defaults and gets identical polygons.

  `cellSize` stays required, with a default only if every caller agrees on it.
- **Validation.** Non-finite or out-of-range values throw a `NavBakeError` that names the option and the value. A bake that yields 0 polys from non-empty input warns once through the engine's existing warning path, if there is one; otherwise it returns `stats.empty: true`.
- **The bake script.** `bake-nav.mjs` gets the same defaults. Add a node test for it, wired into `check:bake` or a new script that `pnpm check` runs. Fix the root README example.
- **Docs.** The nav README *Baking* section gets a table of options with their defaults, plus the types list and a CHANGELOG line.

## Files owned

You own:
- `src/nav/**`
- `scripts/bake-nav.mjs` and its new test
- `package.json`, the `check:bake` script line only
- the root `README.md` *Baking* section
- `CHANGELOG.md`

Do not edit:
- `demos/**`, `harness/**`
- other `src/**`

Branch from `main` (cd856e0 or later). Use `E2E_PORT_OFFSET=890`. Gate per E-031, with the nav, nav4, nav5 and demos/arpg specs each run alone.
