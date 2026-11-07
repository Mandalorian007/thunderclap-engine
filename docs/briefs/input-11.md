# Brief: ws/input-11

Read `docs/briefs/common.md` first, then the ws/core-6 row and notes in `docs/STATUS.md`. Then read `src/input/README.md` and `src/input/{pointer-sources,pointer-router,pointer-dispatch,xr-source,input}.ts` and their tests. Read `src/core/game.ts` too, but only to see how `ctx.replay` detaches input. Do not edit it.

## Goal

core-6 left one wish open: XR controller and hand pointers go straight to `ctx.pointers`, so a running replay still receives them. This brief adds a way to mute pointer sources, which `ctx.replay` can then use.

The STATUS row is done when:

- **Mute pointer sources.**
  - `input.pointers` (or the router) gains `mute(sources?)` and `unmute()`. With no argument, `mute()` mutes every live source. A muted source's events are dropped before dispatch.
  - A pointer that is held when its source is muted is released cleanly, firing an `up` or `cancel` event, never a stuck press.
  - A replay's own synthetic pointers are never muted.
- **Tests:**
  - A muted XR source's select does not dispatch.
  - A pointer held when the mute begins releases.
  - Unmuting restores dispatch.
  - Synthetic playback pointers still dispatch while live sources are muted.
- **Wiring:** a wish for core-8. Write down the one-line call `ctx.replay` would make to use this.
- **Docs:** add to the input README and its types list. Add one CHANGELOG line, and one ARCHITECTURE phrase.

## Files owned

You own:
- `src/input/**`
- `CHANGELOG.md`
- the one ARCHITECTURE phrase

Do not edit:
- `src/core/**`
- `src/xr/**`. Read these only. If you need a hook there, report it as a wish.
- `demos/**`
- `templates/**`

Branch from `origin/main`. Use `E2E_PORT_OFFSET=1210`. Gate per E-031: run check, snap, and the replay, xr and input specs, each spec on its own.
