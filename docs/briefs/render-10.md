# Brief: ws/render-10

Read `docs/briefs/common.md` first. Then read:
- the ws/core-7, ws/adoption-6 and ws/api-render notes in `docs/STATUS.md`
- the render README sections *Aux targets* and *Camera jitter and history*
- `src/render/{renderer,scene-target}.ts`, for `sceneFormats` and how aux attachments join the scene pass
- every pipeline built from `renderer.sceneFormats` (grep for it): fx particles, sky, decals, water, billboards, debug-draw, and the ui world-panel

## Goal

`createGame({ aux: { velocity: true } })` works in any scene. Today, turning on the velocity attachment gives the scene pass 3 colour targets while the particle pipeline (and others) declare 2. That raises a GPU validation error every frame, so object motion blur is unusable as soon as fx is in the scene. ws/adoption-6 found this.

STATUS row, *done when*:

- **One source of truth.** Every pipeline that draws into the scene pass gets its colour-target list from the renderer, for whichever aux attachments are on, through one helper. Name it in the README, for example `renderer.sceneTargets(blend?)`. A pipeline that writes no velocity uses `writeMask: 0` on that target.
  - A pipeline made before aux was turned on is rebuilt or keyed on the target set. Pick one approach and document it.
  - If a pipeline should write real velocity, list it as a wish; billboards and particles moving in world space are the likely ones. `writeMask: 0` is the bar for this branch.
- **Tests.**
  - A unit test with the fake GPU: with velocity on, every scene-pass pipeline's target count equals the pass's attachment count. Enumerate the pipelines through the helper, not a hand list.
  - A harness variant on an existing page you own, or a new `harness/render10*` page: particles, sky, decals and water drawn with velocity on report `gpuErrors: 0`.
  - `e2e/render10.spec.ts`.
- **VR.** If the XR scene target can't take aux attachments, as ws/core-7 noted, leave it camera-only and say so in the README. Do not attempt it here.
- **Docs.**
  - Render README *Aux targets*: add the helper and the rule "pipelines drawing into the scene pass take targets from `renderer.sceneTargets`".
  - CHANGELOG *Fixed*.
  - One ARCHITECTURE phrase.
  - Run `pnpm api:update`.

## Files owned

You own:
- `src/render/**` and `src/fx/**`
- the one world-panel pipeline line in `src/ui/`, coordinated: ws/api-core owns ui. If you need more than a one-line target-list swap, make it a wish.
- the new `harness/render10*` and `e2e/render10.spec.ts`
- `api/*.api.txt`, regenerated
- CHANGELOG, plus one ARCHITECTURE phrase

Do not edit `demos/**`. Turning blur on in the arpg demo comes later.

## Branch and gate

Branch from **ws/api-render at 60c5980**, since it changes render and post and is in train 14. Once `git merge-base --is-ancestor 60c5980 origin/main` succeeds, merge origin/main before your final gate. Use `E2E_PORT_OFFSET=1320`.

Gate:
- `pnpm check` and `snap:check` at 0 px
- run each of these alone: render10, render4, post4, fx3, decals, weather, mesh
