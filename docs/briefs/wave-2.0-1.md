# Wave 2.0-1: shared context (2026-11-14)

Every brief in this wave names this file. Read it after `common.md`.

## Why this wave exists

E-041: ThunderClap 2.0 becomes the foundation for many games (2D, varied 3D, VR), and Forge Wilds (a networked voxel game whose client is at `FW:` = `/Users/matthewfontana/repos/forgewilds/apps/web/src`, read-only) migrates onto it at feature parity. Flexibility comes first: what you build must serve games that are not Forge. Speed is tuned later, but the fast shape (retained, GPU-driven, views done once, no per-frame allocation) is designed in now.

## Who runs beside you

| Step | Branch | Owns | E2E_PORT_OFFSET |
| --- | --- | --- | --- |
| A1 rails | ws/rails | `playwright.config.ts`, `scripts/check-*.mjs` it adds, `.github/workflows/*`, `package.json` **scripts** (owner of package.json) | 100 |
| A2 budget | ws/budget | `src/testing/budget.ts` (+ test), `src/testing/index.ts`, `harness/bench*`, `docs/BENCH.md` | 110 |
| A3 kit | ws/kit | `src/core/game.ts` and new `src/kit/`, `src/index.ts`, `templates/*` wiring | 120 |
| B1 core-retained | ws/core-retained | new files under `src/render/core/`, `src/render/renderer.ts`, `src/render/fake-gpu.ts` (owner) | 130 |
| C1 voxel-data | ws/voxel-data | new files under `src/voxel/` (not the existing `chunks.ts` draw path) | 140 |
| C3 models | ws/models | new `src/models/` | 150 |
| C5 ui-spec | ws/ui-spec | new `src/ui/spec/` and edits under `src/ui/` it needs | 160 |
| C7 intents-quality | ws/intents-quality | `src/input/intents*`, new `src/quality/` | 170 |

**Shared files.** `package.json`: A1 owns it; C3, C7 and A3 may each add their one `exports` subpath (and its `publishConfig.exports` twin) and nothing else. `src/render/fake-gpu.ts`: B1 owns it; anyone else needing a fake-GPU change wraps it from their own file or writes the ask in their report. `ARCHITECTURE.md`, `CHANGELOG.md`, root `README.md`: everyone appends their own lines; the integrator keeps both sides. `api/*.api.txt`: regenerate, never hand-merge.

## Worktree

You are launched from the forgewilds checkout. Make your own worktree in the engine repo:

```sh
git -C /Users/matthewfontana/repos/thunderclap-engine worktree add .claude/worktrees/<step> -b ws/<name> main
cd /Users/matthewfontana/repos/thunderclap-engine/.claude/worktrees/<step> && pnpm install --frozen-lockfile --offline
```

Work only there. Never push, merge, or touch `main` or the main checkout. Keep a progress file at `.claude/worktrees/<step>/.progress.md` (gitignored by the worktree rule) and read it first after a compaction.

## Size and time

Aim for 1–3 hours. New logic stays under ~4k lines; past that, finish a coherent first part, report it, and list the rest. At 3 hours, wrap up what you have.

## The machine

Eight engineers share this machine. Use `nice -n 10` for `pnpm check`, run targeted `pnpm vitest run <files>` while working, and run `pnpm check` once at the end. Honor the e2e slot guard in common.md.
