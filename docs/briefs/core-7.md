# Brief: ws/core-7

Read `docs/briefs/common.md` first, then the ws/core-6, ws/render-4 and ws/adoption-5 rows and notes in `docs/STATUS.md`. Then read `src/core/game.ts`, its tests and the core README. Read the render README's *Aux targets* section (read only) for what a velocity target is.

## Goal

This brief closes two wishes:
- *`onEnd` on `ctx.replay`* (core-6)
- *no `createGame` option for a velocity target, so object motion blur falls back to the camera* (adoption-5)

The STATUS row is done when:

- **`ctx.replay(rec, { onEnd })`.** The callback runs once when the recording ends. That is on the fixed step where the loop stops the replay, after input is reattached. It does not run on a manual `stop()`, unless you document a `reason` argument (`'end' | 'stop' | 'replaced'`) and test each reason.
  - Test: `onEnd` fires once, on the right tick, at speed 1 and speed 4.
- **Velocity target option.** `createGame` gains an option that requests the renderer's velocity aux target through the existing render API, so a game using `post.motionBlur` gets object blur without touching the renderer. Read the option's name and shape from the existing aux-target API, and do not change render.
  - Test: the option produces a velocity target in `PostInputs`.
  - Test: without the option, nothing changes. The snap goldens stay at 0 px.
- **Docs:** core README, the types list, one CHANGELOG line, and one ARCHITECTURE phrase.

## Files owned

You own:
- `src/core/**`
- `CHANGELOG.md`
- the one ARCHITECTURE phrase

Do not edit:
- `src/render/**` and `src/post/**`. Treat these as read only. If you hit a gap there, report it as a wish.
- `demos/**`
- `templates/**`

Branch from `ws/core-6` at ad6ea9c, which is in E-031 train 12. Merge origin/main before your final gate. Use `E2E_PORT_OFFSET=1200`. Gate per E-031: check, snap, and the replay, core2 and lifecycle specs, plus post4 if you touch post inputs. Run each spec on its own.
