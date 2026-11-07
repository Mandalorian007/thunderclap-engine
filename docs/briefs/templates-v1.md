# Brief: ws/templates-v1

Read `docs/briefs/common.md` first. Then read:
- DECISIONS E-036
- the *Deprecated* sections of `CHANGELOG.md`
- `templates/*/` end to end, and the create-game entry point
- the `demos/*/` entry files
- the ws/assets-4 wish about `third-person` `character.ts`
- the ws/api-render wish about positional `createSpriteMaterial` callers

## Goal

Every template and demo compiles with zero uses of deprecated engine names. When v1 removes the aliases, nothing a user copies breaks.

STATUS row, *done when*:

- **No deprecated names.**
  - Add a lint step, `pnpm check:deprecated` or a flag on the templates build, that typechecks `templates/**` and `demos/**` and fails on any use of an `@deprecated` engine export. Wire it into `pnpm check`.
  - If ws/docs-v1's snippet checker exposes a reusable helper, use it. Otherwise write a small one and say so, and the integrator will dedupe.
  - Migrate every hit, including the positional `createSpriteMaterial` callers.
- **third-person on `skinPose`.** `templates/third-person` poses its character with one `skinPose` call per frame. Its e2e spec stays green and its screenshot is unchanged.
- **Template polish for a first-time user.**
  - Each template has a README with what it is, how to run it, the files to edit first, and the engine guides it builds on.
  - `create-game` output runs its own `pnpm test` green out of the box, using the `./testing` kit for at least one game-logic test per template.
- **Gate:**
  - `pnpm check` green, including the new step, and `snap:check` at 0 px.
  - The template e2e specs alone, and the demo specs alone for every demo you touched.

## Files owned

You own:
- `templates/**`
- `demos/**`
- the create-game package or script
- the new lint script and its wiring in `package.json`
- `e2e/templates*` and `e2e/demos/*` (only to keep them green)
- `CHANGELOG.md`

Do not edit:
- `src/**`
- `docs/guide/**`, the root README or the `src/*/README.md` files, which belong to ws/docs-v1
- `api/`

Branch from origin/main once train 15 has landed. Use `E2E_PORT_OFFSET=1350`.
