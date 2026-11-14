# Brief: ws/core-views (B3)

Read `common.md`, `wave-2.0-1.md`, `wave-2.0-2.md`, E-041, `docs/design/2.0/architecture.md` **§3.5, 3.8** (and §3.3 for the cull), B1's `src/render/core/`, and today's two-views and XR render code (`src/render/` and `src/xr/`, found with grep).

## Goal

Views plural from the bottom, so a stereo pair costs one cull, one upload and one shadow pass. ROADMAP *done when*: "Stereo costs one cull pass; the XR and views specs green; a camera 100 km from the origin renders without jitter."

1. The core's views list becomes real: N views per frame, with the GPU cull writing args for every view in one dispatch (union frustum or per-view args, whichever D1 §3.5 says), and per-view uniforms in one buffer.
2. Move two-views and the XR render path onto the core's views. Post runs per view where it must; anything that depends on B2's immediate path waits, so note it.
3. A camera-relative origin (D1 §3.8): world positions in f64 on the CPU, relative in f32 on the GPU, and a far-from-origin harness check.
4. A per-view hook in fake-gpu.ts (A2's ask). Export `FakeBundle` from testing.
5. Counted tests: stereo costs at most the single-view cost plus a small constant (no doubling), and a budget test with A2's meter and `expectProportional`.

## Gate

common.md. The views, two-views and xr specs, and core.spec, green on Chromium and WebKit.
