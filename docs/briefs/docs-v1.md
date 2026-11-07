# Brief: ws/docs-v1

Read `docs/briefs/common.md` first. Then read:
- DECISIONS E-036, the v1 API conventions
- the *Deprecated* sections of `CHANGELOG.md`
- the root `README.md` end to end
- every file in `docs/guide/`
- `docs/OFFERING.md`
- `scripts/check-snippets*` (or whatever `check:snippets` runs)
- the README of each module you touch

## Goal

The root README and the guides are what a new developer reads to ship a game. After this branch, every line in them is true of today's API, every example uses the v1 names, and a reader can go from `pnpm create` to a running 2D or 3D game without opening `src/`.

STATUS row, *done when*:

- **No deprecated names in the docs.**
  - Extend `check:snippets` so a checked snippet that uses an `@deprecated` export fails. Use the TypeScript deprecation diagnostic (code 6385/6387) or an equivalent check on the type checker. Unit-test the check with a fixture that uses a deprecated name.
  - Then fix every hit in the root README, `docs/guide/*` and the `src/*/README.md` snippets.
  - Known stale prose:
    - README:216 and OFFERING:95 say `PlayOptions.at`; the v1 name is `AudioPlayOptions.at`.
    - ARCHITECTURE's input *Today* text predates input-10, input-11 and api-core.
    - Docs still call `createSpriteMaterial` with positional arguments.
- **Front door.** The root README follows *what it is → quick start → first game → guides → modules → testing → status*.
  - The quick start is the shortest true path: `pnpm create thunderclap-game` (or whatever create-game actually is), then dev, then a screenshot of the result.
  - *Features* lists only what ships, with a link per bullet to its guide or module README.
  - The test count and page count lines stay accurate.
- **Migration guide.** Add `docs/guide/migrating-to-v1.md`. It has a table of every deprecated name, its v1 replacement and the module, built from the CHANGELOG *Deprecated* sections and the `@deprecated` tags in `api/*.api.txt`.
  - Add a unit test that fails when an `@deprecated` export in `api/` is missing from the table, so it can't drift.
  - Link the guide from the README's *Guides* list.
- **Guide pass.** Each guide in `docs/guide/` opens with *what you'll build*, uses `createGame` and the testing kit (`createTestGame`, the fake host, the fixed clock) where it tests anything, and ends with *next* links.
  - `testing-your-game.md` must show the `./testing` kit as it landed in train 14.
  - `characters.md` was just rewritten around `skinPose` by ws/assets-4, so only check it for accuracy.
- **Gate:** `pnpm check` green with the new deprecation check on. Docs and checks only, so no e2e beyond `snap:check`.

## Files owned

You own:
- the root `README.md`
- `docs/guide/**`
- `docs/OFFERING.md`
- `ARCHITECTURE.md` (the *Today* prose only, not the contracts)
- the `src/*/README.md` files, snippets and prose only
- `scripts/` (the snippet checker) and its tests
- `CHANGELOG.md` (a *Docs* block)

Do not edit:
- `src/**/*.ts`. A doc that can't be made true without a code change is a wish.
- `templates/**` and `demos/**`, which belong to ws/templates-v1, running alongside you.
- `docs/{STATUS,DECISIONS,VISION,PM}.md` and `docs/briefs/`.

Branch from origin/main once train 15 has landed. Use `E2E_PORT_OFFSET=1340`.
