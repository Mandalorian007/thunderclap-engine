# Brief: ws/demo-arpg-2

Read these first:
- `docs/briefs/common.md` and `docs/briefs/demos-common.md`
- `docs/VISION.md`, the E-015 bar
- the ws/demo-arpg, ws/ui-6, ws/render-5 and ws/core-3 rows and notes in `docs/STATUS.md`
- `demos/arpg/**` end to end, including its README *Known limits*
- `src/render/README.md`, *LOD* and *Dissolve*
- `src/core/README.md`, *Hash*

## Goal

The E-015 showcase uses what has landed since it was built.

STATUS row, *done when*:

- **Dissolve deaths.** Enemy death uses `StandardMaterialDesc.dissolve`: amount 0→1 over about 0.8 s, an emissive edge in the demo palette, and shadows that dissolve too. This replaces the shrink.
  - Use one dissolve material per dying enemy from a small pool, not a new material per death.
  - State `dissolving` holds the count of enemies dissolving.
- **LOD.** Pillars, walls and enemies use `MeshLod` with two or three levels from `geom` at lower segment counts.
  - State `lodCounts` comes from `stats.lodCounts`.
  - The draw-call band and the desktop fps above 20 still hold.
- **Hash.** `demos/arpg/geom.ts` uses core `hash2f`/`hash3f` instead of its hand-rolled hash.
- **Known limits.** Drop the entries these close and re-check the rest against main. List any still-missing engine call as a wish.
- **Spec.** `e2e/demos/arpg.spec.ts` stays green. Add two tests:
  - a killed enemy reaches `dissolving > 0`, then returns to 0;
  - `lodCounts` shows more than one level when the camera is zoomed out. Add a `__arpgApi` zoom hook if needed.

## Files owned

You own:
- `demos/arpg/**`
- `e2e/demos/arpg.spec.ts`

Do not edit:
- `src/**`. An engine gap is a wish.
- other demos

Branch from `main` (2a76b00 or later). Use `E2E_PORT_OFFSET=960`. Gate per E-031 with demos/arpg run alone and snap at 0 px.
