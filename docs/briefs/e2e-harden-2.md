# Brief: ws/e2e-harden-2

Read `docs/briefs/common.md` first, including the *Specs under load* paragraph that ws/e2e-harden wrote. Then read:
- DECISIONS E-017, E-031 and E-032.
- The ws/e2e-harden row and findings line in `docs/STATUS.md`, plus the watch lines for `e2e/ui4.spec.ts:118` and fx3.
- The ws/fx-4 and ws/adopt-sweep notes.

Then read each spec below together with the harness page or demo it drives.

## Goal

Three more specs fail under load for reasons other than a regression. Make them honest about time, using the same patterns as ws/e2e-harden. No engine behaviour changes.

- `e2e/fx3.spec.ts`: `forces` (:136) and `collide` (:158).
  - They failed on ipad and three other rows at load 18–40, on fx-4's branch and on main's `src/fx` alike.
  - They passed in train 1's matrix at load 14.
- `e2e/ui4.spec.ts:118`: the minimap clamps far markers to the rim. On phone-android the rim count held at 1 for the 10 s poll, at load about 28.
- `e2e/demos/voxel.spec.ts`: add explicit asserts that terrain tops sit in 16..44 and that the spawn is on solid ground. This is the ws/adopt-sweep wish: today the demo enforces them only through a boot console error.

STATUS row, *done when*:
- **Reproduce first.** Under deliberate load, run each spec `--repeat-each=10` on its failing rows. Load only while you hold `/tmp/thunderclap-e2e-slot1`, and release it within 20 minutes. Put the before and after failure counts in a table.
- **Fix the cause.** Use these patterns:
  - Poll moving values.
  - Count short-lived events in page state when they happen.
  - Make the page wait for its own settled state, not a sleep.
  - Raise a timeout only with a measured-worst-case comment.
  - New state fields are additive, in the `*-state.ts` file or in `window.__demo`.
- **A real bug is a finding, not a fix.** If one of these fails because the engine is wrong under slow frames, stop and report it with evidence. `src/**` is not yours.
- **Gate.** `pnpm check`, `snap:check` at 0 px, and each owned spec `--repeat-each=5` under deliberate load with 0 failures, or with the residue explained.
- **Docs.** One CHANGELOG *Tests* line. If you find new patterns, propose them in your report.

## Files owned

You own these specs:
- `e2e/fx3.spec.ts`
- `e2e/ui4.spec.ts`
- `e2e/demos/voxel.spec.ts`. Edit it only after ws/e2e-harden and ws/adopt-sweep are on main, which is train 2. Check with `git merge-base --is-ancestor 73c6896 origin/main`, then merge origin/main before you touch it.

You may also add state fields, writes only, to `harness/fx3*-state.ts`, `harness/ui4*-state.ts` and `demos/voxel/main.ts`.

You own the `CHANGELOG.md` line.

Do not edit:
- `src/**`
- `playwright.config.ts`
- other specs
- `templates/**`

Branch from `main`, at the head of this brief or later. Use `E2E_PORT_OFFSET=860`. ws/fx-4 waits for you in train 3.
