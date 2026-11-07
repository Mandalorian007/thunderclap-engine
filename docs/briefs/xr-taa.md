# Brief: ws/xr-taa

Read `docs/briefs/common.md` first, especially *Post-1.0 API changes*. Then read the ws/core-9, ws/testing-3 and ws/render-12 notes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* or *Fixed* line.

## Goal

TAA works in XR.

STATUS row, *done when*:

- **Per-eye history.** TAA keeps one history (and jitter sequence state) per eye in XR, so each eye reprojects against its own previous frame. The screen path stays unchanged.
  - The fake-XR test checks that each eye's TAA pass binds that eye's own history and reads that eye's own uniforms.
  - It also checks there are no errors.
  - Re-run the existing per-eye ring test from ws/render-12.
- **Default stays.** `postQualityFor('xr')` defaults are unchanged. Document how to opt in to TAA for XR.
- **Docs.** Update the post README *XR* section and add a CHANGELOG line.

**Files owned:** `src/post/**`, `src/platform/xr*.test.ts`, the render README XR bullet, `api/` and CHANGELOG.

Use `E2E_PORT_OFFSET=1450`. Gate: `pnpm check` and `snap:check`, then the xr, post4 and render10 specs, each run alone.
