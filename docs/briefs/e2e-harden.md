# Brief: ws/e2e-harden

Read `docs/briefs/common.md` first. Then read DECISIONS E-017 (tolerated specs and `expect.poll`), E-023 (load) and E-030 (slots), plus the backlog lines in `docs/STATUS.md` that name under-load failures: post2 sharpen/grain, music pause ramp, dungeon pad walk, and the ws/template-sweep line listing recurring fails. Then read `playwright.config.ts`, `e2e/ports.ts` (read only, ws/template-sweep is landing changes there) and each spec below together with the harness page or demo it drives.

## Goal

The specs that fail on every branch under load stop failing for reasons other than a real regression. No engine behaviour changes. Each fix makes an assertion honest about time.

These specs have failed under load on at least two branches today (ws/nav-4, ws/ui-4, ws/template-sweep):
- `e2e/decals.spec.ts` (around :143)
- `e2e/voxel.spec.ts` (:128 and :142)
- `e2e/demos/voxel.spec.ts` (the click-breaks test, around :157, on phone rows)
- `e2e/demos/tactics.spec.ts`
- `e2e/skin.spec.ts`
- `e2e/post2.spec.ts` (6 failures on ipad under load)

STATUS row, *done when*:

- **Reproduce first.** Load the machine on purpose by running a second full matrix at another offset while holding both E-030 slots, or `stress`-style busy loops if your shell has them. Then run each spec above with `--repeat-each=10` on its failing rows. Record the failure count per spec before and after your fix in a table in your report. If a spec never fails for you, say so and leave it alone.
- **Fix the cause, not the budget.**
  - Single reads of moving values become `expect.poll`.
  - Fixed `waitForTimeout` sleeps become a poll on the page's own state field: a frame counter, `ready`, `meshed`, `remeshMs` present.
  - Clicks that land before the page is ready wait for that state.
  - Screenshots take a rAF-settled frame.
  - A timeout may be raised only with a one-line comment naming the measured worst case under load.
  - If a fix needs a new state field on a harness page or demo, add it additively. That means a field in its `*-state.ts` or `window.__demo`, with no behaviour change. Name it in the report.
- **A real bug is a finding, not a fix.** If a spec fails because the engine is wrong under slow frames, stop on that spec and report it with evidence. Examples: a fixed-step accumulator that drops input, or a worker reply raced by a dispose. Do not patch `src/**`.
- **Gate**: `pnpm check` green, `pnpm snap:check` 0 px, and the full e2e once on your head under an E-030 slot. Also run the six specs `--repeat-each=5` under deliberate load with 0 failures, or with the residue explained.
- **Docs**: add one paragraph to `docs/briefs/common.md`'s e2e bullet neighbourhood as a proposal in your report, not an edit: the patterns you found, so engineers stop writing them. Add a CHANGELOG line under a *Tests* heading.

## Files owned

You own these spec files:
- `e2e/{decals,voxel,skin,post2}.spec.ts`
- `e2e/demos/{voxel,tactics}.spec.ts`

You may also make additive state fields in the matching pages:
- `harness/{decals,voxel,skin,post2}*-state.ts` or their page `.ts` (state writes only)
- `demos/{voxel,tactics}/main.ts` (state writes only)

You also own the `CHANGELOG.md` line.

Do not edit:
- `src/**`
- `playwright.config.ts` or `e2e/ports.ts` (ws/template-sweep is landing changes there)
- `e2e/ui*.spec.ts` or `e2e/world-panel.spec.ts` (ws/ui-4 owns the ui cursor case)
- other specs
- `templates/**`
- `demos/arpg/**` (ws/demo-arpg)
- the docs under `docs/`

Branch from `main` (765a00e or later). Running alongside: ws/fx-3, ws/render-4, ws/ui-4, ws/core-2, ws/input-5, ws/assets-3 and ws/demo-arpg. Use `E2E_PORT_OFFSET=770`. When you load the machine on purpose, do it only while you hold both slots, and release them within 30 minutes so other gates can run.
