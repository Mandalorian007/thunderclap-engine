# Brief: ws/demo-arpg

Read `docs/briefs/common.md`, then `docs/briefs/demos-common.md`, then `docs/VISION.md`: the E-015 quality bar (PBR, shadows, emissive, particles on a phone) and rule 5. Also read DECISIONS E-015 and E-021 and the ws/demo-arena, ws/demo-polish-2, ws/anim-4, ws/fx-2 and ws/ui-hud rows in `docs/STATUS.md`. Then read `demos/arena/*` end to end: it is the closest sibling, so copy its patterns, not its code paths. Then the READMEs of `src/anim/` (mixer, graph, sockets, spring chains), `src/nav/` (navmesh, `findPath`, crowd/steering if present), `src/fx/`, `src/ui/` (anchors, meters, world labels), `src/render/` (standard material, lights, shadows), `src/post/` and `src/geom/`.

## Goal

A Diablo-Immortal-class isometric action RPG slice in `demos/arpg`. It is the E-015 showcase for "a 3D action game on the engine at phone frame rates". Content is procedural and comes from `geom`, so there are no network assets. Everything runs on the public API only (`scripts/check-boundaries.mjs`).

STATUS row, *done when*:

- **Scene**: a 60×60 m courtyard ruin with an angled-down perspective camera at about 50° that follows the hero.
  - The geometry is `geom`-built: floor tiles, broken pillars, walls, stairs and braziers.
  - Materials: PBR stone, with emissive brazier flames on `fx` particles. Each brazier carries a point light.
  - Lighting: a sun with cascaded or single shadows, whatever main has, plus post bloom, AO if the frame budget allows, a vignette and a grade.
  - The look is a dusky, saturated palette. Aim for 20 to 40 draw calls.
- **Hero**: a skinned humanoid on `createStandardMaterial({ skin })`, built procedurally the way the arena demo does it.
  - It runs an anim graph with idle/run as a 1D blend on speed plus an attack state.
  - **Click/tap-to-move**: a pick on the ground plane, a path from `src/nav` over a navmesh baked from the courtyard, then steering along the path with a facing turn rate.
  - **Hold-to-move**: pointer held, or a left stick on pad or touch.
  - Pressing attack (or clicking an enemy) plays a swing with a `Trail` and a hit burst.
- **Cosmetics** (the E-015 ask): three gear sets, helmet, shoulder pads and weapon, each a `geom` mesh on an anim socket. Each set has its own material: plain iron, gilded with emissive runes, bone.
  - Keys 1–3 or an on-screen `ui` button row swap the set in place, with no re-creation of the skeleton.
  - A cape on a spring chain if `anim` ships spring chains on main. Otherwise note it in *Known limits*.
  - Name in the README which engine call would replace the hand-swap once glTF material variants land (ws/assets-3, `loaded.setVariant`). Do not wait for it.
- **Enemies**: 12 pursuers using the same skeleton with a different material.
  - They path to the hero over the navmesh. Use crowd separation if nav has it, otherwise a simple local push.
  - Each has a world-anchored health bar (`ui` anchors) and takes three hits.
  - On death: a dissolve or shrink plus particles, and a floating damage number. Use `ui.floats` if main has it, else the arena demo's caption path.
  - They respawn at the edge after 3 s.
- **HUD**: a health orb and a mana orb (`ui.meter` or widgets), an ability row of four slots with cooldown sweeps, and a minimap if main has `ui.minimap`. Otherwise leave the minimap out and note it.
- **State**: `window.__demo` holds `fps`, `drawCalls`, `triangles`, `heroPos`, `heroState`, `pathLength`, `enemiesAlive`, `kills`, `gearSet`, `gearMaterialIds` and `cameraPitch`. `?still` parks the time-driven motion (flames, idle sway), and `?seed=N` fixes the spawns.
- **Spec** `e2e/demos/arpg.spec.ts`, polling per E-017:
  - Boot is clean with no console errors, and draw calls are in band.
  - A ground click moves `heroPos` along a path with `pathLength > 0`, and the hero arrives within 0.5 m.
  - A key or button swaps `gearSet` and changes `gearMaterialIds`.
  - Attacking an adjacent enemy three times raises `kills`.
  - A tap moves the hero on touch rows.
  - Desktop fps is above 20.
- **Docs**:
  - `demos/arpg/README.md` with *What to look at* and *Known limits*. The limits list each engine gap as an exact call the demo wanted, and each one is also a wish in your report.
  - A row in the `demos/README.md` table.
  - `pnpm demo` lists it.
  - The root README count line, if your change moves it.

## Files owned

You own:
- the new folder `demos/arpg/**`
- the new spec `e2e/demos/arpg.spec.ts`
- `demos/README.md`, one table row only
- the root `README.md` count line, only if it moves

Do not edit `src/**`. An engine gap is a wish: name the call, keep a local helper in the demo, and say so in *Known limits*. Also leave these alone:
- other demos
- `templates/**` (ws/template-sweep)
- `harness/**`
- other specs
- `scripts/**`

Branch from `main` (8bc61fe or later). Running alongside: ws/fx-3, ws/render-4, ws/ui-4, ws/template-sweep, ws/core-2, ws/input-5 and ws/assets-3. Your demo reads their modules as they stand on main at your branch point. Do not merge their branches in. Use `E2E_PORT_OFFSET=760`, and run the full e2e under an E-030 slot.
