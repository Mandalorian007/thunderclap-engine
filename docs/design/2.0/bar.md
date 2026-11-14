# D2: the parity bar and the quality bar (2026-11-14)

The question: what must ThunderClap (TC) clear to be the shared engine for many games (2D, varied 3D, VR), and what must each TC module clear before Forge Wilds switches to it?

Inputs: A-engine.md, A1, A2, A3, B-client.md, C-spike.md and C/ (all in tc/), plus the code. Repos were read-only. TC is at 5022d33 (1.3.0) and its git status was clean after my runs. Forge is at d38b72ad.

Two cheap measurements are new in this file:
- **D2-P1, counted-work probe.** `tc/D2/count-probe.mjs` drives TC's renderer on its own fake GPU (dist 1.3.0).
- **D2-P2, TC's bench ladder in WebKit with the iPad Pro 11 profile.** `tc/D2/wk-bench.mjs`, raw output in `tc/D2/wk-webkit.jsonl` and `wk-chromium.jsonl`. This is the first time TC has run in WebKit anywhere. It served `harness/` from a scratch Vite config on port 11550, with its cache in the scratchpad. I stopped that server by its PID.

---

## 0. The rule in one paragraph

A TC module replaces a Forge module only when the swap costs nothing on the WebKit iPad profile. "Nothing" has two parts:

1. **Counted work** is equal or lower. Counted work means GPU calls, bytes written, allocations, clock reads, entries visited and sections walked per frame and per message. It is held by Forge's existing fake-GPU budget tests, which are re-pointed at the TC module and never loosened.
2. **Measured time** (CPU per frame, GPU per frame, time to full view, edit latency) is not worse beyond the day's own noise. It is measured in interleaved A/B pairs on one machine, one kept world and one camera.

Bundle and memory are counted, not timed, so they are hard limits.

TC holds the same bar for itself through engine-wide rails (section 2) on a reference scene set (section 3). The Last Rune is the 2D guard.

---

## 1. Forge's switch gate, per module

### 1.1 The metrics, thresholds and how each is measured

The profile is Playwright WebKit with `devices["iPad Pro 11 landscape"]` at 1180×820 CSS and DPR 2, giving a 2360×1640 backbuffer. It is set in `apps/web/e2e/harness.ts:107-109`. The C spike used the same profile (`tc/C/measure.mjs`). The real iPad is the final check (section 1.4).

| # | Metric | Instrument | Pass threshold (B = TC module, A = Forge today) |
|---|---|---|---|
| G1 | **CPU ms per frame** (main thread, rAF entry to submit) | `__forgeBench(120)` back to back (`apps/web/src/boot/bench.ts:23-40`), reported as **total ÷ frames**, not the median of per-frame samples. Second instrument: Chromium with `--cpu-throttle 4` (docs/client/web/web-perf-budgets.md, last paragraph of Budgets). | median(B−A) over ≥5 pairs ≤ ε_cpu, where ε_cpu = max(0.05 ms, the A/A spread). p95 of the live overlay `cpuMs` is not worse by more than 1 quantum. |
| G2 | **GPU ms per frame** | Timestamp queries back to back (`__forgeBench`, with `renderer.timingEvery = 1`, bench.ts:28). Live GPU time is reported but is not the gate, because "the GPU lowers its clocks at 60 fps" (docs/client/web/web-perf.md, "The iPad target"). Compare at the **same preset**: `preset=off governor=0` for bare terrain, and the full preset for the feature set. | median(B−A) ≤ ε_gpu = max(0.1 ms, A/A spread). Live p95 stays ≤ 10 ms (the iPad target, web-perf.md). |
| G3 | **GPU calls per frame** | Fake GPU, `test/client-budget-frame.test.ts:145,159,229-231` | Equal or lower: 46 clear, ≤58 storm, 48 with the Spire. **The same count at 1,500 and 6,000 held sections** (:142). XR: 1 cull, 1 pose pass and 1 frame-uniform build for 2 eyes (`test/stereo.test.ts:105-113`). |
| G4 | **Per-frame allocations and clock reads** | Fake GPU harness: Float32Array proxy (`test/client-budget-harness.ts:69`), `performance.now` wrapped (:415-416), map/set/grid visits (:81) | 0 Float32Array a frame (client-budget-frame.test.ts:245-247). 0 clock reads in renderer, painter or view (:140); the loop's 2 reads are passed down. Visits ≤50 a frame and flat with what is held (:147-148). UI: 0 young-generation bytes once warm (web-perf-budgets.md, "Frame, UI idle"). |
| G5 | **Sections walked per frame** | `renderer.stats.sectionsWalked` (client-budget-frame.test.ts:139,151) | ≤ held/60 + 1 at rest. While streaming 8 a frame, a walk at most 4 times a second. |
| G6 | **Time to full view** | `__forgeStats.fullViewMs` (from navigation), `net.fullViewFromConnectMs` (`apps/web/src/boot/stats.ts:96`) | median(B−A) over ≥5 pairs ≤ max(50 ms, A/A spread). **No new long frame** over 50 ms during the load. C measured TC route a at 920 ms (C-spike.md table). |
| G7 | **Remesh / edit latency** | Overlay `editLatencyMs` p50/p95 (`apps/web/src/net/session.ts:123`). Mesh-budget tests: an edit remeshes ≤6 sections (web-perf-budgets.md, last row). `pnpm --filter web bench` (mesh 0.12 ms/section p50, web-perf.md "Mesher"). | p50/p95 not worse beyond ε (max(1 ms, A/A)). Counts equal or lower. Mesher µs per section not worse. |
| G8 | **Memory** | `__forgeStats.gpuMemoryMB` (vertex arena used/allocated, index, textures). WebKit RSS of the WebContent process over `e2e long-session` (web-perf.md "WebKit memory"). | GPU bytes ≤ A at the same view. Today that is 172 MB full and 128 MB off, with vertex 39.6 used of a 64 MB arena (C table). 8 B per vertex and one shared quad index buffer are kept. RSS growth ≤ today's ~9 MB/min with no unbounded structure; the bounding rule is in web-perf.md "Long sessions". |
| G9 | **Bundle** | `apps/web/scripts/bundle-budget.ts:26,28` | Index ≤500 kB gzip (472.6 today) and total ≤670 kB (640.5 today), **and net change ≤ 0 kB**. The swap must delete as much Forge code as it adds; the headroom is ~27 kB and ~30 kB. |
| G10 | **Main thread per message** | `test/client-budget-stream.test.ts`, `mesh-budget.test.ts`, `arena.test.ts` | Unchanged: 0 sections decoded on the main thread, ≤3 entries visited a message, ≤4.5 KB a job, <60 free ranges looked at. |
| G11 | **Shaders** | `test/shaders.test.ts:57-69` | No WGSL `override` in any module, TC's included (iPad WebKit refuses them). `fs_terrain` texture reads ≤6. |
| G12 | **Pixels** | Screenshot pairs from the C harness (`tc/C/shots/`). The `e2e` scenes (flood, foliage, sky, light). | Matches today's view, or the PR names each intended difference. Flood room ≤240 draws and ≤80k triangles (web-perf.md "The flooded Spire room"). |

### 1.2 Measuring reproducibly on a shared machine

- **Fixed inputs.** Use one kept world: a copy of `tc/C/world` (seed 42, `forge:standard` v2), served by a scratch `forge dev` on a pinned content snapshot. Use one camera (`&cam=8,110,8,45,-20&radius=16&radiusV=8&opening=0&ui=0&auto=0`) and one backbuffer (2360×1640). Wait for full view, then 4 s, then sample. That is C's protocol, `tc/C/measure.mjs`.
- **Interleaved pairs.** Run A,B,B,A,A,B… alternating which goes first, with at least 5 pairs per metric (C used 3; that is too few for sub-ms CPU). Before the B runs, take **A/A calibration** pairs (2 to 3) the same day. Their spread is ε. Don't compare across days. Forge already does this for shader variants (`apps/web/e2e/flood.ts:528`, "Four interleaved pairs, variant then base").
- **Load hygiene.** Run with `nice` and record `uptime` load at every run. Throw away a pair whose load moved by >1.0 between its halves and run it again once. Keep one browser at a time; headless Chromium on macOS "loses its device" under `__forgeBench` (web-perf.md), so bench in WebKit.
- **Timer resolution (new finding, D2-P2).** WebKit's `performance.now()` is 1 ms-quantized. Every TC WebKit `cpuMs` median came back as an integer (0, 1, 2, 4, 5, 11, 15). The C table's forge CPU "1.01 (p95 1)" has the same artifact. So:
  - CPU is the **total over a back-to-back batch ÷ frames** in WebKit;
  - Chromium ×4 throttle is the fine-grained cross-check;
  - per-frame p95 in WebKit only counts quanta.
- **GPU** is gated on back-to-back timestamp time (Playwright WebKit on the Mac has `timestamp-query`: C `gpuSource: timestamp`; D2-P2 `timestamps:true`). It is gated at matched presets. C's "TC 6.2 vs Forge 9.4 ms" compared different feature sets, and its fair row (2.9 vs 5.1 ms) was live, not back to back. Re-measure it under G2 before any decision.
- **Output.** One JSONL row per run (C's format), and a table of per-pair deltas with ε. The PR carries the table.

### 1.3 Per module: which gates apply and which Forge rails it must keep passing

The rails are:
- **golden** = `test/fixtures/frame-trace.json` via client-budget-frame.test.ts:173-231;
- **fake-GPU** = the client-budget-*.test.ts family, hand-budget, actors-budget, model-budget, stereo;
- **smoke** = WebKit iPad smoke in local-ci (`scripts/local-ci.sh:33-34,91-92`, `apps/web/e2e/smoke.ts`);
- **bench** = `pnpm --filter web bench` (mesher), `__forgeBench`, `forge bench all --size ci`;
- **bundle** = bundle-budget.

A golden may be **re-recorded once** in the switching PR (`FORGE_FRAME_TRACE=write`, :178). The new golden must have ≤ the old call counts per scene (clear, storm, Spire), and the PR states the diff. After that it is bit-held again.

| Module switched (TC side) | Gates | Rails that must keep passing (unchanged unless noted) | Already known blockers (A, C) |
|---|---|---|---|
| Frame loop / client mode (`createGame` `sim:false` or a bring-your-own-loop kit) | G1, G4 (2 clock reads, passed down), G6, G9 | fake-GPU clock-read and alloc asserts; governor tests (`test/governor.test.ts`); smoke | `createGame` is all or nothing (A G7); `createGame` pulls 169 kB gzip (A §6) |
| Renderer core (passes, frame uniforms, materials, post chain) | **all of G1-G12** | golden (re-record once), fake-GPU all, stereo, shaders, smoke, bundle, flood counts | Immediate re-record with O(visible) GPU calls (D2-P1); MRT opaque pass; per-eye XR (A G1, G3) |
| Terrain draw (our mesher → TC drawable or retained arena, C route b) | G1, G2, G3 flat in held sections, G5, G8 (8 B/vertex, shared index), G12 | golden, culling-frame (0.86 quads), client-budget-frame "proportional to change", arena test, smoke | +1.5 ms CPU, ~1.8× bare GPU (C), +26 MB per-mesh index buffers (C friction 3), no camera-relative transforms (friction 6) |
| Voxel meshing / streaming (TC voxel, C route a) | G6, G7, G8, G10 and the mesher bench | mesh-budget, client-budget-stream, inflate test, `pnpm --filter web bench` | u8 ids, a dense grid, 48 B vertices (307 MB), 920 ms hitch, opaque only (C friction 7) |
| Sky, lights, shadows, fog | G2 (back to back, matched preset), G3, G11, G12 | golden, weather-frame budget (≤58, map ≤2 dispatches/s), shaders | Single unsnapped shadow map (A G8). TC's uniform block is 16 point and 8 spot lights. |
| Post (bloom/composite/tiers) | G2, G3 (20 calls for 4 passes today), G8 (targets), G12 | golden, stereo (post slots), smoke | Full-res composite; `postQualityFor('tablet')` scale unexplained (C) |
| Particles, weather FX | G2, G3, G4 | weather budget (caps, uniform only on change), life fireflies (1 draw) | — |
| Actors / skinning / models | G1, G3 (actors 14 calls constant), G4 | actors-budget, model-budget, hand-budget (hidden = 0 calls; shown = 1 × 544 B write) | Forge poses in one compute pass for both eyes (stereo.test.ts:107) |
| XR stereo | G3 (1 cull, 1 pose and 1 uniform build for 2 eyes; union ≤1.15×), G1, G2 on device | stereo, xr e2e (`apps/web/e2e/xr-*.ts`), Quest by hand | TC renders, shadows and posts each eye in full (A G3, `src/core/game.ts:760-773` in TC) |
| Input | G1 (handler cost), G4 | touch, controls and HUD tests; ActionSink intents | Polls actions, no pushed intents (A G9) |
| Audio | G4 (no node or param writes when nothing changed), G9 | `test/ambience.test.ts` (≤112 nodes, voice caps) | None structural; +26 kB gzip (A §6) |
| UI / HUD | G4 (0 DOM writes or reads idle), node gates, G9 | the UI budget rows in web-perf-budgets.md, all of them | DOM overlay does not reach XR (A G6) |
| Platform (device loss, screens) | — (behaviour) | resilience e2e; "recoverable without effort" | Reload screen + halt (A G10) |

### 1.4 What only real devices can settle (by hand, recorded)

- **iPad (iPadOS 18.7, Brave/WebKit, over Tailscale).** It has **no timestamp queries** (`apps/web/src/render/governor.ts:13`). So the device's GPU number is the back-to-back `__forgeBench` wall time, plus the governor's missed-frame share and full view. Run the same interleaved A/B on device: two builds, home-screen buttons, never typed flags. Pass:
  - frame p95 ≤ 16.7 ms on the reference view;
  - governor sheds no more rungs than A in 2 minutes;
  - no WebGPU error in the overlay.
- **Quest 3.** 72 Hz, so a 13.9 ms budget. The open question "whether the Quest holds 72 Hz at full resolution" was shelved with VR (docs/archive/roadmap/vr-decisions.md:14). This gate only applies when VR returns. On that day the XR module needs device numbers, because "emulator passes prove little" (memory: vr-shelved).

---

## 2. ThunderClap's own engine-wide rails

The goal: TC holds this bar for every game, so Forge's gate becomes a formality rather than a discovery.

| Rail | In TC today (path) | Add | Size |
|---|---|---|---|
| **R1. WebKit Playwright project** | None. Every project is `browserName: 'chromium'` (`playwright.config.ts:89-99`). The "ipad" row is a Chromium viewport (:61). CI installs only chromium (`.github/workflows/ci.yml:51`). | A `webkit-ipad` project (`devices['iPad Pro 11 landscape']`, 1180×820) running smoke, render*, mesh, lights, post*, voxel, look, the 7 demo specs and an XR-fake spec. A `docs/webkit.md` quirks table (no `override`; 1 ms `performance.now`; no timestamps on device; WebContent memory). Run it in `scripts/release.mjs` before every tag; release.mjs already runs e2e locally, while publish.yml does not (A3 §1). Try a macOS CI job, non-blocking until it proves stable on a VM GPU. D2-P2 shows TC's harness comes up in WebKit with 0 page or GPU errors. | S: ~80 lines of config plus the docs; M if WebKit finds bugs (expect some: Last Rune found 10 gaps in 3 days, A3 §7) |
| **R2. Counted-work budget framework** | `src/render/fake-gpu.ts:147-198` already records passes, commands, writes, copies and submits, exported via `src/testing/index.ts:4,15`. Alloc tests exist only in anim (`src/anim/graph.test.ts:405-437`, `skin-pose.test.ts:165`). There are no per-frame GPU-call or bytes budgets (the only "budget" tests are dynamic resolution). | `src/testing/budget.ts`, modelled on `apps/web/test/client-budget-harness.ts`. It needs: counters (GPU commands, bytes written, buffer copies, Float32Array/ArrayBuffer constructions, clock reads, map/set visits); a `frames(scene, N)` driver; a **golden call-trace hasher** with an explicit `*_TRACE=write`. Per-scene budget tests (section 3): 2D sprites, instances/list, skinned crowd, streamed voxel (**the same commands at 1.5k and 6k held**), XR two views (**prepare once; ≤1.15× an eye**). Ship it as public `testing` API so games (Forge, Last Rune) hold their own budgets on TC's fake device. | M: ~400 lines of framework plus ~600 of tests |
| **R3. Perf bench with rungs per game style** | `harness/bench.ts` (508), `harness/bench-state.ts` (`benchRungsFor` :171), `scripts/bench.mjs` (240, chromium only, median only, rewrites docs/BENCH.md), `e2e/bench.spec.ts` (tiny smoke, no budget). Rungs: instances, batch, list, lights, shadow, sprites, particles. | `--browser webkit\|chromium` (iPad profile); p95 and long frames; **CPU as batch total ÷ frames**; back-to-back GPU mode; **`--a <dist> --b <dist> --pairs N` interleaved A/B with A/A ε**. New rungs: `sprites-2d` (Last Rune-like board: 20 draws, post), `skinned-64` (64 skinned glTF characters with anim graph), `voxel-stream-r16` (a generated Forge-scale world: ~18k sections, 16-bit ids, liquid and cutout; reports full view, remesh p50/p95, GPU bytes), `xr-stereo` (xr-fake two eyes over skinned-64 and voxel), `hud-idle`. Results go to BENCH.md under a dated device header. | M-L: ~800-1,200 lines plus the voxel generator rung |
| **R4. Bundle-size budgets per subpath** | None. A measured them by hand (`tc/abench/bundle/`). `scripts/pack-smoke.mjs` builds a consumer but checks no size. | `scripts/check-bundle.mjs` in `pnpm check`. It Vite-builds a fixed entry per subpath and per named import set (Renderer only; Renderer+Camera+Transform; render+voxel named; audio; post; ui; `createGame`) and holds gzip limits from a checked-in `bundle-limits.json`. Raising a limit is a deliberate PR line, as in Forge (web-perf-budgets.md, "The bundle budget"). | S: ~150 lines |
| **R5. Tree-shaking check** | `sideEffects: false` (package.json). `check-boundaries.mjs` enforces module edges, not shaking. C found that the subpaths still pull most of the engine: 171 kB gzip for createGame+Look+Lights+Sky+post+voxel. | Single-symbol entries (for example `import { Renderer }`) that assert the output contains no marker of `ui/`, `post/`, `audio/` or `assets/`. Feature-off `createGame` entries that must not pull `ui`/`audio`. Fail on any top-level side effect (a module-scope `new`/call) found by a rollup `moduleSideEffects` report. | S: ~100 lines. Fixing what it finds: M |
| **R6. Shader portability check** | TC uses no WGSL `override` today (A §2). Nothing holds that. | A test like Forge's `test/shaders.test.ts:57-64` over every WGSL TC ships or generates. | XS: ~40 lines |
| **R7. Pixel goldens beyond 2D** | 5 goldens, all 2D (`e2e/golden/`). | Goldens for voxel, skinned and post looks, recorded on WebKit and on Chromium-Metal (not SwiftShader). | S |
| **R8. Real-device rungs, by hand** | None. "Watch on real devices" is a backlog note (A3 §1). | A bench launcher page with one button per rung and an A/B toggle (no URL typing). A per-release BENCH.md device section: iPad (WebKit, no timestamps, so the submit-to-done fallback plus missed-frame share) and Quest 3 (72 Hz, XR rung). This is required before any release that touches render, voxel or xr. | S: ~100 lines plus ~30 min per release by hand |

Where they run: R2, R4, R5 and R6 go in `pnpm check` (no GPU, and fast on a shared or CI machine). R1 and R7 go in the e2e matrix and the local release gate. R3 and R8 are reported numbers and A/B evidence for PRs, never CI gates. That follows Forge's rule that a shared machine can count work but can't time it (docs/CLIENT.md:14).

---

## 3. The reference scene set

Every TC renderer change is measured on S1-S5 (S6 for UI). Every Forge switch PR is measured on S4 plus the module's own scenes.

| Scene | Built from | Counted (R2) | Timed (R3, WebKit iPad) | Guards |
|---|---|---|---|---|
| **S1 2D board** | **The Last Rune** perf scenes (title, hall-start, strike, ending-flood: `last-rune/scripts/perf/`), TC `sprites-10k/50k` rungs, `demos/tactics` (one sorted-sprite draw) | draws ≤ today (10-20), 0 alloc, bytes/frame | CPU, GPU (`ts`), frame p95 | 2D must not pay for 3D, voxel or XR features. Last Rune's 129 baselines unchanged. |
| **S2 3D characters** | `demos/arena` (skinned humanoid, Follow camera), new `skinned-64` rung | calls flat in the number of characters at fixed visibility; pose pass once per frame | CPU, GPU | glTF and anim for "varied 3D" games; Forge actors (14 calls) |
| **S3 lit arena / heightfield** | `demos/arpg` (instance lists, point lights, shadow, post), `demos/showroom` (PBR, post looks) | lights and shadow calls, post passes | GPU per pass | Lights, shadow and post tiers on iPad |
| **S4 streamed voxel world** | Forge: the kept world `tc/C/world` with C's camera via `tc/C/measure.mjs`. TC: the `voxel-stream-r16` generated world (TC stays game-free, so no Forge data in TC). | **calls the same at 1.5k and 6k held**, sections walked, bytes per section | CPU, GPU, full view, remesh p50/p95, GPU bytes | The Forge switch gate (section 1). TC's large-world claim. |
| **S5 XR stereo** | S2 + S4 through TC `platform/xr-fake.ts` and Forge `?xr=emulate` | 1 cull/prepare, 1 pose and 1 frame build per frame for 2 eyes; union ≤1.15× | Quest 3 by hand only | VR first-class |
| **S6 HUD idle** | TC `hud`/`ui` harness pages; Forge HUD tests | 0 DOM writes or reads idle | — | UI changes |

---

## 4. Today's baseline numbers

**Forge vs TC on S4.** WebKit iPad profile, 2360×1640, 3 interleaved runs, live (not back to back). Source: C-spike.md and `tc/C/table.md`.

| | CPU/frame avg | GPU ms avg (p95) | GPU calls / draws | Full view | GPU mesh mem | Long frames |
|---|---|---|---|---|---|---|
| Forge, full preset | 1.01 (quantized) | 9.36 (12.1) | **46 calls**; 2,851 indirect draws in bundles | ~1,020 ms | 172 MB (vtx 39.6/64) | – |
| Forge, `preset=off governor=0` | 1.01 | **2.87** (6.7) | 46 / 2,850 | 1,046-3,798 ms | 128 MB | – |
| TC route b, no shadow | 2.64 | 5.08 | 869 direct draws | 977 ms | 60.7 MB | 3 / 66 ms |
| TC route b, shadow | **2.48** | 6.25 (7.3) | 869 | ~925 ms | 60.7 MB | 2 / 82 ms |
| TC route a (TC voxel) | 2.37 | 6.28 | 1,351 | **~4,580 ms** | **307 MB** | 9 / **~920 ms** |

**TC renderer, counted (D2-P1).** Fake GPU, distinct meshes, 2360×1640, camera turning, 120 frames.

| Held meshes | Views | GPU commands/frame | Bytes written/frame | Draws (visible) | Float32Array/frame | Clock reads/frame | JS ms (fake GPU) |
|---|---|---|---|---|---|---|---|
| 1,500 | 1 | 1,366 | 39.8 kB | 364 | 0 | 0 | 0.13 |
| 6,000 | 1 | 5,358 | 151.6 kB | 1,377 | 0 | 0 | 0.48 |
| 1,500 | 2 (per-eye loop) | 2,731 | 79.6 kB | 364 | 0 | 0 | 0.26 |

Read: TC already meets G4 (0 allocations and 0 clock reads a frame). It fails G3 by construction:
- about 3.8 commands and ~110 B per visible draw;
- the count grows with what is visible (4× from 1.5k to 6k);
- it doubles exactly for two eyes.

Forge's frame is 46 calls, flat. (Commands counted as pass commands + begin/end + queue writes + copies + submits.)

**TC bench ladder, WebKit iPad profile vs Chromium-Metal, the same 2360×1640 (D2-P2; one run each, CPU medians in WebKit quantized to 1 ms).**

| Rung | CPU ms WebKit / Chromium | GPU ms WebKit / Chromium |
|---|---|---|
| instances-10k-cull (per-call `frame.mesh`) | 5 / 5.35 | 0.26 / 0.61 |
| instances-50k-cull | 11 / 15.1 | 1.28 / 1.63 |
| batch-50k | 4 / 3.8 | 1.07 / 1.91 |
| list-50k (retained) | 0 / 0.3 | 1.09 / 1.91 |
| lights-16 | 5 / 4.65 | 0.93 / 2.31 |
| shadow-on | 5 / 4.6 | 0.47 / 1.05 |
| sprites-10k / 50k (2D path) | 3 / 2.4 · 5 / 4.0 | 0.26 / 0.85 · 1.36 / 3.20 |
| particles-100k | 0 / 0.3 | 2.73 / 4.06 |

TC works in WebKit with 0 errors and timestamps on. The per-call submit path is CPU-bound in both browsers. The retained list is effectively free on the CPU, so a retained or indirect path is where parity lies.

**Others**

| Item | Number | Source |
|---|---|---|
| Last Rune (S1 guard) | 10-20 draws; CPU 0.1-0.3 ms p50/p95; timestamp GPU 5.7-10.4 ms p50 (ending-door 10.4/11.7); 60 fps p95 in every scene. Chromium 1920×1080 DPR 1, shared machine. | `last-rune/docs/design/screens/v1.0/BASELINE.md:72-84` |
| Last Rune bundle | one chunk, 1,321 kB raw / 413 kB gzip (dist of 11-09, engine 1.2.x; measured here) | `last-rune/dist/assets/index-*.js` |
| Forge bundle | index 472.6 / 500 kB gzip; total 640.5 / 670 | web-perf-budgets.md |
| TC bundle | createGame 169 kB gzip; render/* 50; voxel/* 7.5; post/* 30; ui/* 68; audio/* 26; the spike's TC import set 171 | A §6, C |
| Forge mesher / stream | 0.12 ms/section p50; 8 workers mesh r16 in 175 ms; edit 4-6 ms click→`SectionEdit`; full view ~3 s from connect | web-perf.md "Results" |
| TC mesher | 335-479 µs per non-empty 16³ chunk; edit+remesh 193-231 µs; 216 B/quad | A §4 |

**Unmeasured (mark as open):**
- **The real iPad**, for anything TC. The real iPad also has no timestamps.
- **Quest 3**, for anything; both Forge's 72 Hz question and TC's per-eye XR.
- TC route b re-measured **back to back** at matched presets (C's numbers are live).
- Remesh latency through TC (C time-boxed it out).
- WebKit RSS over a long session for TC.
- Skinned glTF and characters perf anywhere in TC: BENCH.md has no skinned rung.
- Last Rune in WebKit.
- Forge's GPU at 1.5k vs 6k sections on real hardware (only counted).

---

## 5. Risks: where parity is hardest

1. **The frame architecture is the gap, not the JS.** TC's JS is cheap: 0.13 ms for 1.5k meshes, with 0 allocations. The cost is WebGPU calls, and WebKit validates each one on the CPU. Parity needs:
   - retained or indirect draw lists in render bundles;
   - a pooled vertex arena with a shared index buffer;
   - a one-cull/prepare-for-N-views split.

   That is A's G1+G3 (~900 lines). It also has to be **general**: the same path must serve sprites, instanced props, skinned characters and voxel sections, or each game style rebuilds it. This is the single largest item, and C showed nothing else closes the +1.5 ms CPU.
2. **Generality taxes the 2D path.** Each feature added for 3D, voxel or XR (MRT targets, camera-relative transforms, cull compute, union frustum) must cost a 2D game zero. Last Rune runs ~20 draws at 0.1-0.3 ms CPU, so a fixed per-frame overhead of 0.2 ms would double its CPU. Engine features must be pay-for-what-you-use, and S1 counts them (R2).
3. **Bare-terrain GPU is 1.8× and unexplained.** Suspects are the MRT `FragOut`, the Sky pass, per-pixel fog/lambert and front-to-back order. Terrain fragment shading is already 6-7 of ~8 ms on the iPad (web-perf.md). That leaves no room. This needs a back-to-back, per-pass profile before any terrain switch.
4. **The real devices can't be gated in CI.**
   - The iPad has no timestamps (governor.ts:13).
   - WebKit `performance.now` is 1 ms-quantized (D2-P2).
   - Live GPU time is clock-scaled.
   - Playwright WebKit runs on an M-series Mac, not the iPad's GPU, thermals or memory limits.
   - Every number short of the device is a proxy, and the device runs are by hand. Quest has never been measured, and VR is shelved.
5. **Noise on a shared machine.** Deltas we care about (0.05-0.2 ms CPU, 0.1-0.3 ms GPU) are near the noise. Without A/A calibration and ≥5 interleaved pairs, a gate either flakes or waves regressions through. C's 3 runs were enough for 2.5× gaps, not for parity calls.
6. **Bundle headroom is ~27 kB.** A TC module must replace Forge code byte for byte. That works only if TC tree-shakes to near zero; today the subpaths pull most of the engine (C friction 8).
7. **The golden re-record is the weak moment.** Each renderer-module switch rewrites `frame-trace.json`. If the new golden is accepted without the "≤ old counts per scene" rule, the guard is lost exactly when it matters.
8. **Memory formats.** Forge's 8 B vertex and shared index are why it holds 39.6 MB of terrain. TC's 48 B vertices (route a: 307 MB) or per-mesh index buffers (+26 MB) would push the iPad toward WebKit's process memory limits. A general vertex-layout API must allow packed integer formats (C friction 1-2).
9. **Large-world precision.** Float32 world matrices with no camera-relative origin (C friction 6) break far from spawn. Forge's `View` is camera-relative (B §5). TC must adopt that for all 3D games.
10. **Maturity.** TC is 11 days old and 95% agent-written, its 3D, voxel and XR half has no consumer, and its CI GPU is SwiftShader. Its first consumer found 10 gaps in 3 days (A3 §7). Expect the WebKit project (R1) and Forge's fake-GPU tests to surface a similar count. Budget fix time per module switch.
