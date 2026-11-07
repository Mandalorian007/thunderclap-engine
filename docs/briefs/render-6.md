# Brief: ws/render-6

Read `docs/briefs/common.md` first, then the ws/render-5 and ws/post-4 rows and notes in `docs/STATUS.md`. Then read:
- `src/render/README.md` (*LOD*, *Dissolve*, *Shadows*, *Camera jitter and history*)
- `src/render/{renderer,frame,camera,standard-material,shadow*}.ts`
- `src/platform/gpu.ts`
- `harness/render5*`, `e2e/render5.spec.ts`

## Goal

This closes render-5's deviations and gives post a clean jitter hook. Each item is additive, and the 2D goldens stay pixel-identical.

STATUS row, *done when*:

- **LOD everywhere.** `frame.meshes` and `InstanceList` accept a `MeshLod`.
  - Each instance picks its level with the same `pickLodLevel` and hysteresis.
  - Instances are bucketed per level, so each non-empty level is one instanced draw.
  - Level memory is kept per view (main, each shadow cascade, each XR eye) instead of per Transform. A shadow cascade always uses the main view's level.
  - Tests: bucketing, per-view memory, `stats.lodCounts`.
  - Harness `render5?lod` gains `&instanced`, with state `instancedDraws`.
- **Alpha-masked shadows.** A material with `alphaMode: 'mask'` (or whatever main calls it) discards below its cutoff in the shadow pass through the render-5 `shadowFragmentEntry`.
  - The pipeline cache key includes it.
  - Opaque materials keep the depth-only fast path.
  - Test that a masked quad's shadow has holes. A harness variant `render5?mask` provides state `shadowHolePx`.
  - Snap stays at 0 px. If a golden would change, stop and report.
- **Renderer jitter hook.** `renderer.setJitter(fn: ((frame) => [x, y]) | null)` is applied to every view camera, including XR eyes. The renderer owns previous-matrix bookkeeping.
  - Keep `Camera.setJitter` working.
  - Do not edit `src/post`. Post will move from `addJitterCamera` to this hook in a later brief, so document the migration in the README.
- **GPU features.** `initGpu` in `src/platform/gpu.ts` requests `compressionFeatures(adapter)` when the adapter has them, so `renderer.caps.compressed` is truthful without a second device. Make `harness/render5?ktx2` use the shared device.
- **Docs.** The render README, the types list, a CHANGELOG block and one ARCHITECTURE sentence.

## Files owned

You own:
- `src/render/**`
- `src/platform/gpu.ts` and its test
- `harness/render5*`, `e2e/render5.spec.ts`
- `CHANGELOG.md`, `ARCHITECTURE.md` (one sentence)

Do not edit:
- `src/post/**` (ws/post-5 is in flight)
- `demos/**`, `templates/**`

Branch from `main` (f9c3764 or later). Use `E2E_PORT_OFFSET=910`. Gate per E-031: the render4, render5, pbr, mesh, shadow* and post4 specs each run alone, and snap at 0 px.
