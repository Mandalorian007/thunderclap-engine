# Brief: ws/post-5

Read `docs/briefs/common.md` first, then the ws/post-4 and ws/render-5 rows and notes in `docs/STATUS.md`. Then read:
- `src/post/README.md`, *Passes* (TAA)
- `src/post/{taa,post-stack}.ts`
- `src/post/post4.test.ts`
- `src/render/camera-layout.test.ts`
- `harness/post4*`, `e2e/post4.spec.ts`

## Goal

TAA reprojects moving and skinned objects with the per-pixel velocity target, not only the camera matrix. That stops ghosting on characters, which is the E-015 bar.

STATUS row, *done when*:

- **Velocity reprojection.** When `PostInputs.velocity` is present, TAA's history lookup uses `uv - velocity`. Without it, today's `previousViewProj` path runs unchanged.
  - Add neighbourhood clamping in YCoCg, or keep today's if it is already there.
  - Reject history when the depth or velocity disagree by more than a threshold.
  - Option `taa.reprojection: 'camera' | 'velocity'`, default `'velocity'` when the target exists.
- **Measured.** `harness/post4` `?taa` gains a moving cube under a still camera, with state `ghostObject`. Assert in `e2e/post4.spec.ts` that it is at least 50% lower than with `'camera'` mode, polled per E-017. The existing post4 cases stay green.
- **Dedupe.** Delete the camera-layout check in `src/post/post4.test.ts`, because `src/render/camera-layout.test.ts` now covers it. Don't touch `src/render`.
- **Docs.** The README TAA row, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/post/**`
- `harness/post4*`, `e2e/post4.spec.ts`
- `CHANGELOG.md`

Do not edit `src/render/**`. ws/render-5 is in train 3. Branch from `main` (cd856e0 or later); you need nothing from render-5.

Use `E2E_PORT_OFFSET=900`. Gate per E-031 with the post2, post3, post4 and depth-post specs each run alone, and snap at 0 px.
