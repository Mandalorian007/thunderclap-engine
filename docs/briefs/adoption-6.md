# Brief: ws/adoption-6

Read `docs/briefs/common.md` first. Then read:
- the ws/ui-11, ws/ui-10 and ws/adoption-5 rows and notes in `docs/STATUS.md`, plus the per-form meter size wish
- the ui README *Layout* and *HUD widgets* sections
- `demos/arpg/` end to end

## Goal

The arpg demo uses the engine's placement instead of hand-built workarounds, and it shows the new core features.

STATUS row, *done when*:

- **Meters and minimap.**
  - The orbs and bars use `MeterOptions.place` maps per form factor. Remove the orb rebuild on form change.
  - Remove the minimap `min-width` workaround.
  - The phone, tablet and desktop layouts look the same as today or better. Prove it with the demo spec's screenshots or state on every row.
- **Core features.**
  - Add an in-game "watch replay" action that uses `ctx.replay(rec, { onEnd })`.
  - Turn on object motion blur with `createGame({ aux: { velocity: true } })` when the post setting asks for it.
- **Other demos.** Grep `demos/**` for other hand-built placement or replay code that the engine now covers. Adopt it where it is a small change, and list the rest.
- **Docs.** Update the demo README and add a CHANGELOG *Demos* line.

## Files owned

You own `demos/**`, `e2e/demos/**` and `CHANGELOG.md`.

Do not edit:
- `src/**`
- `templates/**`
- `harness/**`

Use only APIs on main. ws/api-core, ws/api-render and ws/api-rest keep deprecated aliases, so your calls keep compiling.

## Branching and gate

Branch from `origin/main` once train 13 has landed. Use `E2E_PORT_OFFSET=1290`.

Gate:
- `pnpm check` and `snap:check`
- `e2e/demos/arpg.spec.ts` alone
- any other demo spec you touched, alone
