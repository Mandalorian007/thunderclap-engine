# Brief: ws/comment-sweep

Read `docs/briefs/common.md` first. Then read every line of the *Backlog* section of `docs/STATUS.md` that mentions comment-sweep, stale comments or doc-sweep-3, along with the ws/spot-lights and ws/skinning follow-ups.

## Goal

Make the code comments true. A reader of `src/**` should never find a comment that describes behaviour the code no longer has.

The STATUS row is done when all of these hold:

- **Listed items fixed.** Every stale comment the backlog lists is fixed, or reported as already fixed with the line that proves it. This includes:
  - the doc-sweep-3 list: host types, core game, assets gltf-load, input types/pointer-sources/pointer-router/xr-source, ui styles/overlay, render material/lights/wgsl/scene-target/shadow/renderer
  - the instance-format flags comment (layers ride bits 1..23)
  - the platform README line that says "No dependencies"
  - the post README line about bgra8unorm
- **Sweep beyond the list.** Grep `src/**` for comments that name removed or renamed APIs: the post jitter WeakMap, sample-UV jitter, `InputClock` on `ctx.clock`, and anything the last three trains renamed (read `git log -p --since=12.hours -- src` for renames). Fix each one.
- **No code changes.** Only comments and JSDoc change. `pnpm check` and `snap:check` must give identical results before and after. Prove it with the Vitest count and 0 px.
- **Report.** List the fixes per file, with counts.

## Files owned

You own comments and JSDoc in `src/**`. Do not edit:

- `src/*/index.ts`, which ws/harden-api owns
- `src/*/README.md`, which ws/docs-modules owns, except the two README lines named above
- `src/ui/**`, `src/input/**` and `src/core/game.ts`, which ws/ui-11, ws/input-11 and ws/core-7 are editing. List what you would fix in those files in your report instead.
- `demos/**` and `templates/**`

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1250`. Gate: `pnpm check` and `snap:check`.
