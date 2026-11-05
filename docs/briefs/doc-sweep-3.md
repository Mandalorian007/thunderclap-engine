# Brief: ws/doc-sweep-3

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-014; `docs/briefs/doc-sweep-2.md` (method); `scripts/check-docs.mjs`; `ARCHITECTURE.md` whole; root `README.md`.

## Goal

After nine wave-4 merges, every README claim matches the code, ARCHITECTURE has no *Planned* line the code already does, the root README's module table, harness page list and roadmap are current, and `check:docs` is clean.

STATUS row, *done when*: `check:docs` clean; ARCHITECTURE *Planned* lines current after wave 4 (XR lines all *Today*); root README page list and roadmap current; contradictions fixed and listed.

## Scope

- Run `pnpm check:docs`; document every name it lists in the owning README. Names that look like leaked internals go in your report (ws/prune already pruned once; do not un-export).
- Walk every ARCHITECTURE paragraph against the merged code for: shadows and fog in *Lighting*, bounds and culling in *Transforms*/*Renderer*, `Look` in *Input*, anchors in *UI*, world-space particles in *FX*, texture arrays in *Materials*, spatial audio in *Audio*, XR in *Surface*/*Camera*/*Renderer*/*Host*/*Input*/*Scene and Ctx*. Where a branch wrote its *Today* sentence, check it; where a *Planned* line is now done, move it. Principle 4 ("XR is out of scope until after Gate 5") is now false: reword to say XR is *Today* behind `createGame({ xr })` with post per eye pending, and name what is still after Gate 5 (nothing XR-specific unless the code says so).
- Root `README.md`: harness page list (look, anchors, weather, xr), module table rows for new files, roadmap section, templates list (two templates).
- `CHANGELOG.md`: group wave-4 entries under the existing headings; one line per workstream if an engineer wrote a paragraph.
- Fix every README/ARCHITECTURE contradiction with the code and list each in your report. No code changes; a stale code comment goes in the report.

## Files owned

`src/*/README.md`, `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `scripts/check-docs.mjs`.

Running alongside: ws/template-first-person (adds one root README row at the end of the templates list and one CHANGELOG line), ws/xr-post (`src/post/**`, `src/core/game.ts`, its own README/ARCHITECTURE sentences in `src/post/README.md` and the *Post* paragraph: leave that paragraph to it).
