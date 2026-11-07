# Brief: ws/ui-9

Read `docs/briefs/common.md` first. Then read the ws/ui-7 and ws/ui-8 rows and notes in `docs/STATUS.md` (the wish: content-sized `left`/`right` rails). Then read `src/ui/README.md` *Layout* and `src/ui/layout.ts` and its tests.

## Goal

Side rails can size to their content like the top and bottom bars, so a phone HUD can put orbs at the sides.

STATUS row, *done when*:

- **Content rails.** Extend ui-8's `BarSize` to `left` and `right`, so the name type becomes `'top' | 'bottom' | 'left' | 'right'`.
  - A `content` rail grows to its widest widget plus `pad`, between the form track and `max`.
  - `freeRect` and the world area shrink to make room.
  - Fixed stays the default, and nothing changes for existing layouts.
- **Corner rule.** When a content bar and a content rail meet, the corner cell belongs to the larger of the two. Document this.
- **Tests.**
  - Pure test: on a phone form, a 96 px widget in a content `left` rail widens the rail and shrinks `freeRect` by the same amount.
  - A rail capped by `max` still reports in `overflows()`.
- **Harness.** Add a `ui5?orb-rails` variant (additive): the two orbs sit in content rails on phone rows. Assert in `e2e/ui5.spec.ts` that it produces 0 overflow warnings on every row.
- **Docs.** The ui README *Layout* section, the types list, one CHANGELOG line, and one ARCHITECTURE phrase in the ui clause.

## Files owned

You own:
- `src/ui/layout.ts` and `layout.test.ts`
- `src/ui/index.ts` (append only)
- `src/ui/README.md`
- `harness/ui5*` (additive)
- `e2e/ui5.spec.ts` (additive)
- `CHANGELOG.md`
- the one ARCHITECTURE phrase

Do not edit:
- other `src/ui` files
- `demos/**`
- `templates/**`

Branch from `main` once ui-8 is there, which is when `git merge-base --is-ancestor b6eb711 origin/main` succeeds. Until then, branch from `ws/ui-8` at b6eb711 and merge main before your final gate. Use `E2E_PORT_OFFSET=1060`. Gate per E-031 with ui, ui4, ui5 and layout each run alone.
