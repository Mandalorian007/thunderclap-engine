# Brief: ws/ui-7

Read `docs/briefs/common.md` first, then the ws/ui-5 and ws/ui-6 rows and notes in `docs/STATUS.md`. Then read:
- `src/ui/README.md`, *Layout* and *Canvas minimap*
- `src/ui/{layout,minimap-canvas}.ts` and their tests
- `harness/ui5*`, `e2e/ui5.spec.ts`

## Goal

Two small ui wishes from ui-6.

STATUS row, *done when*:

- **Overflow warning.** `layout.add` warns once per widget, through the existing warning path, when the widget's measured box exceeds its region on the current form factor. The warning names the widget, its region and both sizes.
  - Add `layout.overflows(): readonly { id, region, w, h, rw, rh }[]` for tests and dev overlays.
  - Production builds pay no per-frame cost. Re-measure only on layout change.
  - Tests: an oversized widget appears in `overflows()` and warns once; one that fits does not.
- **Marker heading.** `MinimapMarker.heading?: number` is in radians, in the same convention as `setPlayer`'s yaw.
  - A kind can declare `shape: 'arrow'`, so any marker can draw as the player arrow does, rotated in both `rotate` modes.
  - Tests: drawn rotation in north and player modes.
  - Harness: `ui5?minimap` gets a heading-carrying marker, with state `headingMarkers`.
- **Docs.** The ui README, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/ui/**`
- `harness/ui5*`, `e2e/ui5.spec.ts`
- `CHANGELOG.md`

Do not edit `demos/**` (ws/demo-arpg-2 adopts the heading).

Branch from `main` (2a76b00 or later). Use `E2E_PORT_OFFSET=950`. Gate per E-031 with the ui, ui4, ui5 and layout specs each run alone.
