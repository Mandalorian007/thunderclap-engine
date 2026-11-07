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
  `stats.lodCounts`. Per-texel and per-tile rolls are core `hash2f`. Each 2 m floor tile carries
  2 × 2 textured slabs, so a seam runs every metre (the gap at its edge, a grout line through its
  middle); the tiling is offset a quarter tile on x and z (a strip of half-width tiles fills the
  near walls, and one quarter tile their corner), so the hero's spawn column at x = 0 sits half a
  metre from both. `?still`
  publishes `__demo.centreSeam` (the canvas's centre column less its neighbours 4 px out, read
  back once; about −0.03 on desktop-1280).
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
  one `InstanceList` on a two-level `MeshLod` (far: no hands, feet or hair), refilled each frame
  and keyed by ghoul index (`setKey`, ws/render-7): a death moves the later ghouls up a slot, but
  their LOD memory (and, with `velocity: true`, their motion history) follows the key, so no
  other ghoul pops a level. `__demo.ghoulLevels` is `renderer.lodLevelOf` per ghoul, and
  `deathLodShifts` counts level changes on the flush after a death (0). `?blur` turns object
  motion blur on, and only then does the list keep previous matrices (`ghoulVelocity`). A death burns away over 0.8 s on one of four
  pooled `createStandardMaterial({ skin, dissolve })` copies with an ember edge, its shadow
  dissolving with it (`__demo.dissolving`).
- The HUD from engine calls (ws/ui-6): health and mana orbs are `ui.meter({ shape: 'orb', trail:
  true })`, damage numbers `ui.floats(() => camera).spawn(text, point, { crit })` (the killing third
  hit pops as a crit), and a north-up `ui.minimap` of the whole courtyard over a background painted
  once (`paintCourtyard`), braziers and live ghouls as marker kinds (ghouls as 12 px arrows on
  their `heading`, ws/ui-7) and the hero as the arrow. A tap on
  the map goes through `onPick`, snaps to the navmesh and takes the same `findMeshPath` walk as a
  ground click.
- The HUD on content bars (ws/ui-8, `LayoutSpec.bars`): the two orbs at the ends of the `bottom`
  bar and the ability slots between them size it (max 160 CSS px; 120 on phone-portrait, so the
  world keeps at least 70% of the height between the bars), and the gear row sizes the `top`
  bar (max 96). No widget overflows its region on any row; `__demo` publishes `formFactor`,
  `overflows` (`layout.overflows()` ids), `bottomBar`, `worldView` and `worldArea` after each
  re-layout.
- Phone-landscape side rails (ws/adoption-5, ws/ui-9's corner rule): the map and the mana orb
  share a content-sized `right` rail (map at the top, orb at the foot) and the health orb sits at
  the foot of the `left` rail, so the bottom bar holds only the ability row (64 → 52 px) and the
  world band grows 64–70% → 68–73% of the height (`__demo.orbRegions`). Since ws/adoption-6 the
  orbs are built once with `MeterOptions.place` maps (`{ 'phone-landscape': 'left' | 'right',
  default: 'bottom' }`) and the layout moves them; their `size` is a `FormSize` (112 theme px,
  96 on phone-landscape: 48 CSS px there, so the left rail drops to the form's 56 px track and
  the world gains about 1% of the area on every phone). The minimap holds its own size in a
  content rail (ws/ui-11), so the demo no longer pins a `min-width` on it. `__demo.orbPx` is the
  drawn diameter. Desktop, tablet and phone-portrait keep the bottom bar and the `right` /
  card-lane map, their world rects unchanged.
- Watch replay (P, or the top bar's button): everything since boot replays from a rewound start
  (`ctx.replay(recording, { onEnd })`, ws/core-6) and ends on the spot the player stood on, tick
  for tick; then play resumes and a new take is recorded after it, so a second replay plays
  both. The input records from boot (`input: { record: true }`); ground clicks reach the demo
  through a `PointerConsumer` on `input.dispatcher` and the wheel through `input.pointer.wheelY`,
  so both replay. The gear buttons and minimap taps are overlay DOM, not input: the demo logs
  them per tick in a side lane and re-applies them on the same ticks. The rewind resets the rng
  (`Random.state`), the hero, the ghouls, the crowd, cooldowns and gear. `__demo.replays`,
  `replayEnds`, `replayLength`, `replayFrom` and `replayTo` publish it.

## Known limits

The ghoul LOD drops boxes rather than segments: the body is boxes, with nothing to lower. LOD
lists are copied into the frame upload each frame; with `?blur` the ghoul list keeps previous
matrices (`velocity: true`), but the demo still builds its renderer without a velocity target, so
object motion blur falls back to the camera's motion: with `createGame({ aux: { velocity: true }
})` the scene pass has three colour targets while the flame particles' pipeline (built on
`renderer.sceneFormats`) has two, a validation error every frame. Gear swapping stays by hand:
the three sets are procedural `geom` meshes, not a glTF, and they differ in shape as well as
colour, while `loaded.setVariant` swaps only the materials of a loaded glTF
(`KHR_materials_variants`). The hero is a crowd agent with zero preferred velocity, so ghouls part
around it but it does not push them. Phone-portrait keeps the map in the card lane: rails there
would leave the world about 218 of 390 px of width. The replay covers mouse, keys and wheel; the
touch stick does not replay (`ctx.replay` feeds a 0 × 0 sink, so a replayed touch lands outside
the zone rect), and the overlay buttons go through the demo's side lane rather than the
recording.
