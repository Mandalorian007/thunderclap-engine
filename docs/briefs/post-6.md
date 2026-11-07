# Brief: ws/post-6

Read these first:
- `docs/briefs/common.md`
- the ws/post-5 and ws/render-6 rows and notes in `docs/STATUS.md`
- `src/post/README.md`, *TAA*
- `src/render/README.md`, *Jitter hook*: what render-6 added and its migration note
- `src/post/{post-stack,taa,shaders}.ts`
- `harness/post4*`, `e2e/post4.spec.ts`

## Goal

TAA holds up under sub-pixel motion with camera jitter on, and the post stack jitters through the renderer, not the camera.

STATUS row, *done when*:

- **Jitter through the renderer.** While TAA is enabled, the stack drives Halton (2, 3) through `renderer.setJitter(fn)`, and clears it with `null` when TAA turns off or the stack is disposed. Nothing in `src/post` calls `Camera.setJitter` any more; add a grep test. XR per-eye still works: run the fake-XR test.
- **History filter.** Add `taa.historyFilter: 'bilinear' | 'catmull-rom'`, defaulting to `'catmull-rom'`. It is a 5-tap Catmull-Rom history sample, clamped to the neighbourhood.
  - Measure on a new harness phase where the cube moves 0.37 px a frame with jitter on: compare state `ghostSubpixel` and `blurSubpixel` for both filters against TAA off.
  - Done when catmull-rom has lower blur than bilinear and no more ghost. Report the numbers.
- **Unchanged.**
  - The integer-pixel phases keep their post-5 numbers within 10%.
  - The static scene converges as today.
  - The 2D goldens stay at 0 px.
- **Docs.**
  - Post README *TAA*: add `historyFilter` and the jitter source.
  - Types list.
  - One CHANGELOG line.

## Files owned

You own:
- `src/post/**`
- `harness/post4*`, `e2e/post4.spec.ts`
- `CHANGELOG.md`

Do not edit:
- `src/render/**`. A renderer gap is a wish.
- `demos/**`

Branch from `main` (43d0a1d or later). Use `E2E_PORT_OFFSET=980`. Gate per E-031 with post4, post2, post3 and depth-post each run alone.
