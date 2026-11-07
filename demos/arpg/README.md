# Demo: arpg

An isometric action-RPG slice: a hero in a ruined courtyard at dusk cuts down ghouls that path in
from the edges. `pnpm demo arpg`, or `/demos/arpg/` on the harness server. `?still` parks the idle
bob, flame flicker, cape and enemy AI; `?seed=N` fixes the spawns (`createRandom`).

Controls: click or tap the ground or the minimap to walk there (hold to keep steering); click a ghoul to chase
and strike it; WASD, the left stick or a bottom-left touch stick run directly. Space strikes,
Q whirls, E dashes, R casts a nova; keys 1–3 or the top buttons swap gear.

## What to look at

- A 60×60 m courtyard of `geom` meshes (tiles, walls, pillars, stairs, a dais and arch, braziers),
  one `InstanceList` per prop kind. Walls, broken walls, pillars, broken pillars and drums are
  lists on `MeshLod` chains (ws/render-6; pillars at 16, 8 and 5 sides, walls lose their coping
  and chunks): each instance picks its level, each level in view is one draw. The wheel (or
  `__arpgApi.zoom`) pulls the camera back to show the far levels; `__demo.lodCounts` is
  `stats.lodCounts`. Per-texel and per-tile rolls are core `hash2f`. The 2 m floor tiles centre
  on even coordinates, so no grout gap runs under the hero's spawn at x = 0; `?still` publishes
  `__demo.centreSeam` (the canvas's centre column less its neighbours 4 px out, read back once).
- Six braziers: an emissive core, additive flame particles and a flickering point light each, under a
  low sun shadow, bloom, AO, vignette and an ACES grade.
- The pick: `screenRay` onto the floor, refined by `NavMesh.height`, `findMeshPath` from a
  `bakeNavMesh` of the courtyard, then `followPath3` steered at a turn rate (speed drops while turning).
- The hero: `createStandardMaterial({ skin })`, an anim graph (a 1D idle/run blend on speed plus a
  sub-stepped `attack` state whose blade tip feeds a `Trail`), a cape on `createSpringChain`.
- Gear on four `createSocket`s: iron, gilded (rune emissive, blue rune-blade) and bone. Every set is
  built at boot and a swap only changes the drawn meshes (`__demo.rigBuilds` stays 1). The
  hand-swap is what `loaded.setVariant` (ws/assets-3) replaces for glTF heroes.
- Twelve ghouls on the same skeleton and `SkinPalette`, each with its own graph, replanning a
  `NavPath3` every 0.5 s and separated by `createCrowd`; anchored health bars. The live bodies are
  one `InstanceList` on a two-level `MeshLod` (far: no hands, feet or hair), refilled each frame. A death burns away over 0.8 s on one of four
  pooled `createStandardMaterial({ skin, dissolve })` copies with an ember edge, its shadow
  dissolving with it (`__demo.dissolving`).
- The HUD from engine calls (ws/ui-6): health and mana orbs are `ui.meter({ shape: 'orb', trail:
  true })`, damage numbers `ui.floats(() => camera).spawn(text, point, { crit })` (the killing third
  hit pops as a crit), and a north-up `ui.minimap` of the whole courtyard over a background painted
  once (`paintCourtyard`), braziers and live ghouls as marker kinds (ghouls as 12 px arrows on
  their `heading`, ws/ui-7) and the hero as the arrow. A tap on
  the map goes through `onPick`, snaps to the navmesh and takes the same `findMeshPath` walk as a
  ground click. On phones the map sits in the card lane (the side rails are 56 px).

## Known limits

The ghoul LOD drops boxes rather than segments: the body is boxes, with nothing to lower. The
ghoul list keeps LOD level memory by index, so a death shifts the later ghouls' hysteresis once;
LOD lists are copied into the frame upload each frame and carry no per-instance velocity
(ws/render-6). Gear swapping stays by hand: the three sets are procedural `geom` meshes, not a
glTF, and they differ in shape as well as colour, while `loaded.setVariant` swaps only the
materials of a loaded glTF (`KHR_materials_variants`). The hero is a crowd agent with zero
preferred velocity, so ghouls part around it but it does not push them.
