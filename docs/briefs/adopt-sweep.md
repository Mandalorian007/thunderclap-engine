# Brief: ws/adopt-sweep

Read `docs/briefs/common.md` first, then `docs/briefs/demos-common.md`. In `docs/STATUS.md`, read:
- the ws/template-sweep, ws/core-2, ws/input-5 and ws/assets-3 rows
- the wish lines routed to the adoption sweep: core-2's list of hand-rolled copies, and demo-arpg's `loaded.setVariant`
- the ws/geom-3 line: the platformer adopts `slideTiles`

Then read the READMEs of `src/core` (Random, Noise, Scheduler, Pool), `src/input` (contexts, buffer, shaped sticks), `src/assets` (*Material variants*) and `src/geom` (`slideTiles`).

## Goal

Templates and demos stop carrying hand-rolled copies of things the engine now ships. A game author copying a template learns the engine call, not a local helper. Behaviour stays the same, except where seeded determinism changes a random sequence. Where it does, the README says so, and specs that pinned the old sequence are updated.

STATUS row, *done when* each swap below is made, or kept with a one-line reason in your report:

- **Random.**
  - mulberry32 in `demos/dungeon/map.ts` and `demos/tactics/map.ts` becomes `createRandom(seed)`.
  - The same goes for `templates/puzzle/src/rules/random.ts`.
  - Maps generated with `?seed` must stay valid. They may differ from today.
- **Noise.**
  - Value noise in `demos/voxel/world.ts` and `templates/first-person/src/world/terrain.ts` becomes `createNoise`.
  - Terrain may change shape. Keep the height range and the spawn on solid ground, and assert both in the specs.
- **Scheduler.**
  - The cooldowns and timers in dungeon `hitCooldown`, platformer `dashCooldown` and `dustTimer`, and puzzle `mismatchFor` become `createScheduler`.
- **Pool.**
  - The third-person template's particle pool becomes `createPool`.
- **Input.**
  - Where a template or demo hand-rolls a jump buffer or coyote press, use input-5's buffer.
  - Where one hand-rolls a stick deadzone or curve, use the shaped stick read.
  - Name each site in your report.
- **Variants.**
  - The arpg demo's hand gear swap becomes `loaded.setVariant` if the gear is built as a glTF with variants. Otherwise keep the hand swap, and update the README *Known limits* line to name exactly what blocks it.
- **slideTiles.**
  - The platformer's tile collision slide uses geom's `slideTiles`.

Every touched template and demo spec stays green, as does the template smoke e2e. Run them on their own. `pnpm check` must pass with its template checks, and `pnpm snap:check` must show 0 px.

## Files owned

- `templates/**`
- `demos/{dungeon,tactics,voxel,arpg,arena,range,showroom}/**`
- their specs under `e2e/demos/*` and `e2e/templates*`, edited only where a pinned value moves
- `CHANGELOG.md`, one *Templates and demos* block

Do not edit:
- `src/**`. An engine gap is a wish.
- `e2e/demos/{voxel,tactics}.spec.ts` beyond a pinned value: ws/e2e-harden owns their timing. Coordinate through your report.

Branch from `main` (e23be4d or later). Use `E2E_PORT_OFFSET=830`. Gate per E-031.
