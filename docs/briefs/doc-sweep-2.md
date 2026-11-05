# Brief: ws/doc-sweep-2

Read `docs/briefs/common.md` first, then DECISIONS E-011, E-012; `docs/briefs/doc-sweep.md` (the first sweep, for its method); `scripts/check-docs.mjs`; `ARCHITECTURE.md` whole; `docs/VISION.md` rule 6.

## Goal

Every public export is named in its module README, ARCHITECTURE has no *Planned* line that the code already does, and `pnpm check` fails when either regresses.

STATUS row, *done when*: 132 undocumented exports in core/input/render/testing READMEs; ARCHITECTURE principle 4 reword, stale *Planned* lines; chain `check:docs` into `check`.

## Scope

- Run `pnpm check:docs`; for every name it lists, add a one-line entry to the owning module README (what it is, when a game uses it). Group under the README's existing headings; do not restructure. Where a name is an internal that leaked through `index.ts`, say so in your report rather than un-exporting it (that is an engineer's call in a later step).
- ARCHITECTURE: reword principle 4 to "XR is out of scope until after Gate 5; 3D arrives capability by capability with the game that needs it (VISION rule 6)." Then walk every *Planned* sentence: if the code does it (lights, dynamic meshes, two views, `fitFreeRect`, `Scene.render(frame, camera, alpha)`, `ctx.pointers`/`gestures`), move it to *Today* in the present tense; if a named workstream still owes it, leave it. The wave-3 branches already moved most; you are checking the remainder.
- Chain `check:docs` into the root `check` script after `check:boundaries`. Make sure `check:docs` exits non-zero on any undocumented export and prints only the list.
- Do not change code or tests. If a README claim contradicts the code, fix the README and list the contradiction in your report.

## Files owned

`src/*/README.md`, `ARCHITECTURE.md`, `README.md`, `scripts/check-docs.mjs`, root `package.json` (the `check` script line only), `CHANGELOG.md` (one line).

Running alongside: nothing in `src/`; a cleanup agent is removing merged worktrees and branches, which does not touch files.
