# Brief: ws/render-12

Read `docs/briefs/common.md` first, especially the *Post-1.0 API changes* rule. Then read the ws/testing-2, ws/input-12 and ws/render-11 notes and wishes in `docs/STATUS.md`. Changes must be additive only, and each changed module needs a CHANGELOG `## Unreleased` *Added* line.

## Goal

XR scene mode carries aux all the way through.

STATUS row, *done when*:

- **Eye layer aux.** In `XrSurface` scene mode, the eye layer targets carry the requested aux attachments. Alternatively, post reads per-eye aux in place of `surface.scene`, if that's simpler. Pick one and say why in the report.
  - The fake-XR test asserts per-eye aux in scene mode and `gpuErrors: 0`.
  - Object motion blur in XR scene mode uses each eye's velocity.
- **Docs.** Update the render README *Aux targets* XR bullet and add a CHANGELOG line.

**Files owned:** `src/{render,platform/xr*,post}/**`, `api/` and CHANGELOG.

Use `E2E_PORT_OFFSET=1440`. Gate: `pnpm check` and `snap:check`, then the xr, render10 and post4 specs run alone.
