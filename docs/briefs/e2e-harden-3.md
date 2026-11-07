# Brief: ws/e2e-harden-3

Read these first:
- `docs/briefs/common.md`
- DECISIONS E-017, E-031 and E-033
- the ws/e2e-harden and ws/e2e-harden-2 rows in `docs/STATUS.md`

Then read:
- `e2e/demos/tactics.spec.ts`, the d-pad test at :247
- `demos/tactics/main.ts`: the `__demo.pad` hook and how a pad press reaches the cursor
- `src/input/` pad polling, read only: how a button down/up between two polls is seen

## Goal

E-033 closes, and the d-pad test stops depending on timing.

STATUS row, *done when*:

- **Find the cause.** In the train 5 matrix the second press of up didn't move the cursor. Load the machine the way ws/e2e-harden did, only while holding slot1 with an owner file, and release within 20 minutes. Run the test with `--repeat-each=20` on all rows and record the failure count.
  - Then find out which it is:
    - (a) The engine or demo drops a press and release that both fall between two polls. That is an input finding: show the evidence, don't patch `src/**`, and say which call should latch it.
    - (b) The spec only works if a frame lands between press and release.
- **Fix.**
  - For (b), press, then poll for the demo seeing it (add a state field such as `padPresses`), then release.
  - For (a), make the same spec change so the test is honest, and report the finding.
  - Then 0 failures in 20 repeats under the same load.
- **Sweep.** Look for other specs that press and release inside one `evaluate` (grep `pad(` and `, true);` followed by `, false);`). List them in your report and fix them the same way if they are in files you own.

## Files owned

You own:
- `e2e/demos/tactics.spec.ts`
- `demos/tactics/main.ts`, state writes only
- any other `e2e/demos/*.spec.ts` the sweep finds, spec only
- one CHANGELOG *Tests* line

Do not edit:
- `src/**`
- `demos/arpg/**` (ws/demo-arpg-2)
- `harness/ui5*` and `e2e/ui5.spec.ts` (ws/ui-7)

Branch from `main` once train 5 has landed: ea53645 or later. Use `E2E_PORT_OFFSET=970`. Gate per E-031.
