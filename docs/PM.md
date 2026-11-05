# PM: how work runs in this repo

*Adapted 2026-11-05 from Forgewilds' `docs/PM.md` and `docs/briefs/` (E-005). Forgewilds merges through PRs; this repo merges branches directly, so the integrator does what its merge script does.*

## Roles

| Role | Who | Owns |
| --- | --- | --- |
| User | the human | vision calls, the forks the PM brings (at most three per track, each with a recommendation), pushes and releases |
| PM | the main session | `docs/VISION.md`, `docs/DECISIONS.md`, `docs/STATUS.md`, `docs/PM.md`, `docs/briefs/`; waves, briefs, dispatch, the tracker. **The PM never writes or merges code.** |
| Engineer | one agent per workstream, in its own worktree | one `ws/<name>` branch; the code, tests, module README, `ARCHITECTURE.md` *Today* text and `CHANGELOG.md` entry for that change |
| Integrator | an agent the PM dispatches per merge | merging a green branch to `main`, resolving conflicts, re-running the gate on the merged tree, reporting what was resolved |
| Reviewer | an agent, only when a branch needs one | an unanchored read of a diff; it fixes, it does not send lists back |
| Research | an agent | a proposal in the scratchpad, never in the repo until the PM accepts it |

## One workstream, start to finish

1. The PM writes the brief (below) and the STATUS row with its *done when*.
2. The engineer works in its worktree, on its branch, inside its file ownership. It runs the gate once on its final head and reports in the report format.
3. The PM reads the report, decides, logs in DECISIONS if a decision was made, and dispatches an integrator with the branch and the merge order.
4. The integrator merges, resolves, runs `pnpm check` and the e2e matrix on the merged `main`, commits, and reports counts and every conflict it resolved.
5. The PM updates STATUS (hash, counts) and starts the next wave the merge unblocked.

While an integrator is working, the main checkout is **its**: the PM writes no files and runs no `git commit` there until the report arrives (a PM docs commit once closed an in-progress merge under the wrong message).

## Briefs

A brief is the whole context an engineer gets, so it carries:

- the goal, and the STATUS row's *done when*, quoted;
- the docs to read first (VISION, the DECISIONS entries that bind it, the ARCHITECTURE sections, the module READMEs);
- the branch name and the worktree rule (`git checkout -b ws/<name>`, commit there only, never push, never merge, never touch `main`);
- **files owned**, and what runs alongside with *its* files, so nobody edits the other's;
- what may change on purpose and what must stay bit-identical (the 2D harness pages, as a rule);
- the gate to run and the docs to update in-branch;
- the report format.

`docs/briefs/common.md` holds the shared text; a brief adds only what is specific.

## Waves and sizing

- Steps in one wave own disjoint files. A step that needs another's output stacks on that branch's head rather than waiting for the merge.
- Target one to three hours of agent time per step; batch anything under ~500 lines into a neighbour; check on an agent past three hours; split past four.
- Keep the agent count to what the file ownership allows; six wave-1 agents on a 15k-line library already shared `renderer.ts` and `game.ts`.
- Shared files that two steps must touch (`renderer.ts`, `wgsl.ts`, `core/game.ts`, `package.json`, `ci.yml`) get a named owner and an edit scope for the other; the integrator resolves the seam in the order the PM states.

## The gate

`pnpm check` (typecheck, Biome, boundaries, Vitest, host-electron) and `pnpm test:e2e` on the harness matrix. Both green on the branch head before a merge is requested, and both green on the merged `main` before the integrator commits. No retries for flakes: a flaky test is a bug to fix. Refactors (camera, transforms, render call) must leave the 2D harness pixel-identical; the e2e matrix and its screenshots are the regression suite.

## Docs

- Only the PM edits VISION, DECISIONS, STATUS, PM and briefs. Every other doc changes in the branch that changes the code it describes; a branch that lands code without its ARCHITECTURE *Today* and CHANGELOG lines is not done.
- ARCHITECTURE keeps *Today* / *Planned* honest: *Today* says what the code does, *Planned* says what a named workstream will do.
- History inside a doc condenses to dated one-line results; superseded plans move to `docs/archive/` with a row in its README.

## Lessons carried over from Forgewilds

- Reviewer round trips stall the queue: reviewers fix. Merge before launching more.
- Conflicts on roadmap docs: the PM owns them. Conflicts on shared enums or numbers: the PM reserves them per step; append-only; whoever lands later rebases.
- Agent context is the scarce resource: briefs name files, not contents; agents read what the brief lists and use summary-only script output.
- Kill only your own processes, by PID. Clean worktrees after merge.
- A doc nobody re-reads goes stale: a doc-vs-code sweep is a step like any other, scheduled per phase.
