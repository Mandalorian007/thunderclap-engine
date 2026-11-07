# Brief: ws/adoption-3

Read these first:
- `docs/briefs/common.md` and `docs/briefs/demos-common.md`
- the ws/render-6, ws/ui-7, ws/demo-arpg-2 and ws/core-3 rows and notes in `docs/STATUS.md`
- `demos/arpg/**`
- `src/render/README.md`, *LOD*
- `src/ui/README.md`, *Canvas minimap*

## Goal

The arpg showcase uses what trains 5 and 6 shipped, and its floor seam is gone.

STATUS row, *done when*:

- **Instanced LOD.** Pillars, broken pillars, drums, walls and ghouls go back to `createInstanceList(meshLod, ...)` or `frame.meshes(meshLod, ...)` in place of one `frame.mesh` per instance. Use one list per prop kind.
  - Report draw calls and fps before and after at the default and zoom-64 cameras on desktop-1280 and phone-se.
  - Done when draw calls fall and fps stays at or above today's.
  - `lodCounts` keeps working.
- **Floor seam.** Offset the 2-unit floor tiles by half a tile, or remove the 0.06 gap at x = 0, so nothing bright shows at screen centre at spawn.
  - Add state `centreSeam`: the brightness of column 640 less the mean of columns 636 and 644, read from a canvas readback at `?still&seed=3` on desktop-1280.
  - Spec: `centreSeam` is below 10.
- **Minimap headings.** Ghouls on the minimap use `heading` with an `'arrow'` kind at size 12–14.
- **Known limits.** Drop the instanced-LOD entry.
- **Spec.** `e2e/demos/arpg.spec.ts` stays green, with the seam test added.

## Files owned

You own:
- `demos/arpg/**`
- `e2e/demos/arpg.spec.ts`

Do not edit `src/**`. An engine gap is a wish.

Branch from `main` (9fbc59d or later). Use `E2E_PORT_OFFSET=1010`. Gate per E-031 with demos/arpg run alone and snap at 0 px.
