# Demo: arpg

An isometric action-RPG slice: a hero in a ruined courtyard at dusk cuts down ghouls that path in
from the edges. `pnpm demo arpg`, or `/demos/arpg/` on the harness server. `?still` parks the idle
bob, flame flicker, cape and enemy AI; `?seed=N` fixes the spawns (`createRandom`).

Controls: click or tap the ground to walk there (hold to keep steering); click a ghoul to chase
and strike it; WASD, the left stick or a bottom-left touch stick run directly. Space strikes,
Q whirls, E dashes, R casts a nova; keys 1–3 or the top buttons swap gear.

## What to look at

- A 60×60 m courtyard of `geom` meshes (tiles, walls, pillars, stairs, a dais and arch, braziers),
  one `InstanceList` per prop kind: 18 draw calls with the shadow and post passes, ~21k triangles.
- Six braziers: an emissive core, additive flame particles and a flickering point light each, under a
  low sun shadow, bloom, AO, vignette and an ACES grade.
- The pick: `screenRay` onto the floor, refined by `NavMesh.height`, `findMeshPath` from a
  `bakeNavMesh` of the courtyard, then `followPath3` steered at a turn rate (speed drops while turning).
- The hero: `createStandardMaterial({ skin })`, an anim graph (a 1D idle/run blend on speed plus a
  sub-stepped `attack` state whose blade tip feeds a `Trail`), a cape on `createSpringChain`.
- Gear on four `createSocket`s: iron, gilded (rune emissive, blue rune-blade) and bone. Every set is
  built at boot and a swap only changes the drawn meshes (`__demo.rigBuilds` stays 1). The
  hand-swap is what `loaded.setVariant` (ws/assets-3) replaces for glTF heroes.
- Twelve ghouls on the same skeleton and `SkinPalette`, one `InstanceList`, each with its own graph,
  replanning a `NavPath3` every 0.5 s and separated by `createCrowd`; anchored health bars.

## Known limits

No minimap (`ui.minimap({ world, markers })` is missing). The orbs are hand DOM (no
`ui.meter({ shape: 'orb' })`); damage numbers are a pool of anchors risen by hand (no
`ui.floats.spawn(text, world)`). Deaths shrink instead of dissolving (no
`createStandardMaterial({ dissolve })`). Gear swapping stays by hand: the three sets are procedural `geom` meshes, not a
glTF, and they differ in shape as well as colour, while `loaded.setVariant` swaps only the
materials of a loaded glTF (`KHR_materials_variants`).
The hero is a crowd agent with zero preferred velocity, so ghouls part around it but it does not
push them.
