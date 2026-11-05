# Brief: ws/doc-sweep

Read `docs/briefs/common.md`, then `docs/PM.md` *Docs*, DECISIONS E-005 through E-010, and all of `ARCHITECTURE.md`.

## Goal

Docs say what the code does. After two waves, several *Planned* lines describe work that landed.

STATUS row: ARCHITECTURE *Planned* lines that are now *Today*; module READMEs vs code; root README table; superseded plans to `docs/archive/`.

## Scope

- `ARCHITECTURE.md`: for each paragraph, read the module and move *Planned* text that landed into *Today* (or delete it), e.g. *Layout*'s "ws/camera deletes `device`, `setFill` and the fill bands" (landed in ws/render-call, E-010), *Surface*'s `size` rename note (check), *Host*'s `requestFrame` (landed), *Analytics* template sink (ws/plumbing is doing it now: say so). Keep *Planned* lines that name a live workstream (`ws/lights`, `ws/mesh-stream`, `ws/two-views`, `ws/plumbing`, XR after Gate 5).
- Module READMEs you own (below): every exported name in the module's `index.ts` appears in its README; stale names go.
- Root `README.md`: the subpath/exports table matches `package.json` `exports`; harness page list matches `harness/`.
- `docs/archive/`: move any superseded planning doc out of `docs/` with a row in `docs/archive/README.md`; do not touch `VISION`, `DECISIONS`, `STATUS`, `PM`, `briefs`.
- A `scripts/check-docs.mjs` (optional, under an hour) that fails when an `index.ts` export is missing from its module README; add `pnpm check:docs` but do **not** chain it into `check` yet (the PM decides); report its findings.

## Files owned

`ARCHITECTURE.md` paragraphs *Surface*, *Host*, *Layout*, *Analytics*, *Audio*, *Save*, *Post*, *FX*, *Platform*, *Testing* (not *Camera*, *Transforms*, *Renderer*, *Lighting*, *Scene and Ctx*, *Input*: other steps own those), `src/{audio,save,post,fx,platform,ui,host,testing,analytics}/README.md` except `src/analytics/README.md`'s conventions section and `src/ui/README.md`'s regions note (ws/plumbing), root `README.md`, `docs/archive/**`, `scripts/check-docs.mjs`, `package.json` (one script line).

No code changes in `src/`. Report every doc-vs-code mismatch you could not fix within your ownership.
