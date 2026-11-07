# Brief: ws/adoption-5

Read `docs/briefs/common.md` first. Then read these in `docs/STATUS.md`:
- the ws/adoption-4 row and notes, with their wishes: phone map and orbs onto content rails, and the 0.5 m grout corner
- the ws/ui-9 notes (content rails and the corner rule)
- the ws/render-7 notes (`InstanceList.setKey`, keyed LOD and velocity history)

Then read `demos/arpg/` end to end, `e2e/demos/arpg.spec.ts`, and `src/ui/README.md` *Layout*.

## Goal

The arpg demo uses what the engine now offers. On a phone, the world takes the most room it can. A dying ghoul doesn't make its neighbours pop LOD or smear motion blur.

STATUS row, *done when*:

- **Rails on phones.** On phone form factors, the minimap and the two orbs move onto content `left` and `right` rails, using ui-9's corner rule. They leave `cardLane` and the bottom bar.
  - Desktop and tablet are unchanged.
  - The spec asserts 0 overflow warnings on every row.
  - Phone-landscape world height should beat adoption-4's figure (about 64%). Record before and after in `__demo.worldView`.
- **Keyed ghouls.** The ghoul `InstanceList` keys each instance by ghoul id (`setKey`) and enables `velocity: true` where the post stack has motion blur on.
  - Spec: kill one ghoul mid-pack. Assert, through the page's state or `renderer.lodLevelOf`, that no other ghoul changes LOD level on that flush.
- **Grout corner.** The 0.5 × 0.5 m corner inside the near walls no longer shows the grout bed (a quarter tile, or one more edge piece). `centreSeam` stays under 10 in absolute value, and draw calls stay inside the band.
- **Docs.** The arpg README (*What to look at* and Known limits), and one CHANGELOG line under *Demos*.

## Files owned

You own:
- `demos/arpg/**`
- `e2e/demos/arpg.spec.ts`
- the arpg row of `demos/README.md`
- `CHANGELOG.md`

Do not edit:
- `src/**`. Engine gaps are wishes; ws/ui-10 is changing `ui.meter` sizing alongside you, so don't depend on it.
- other demos
- `templates/**`

**Branch** from `ws/render-7` at 7d60386 (keys are there). It is in E-031 train 10. Merge origin/main before your final gate. Your integrator lands you only after render-7 is on main.

Use `E2E_PORT_OFFSET=1140`. Gate per E-031, with arpg run alone.
