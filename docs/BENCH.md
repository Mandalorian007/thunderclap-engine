# Bench

Numbers from `harness/bench.html`, written by `pnpm bench` (`scripts/bench.mjs`). Each rung is a fixed scene held for 120 measured frames after a 20-frame warm-up; `CPU ms` is the median of `performance.now()` around the render callback (`beginFrame` to `endFrame`). `GPU ms` is the median `GpuTimer.totalMs` (first to last timestamp of a sampled frame) over the samples that resolved during the measured frames. `Count` is what the rung submits (instances, sprites or live particles); `Instances`, `Culled` and `Draw calls` are `renderer.stats` on the rung's last frame (a particle system is a drawable, so it counts 0 there); `Shadow draws` is the instances the sun's shadow pass drew (0 without a shadow). Numbers are what this run measured on a shared machine, not the engine's ceiling: other work on the same GPU and CPU moves them, so compare rungs within a run before comparing runs.

- Date: 2026-11-06
- Machine: headless Chromium at 1280×720 (the e2e `desktop-1280` row), shared with other processes while this ran.
- Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36
- Adapter: apple, metal-3
- Timestamps: yes (`timestamp-query`)

| Rung | Count | Frames | CPU ms | GPU ms | Instances | Culled | Shadow draws | Draw calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `instances-1k-cull` | 1,000 | 120 | 0.30 | 0.09 | 709 | 291 | 0 | 1 |
| `instances-1k` | 1,000 | 120 | 0.40 | 0.10 | 1,000 | 0 | 0 | 1 |
| `instances-10k-cull` | 10,000 | 120 | 3.20 | 0.35 | 7,084 | 2,916 | 0 | 1 |
| `instances-10k` | 10,000 | 120 | 4.10 | 0.38 | 10,000 | 0 | 0 | 1 |
| `instances-50k-cull` | 50,000 | 120 | 24.80 | 1.51 | 35,138 | 14,862 | 0 | 1 |
| `instances-50k` | 50,000 | 120 | 32.65 | 1.60 | 50,000 | 0 | 0 | 1 |
| `batch-10k-cull` | 10,000 | 120 | 0.70 | 0.35 | 7,084 | 2,916 | 0 | 1 |
| `batch-10k` | 10,000 | 120 | 0.70 | 0.35 | 10,000 | 0 | 0 | 1 |
| `batch-50k-cull` | 50,000 | 120 | 3.90 | 1.54 | 35,138 | 14,862 | 0 | 1 |
| `batch-50k` | 50,000 | 120 | 3.20 | 1.61 | 50,000 | 0 | 0 | 1 |
| `list-10k` | 10,000 | 120 | 0.20 | 0.40 | 10,000 | 0 | 0 | 1 |
| `list-50k` | 50,000 | 120 | 0.30 | 1.54 | 50,000 | 0 | 0 | 1 |
| `lights-0` | 10,000 | 120 | 4.00 | 0.41 | 7,084 | 2,916 | 0 | 1 |
| `lights-8` | 10,000 | 120 | 3.55 | 0.69 | 7,084 | 2,916 | 0 | 1 |
| `lights-16` | 10,000 | 120 | 3.80 | 1.05 | 7,084 | 2,916 | 0 | 1 |
| `shadow-off` | 10,000 | 120 | 3.90 | 0.41 | 7,084 | 2,916 | 0 | 1 |
| `shadow-on` | 10,000 | 120 | 2.80 | 0.52 | 7,084 | 2,916 | 7,084 | 1 |
| `sprites-10k` | 10,000 | 120 | 0.70 | 0.33 | 10,000 | 0 | 0 | 1 |
| `sprites-50k` | 50,000 | 120 | 1.90 | 1.56 | 50,000 | 0 | 0 | 1 |
| `particles-10k` | 10,000 | 120 | 0.20 | 0.33 | 0 | 0 | 0 | 0 |
| `particles-100k` | 100,000 | 120 | 0.30 | 2.58 | 0 | 0 | 0 | 0 |

## Rungs

- `instances-*`: that many cubes (one `Mesh`, one lit `Material`, one `Transform` each) in a 120×14×120 field the camera looks into from one side; `-cull` has `camera.cull` on, so the cubes outside the frustum are dropped before sorting (`Culled`), the other has it off and draws them all.
- `batch-*`: the same cubes as one `frame.meshes` batch (matrices and params in typed arrays built once, no batch bounds, so `-cull` culls per instance over the array); `list-*`: the same cubes in one retained `InstanceList` (`frame.list`), filled when the rung starts and unchanged after, so the frame uploads nothing (`camera.cull` off, like the plain `instances-*` and `batch-*` rungs; a list is culled as one sphere either way).
- `lights-N`: 10k culled cubes under a sun and N point lights (`Lights.points`).
- `shadow-on|off`: 10k culled cubes with `lights.sun.shadow` set (2048² map, extent 40) or not.
- `sprites-N`: N 24 px sprites through `frame.sprite` under the `ortho2d` camera (the 2D path).
- `particles-N`: a world-space `ParticleSystem` of capacity N, every particle alive, hovering in front of the camera.

Rerun with `pnpm bench`; `pnpm bench --rung instances-10k-cull,shadow-on` prints part of the ladder without writing this file.

## Reading the perf overlay against the bench

The perf overlay (`createPerfMonitor` / `createPerfOverlay` in `@thunderclap/engine/ui`; `?perf` on the harness's `mesh`, `lights` and `pbr` pages) shows the same quantities the bench table reports, but live and per frame rather than as a median over a rung. Its `cpu` line is the frame interval (or the `begin`/`end` span a page brackets), so it includes the page's own update work, vsync waiting and whatever else the tab is doing; the bench's `cpuMs` is the renderer's `beginFrame` → `endFrame` span only, so the overlay's CPU number is the upper bound of the bench's. `gpu` is `renderer.timing.gpuMs` on both: per-pass lines appear only where the device has `timestamp-query`, otherwise the total is the queue's submit-to-done time, which on a vsynced page approximates the frame's GPU cost and reads as "over budget" when the GPU falls behind. `drawCalls`, `instances`, `culled` and `shadowDraws` are `renderer.stats` of the last frame, the bench's per-rung counts; `scale` is the dynamic-resolution scale in effect. `avg`, `p95` and `max` are over the last 120 frames (the sparkline, with a 16.7 ms guide), so compare the overlay's `avg` after a few seconds of steady state with a rung's median, and use `p95` and `max` to see the stalls a median hides.
