# Brief: ws/ui-6

Read `docs/briefs/common.md` first. Then read these rows and notes in `docs/STATUS.md`:
- the ws/ui-4 and ws/ui-5 rows
- the ws/ui-5 notes line, which carries the unification wishes
- the ws/demo-arpg wish line

Then read:
- `src/ui/README.md`: *HUD widgets*, *Floating text*, *Canvas minimap*
- `src/ui/{overlay,float-numbers,floats,minimap,minimap-canvas}.ts` and their tests
- `harness/ui4*`, `e2e/ui4.spec.ts`
- `demos/arpg/{hud,main}.ts`, the hand-built orbs and damage numbers

## Goal

There is one floating-text API and one minimap. `ui.floats` and `ui.minimap` return the ui-5 implementations, and ui-4's earlier versions are retired. The arpg demo, the E-015 showcase, drops its hand-built orbs and damage numbers for engine calls.

STATUS row, *done when*:
- **`ui.floats(camera?)`** is a method that returns ui-5's `Floats` (`createFloats` bound to the overlay). The `float-numbers.ts` getter is retired.
  - If no caller outside `harness/ui4` and `demos` uses `FloatNumbers`, delete it.
  - Otherwise keep a deprecated alias and say so in the CHANGELOG.
- **`ui.minimap(opts)`** returns ui-5's canvas minimap in a layout region. ui-4's DOM `minimap.ts` is retired in the same way.
  - Keep the behaviours ui4.spec pins: rim clamp of far markers as the centre moves, pooled markers, and the layout region.
  - Port whatever the canvas version lacks.
- **Harness and spec.** Move `harness/ui4*` and `e2e/ui4.spec.ts` onto the unified calls in this same change. The assertions stay the same. Where a DOM query no longer applies because the map is a canvas, assert through state fields.
  - The ui4 spec, ui5 spec and ui spec are green, each run alone.
- **arpg adopts them.**
  - The orbs become `ui.meter({ shape: 'orb', trail: true })`.
  - Damage numbers become `ui.floats(camera).spawn`, with `crit` on the third hit.
  - The demo gains a minimap with the hero, enemies and braziers as marker kinds, and tap-to-move from the map using `onPick` and the existing path.
  - Drop the gaps these close from *Known limits*.
  - Move third-person and arpg enemy `Math.random` to `createRandom` (the adopt-sweep wish).
  - `e2e/demos/arpg.spec.ts` stays green. Add one test: a minimap pick moves the hero.
- **Docs.** The ui README, the types list, a CHANGELOG block, and the arpg README.

## Files owned

You own:
- `src/ui/**` and its tests
- `harness/ui4*`, `harness/ui5*`
- `e2e/ui4.spec.ts`, `e2e/ui5.spec.ts`
- `demos/arpg/**`, `e2e/demos/arpg.spec.ts`
- `templates/third-person/**`, for the random swap only
- `CHANGELOG.md`

Do not edit:
- `src/render/**`, `src/input/**`, `src/audio/**`, `src/fx/**` (other workstreams are in flight)
- other demos and specs. ws/e2e-harden-2 also edits `e2e/ui4.spec.ts`, but only in the :118 rim test; keep that test's poll shape when you port it, and the integrator merges the two.

Branch from `main` (5f6557c or later). Use `E2E_PORT_OFFSET=870`. Gate per E-031.
