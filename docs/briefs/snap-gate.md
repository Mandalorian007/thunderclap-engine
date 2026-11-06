# Brief: ws/snap-gate

Read `docs/briefs/common.md` first, then DECISIONS E-008 (pixel-identical rule and tolerance), E-011, E-013; `playwright.config.*`, `e2e/fixtures.ts`, `e2e/ports.ts`, `e2e/layout.spec.ts` (the `screens/` screenshots), `e2e/mesh.spec.ts` (how a probe screenshot is taken), `package.json` scripts, `docs/briefs/integrate.md`.

## Goal

"2D harness pixel-identical" becomes a command. An integrator runs `pnpm snap` on main and on the merged tree and gets a diff report; the e2e matrix carries committed golden PNGs for the 2D pages on one deterministic row.

STATUS row, *done when*: `pnpm snap` captures every 2D harness page (`smoke`, `ui`, `layout`, `gestures`, `surface`, `views` and whatever `harness/*.html` has no perspective camera) on the `desktop-1280` row at a fixed frame into `e2e/golden/<page>.png`; `pnpm snap:check` fails on any pixel outside E-008's tolerance and writes a diff PNG under `screens/diff/`; `snap:check` runs inside `pnpm test:e2e` as one spec on that row only; goldens committed; integrate brief updated to run it; documented.

## Scope

- A Playwright spec `e2e/golden.spec.ts` (project `desktop-1280` only via `test.skip` on other rows) that opens each page with the harness `?frame=N` or whatever deterministic hook exists (if none exists, add `harness/golden-state.ts`-style support: the page's state object exposes `frame`, and the spec waits for a fixed frame count; name any harness file you touch, one line each). Pixel compare in Node with the PNG decoder Playwright already bundles (`pngjs` is a Playwright dependency; the engine itself gains no dependency: the script lives in `scripts/` and `e2e/`).
- `scripts/snap.mjs`: `pnpm snap` (re-capture goldens, `--update`) and `pnpm snap:check` (compare, non-zero exit on diff, prints per-page max channel delta and count of differing pixels).
- Document the deterministic requirements a page must meet to be golden-tested (no time-based animation, or frozen clock) and list which pages are excluded and why.
- `docs/briefs/integrate.md`: one step "run `pnpm snap:check` after the merge; a diff on a 2D page fails the merge unless the brief said the page changes".

## Files owned

`e2e/golden.spec.ts`, `e2e/golden/**`, `scripts/snap.mjs`, `package.json` (two script lines), `playwright.config.*` (only if a project tag is needed), `harness/*-state.ts` (a `frame` counter field only, name each), `docs/briefs/integrate.md` (one step), `README.md` (one paragraph under the e2e section), `CHANGELOG.md`.

Branch from `main` (24aa230 or later). Running alongside: every wave-5 stream adds its own harness page and spec; do not golden-test 3D pages. ws/doc-sweep-3 edits README tables; add your paragraph at the end of the e2e section to keep the conflict trivial.
