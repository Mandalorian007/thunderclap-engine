# Brief: ws/ui-8

Read these first:
- `docs/briefs/common.md`
- the ws/ui-5, ws/ui-6 and ws/ui-7 rows and notes in `docs/STATUS.md` (the `ui5?orb` overflow finding)
- `src/ui/README.md`, *Layout*
- `src/ui/layout.ts` and its tests
- `harness/ui5*`

## Goal

HUD bars fit their content, and the harness stops overflowing.

STATUS row, *done when*:

- **Content-sized bars.** Form factor regions `top` and `bottom` take `size: 'content'`. The bar's track grows to its tallest widget, clamped by a `max`, and the layout re-flows. Existing fixed sizes are unchanged.
  - Tests:
    - a 128 px orb in a content bar gives no overflow;
    - a fixed bar still reports it;
    - `max` clamps and then reports.
- **Harness.** `ui5?orb` either uses content bars or places the orbs in `left` and `right`, whichever reads better on phone-se. After the change the matrix log shows no `[layout] … overflows` warning.
  - Add a spec assertion: no overflow warning on any ui5 variant.
- **Docs.** The ui README *Layout* section, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/ui/**`
- `harness/ui5*`, `e2e/ui5.spec.ts`
- `CHANGELOG.md`

Do not edit `demos/**`.

Branch from `main` (9fbc59d or later). Use `E2E_PORT_OFFSET=1030`. Gate per E-031 with the ui, ui4, ui5 and layout specs each run alone.
