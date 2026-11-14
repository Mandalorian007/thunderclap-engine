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

The perf overlay (`createPerfMonitor` / `createPerfOverlay` in `@thunderclap-engine/engine/ui`; `?perf` on the harness's `mesh`, `lights` and `pbr` pages) shows the same quantities the bench table reports, but live and per frame rather than as a median over a rung. Its `cpu` line is the frame interval (or the `begin`/`end` span a page brackets), so it includes the page's own update work, vsync waiting and whatever else the tab is doing; the bench's `cpuMs` is the renderer's `beginFrame` → `endFrame` span only, so the overlay's CPU number is the upper bound of the bench's. `gpu` is `renderer.timing.gpuMs` on both: per-pass lines appear only where the device has `timestamp-query`, otherwise the total is the queue's submit-to-done time, which on a vsynced page approximates the frame's GPU cost and reads as "over budget" when the GPU falls behind. `drawCalls`, `instances`, `culled` and `shadowDraws` are `renderer.stats` of the last frame, the bench's per-rung counts; `scale` is the dynamic-resolution scale in effect. `avg`, `p95` and `max` are over the last 120 frames (the sparkline, with a 16.7 ms guide), so compare the overlay's `avg` after a few seconds of steady state with a rung's median, and use `p95` and `max` to see the stalls a median hides.





## Reference scenes

Six scenes every engine change is measured on (E-041 A4): `harness/ref-<scene>.html` in a browser, the same code counted on the fake device by `src/<module>/ref-<scene>.budget.test.ts`. Each is deterministic: a fixed seed, frame `i` at `i / 60` s, a fixed camera path, procedural art only, a 1920×1080 logical view on a 1280×720 backbuffer.

- `ref-board` (S1, 2D): a 48×27 tile layer, a flipbook walker and 4,000 sprites drifting on circles under the `ortho2d` camera.
- `ref-characters` (S2): 64 (and 256) seven-joint figures, each its own `AnimationMixer` on a walk clip, skinned through one `SkinPalette`, under a sun shadow; the camera orbits.
- `ref-arena` (S3): standard-material spheres and pillars on a floor, a sun shadow, 8 moving point lights and 2 spots, bloom and vignette (`PostStack`).
- `ref-voxel` (S4): an 8×2×8 (and 16×2×16) chunk world of 16³ chunks, meshed before frame 0 (in a Worker on the page), flown over.
- `ref-stereo` (S5): S2's figures (32) seen by two eyes a frame (`viewIndex` 0 and 1, half the target each); `ref-stereo-mono` is the same frame through one view.
- `ref-hud` (S6): an idle overlay (reticle, two meters, six slots, a heading) over a still scene; every frame sets the widgets to the values they hold.

Counted per frame (40 measured after 10 warm-up), as in "Counted work, 1.3 baseline" below; a row must stay at or under these, counter by counter. `↳` rows split the frame by `meter.view`: `update` is the scene's own work (animation, skinning), `view`/`left`/`right` a `renderer.render`, `hud` the overlay's `set` calls, `present` `endFrame`. Written by `TC_REF=write pnpm vitest run /ref-`; this part of the section is checked against the JSONs by `src/render/ref-scenes.budget.test.ts`.

| Row | Commands | Draws | Pipelines | Bind groups | Passes | Submits | Writes | Bytes written | Creates | Typed arrays | Clock reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ref-board` | 28 | 4 | 4 | 5 | 2 | 1 | 2 | 450,256 | 1 | 0 | 0 |
| `ref-characters-64` | 46 | 6 | 6 | 6 | 3 | 1 | 4 | 36,852 | 1 | 0 | 0 |
| ↳ `update` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 21,504 | 0 | 0 | 0 |
| ↳ `view` | 38 | 5 | 5 | 5 | 2 | 0 | 3 | 15,348 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-characters-256` | 46 | 6 | 6 | 6 | 3 | 1 | 4 | 130,145.2 | 1 | 0 | 0 |
| ↳ `update` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 86,016 | 0 | 0 | 0 |
| ↳ `view` | 38 | 5 | 5 | 5 | 2 | 0 | 3 | 44,129.2 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-arena` | 252.25 | 52.38 | 48.6 | 49.6 | 15 | 1 | 6 | 18,822.4 | 1 | 0 | 0 |
| ↳ `view` | 177.25 | 39.38 | 35.6 | 36.6 | 2 | 0 | 3 | 16,518.4 | 1 | 0 | 0 |
| ↳ `present` | 75 | 13 | 13 | 13 | 13 | 1 | 3 | 2,304 | 0 | 0 | 0 |
| `ref-voxel-8` | 51.1 | 34 | 2 | 3 | 2 | 1 | 2 | 5,728 | 1 | 0.03 | 1 |
| ↳ `view` | 44.1 | 33 | 1 | 2 | 1 | 0 | 2 | 5,728 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-voxel-16` | 101.6 | 84.4 | 2 | 3 | 2 | 1 | 2 | 11,372.8 | 1 | 0.03 | 1 |
| ↳ `view` | 94.6 | 83.4 | 1 | 2 | 1 | 0 | 2 | 11,372.8 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-stereo` | 87 | 11 | 11 | 11 | 5 | 1 | 7 | 30,780 | 1 | 0 | 0 |
| ↳ `update` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 10,752 | 0 | 0 | 0 |
| ↳ `left` | 40 | 5 | 5 | 5 | 2 | 0 | 3 | 10,019.6 | 1 | 0 | 0 |
| ↳ `right` | 39 | 5 | 5 | 5 | 2 | 0 | 3 | 10,008.4 | 0 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-stereo-mono` | 46 | 6 | 6 | 6 | 3 | 1 | 4 | 20,766 | 1 | 0 | 0 |
| ↳ `update` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 10,752 | 0 | 0 | 0 |
| ↳ `view` | 38 | 5 | 5 | 5 | 2 | 0 | 3 | 10,014 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `ref-hud` | 22 | 3 | 2 | 2 | 2 | 1 | 2 | 2,480 | 1 | 0 | 0 |
| ↳ `view` | 15 | 2 | 1 | 1 | 1 | 0 | 2 | 2,480 | 1 | 0 | 0 |
| ↳ `present` | 7 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

`renderer.stats` at frame 30, pinned exactly; e2e/ref-scenes.spec.ts checks each page draws the same:

| Row | Draw calls | Triangles | Instances | Culled | Shadow draws | Views |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `ref-board` | 3 | 10,594 | 4,002 | 0 | 0 | 1 |
| `ref-characters-64` | 3 | 5,378 | 65 | 0 | 36 | 1 |
| `ref-characters-256` | 3 | 21,506 | 257 | 0 | 100 | 1 |
| `ref-arena` | 35 | 47,138 | 58 | 0 | 53 | 1 |
| `ref-voxel-8` | 33 | 15,136 | 33 | 0 | 0 | 1 |
| `ref-voxel-16` | 83 | 47,624 | 83 | 0 | 0 | 1 |
| `ref-stereo` | 6 | 5,380 | 66 | 0 | 42 | 2 |
| `ref-stereo-mono` | 3 | 2,690 | 33 | 0 | 21 | 1 |
| `ref-hud` | 2 | 38 | 4 | 0 | 0 | 1 |

Other pinned numbers:

- ref-stereo: commands, two eyes over one view: 1.89
- ref-hud: DOM writes a frame: 0
- ref-hud: DOM reads a frame: 0

### Timings

Chromium only (no WebKit project yet), headless at 1280×720 on the e2e `desktop-1280` row, 2026-11-14, Apple M-series (`apple metal-3`), timestamps on, a machine shared with other agents' runs. `TC_REF_TIMES=<file> E2E_PORT_OFFSET=… pnpm test:e2e e2e/ref-scenes.spec.ts` writes these; a `ref-*` page skips `BENCH_WARMUP` (20) frames and takes the median of the rest of `BENCH_FRAMES` (140): CPU is `performance.now()` around the frame's `step` (scene work, `beginFrame` → `endFrame`), GPU the median `renderer.onGpuTime` sample. `core-*` rungs are B1's retained core page (harness/core.html, `?sets=`): its own median CPU of the last 60 frames, no GPU time. `performance.now()` is coarsened to 0.1 ms in the page, so a CPU median under 1 ms is a step of that grain.

| Rung | Frames | CPU ms | CPU p95 ms | GPU ms |
| --- | ---: | ---: | ---: | ---: |
| `ref-board` | 120 | 1.00 | 1.20 | 0.16 |
| `ref-characters` | 120 | 0.30 | 0.50 | 0.23 |
| `ref-characters-256` | 120 | 0.60 | 1.20 | 0.24 |
| `ref-arena` | 120 | 0.40 | 0.50 | 2.03 |
| `ref-voxel` | 120 | 0.20 | 0.30 | 0.18 |
| `ref-voxel-16` | 120 | 0.30 | 0.80 | 0.30 |
| `ref-stereo` | 120 | 0.40 | 1.00 | 0.35 |
| `ref-hud` | 120 | 0.20 | 0.30 | 0.08 |
| `core-1.5k` | 60 | 0.10 | — | — |
| `core-6k` | 60 | 0.10 | — | — |

## Counted work, 1.3 baseline

What a frame does, counted on the fake device by `createWorkMeter` (`@thunderclap-engine/engine/testing`), averaged per frame over the measured frames after a warm-up. Written by `TC_BUDGET=write pnpm vitest run src/render/baseline.budget.test.ts` from `src/render/baseline.budget.json`; that test fails any scene that does more of any counter than its row, and fails if this section and the JSON disagree. `pnpm bench` keeps this section. Today's numbers (engine 1.3) are the guard the render core must beat or explain (E-041, D2 R2).

- Rows are the bench rungs above (the same seeded scenes on the fake device; timings are the browser's, these are counts), `2d-tiles` (harness/tiles.html's grid: a 32×18 tile layer and a flipbook walker), `2d-game` (`createGame` with one empty scene, its default post chain) and `distinct-*` (design/2.0/bar.md D2-P1: that many distinct meshes, nothing batches, the camera turning; `2views` renders an eye each with `renderer.render`).
- `Commands` is every call on the device, queue, encoders and passes; `Draws` is `draw` + `drawIndexed`; `Passes` render + compute; `Writes` `writeBuffer` + `writeTexture`; `Creates` every `create*` call on the device during the frame (buffers, textures, bind groups, pipelines, command encoders: today's 1 is the frame's encoder); `Typed arrays` typed arrays, `ArrayBuffer`s made by the frame's code (not the device); `Clock reads` `performance.now` + `Date.now`. A fraction is a count that varies frame to frame (the turning camera sees a different set), averaged.
- `↳ view` rows split a frame by `meter.view(name)`; `present` is `endFrame`.
- Since ws/core-immediate (engine 2.0) the `distinct-*` rows draw their meshes as one merged run on a device with `indirect-first-instance` (as `initGpu` asks for): one cached bundle of `drawIndexedIndirect` per view, so the calls are flat in what is visible (1.5k: 1,418 → 19.2; 6k: 5,775 → 33.1; two views: 2,832 → 30.2). What rises: one `writeBuffer` per view (the run's 20-byte indirect arguments, hence the bytes), and `copies` (not in the table: about 4 a frame at 1.5k, 18 at 6k), the pool's one-time copy of each mesh the turning camera sees for the first time; the difference between the 1.5k and 6k rows is those copies only.

| Scene | Commands | Draws | Pipelines | Bind groups | Vertex buffers | Passes | Dispatches | Submits | Writes | Bytes written | Creates | Typed arrays | Clock reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `instances-1k-cull` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 81,440 | 1 | 0 | 0 |
| `instances-1k` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 114,032 | 1 | 0 | 0 |
| `instances-10k-cull` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `instances-10k` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 1,122,032 | 1 | 0 | 0 |
| `instances-50k-cull` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 3,937,488 | 1 | 0 | 0 |
| `instances-50k` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 5,602,032 | 1 | 0 | 0 |
| `batch-10k-cull` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `batch-10k` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 1,122,032 | 1 | 0 | 0 |
| `batch-50k-cull` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 3,937,488 | 1 | 0 | 0 |
| `batch-50k` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 5,602,032 | 1 | 0 | 0 |
| `list-10k` | 17 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 1 | 2,032 | 1 | 0 | 0 |
| `list-50k` | 17 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 1 | 2,032 | 1 | 0 | 0 |
| `lights-0` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `lights-8` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `lights-16` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `shadow-off` | 18 | 2 | 2 | 2 | 2 | 2 | 0 | 1 | 2 | 795,440 | 1 | 0 | 0 |
| `shadow-on` | 27 | 3 | 3 | 3 | 4 | 3 | 0 | 1 | 3 | 1,123,504 | 1 | 0 | 0 |
| `sprites-10k` | 19 | 2 | 2 | 3 | 2 | 2 | 0 | 1 | 2 | 1,122,032 | 1 | 0 | 0 |
| `sprites-50k` | 19 | 2 | 2 | 3 | 2 | 2 | 0 | 1 | 2 | 5,602,032 | 1 | 0 | 0 |
| `particles-10k` | 29 | 3 | 5 | 6 | 0 | 4 | 2 | 1 | 2 | 2,496 | 1 | 0 | 0 |
| `particles-100k` | 29 | 3 | 5 | 6 | 0 | 4 | 2 | 1 | 2 | 2,496 | 1 | 0 | 0 |
| `2d-tiles` | 23 | 3 | 2 | 3 | 4 | 2 | 0 | 1 | 2 | 2,256 | 1 | 0 | 0 |
| `2d-game` | 80 | 13 | 13 | 14 | 0 | 14 | 0 | 1 | 4 | 4,336 | 1 | 0 | 0 |
| `distinct-1.5k` | 19.2 | 1 | 1 | 2 | 0 | 2 | 0 | 1 | 3 | 51,584 | 1 | 0 | 0 |
| ↳ view `view` | 12.2 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 3 | 51,584 | 1 | 0 | 0 |
| `distinct-6k` | 33.1 | 1 | 1 | 2 | 0 | 2 | 0 | 1 | 3 | 204,301.9 | 1 | 0 | 0 |
| `distinct-1.5k-2views` | 30.2 | 1 | 1 | 3 | 0 | 3 | 0 | 1 | 6 | 103,158.7 | 1 | 0 | 0 |
| ↳ view `left` | 13.8 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 3 | 51,584 | 1 | 0 | 0 |
| ↳ view `right` | 9.4 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 3 | 51,574.7 | 0 | 0 | 0 |
| ↳ view `present` | 7 | 1 | 1 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

Trace goldens (every call in order, hashed; the 2D path must not change under the render core):

- `sprites-10k`: 19 calls × 10 frames, sha256 `a3236ea6e63f2968…`
- `2d-tiles`: 23 calls × 30 frames, sha256 `f3c57bc15d4ad4b4…`
- `2d-game`: 80 calls × 30 frames, sha256 `6c415835df8dc25c…`
