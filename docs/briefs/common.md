# Common brief: every engineer agent

You are an engineer on one workstream of the ThunderClap engine (`/Users/matthewfontana/repos/thunderclap-engine`, a raw-WebGPU game engine in TypeScript with zero runtime dependencies). You work in your own git worktree.

## Branch

Your worktree may start from an old commit. First `git reset --hard main` (or the branch your brief says you stack on), then `git checkout -b ws/<name>` (rename the throwaway worktree branch if there is one). Then `pnpm install --frozen-lockfile --offline` in the worktree (the templates and packages have their own importers; `pnpm check` fails without it). Commit on that branch only. Never push. Never merge. Never touch `main`. Never check out branches in another repo you are told to read.

## Read first

`docs/VISION.md`, the `docs/DECISIONS.md` entries your brief names, `docs/STATUS.md` (your row), the `ARCHITECTURE.md` sections your brief names, and the README of each module you touch. Read nothing else up front; read on need.

## Rules

- **No game nouns.** Code joins the engine only if a shipped game uses it and the next game plausibly would, and its API names nothing from either.
- **One direction.** The engine never imports a game, the harness or the tests.
- **No runtime dependencies.** No network calls from the engine.
- **Rendering, not mechanics.**
- **Zero allocations per frame** in steady state on render paths.
- Stay inside the files your brief gives you. If you need a change in a file another workstream owns, write it down in your report instead of making it.
- Stop only your own processes, by PID.

## Done when

- `pnpm check` is green (typecheck, Biome, boundaries, Vitest, host-electron).
- **E2E (E-031).** Engineers do not run the full `pnpm test:e2e`; the integration train does. Your gate is `pnpm check` green, `pnpm snap:check` at 0 px, and every spec your branch owns or touches green on its own (`E2E_PORT_OFFSET=<n> pnpm test:e2e e2e/x.spec.ts`), run on your final head. Refactors leave the 2D harness pages pixel-identical. An e2e assertion on a value that moves over time polls (`expect.poll`); a single read is a flake waiting to happen.
  While `/tmp/thunderclap-e2e-slot1` exists, a train matrix is running. Do not start an e2e spec, `pnpm check` or `pnpm snap:check` until it is gone; poll with `while [ -d /tmp/thunderclap-e2e-slot1 ]; do sleep 60; done`. Editing and targeted `pnpm vitest run <file>` are fine.
  Write logs inside your own worktree (for example `.e2e-<branch>.log`, deleted before commit), never under a shared scratchpad name. Report the 1-min load (`uptime`) with each e2e result.
- Unit tests cover what you added; the fake GPU (`src/render/fake-gpu.ts`) covers renderer changes.
- `ARCHITECTURE.md` *Today* text, the module README and `CHANGELOG.md` ("Next (unreleased)") describe the change, in the same branch.
- Public API is exported only from the module's `index.ts`; new subpaths go in `package.json` `exports` and the root README table.

## Report back (under 400 words)

1. Branch, worktree path, commit hashes.
2. What shipped: public API added, changed or removed, exact names and signatures.
3. Gate: `pnpm check` test count; `snap:check`; each spec you ran with passed/failed.
4. Changes to shared files (function names and line ranges) for the integrator.
5. Decisions you made that the brief left open, and anything you wished another module offered.
6. Deviations from the brief, and anything you did not finish.

Every commit message ends with the project's attribution line: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (the user's convention for this repo, whatever model runs the session).
