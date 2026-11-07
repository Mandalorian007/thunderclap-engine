# Brief: ws/core-8

Read `docs/briefs/common.md` first. Then read:
- the ws/testing-kit, ws/adoption-6, ws/render-10 and ws/api-core notes in `docs/STATUS.md`
- the core, input, ui and testing READMEs
- `src/core/game.ts` and `src/testing/`

## Goal

Close the hardening wishes that block clean game tests and touch replays.

STATUS row, *done when*:

- **Headless `createGame`.** `createGame({ gpu?, clock?, host? })` runs with injected fakes and no canvas or WebGPU. `createTestGame` in `src/testing` becomes a thin wrapper over it, and the hand-rolled loop it uses today is deleted.
  - Test: a game made with the fake GPU and fixed clock steps N frames deterministically, and its scene stack, save and pointers work.
- **Touch replay.** `ctx.replay`'s input sink has real viewport bounds, so a recorded touch stick or touch zone replays. Overlay page-button events become recordable if that's feasible; otherwise make it a wish with the reason.
  - Test: record a stick drag, replay it, and get the same action values frame for frame.
- **`HostLifecycle.state`** is a getter, per E-036, with a deprecated alias for the old shape if there was one.
- **WorldPanel on `frame.auxKey`.** The WorldPanel pipeline is keyed per aux key through `renderer.sceneTargets(blend, frame.auxKey)`, as ws/render-10 did for fx.
  - Test: a fake-GPU unit test where a WorldPanel draws into an aux target and a plain target in the same frame.
- **Docs:**
  - The core, testing and ui READMEs.
  - A CHANGELOG entry.
  - ARCHITECTURE phrases.
  - Run `pnpm api:update`.
  - Snippets in `src/*/README.md` only for the sections you change. ws/docs-v1 owns the rest of the docs.

## Files owned

You own:
- `src/{core,testing,input}/**`
- `src/ui/world-panel/**`
- `src/host/**`, for the lifecycle getter only
- your tests
- `api/`
- `CHANGELOG.md`
- ARCHITECTURE phrases

Do not edit:
- `docs/guide/**` or the root README: those are ws/docs-v1's
- `templates/**` or `demos/**`: those are ws/templates-v1's

Branch from origin/main at d411171 or later. Use `E2E_PORT_OFFSET=1360`.

Gate:
- `pnpm check` and `snap:check`
- each of replay, input, input5, ui4, world-panel, xr, lifecycle and core2, run alone
