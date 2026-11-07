# Brief: ws/render-9

Read `docs/briefs/common.md` first. Then read these in `docs/STATUS.md`:
- the ws/render-7 and ws/render-8 rows and notes
- the wishes this closes:
  - *a LOD list still uploads its main instance `buffer` that nothing draws* (render-8)
  - *fake GPU `copyBufferToBuffer` should check usage flags* (fx-6)
  - *a fake GPU staging buffer with a working `mapAsync`/`getMappedRange`/`unmap`* (fx-7)

Then read `src/render/{instance-list,fake-gpu}.ts`, their tests, and the tests that stub mapping (`grep -rl mapAsync src`).

## Goal

LOD lists upload only what is drawn. The fake GPU catches the usage-flag and mapping mistakes a real device would reject.

STATUS row, *done when*:

- **LOD uploads.** A LOD `InstanceList`'s flush skips the main instance `buffer` upload when only the per-level copies are drawn.
  - Write-count test: the LOD flush writes N fewer bytes than today and draws the same.
- **Usage flags.** The fake GPU's `copyBufferToBuffer`, `writeBuffer` and `mapAsync` throw a `GPUValidationError`-like error when the source, destination or mapped buffer lacks the required `GPUBufferUsage` flag (`COPY_SRC`, `COPY_DST`, `MAP_READ`).
  - Fix any engine code this exposes as a real bug. Report each one with evidence.
  - Fix any test that built an under-flagged buffer.
- **Working staging.** Fake buffers created with `MAP_READ` support:
  - `mapAsync` resolving after the copy's queue submission
  - `getMappedRange` returning the copied bytes
  - `unmap` detaching the range
- **Readback tests move off stubs.** fx-7's particle readback tests and gpu-timer tests drop their hand-stubbed mapping. If fx-7 is not yet on main when you start, do the fx part after merging it, and say so.
- **Docs.** The render README *Testing* (or the fake-GPU section) and one CHANGELOG line under *Tests*.

## Files owned

You own:
- `src/render/{instance-list,fake-gpu}.ts` and their tests
- any `*.test.ts` that needs flag or mapping fixes (test files only)
- `CHANGELOG.md`

Engine bug fixes outside `src/render` need PM approval in your report. Do not edit:
- `demos/**`
- `templates/**`
- harness pages

**Branch** from `ws/render-8` at b3dc3b6 (E-031 train 10). Merge origin/main before your final gate, and once fx-7 c5ee45a is on main, merge it too. Use `E2E_PORT_OFFSET=1160`. Gate per E-031 with render4, render5, render7, fx3 and pbr each run alone.
