# Brief: ws/render-11

Read `docs/briefs/common.md` first, then the ws/render-10, ws/core-8, ws/assets-4, ws/api-core and ws/src-v1 wish lines in `docs/STATUS.md`. **Post-v1 rule:** `api/` is frozen. Additions are allowed, but each changed module needs a CHANGELOG `## Unreleased` *Added* line, and `check:api` enforces it. No breaking changes.

## Goal

Object motion blur and VR finish the aux work that ws/render-10 started.

STATUS row, *done when*:

- **Velocity.** Billboards and world-space particles write real velocity into the velocity target instead of masking it.
  - Unit test on the fake GPU.
  - A `harness/render10?aux=velocity` variant shows moving particles blurring under object blur. State field `particleBlurPx` > 0, background 0.
- **XR aux.** `XrSurface` makes its eye targets with the aux attachments that `createGame({ aux })` asked for, through `SceneTarget.external({ aux })`.
  - The fake-XR test asserts per-eye attachment counts and `gpuErrors: 0`.
  - If one eye's velocity needs that eye's own previous view-projection, wire it, or say why not.
- **SkinPalette.** `SkinPalette.jointCount` is a getter, and anim `skinPose` asserts the palette is big enough, with a clear error.
- **Docs.** Update the render README *Aux targets*, add CHANGELOG *Added* lines, and run `api:update`.

**Files owned:** `src/{render,fx,xr}/**`, `src/anim/skin-pose.ts` and its test, `harness/render10*`, `e2e/render10.spec.ts`, `api/` and CHANGELOG.

Branch from origin/main. Use `E2E_PORT_OFFSET=1390`. Gate: `pnpm check` and `snap:check`, then render10, xr, fx3, skin and post4, each run alone.
