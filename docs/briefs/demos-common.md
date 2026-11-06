# Demos: common rules

Demos live in `demos/<name>/` at the repo root, outside the engine (`src/`) and outside the templates. They are not shipped, not part of the package, and never imported by the engine. Their purpose is quality validation: each one exercises a real use case end to end so a regression shows up as a visible or measured change. Keep each one light: `index.html`, `main.ts`, at most a few more `.ts` files, no build config of its own, no dependencies beyond the workspace engine. Run with `pnpm demo <name>` (vite serves `demos/<name>`).

Rules for every demo brief:

- Import only through the exports map (`@thunderclap/engine`, `@thunderclap/engine/<module>`); `pnpm check:boundaries` covers `demos/` once ws/demo-arena lands its one-line change (other demos: keep imports clean regardless).
- No assets fetched from the network. Procedural geometry (`@thunderclap/engine/geom` once landed; until then hand-built or copied from `harness/`), procedural textures (canvas or typed arrays), synthesised audio. Small local files under `demos/<name>/assets/` are fine if you generate them.
- Expose `window.__demo` with a small state object (`frame`, `fps` running average, `stats` from the renderer when available, plus demo-specific numbers named in the brief) so `e2e/demos/<name>.spec.ts` can assert without screenshots. The spec boots the demo through the harness server config (`vite.harness.config.ts` serves `harness/`; add `demos/` to it or start a second server: say which in your report; prefer one config change in ws/demo-arena, others follow the same route) and asserts: it reaches a steady state with no console errors, `fps` above 20 on the desktop row, and the brief's numbers.
- No game nouns leak into the engine. If a demo needs an engine feature that is missing, write it the long way in the demo and list the wish in your report under *Decisions*; do not edit `src/`.
- Each demo gets a 20-line `README.md`: what it shows, which engine modules, what the spec checks.
- Shared files: `demos/README.md` (a table, one row per demo: append yours), root `README.md` *Demos* paragraph (ws/demo-arena writes it; others add nothing), root `package.json` `demo` script (ws/demo-arena), `scripts/check-boundaries.mjs` and `vite.harness.config.ts` (ws/demo-arena only), `playwright.config.ts` only if a new project is unavoidable (ws/demo-arena only). `CHANGELOG.md` one line each under a *Demos* heading (create it if missing; keep others').

Branch from `main` (92c726e or later). The 2D harness stays pixel-identical (`pnpm snap:check`). Full gate: `pnpm check` and `pnpm test:e2e` at your offset.
