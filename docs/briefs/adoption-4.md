# Brief: ws/adoption-4

Read `docs/briefs/common.md` first. Then read the ws/ui-8, ws/adoption-3 and ws/core-3 rows and notes in `docs/STATUS.md`, including the wishes this closes:
- arpg HUD onto `bars` (ui-8)
- quarter-tile offset for the grout line (adoption-3)
- `demos/arpg/geom.ts` onto `hash2f` (core-3)

Then read `demos/arpg/` end to end, `src/ui/README.md` *Layout* (content bars) and `src/core/hash.ts`.

## Goal

The arpg demo uses the engine's layout and hashing the way a game should, and its floor reads clean at spawn.

STATUS row, *done when*:

- **HUD on bars.** The health and mana orbs leave the `cardLane` placement and sit in a content-sized `bottom` bar (as `ui5?orb` does). The bar is clamped so the world view keeps at least 70% of the height on phone-portrait.
  - Overflow warnings: 0 on every row. Assert this in `e2e/demos/arpg.spec.ts`.
  - If ws/ui-9's content rails are on main by your final gate, you may use them on phone-landscape. Say which you chose.
- **Grout off centre.** Shift the floor tiling by a quarter tile so the spawn-centre column hits neither a gap nor a grout line. State `centreSeam` has |value| < 10 at spawn on desktop-1280. Tighten the seam test to assert it.
- **Hashes.** `demos/arpg/geom.ts`'s hand-rolled hash moves to `hash2f`/`hash3f`. Any visual change from this is in demo pixels only; the demo has no golden. Say what moved.
- **No engine change.** If you need one, write it as a wish.
- **Docs.** arpg README (HUD, Known limits), one CHANGELOG line under *Demos*.

## Files owned

You own:
- `demos/arpg/**`
- `e2e/demos/arpg.spec.ts`
- the one CHANGELOG line
- the arpg row of `demos/README.md`

Do not edit:
- `src/**`
- `harness/**`
- `templates/**`

Branch from `main` (22f809c or later). Use `E2E_PORT_OFFSET=1090`. Gate per E-031 with `e2e/demos/arpg.spec.ts` run alone.
