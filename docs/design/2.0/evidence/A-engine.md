# Track A: ThunderClap engine audit (2026-11-14)

Subject: /Users/matthewfontana/repos/thunderclap-engine @ 5022d33 (@thunderclap-engine/engine 1.3.0, MIT, zero runtime deps).
Question: could it drive Forge Wilds' browser client (server-authoritative voxel survival, iPad WebKit WebGPU as the weakest target, WebXR live, one HUD everywhere, no asset pipeline)?

Detail files (all in this folder, each with file:line for its claims):
- A1-render-voxel.md: render, voxel, post, fx (+ test runs)
- A2-io.md: ui, input, xr, platform, audio, host, assets, save, i18n
- A3-maturity.md: tests, e2e, benches, changelog, API freeze, git history, The Last Rune
- abench/: my bench scripts (mesher-bench*.mjs, render-bench.mjs, bundle/build.mjs). They run against the repo's dist/ and touch nothing in it.

## Verdict

ThunderClap cannot *drive* the client. `createGame` owns the loop, the DOM overlay, input, audio and the page lifecycle. Its renderer is immediate-mode: each frame re-records every draw, with a CPU cull, a sort and a 112 B/instance upload per view. Its voxel module is a demo-scale dense grid. Forge Wilds' client is already GPU-driven: 46 GPU calls a frame whether it holds 1,500 or 6,000 sections, plus render bundles, indirect draws, connectivity culling and one cull for both eyes (docs/client/web/web-perf-budgets.md:24,30-32). Swapping the drivers would break the user's binding call: "no change may cost frame time".

It *can* be a library taken à la carte. The subpaths are cleanly separated and `sideEffects: false`. Audio is the clear win, input's pointer router and recorder are useful, and the renderer can host our terrain as a `Drawable` after small upstream changes. Maturity is the larger worry. The engine is about 9 days old and 95% agent-written. It has never run on WebKit or a real iPad, and its 3D, voxel and XR half has no production consumer.

| Module | Verdict | One-line reason |
|---|---|---|
| core (createGame, loop) | skip createGame; helpers OK | owns loop+DOM+input+audio; `sim:false` client mode exists but is all-or-nothing |
| render | adopt with changes, non-terrain only (or skip) | immediate re-record per view; terrain must stay ours as a Drawable; needs R1-R4 |
| voxel | skip | 8-bit dense box grid, 48 B vertices, no light/fluid/transparency, 1 draw per chunk, walks all chunks |
| post | adopt with changes, optional | good tiers (`postQualityFor('tablet'|'xr')`); cinematic defaults; full-res composite |
| fx | mostly skip; particles+decals if render adopted | sky/water too simple; particles are GPU compute and good |
| ui | skip | DOM overlay that does not show in immersive XR; world panels are a separate, smaller kit → breaks "one HUD" |
| input | adopt with changes, à la carte, low priority | action-mapped; ray pointer router fits "aim by ray"; polls instead of pushing to ActionSink |
| xr | skip | per-eye full render+post; e2e only checks the no-XR path; ours is further along |
| platform | helpers only | device loss = reload screen + halt; WebKit handling is CSS/fullscreen/audio only |
| audio | adopt (à la carte) | procedural synth (no files), buses, spatial, music, correct iOS unlock |
| assets | skip | glTF/KTX2 pipeline goes against the ROADMAP's no-asset-pipeline call; fully optional |
| save / host / i18n | skip / optional / later | save optional in createGame, no storage touched when omitted |

## 1. Architecture and ownership

- `createGame` (src/core/game.ts:542-786) always builds a `Renderer`, a `PostStack`, a `ParticleSystem` (580-587), the web host (590), a DOM overlay (599), `PadNav` (618), an `AudioEngine` attached to the gesture unlock (627-628), `Input` with gestures and a pointer router attached to the canvas (639-677), a `SceneStack` and a `GameLoop` (726-786). It blocks browser zoom (564).
- `overlay: false` (game.ts:191, 551-555) is all or nothing: there is no DOM at all, and `gpu` and `host` must be passed in. You cannot keep the engine loop and drop only its UI or audio.
- Client mode: `sim: false` makes the loop call `hooks.frame(dt)` once per rendered frame (game.ts:752-753). The real delta is clamped to 0.25 s (core/loop.ts:29, 35). With a `save` omitted, nothing touches storage (game.ts:591-592). This fits a server-authoritative client.
- Render order is fixed in the loop: `hooks.beforeRender` → `renderer.beginFrame` → `stack.render` → `renderer.render(frame, camera)` → `endFrame` → `hooks.afterRender` → `ui.updateAnchors` (game.ts:757-783).
- XR path: the scenes record once through the head camera. Then *each eye* gets a full `renderer.render` and a post `resolve` (game.ts:760-773).
- À la carte works. In non-test code, render imports only core, geom and assets (KTX2 only, render/compressed.ts:9). voxel imports render; post imports core, render and tween; fx imports render, core, geom and ui; input imports `ui/loupe` (input/gestures.ts:1); audio imports save (audio/persist.ts:2). `scripts/check-boundaries.mjs` enforces the module edges. `new Renderer(gpu)` runs standalone (render/README.md quick use).
- Escape hatches for our own GPU work are `Drawable` {prepare(encoder), draw(pass), readsDepth, afterOpaque} (render/frame.ts:176-183), `frame.prePass` and a custom `PostProcessor` (renderer.ts:112). There is no general frame graph.

## 2. Modules (summary; detail in A1/A2)

- **render**
  - Materials are our own WGSL over a prelude with lights, shadow and fog.
  - Lights are capped at 16 point and 8 spot in one uniform block, with no clustering (lights.ts:14,42).
  - One sun shadow map, with no cascades and no texel snapping (shadow.ts:131-163).
  - Dynamic resolution and GPU timers are present.
  - It uses no WGSL `override`, which keeps it iPad-safe.
  - The instance format is a fixed 28 floats = 112 B (frame.ts:15, renderer.ts:1687-1745).
  - There are no render bundles, no indirect draws and no GPU culling. The only compute is in fx/particles.
- **voxel**: see A1. Key facts:
  - `Uint8Array` dense finite grid (grid.ts:40), chunk 16 by default.
  - Greedy mesher with 4-neighbour AO (mesher.ts:1-24), 12-float vertices.
  - One `Mesh` and one `frame.mesh` per chunk (chunks.ts:142, 211).
  - One worker that mirrors the grid.
- **post**: bloom, AO, TAA, SSR, DoF, motion blur, exposure, god rays, LUT and FXAA, with quality tiers per device (settings.ts:607). Disabled passes are skipped.
- **fx**: GPU particles, decals, billboards, a gradient sky dome and a flat water plane.
- **ui**: a DOM overlay on a 1920×1080 design frame. docs/guide/xr.md says it does not show in a headset.
- **input**: action map, touch zones, gestures, `{xr}` bindings, a ray router, record and replay.
- **audio**: procedural-first, with iOS unlock (audio.ts:1305-1420).
- **platform**: device loss leads to a reload screen (platform/screens.ts:159-170). Forge Wilds also says so and stops (apps/web/src/main.ts:284), so that is parity, not a regression.

## 3. Maturity (detail in A3)

| Item | Finding |
|---|---|
| Age / authorship | 1,207 commits, 2026-11-03 → 11-10 (826 on 11-06); 95% co-authored by Claude; 1 human |
| Releases | 0.2.0-alpha.1 (11-04) → 1.3.0 (11-10): 5 releases in 4 days, then none |
| Unit tests | 230 files, ~2.4k cases (55.8k test lines / 89.6k src). On a fake GPU: they check API behaviour and call counts, not pixels. A1 ran render+voxel (376 tests, 1.4 s) and post+fx (267 tests, 1.4 s): all green |
| e2e | 84 specs / ~379 cases, **Chromium only** (playwright.config.ts:89-99); the "ipad" row is a Chromium viewport; CI on SwiftShader with 1 worker and 1 retry |
| WebKit / real devices | never tested |
| Benches | docs/BENCH.md: one headless-Chrome Mac run, medians only; no voxel, mobile or WebKit rungs |
| API | 1,820 exported names frozen by `check:api` (api/*.api.txt); STATUS.md:222 says some look like leaked internals |
| Coverage | no coverage config |
| Consumers | only The Last Rune, a 2D/UI puzzle game that uses none of voxel, geom, nav, glTF, XR or client mode |
| Last Rune migration | asks #1-#10 in 3 days (crash screen, a getContext throw not mapped to the unsupported screen, a loop clock throw, phone full-bleed lost in v1). Visual changes forced baseline regeneration (86 baselines). Upstream fixed each within 1-2 days; no local patches |
| Open bugs relevant to us | voxel "+z riser quad draws as a triangle" (STATUS.md:289,306; repro skipped at demos/voxel/riser.test.ts:31); stale XR frustum entry (IDEAS.md:31) |
| Docs | the README Status still says 1.1.0 (README.md:313); XR guide head-locked panel section is stale. Otherwise 5 of 5 README claims spot-checked hold |
| Green | OIDC provenance publishing, pack smoke test, API-diff gate, fast upstream loop; VISION.md:18,38 names Forge Wilds as a target game |

## 4. Performance model (my measurements)

Machine: this Mac (M-series), Node 25, `nice -n 15`, against `dist/` (1.3.0 build).

**Renderer CPU path** (abench/render-bench.mjs, fake GPU device so WebGPU call cost is ~0; 1,280×720, perspective camera, `cull` on):

| Draws submitted | Mesh | Visible / draw calls | ms per frame (median) |
|---:|---|---|---:|
| 3,000 | one shared | 1,958 inst / 1 draw | 0.30 |
| 3,000 | distinct (chunk-like) | 1,958 / 1,958 draws | 0.44 |
| 10,000 | one shared | 2,678 / 1 | 0.67 |
| 10,000 | distinct | 2,678 / 2,678 draws | 0.97 |

- The engine's own JS is cheap: about 0.1 µs per record and about 0.15 µs extra per distinct draw. It allocates nothing per frame, since records are pooled and the arrays grow by doubling (renderer.ts:1878, 2751).
- The real cost is in the browser. BENCH.md's 10k `frame.mesh` rung costs 3.2-4.1 ms in Chrome, against 0.67 ms here, so the WebGPU calls and `writeBuffer` cost about 5× the engine's JS.
- Draw count is what hurts. A chunk-per-draw voxel world means 2-3k draws, each with set vertex buffer, set index buffer and drawIndexed, repeated per eye in XR and again in the shadow pass. WebKit validates every one of those calls on the CPU.
- Forge Wilds sits at 46 calls flat. This difference decides the verdict, not the engine's JS.

**Voxel mesher** (abench/mesher-bench*.mjs; 128³ grid = 512 chunks of 16³, AO on):

| World | Non-empty chunks | Quads | Full mesh | Per non-empty chunk | Edit + remesh 1 chunk |
|---|---:|---:|---:|---:|---:|
| terrain, solid varied stone | 230 | 70.9k | 77 ms | 335 µs | 193 µs |
| terrain + 8% random holes | 267 | 405.6k | 128 ms | 479 µs | 231 µs |

- 216 B per quad (4 × 48 B vertices + 6 × 4 B indices). 405k quads come to about 87 MB of vertex and index buffer; Forge Wilds uses 8 B per vertex.
- Turning AO off saves only 5-15%.
- The mesher is reasonable for its scope. The memory format, the single worker and the walk over every chunk per view are what don't scale.

**Workers**: the voxel worker is the only one (worker-client.ts), and it mirrors the grid with one message per changed cell. Particles run in GPU compute.

## 5. Gaps for a Minecraft-like networked client → upstream proposals

| # | Gap | Upstream change | Size |
|---|---|---|---|
| G1 | Immediate re-record, CPU cull and sort per view, one draw per mesh; no bundles or indirect draws | Retained/static draw lists backed by render bundles or `drawIndexedIndirect` + a shared arena; a compact custom instance layout (R7, R8) | ~550 lines, 1 week |
| G2 | Drawables are second-class: always sorted as blended, no shadow casting, no per-view camera in `draw` | R1 opaque drawables (~40), R2 shadow-casting drawables (~120), R3 per-view camera and target in `draw` (~60) | ~220 lines, 2 days |
| G3 | XR renders, shadows and posts once per eye | R4: one union-frustum cull, sort and upload and one shadow pass for both eyes; a light XR post setting; later multiview | ~350 lines, 2-3 days (+ post) |
| G4 | The voxel module is demo-scale | Upstream *our* streamed-section model: 16-bit ids, sparse sections, 8 B vertices, a worker pool, light, fluid and cutouts, connectivity culling (V1-V7); plus ~60 lines of quick fixes (V8) | 4-6k lines, 2-4 weeks |
| G5 | No WebKit or real-device testing | A Playwright WebKit project, a WebKit WebGPU quirks table and a real-iPad bench rung | S-M, 2-4 days |
| G6 | UI does not reach XR (one HUD rule) | A UI spec with a DOM presenter and a world presenter, modelled on ours; world-panel grid, meter, slots and text field | 8-12k + 2-3k lines |
| G7 | createGame is all or nothing | `createGame({ ui:false, audio:false, post:false, particles:false, input:'external' })`, or document a "bring your own loop" kit (renderer + hooks) | ~200 lines |
| G8 | Shadows shimmer and have one cascade | R5 texel snapping (~15), R6 cascades (~500) | 3-5 days |
| G9 | input/ui coupling; input polls actions, while our ActionSink takes pushed intents | Inject the loupe (XS); an intent-sink adapter and a still-hold gesture (S-M) | small |
| G10 | Device loss halts the game | A rebuild hook with automatic recovery and a guarded reload fallback (matches our "recoverable without effort" rule) | 1-2 weeks |

Things that do *not* conflict:
- The fixed 60 Hz sim: `sim:false` solves it.
- The save system: optional.
- The asset pipeline: optional, and nothing in createGame imports assets.
- The cinematic post defaults: `neutralPostSettings()` turns them off.

## 6. Licensing, deps, bundle

- MIT (LICENSE). Zero runtime dependencies. Node >= 22. `sideEffects: false`. Each subpath is its own export (package.json:29-49). dist is unbundled tsc output: 2.6 MB of JS and 1.3 MB of .d.ts.
- Measured with Vite 8 (rolldown, minified), entries in abench/bundle/:

| Import | min KB | gzip KB |
|---|---:|---:|
| `createGame` (pulls effectively everything) | 610.1 | 169.3 |
| whole root `*` | 610.3 | 169.4 |
| `render/*` | 177.8 | 50.2 |
| render+voxel, named (Renderer, Camera, Transform, VERTEX_LAYOUT_3D, createVoxelGrid/Chunks/Mesher) | 150.7 | 41.9 |
| `voxel/*` | 22.7 | 7.5 |
| `post/*` | 103.0 | 30.1 |
| `fx/*` | 189.0 | 54.1 |
| `ui/*` | 246.1 | 68.1 |
| `input/*` | 113.6 | 32.2 |
| `audio/*` | 87.5 | 25.7 |
| `platform/*` | 44.5 | 13.5 |
| `core/*` | 31.6 | 10.0 |

- Tree-shaking helps for named imports, but `createGame` defeats it.
- Audio alone, the most likely adoption, adds about 26 KB gzip.
