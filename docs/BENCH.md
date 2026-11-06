# Bench

Numbers from `harness/bench.html`, written by `pnpm bench` (`scripts/bench.mjs`). Each rung is a fixed scene held for 120 measured frames after a 20-frame warm-up; `CPU ms` is the median of `performance.now()` around the render callback (`beginFrame` to `endFrame`). `GPU ms` is the median `GpuTimer.totalMs` (first to last timestamp of a sampled frame) over the samples that resolved during the measured frames. `Count` is what the rung submits (instances, sprites or live particles); `Instances`, `Culled` and `Draw calls` are `renderer.stats` on the rung's last frame (a particle system is a drawable, so it counts 0 there); `Shadow draws` is the instances the sun's shadow pass drew (0 without a shadow). Numbers are what this run measured on a shared machine, not the engine's ceiling: other work on the same GPU and CPU moves them, so compare rungs within a run before comparing runs.

- Date: 2026-11-05
- Machine: headless Chromium at 1280×720 (the e2e `desktop-1280` row), shared with other processes while this ran.
- Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36
- Adapter: apple, metal-3
- Timestamps: yes (`timestamp-query`)

| Rung | Count | Frames | CPU ms | GPU ms | Instances | Culled | Shadow draws | Draw calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `instances-1k-cull` | 1,000 | 120 | 0.30 | 0.09 | 709 | 291 | 0 | 1 |
| `instances-1k` | 1,000 | 120 | 0.40 | 0.10 | 1,000 | 0 | 0 | 1 |
| `instances-10k-cull` | 10,000 | 120 | 3.60 | 0.35 | 7,084 | 2,916 | 0 | 1 |
| `instances-10k` | 10,000 | 120 | 4.60 | 0.37 | 10,000 | 0 | 0 | 1 |
| `instances-50k-cull` | 50,000 | 120 | 28.95 | 1.20 | 35,138 | 14,862 | 0 | 1 |
| `instances-50k` | 50,000 | 120 | 38.25 | 1.65 | 50,000 | 0 | 0 | 1 |
| `lights-0` | 10,000 | 120 | 4.40 | 0.24 | 7,084 | 2,916 | 0 | 1 |
| `lights-8` | 10,000 | 120 | 4.30 | 0.28 | 7,084 | 2,916 | 0 | 1 |
| `lights-16` | 10,000 | 120 | 4.20 | 0.58 | 7,084 | 2,916 | 0 | 1 |
| `shadow-off` | 10,000 | 120 | 3.90 | 0.28 | 7,084 | 2,916 | 0 | 1 |
| `shadow-on` | 10,000 | 120 | 2.90 | 0.54 | 7,084 | 2,916 | 7,084 | 1 |
| `sprites-10k` | 10,000 | 120 | 0.90 | 0.21 | 10,000 | 0 | 0 | 1 |
| `sprites-50k` | 50,000 | 120 | 2.50 | 1.04 | 50,000 | 0 | 0 | 1 |
| `particles-10k` | 10,000 | 120 | 0.10 | 0.88 | 0 | 0 | 0 | 0 |
| `particles-100k` | 100,000 | 120 | 0.10 | 2.98 | 0 | 0 | 0 | 0 |

## Rungs

- `instances-*`: that many cubes (one `Mesh`, one lit `Material`, one `Transform` each) in a 120×14×120 field the camera looks into from one side; `-cull` has `camera.cull` on, so the cubes outside the frustum are dropped before sorting (`Culled`), the other has it off and draws them all.
- `lights-N`: 10k culled cubes under a sun and N point lights (`Lights.points`).
- `shadow-on|off`: 10k culled cubes with `lights.sun.shadow` set (2048² map, extent 40) or not.
- `sprites-N`: N 24 px sprites through `frame.sprite` under the `ortho2d` camera (the 2D path).
- `particles-N`: a world-space `ParticleSystem` of capacity N, every particle alive, hovering in front of the camera.

Rerun with `pnpm bench`; `pnpm bench --rung instances-10k-cull,shadow-on` prints part of the ladder without writing this file.
