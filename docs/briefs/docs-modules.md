# Brief: ws/docs-modules

Read `docs/briefs/common.md` first. Then read `scripts/check-docs.mjs` and the ws/docs-guide brief (`docs/briefs/docs-guide.md`) for the snippet-check contract. Then read every `src/*/README.md`.

## Goal

Every module reference opens the same way, so a reader gets oriented in 30 seconds and a long reference stays navigable. Do not delete any reference content.

The STATUS row is done when:

- **Every `src/<module>/README.md` opens with the same three parts.**
  1. A purpose paragraph of 3 sentences at most: what the module owns, and what it leaves to the game.
  2. **Quick use**: one short `ts` block preceded by `<!-- snippet:check -->` that shows the most common call. It must compile against the public entry points. Until ws/docs-guide's checker lands, verify each block yourself: copy them into a throwaway `.ts` file under `/tmp/dm-` and run the repo's `tsc` against the package. Say how you checked in the report.
  3. **Entry points**: a table of the 5–10 names a game uses first, each with one line.
- **A Contents list** under the opening, in every README over 300 lines (render, ui, fx, nav, assets, input, geom, post, audio).
- **No other changes to the body**, except fixing statements that are false on main today. List each fix in the report with the code line that proves it. The ws/doc-sweep-3 backlog line in STATUS names stale comments; it does not name README errors, so find the README errors yourself.
- `pnpm check:docs` stays green.
- **CHANGELOG:** one *Docs* line.

## Files owned

You own:
- `src/*/README.md`, with additions at the top only, plus the false-statement fixes
- `CHANGELOG.md`

Do not edit:
- any `.ts` file
- the root `README.md` and `docs/**` (ws/docs-guide owns them)
- `templates/**` and `demos/**`

ws/ui-11, ws/core-7 and ws/input-11 are editing sections in the ui, core and input READMEs. Keep your edits in those three to the opening block and the contents list, so the merges stay clean.

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1230`. Gate: `pnpm check` and `snap:check`.
