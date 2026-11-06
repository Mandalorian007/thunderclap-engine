# Brief: ws/ui-5

Read `docs/briefs/common.md` first. Then read `docs/VISION.md`, in particular the E-015 quality bar: a Diablo-Immortal-class HUD on a phone. Also read the ws/ui-hud, ws/ui-4 and ws/demo-arpg rows in `docs/STATUS.md` and the ws/demo-arpg wish line. Then read:
- `src/ui/README.md` end to end, especially *HUD widgets*, *Anchors* and *Theme*.
- `src/ui/{hud,anchor,widgets,widgets-2,theme,styles,overlay}.ts`.
- `demos/arpg/` (read only; it lands with the train), for the hand-built orbs, damage numbers and the missing minimap. If it is not on main yet, read it at ws/demo-arpg `bc26f00`.

## Goal

The three widgets every action-RPG HUD hand-builds today become engine calls. They are themed, scale with text size, work on touch, and cost nothing per frame when idle.

STATUS row, *done when*:

- **Orb meter.** `ui.meter({ shape: 'orb', ... })` is a round fill gauge for health or mana.
  - Fill rises from the bottom with a meniscus line.
  - Optional `trail`: a lagging damage band, as the bar meter has (or add one).
  - Optional label `'value' | 'percent' | 'none'`.
  - Colours come from theme tokens, with a per-call `color` override.
  - Tests: the fill height matches the value; the trail lags and catches up; `prefers-reduced-motion` disables the trail.
- **Floating text.** `ui.floats(camera)` returns a `Floats` with:
  - `spawn(text, world: Vec3, opts?)`, where `opts` is `{ color, size, rise, life, crit, stack }`.
  - Pooled DOM nodes, so steady state allocates nothing.
  - Labels projected through the same path as `ui.anchors`, and culled behind the camera.
  - Overlapping spawns at one point fan out (`stack`).
  - `crit` pops in scale.
  - `update(dt)` and `dispose()`.
  - Tests: the pool reuses nodes; a spawn behind the camera is hidden; life ends removes the node from view.
- **Minimap.** `ui.minimap({ size, world: { minX, minZ, maxX, maxZ }, rotate?: 'north' | 'player', background? })` returns:
  - `setMarkers(list)`, where each item is `{ id, x, z, kind, color? }`.
  - `setPlayer(x, z, yaw)`.
  - `setBackground(canvas | ImageBitmap | null)`, for the game to paint its layout.
  - `zoom`.
  - It is drawn on its own canvas, round or square, and redrawn only on change. Markers can use different shapes per `kind`.
  - Tap or click on the map gives `onPick(worldX, worldZ)`, for click-to-move from the map.
  - Tests: world-to-map mapping in both rotate modes; no redraw when nothing changed; pick inverts the mapping.
- **Harness.** New pages only: `harness/ui5.html`, `ui5.ts` and `ui5-state.ts`, with these variants:
  - `?orb`: two orbs draining and refilling. State `fill`, `trail`.
  - `?floats`: a ring of spawning numbers in 3D. State `active`, `pooled`.
  - `?minimap`: a moving player and 20 markers. State `redraws`, `pick`.
  - `?still`.

  Add `e2e/ui5.spec.ts`, using E-017 polling. Set state and read ticks in one `evaluate`, per common.md. `e2e/ui.spec.ts` and `e2e/ui4.spec.ts` must stay green, and `pnpm snap:check` at 0 px.
- **Docs.**
  - ui README sections for the three widgets.
  - The types list.
  - A CHANGELOG block.
  - One sentence in the ARCHITECTURE ui clause.
  - The root README harness list.

## Files owned

You own:
- `src/ui/{hud,widgets-2,theme,styles,index}.ts` and their tests (`index` is append only)
- the new `src/ui/{orb,floats,minimap}.ts` and their tests
- `src/ui/README.md`
- the new `harness/ui5*`
- `e2e/ui5.spec.ts`
- `ARCHITECTURE.md`, one sentence only
- `CHANGELOG.md`
- the root `README.md` harness list

Do not edit:
- `src/ui/{overlay,anchor}.ts` (ws/ui-4 is landing). Reuse the anchor projection through its public export. If you need a hook, make it a wish.
- `e2e/ui*.spec.ts` except your own.
- `demos/**`. The arpg demo adopts these widgets in a later sweep.
- `templates/**`.
- `src/render/**`.

**Branch from `ws/ui-4` at c7ef764.** It is in the integration train. Once the train lands it on main, which is when `git merge-base --is-ancestor c7ef764 origin/main` succeeds, merge origin/main into your branch before your final gate.

Running alongside: ws/post-4 and ws/e2e-harden, with the train integrating. Use `E2E_PORT_OFFSET=790`. Gate per E-031: `pnpm check`, `snap:check`, and your ui specs run alone. Run no e2e, check or snap while `/tmp/thunderclap-e2e-slot1` exists.
