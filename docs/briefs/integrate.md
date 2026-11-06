# Integrator brief

You merge finished `ws/<name>` branches into `main` of `/Users/matthewfontana/repos/thunderclap-engine`. Never push.

Work in your own worktree, never in the main checkout (E-018: the PM commits docs there while you work, and a `git commit` of theirs would swallow your staged merge). Setup: `git -C /Users/matthewfontana/repos/thunderclap-engine worktree add --detach <scratchpad>/integrate-<name> main`, then `pnpm install --frozen-lockfile --offline` there. Your e2e run needs its own port: `E2E_PORT_OFFSET=<a multiple of 10 no other agent uses>` (the harness takes 4177+offset, its wrapper 4178+offset, bench 4179+offset, so neighbouring offsets collide).

## Steps, per branch in the order the PM gives

1. `git merge --no-ff --no-commit ws/<name>`, so the gates run before the commit even when nothing conflicts; commit with a message that names the workstream and ends with the attribution line the PM gives you.
2. Resolve conflicts by intent, not by side: read both branches' reports (the PM pastes them), keep every behaviour each branch added, and keep `ARCHITECTURE.md` and `CHANGELOG.md` entries from both. For a shared hot spot the PM names an order (for example camera first, then transforms) and the invariant to keep (the 2D path pixel-identical).
3. Semantic conflicts (a type one branch deleted that another reads) are fixed in the merge commit with the smallest change that keeps both branches' intent; name each in the report.
4. Run `pnpm install` if `package.json` or the lockfile changed, then `pnpm check` and `pnpm test:e2e`. Both must be green before you commit. If they are not and the fix is not small and obvious, stop and report; do not rewrite a branch's work.
5. Run `pnpm snap:check` after the merge (the 2D harness goldens in `e2e/golden/`, E-008 tolerance; diffs land in `screens/diff/`). A diff on a 2D page fails the merge unless the brief said the page changes; in that case the branch carries re-captured goldens (`pnpm snap`) and you keep them.
6. Commit in your worktree. Then land it: `git -C /Users/matthewfontana/repos/thunderclap-engine merge --ff-only <your HEAD>` (run from anywhere; it moves `main` and the PM's checkout together and refuses anything but a fast-forward). If it refuses because main moved (the PM's docs commits), `git merge main` in your worktree (docs only; keep both sides), rerun `pnpm check` only (a docs-only merge needs no e2e rerun; a code change on main does), commit, and land again. Tell the PM main's new hash. Only then take the next branch.
7. Remove your worktree (`git worktree remove --force`) and the branch worktrees the PM names. Nothing else.

A failure in a spec on the E-017 list (mesh.spec fog and drag, ui.spec menuNav) while every other test passes is the spec's, not the merge's: land, and say so in the report.

## Report back (under 300 words)

Merge commit hashes; every conflict resolved (file, what each side wanted, what you kept); semantic fixes; `pnpm check` counts and e2e passed/skipped/failed on the final `main`; anything the PM must decide or log.
