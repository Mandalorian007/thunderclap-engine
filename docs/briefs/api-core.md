# Brief: ws/api-core

Read `docs/briefs/common.md` first. Then read these:

- DECISIONS E-036, the public API conventions.
- In `docs/STATUS.md`: the ws/docs-guide wishes; the ws/input-11, ws/core-7 and ws/comment-sweep notes; and the deferred-comments list.
- `api/index.api.txt`, the core, ui and input sections.
- The core, ui and input READMEs, and `docs/guide/{getting-started,input,ui-and-hud}.md`.

## Goal

Get core, ui and input ready for v1. That means E-036 is applied, replay mutes pointers, and the friction found while writing the guides is fixed. Every change is additive or keeps a deprecated alias, so no demo, template or guide breaks.

The STATUS row is done when all of these hold:

- **Replay mutes pointers.** `ctx.replay` calls `pointers.mute()` after `attachSink()` and `unmute()` in `stop`/end, before `attachHome()`.
  - `mute()` returns a remover, so a game mute and a replay mute no longer clear each other. `unmute()` still clears everything.
  - Test: a live XR or screen pointer press during a replay does not reach the game, and a game mute survives the replay ending.
- **E-036 in core, ui and input.**
  - Every name ruled there in these modules is renamed with a deprecated alias: input `Rect` becomes `Edges`, plus `Hit`, `Aabb` (input side), `Cooldown` (ui side) and `prefersReducedMotion` (ui side). Pick the new names and list them.
  - Reads become getters where E-036 says so. Keep the old method as a deprecated alias.
  - Test-only exports, such as the ui `*_CSS` strings and `WORLD_PANEL_WGSL`, are deprecated.
- **Ergonomics.**
  - `ctx.camera` can be replaced with a `Camera.perspective`, via `ctx.setCamera(cam)` or similar.
  - `EngineCtx`'s save type no longer forces `FlushableSave` on games that have no save.
  - `ui.anchors()` and `ui.floats()` default to `ctx.camera`, and `WorldPanel` uses the right camera in VR.
  - `createGame({ theme, textScale })` is added.
  - `ctx.pointers` and touch-zone bindings are typed.
  - `pushContext` can add actions.
  - `planeTester` takes any plane.
  - Each item gets a unit test. Skip any item that would break a caller without an alias, and write it up as a wish instead.
- **Comments.** Fix the stale comments comment-sweep deferred: in `src/input/*` ("no XR source yet"), in `src/core/game.ts:76/:142/:323`, and in `src/ui/styles.ts:179`.
- **Docs.**
  - Update the core, ui and input READMEs. Their `<!-- snippet:check -->` blocks must still pass `check:snippets`.
  - Update the guides that show old spellings: getting-started, input, ui-and-hud.
  - Add a CHANGELOG block. Deprecations go under *Deprecated*.
  - Run `pnpm api:update`.

## Files owned

- `src/{core,ui,input}/**`
- the matching README sections
- `docs/guide/{getting-started,input,ui-and-hud}.md`
- `api/*.api.txt` (regenerated, never hand-edited)
- `CHANGELOG.md`
- ARCHITECTURE, one phrase per module

Do not edit `src/{render,post,fx}/**` (ws/api-render), the other modules (ws/api-rest), `demos/**` or `templates/**`. Deprecated aliases keep demos and templates compiling.

Branch from `origin/main` after train 13 lands. Use `E2E_PORT_OFFSET=1260`.

Gate:
- `pnpm check` and `snap:check`.
- These specs, each run alone: replay, xr, input, input5, ui, ui4, ui5, core2, lifecycle.
