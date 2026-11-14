# Brief: ws/ui-world (C6)

Read:
- `common.md` and `wave-2.0-3.md`
- C5's `src/ui` spec work (README, `presentDom`, `presentHud`)
- B3's views
- the harness `ui-world-panel` page

Merge ws/core-views first if it isn't on main.

Forge sources, read only: `FW:xr/present.ts`, `quad-panels.ts`, `status-panel.ts`, `FW:ui/`.

## Goal

One UI spec shows the same on a flat screen, on touch and in a headset. This follows Forge's "one HUD layout everywhere" rule.

1. **The world presenter** (`presentWorld(spec, …)`):
   - spec → Canvas2D → texture, on a quad in the world;
   - redraws only dirty regions, and runs on the core as a drawable per view.
2. **The head-following screen:** in VR the HUD and modals ride a comfortable head-locked or lazy-follow quad, which `presentHud` and `presentModal` target unchanged.
3. **Ray aim on panels:** intents (C7) aim rays hit panel quads and become the same `press`, `select` and `hover` the DOM presenter gives. Focus order and keyboard are the same.
4. **Backlog:**
   - Fix `src/ui/stack.ts`'s focus trap: always `preventDefault` Tab and move focus by hand, because WebKit skips buttons. Remove the ui.spec WebKit fixme.
   - Expose Layout's root doc (C5's ask).

## Done when

- One spec is shown on screen and in the stereo page with the same behaviour: a test drives the same press sequence through DOM and through ray aim, and checks the same state.
- WebKit ui.spec passes without fixme.

## Size

M.
