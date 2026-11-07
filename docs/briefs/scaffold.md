# Brief: ws/scaffold

Read `docs/briefs/common.md` first, then `docs/VISION.md` (the yardstick: a game should be trivial to start), DECISIONS D-051 (games consume the engine from their own repo); `templates/puzzle/` whole (package.json, CLAUDE.md, index.html, src layout, vitest config); `git show ws/template-first-person --stat` and its `templates/first-person/package.json` + `CLAUDE.md` (landing via chain 2; your script must handle it when it exists on main); `scripts/release.mjs` (house style for a Node script: no deps, argv parsing, exit codes); root `README.md` *Templates* and *Getting started*; `package.json` scripts.

## Goal

Starting a game is one command. `pnpm create-game <dir> --template puzzle|first-person` copies a template out of this repo into a standalone project that installs the published engine (`@thunderclap-engine/engine` from the registry, or a `file:`/`link:` path with `--engine <path>` for local work), renames the package, rewrites the imports that pointed at the workspace, and leaves a `CLAUDE.md` that names the engine concepts the template uses. No runtime code in `src/`.

STATUS row, *done when*: `scripts/create-game.mjs` (`pnpm create-game <dir> [--template <name>] [--name <pkg>] [--engine <spec>] [--force] [--dry-run]`) copies `templates/<name>` to `<dir>` minus `node_modules`, `dist`, `.turbo`, lockfiles; rewrites `package.json` (name from `--name` or the directory's basename, `private: true`, `@thunderclap-engine/engine` from `workspace:*` to `--engine` or `^<current engine version from the root package.json>`, drops `check` sub-scripts that reference the monorepo), writes `.gitignore`, `README.md` (how to run, where the engine docs are) and keeps the template's `CLAUDE.md`; refuses a non-empty target without `--force`; `--dry-run` prints the plan; `--list` prints templates with their one-line descriptions read from each `package.json`; a test (`scripts/create-game.test.mjs` under Vitest's node project or a `node --test` file wired into `pnpm check`) scaffolds into a temp dir, asserts the rewritten manifest and the file set, and runs `tsc --noEmit` there against the engine via `--engine link:<repo>` (skip that last step when offline-only install would be needed: assert the manifest instead and say so); documented.

## Scope

- `scripts/create-game.mjs`: Node ≥ 20, no dependencies, `fs.cp` with a filter, JSON rewrite preserving key order, colourless output, exit 1 on misuse with usage text.
- `package.json`: `"create-game": "node scripts/create-game.mjs"` and the test in `check`.
- Each template gains a `templates/<name>/template.json`? No: read `description` from its `package.json` and keep templates untouched (ws/template-first-person is landing). If a template needs a rewrite rule beyond `package.json`, add it to a small table in the script keyed by template name.
- Docs: root `README.md` *Getting started* (the one command, then `pnpm dev`), `docs/OFFERING.md` one line (if it exists on main when you branch), `CHANGELOG.md`, `ARCHITECTURE.md` *Repository* or *Templates* one sentence if a paragraph fits.

## Files owned

`scripts/create-game.mjs`, `scripts/create-game.test.mjs` (or `.test.ts` under the vitest node project; say which), `package.json` (two script lines), root `README.md` (*Getting started*), `CHANGELOG.md`, `ARCHITECTURE.md` (one sentence), `docs/OFFERING.md` (one line, if present).

Branch from `main` (a5a4f81 or later). Running alongside: chain 2 landing `templates/first-person` (do not edit templates), ws/geom adding a `./geom` export to `package.json` (different lines), chains 1/3/4 touching render, input, anim, ui. Use `E2E_PORT_OFFSET=140` (you likely need no e2e, but run the full gate anyway).
