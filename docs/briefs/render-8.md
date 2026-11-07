# Brief: ws/render-8

Read `docs/briefs/common.md` first. Then read the ws/render-6, ws/render-7 and ws/post-6 rows and notes in `docs/STATUS.md`, including the wishes this closes:
- per-object velocity for single `frame.mesh` draws (render-7)
- skip the unbound `prevBuffer` upload on velocity LOD lists (render-7)
- a renderer getter for the jitter hook (post-6)

Then read `src/render/README.md` (*Aux targets*, *Drawing many things*, *Camera jitter*) and `src/render/{renderer,frame,instance-list}.ts` with `render7.test.ts`.

## Goal

Every draw kind contributes true object motion to the velocity target, at no extra cost when velocity is off.

STATUS row, *done when*:

- **Single-draw velocity.**
  - `frame.mesh(mesh, material, transform)` writes per-object motion when a velocity target is on. It uses the transform's previous world matrix, kept per Transform and per view (render-5's per-view memory pattern).
  - A first-seen transform writes zero.
  - Unit test against the fake GPU: the previous matrix reaches the draw's uniforms.
  - Harness: add `render7?single-velocity` (additive), where a moving single mesh under a still camera has a velocity mean above 0 and the background has 0.
- **No wasted upload.** A velocity LOD list no longer uploads its own `prevBuffer`. A fake-GPU test counts the writes.
- **Jitter getter.** `renderer.jitter` (readonly) returns the installed jitter hook or `null`. Doc-comment it so the post stack can check it holds the hook. Do not edit `src/post`; ws/post-7 is running.
- **Unchanged when off.** The 2D goldens stay at 0 px. render4, render5, render7, post4, pbr and views stay green.
- **Docs.** The render README, one CHANGELOG block, and one ARCHITECTURE phrase.

## Files owned

You own:
- `src/render/**`
- `harness/render7*` and `e2e/render7.spec.ts` (additive)
- `CHANGELOG.md`
- the one ARCHITECTURE phrase

Do not edit:
- `src/post/**`
- `demos/**`
- `templates/**`

Branch from `ws/render-7` at 8ba7c15. It is in train 8; once `git merge-base --is-ancestor 8ba7c15 origin/main` succeeds, merge origin/main before your final gate. ws/post-7 may add one line to `renderer.ts` in its own commit; if both land, the integrator resolves it. Use `E2E_PORT_OFFSET=1100`. Gate per E-031 with render4, render5, render7, post4, pbr and views each run alone.
