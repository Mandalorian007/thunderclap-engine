# Integrator brief

You merge finished `ws/<name>` branches into `main` of `/Users/matthewfontana/repos/thunderclap-engine`. Never push.

Work in your own worktree, never in the main checkout (E-018: the PM commits docs there while you work, and a `git commit` of theirs would swallow your staged merge). Setup: `git -C /Users/matthewfontana/repos/thunderclap-engine worktree add --detach <scratchpad>/integrate-<name> main`, then `pnpm install --frozen-lockfile --offline` there. Your e2e run needs its own port: `E2E_PORT_OFFSET=<a multiple of 10 no other agent uses>` (the harness takes 4177+offset, its wrapper 4178+offset, bench 4179+offset, so neighbouring offsets collide).

## Steps, per branch in the order the PM gives

1. `git merge --no-ff --no-commit ws/<name>`, so the gates run before the commit even when nothing conflicts; commit with a message that names the workstream and ends with the project's attribution line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the user set this convention for the repo; it applies whatever model runs the session).
2. Resolve conflicts by intent, not by side: read both branches' reports (the PM pastes them), keep every behaviour each branch added, and keep `ARCHITECTURE.md` and `CHANGELOG.md` entries from both. For a shared hot spot the PM names an order (for example camera first, then transforms) and the invariant to keep (the 2D path pixel-identical).
3. Semantic conflicts (a type one branch deleted that another reads) are fixed in the merge commit with the smallest change that keeps both branches' intent; name each in the report.
4. Run `pnpm install` if `package.json` or the lockfile changed, then `pnpm check` and `pnpm test:e2e` (a full run follows E-031: one train, `mkdir /tmp/thunderclap-e2e-slot1` held for the run, start under load 30). Both must be green before you commit. If they are not and the fix is not small and obvious, stop and report; do not rewrite a branch's work.
5. Run `pnpm snap:check` after the merge (the 2D harness goldens in `e2e/golden/`, E-008 tolerance; diffs land in `screens/diff/`). A diff on a 2D page fails the merge unless the brief said the page changes; in that case the branch carries re-captured goldens (`pnpm snap`) and you keep them.
6. Commit in your worktree. Read the e2e summary first; the land command is a separate step, never chained in the same shell line as the test run (E-020). Then land it: `git -C /Users/matthewfontana/repos/thunderclap-engine merge --ff-only <your HEAD>` (run from anywhere; it moves `main` and the PM's checkout together and refuses anything but a fast-forward; never pipe it into `tail` or anything else: a pipe hides the exit code and a refused merge once passed unnoticed). If a merge of main brings `package.json` or `pnpm-lock.yaml` changes, run `pnpm install --frozen-lockfile --offline` before `pnpm check`. If it refuses because main moved, `git merge main` in your worktree (keep both sides), then: if main's new commits are docs only, or code whose changed files are disjoint from your branch's changed files (compare `git diff --name-only <old main> <new main>` with `git diff --name-only <merge-base> ws/<name>`; shared docs like CHANGELOG, README, ARCHITECTURE never count as overlap; nor do module barrels `src/**/index.ts` when git auto-merged them and `pnpm check` is green, E-029: name the waived barrels in your report), rerun `pnpm check` only, commit, and land (E-025). If any `src/`, `harness/`, `e2e/`, `demos/`, `templates/` or config file overlaps, rerun the full e2e (and snap:check for a 2D file) first. Start a matrix when the 1-minute load average is under 40. Tell the PM main's new hash. Only then take the next branch.
7. Remove your worktree (`git worktree remove --force`) and the branch worktrees the PM names. Nothing else.

A failure in a spec on the E-017 list (ui.spec menuNav, skin.spec joints sway, stream.spec streamed geometry on screen; the dungeon pad walk left the list when ws/demo-polish landed, E-027) while every other test passes is the spec's, not the merge's: land, and say so in the report.

## Report back (under 300 words)

Merge commit hashes; every conflict resolved (file, what each side wanted, what you kept); semantic fixes; `pnpm check` counts and e2e passed/skipped/failed on the final `main`; anything the PM must decide or log.

> Note (2026-11-06): since `templates/first-person` landed as a workspace package, a fresh integration worktree needs `pnpm install --frozen-lockfile --offline` before `pnpm check` can pass; this changes no tracked file.

> E-026 (2026-11-06): if main moved only by docs (`docs/**`, README, CHANGELOG, ARCHITECTURE), merge it and run `pnpm check:docs` + `pnpm lint` only, then land. Any other file → `pnpm check`; E-025 decides e2e.

> Before landing, `git grep -n '^<<<<<<<\|^>>>>>>>' HEAD -- . ` must be empty: a resolver pass once committed stale markers (chain 3, ws/audio-2) and only a grep caught it.

- **Silent removals.** After each member merge, run `git diff <pre-merge main> HEAD -- ARCHITECTURE.md README.md CHANGELOG.md src/*/README.md | grep '^-[^-]'`. Account for every removed line: either the member's brief owns that change, or you restore the line. A branch carrying a stale merge of main can drop lines with no conflict (train 13, core-7).
