# Brief: ws/src-v1

Read `docs/briefs/common.md` first. Then read:
- DECISIONS E-036
- `docs/guide/migrating-to-v1.md`
- the ws/docs-v1 and ws/core-8 notes in `docs/STATUS.md`
- `scripts/check-snippets.mjs`, for `findDeprecatedUses`
- the ws/templates-v1 lint script

## Goal

The engine's own source uses no deprecated names. That is the last step before v1 can delete the aliases and freeze `api/`. ws/docs-v1 counted 240 internal uses.

STATUS row, *done when*:

- **Zero internal uses.** `findDeprecatedUses` (or the templates-v1 lint) run on `tsconfig.json` reports 0 for `src/**`, `harness/**`, `e2e/**` and `packages/**`.
  - Tests that exist only to cover a deprecated alias keep their use. Mark each one with a `// deprecated-alias test` comment, and have the checker skip those lines.
  - Wire the check into `pnpm check`, so a new internal use fails the gate.
- **Mechanical.** Each change is a rename to the v1 name in the migration guide. Behaviour and rendered pixels do not change.
- **Stale comments.** Fix comments that the renames make wrong, including the `src/fx/render10.test.ts` note and the CHANGELOG note saying WorldPanel is right for `renderer.target` only. core-8 fixed WorldPanel.
- **One checker.** Merge `scripts/check-deprecated.mjs` (templates-v1) and `findDeprecatedUses` in `scripts/check-snippets.mjs` (docs-v1) into one module that covers snippets, templates, demos and src. Keep the `pnpm check:*` names working.
- **Alias removal plan.** Do not remove the aliases. Add `docs/guide/migrating-to-v1.md` § *Removal*: one line saying they go in the v1.0.0 release, plus the command a game runs to find its own uses.
- **Gate:**
  - `pnpm check` and `snap:check` at 0 px.
  - The full e2e once under the slot. This branch touches every module, so the train matrix is the real gate. Run the full suite only if load is under 20.

## Files owned

You own:
- `src/**`, `harness/**`, `e2e/**` and `packages/**`, for renames only
- `scripts/`, for wiring the check
- CHANGELOG

Do not edit:
- `templates/**` or `demos/**`. They belong to templates-v1, which has already migrated them.
- `api/`. It must not change; if it does, you renamed an export rather than a use.

Branch from origin/main after train 16 lands. Use `E2E_PORT_OFFSET=1370`.

Nothing runs alongside you in `src`. Keep it that way: this is a whole-repo rename.
