# Brief: ws/bench

Read `docs/briefs/common.md` first, then DECISIONS E-011, E-017; `src/render/README.md` (Performance: `GpuTimer`, `supportsTimestamps`, `renderer.gpuTimer`, `stats`), `src/render/gpu-timer.ts`, `harness/stream.ts` and `harness/mesh.ts` (instanced 3D scenes), `harness/state.ts` (state object convention), `e2e/fixtures.ts`, `e2e/ports.ts`, `playwright.config.*`, `scripts/snap.mjs` if on main (a script that drives one Playwright project; copy its shape).

## Goal

Numbers. The engine has never recorded how many instances, lights, particles or shadowed draws a frame affords on this machine. A bench page scales a scene until the frame budget breaks, and a script writes the results to a committed table so each wave can see what it cost.

STATUS row, *done when*: `harness/bench.html` runs a fixed scene ladder (instances 1k/10k/50k with culling on and off; point lights 0/8/16; sun shadow on/off; 2D sprites 10k/50k; world particles 10k/100k) for N frames each and exposes per rung `{ cpuMs, gpuMs | null, instances, culled, shadowDraws }` (medians) on the state object; `pnpm bench` (`scripts/bench.mjs`) runs it on `desktop-1280` with `?rung=all`, prints the table and writes `docs/BENCH.md` (machine line from `navigator.userAgent` + adapter info the renderer exposes, date, table); `e2e/bench.spec.ts` on `desktop-1280` only asserts the page completes one short rung and reports numbers; documented.

## Scope

- Timing: CPU ms from `performance.now()` around the game's render callback (median over the rung's frames, warm-up skipped), GPU ms from `renderer.gpuTimer` when `supportsTimestamps`, else `null` (say so in the table). Use fixed `time.frameDt` where the loop allows so the rung is deterministic in content; the measurement is not.
- Scene: generated meshes (cubes), one material; lights ladder uses `Lights.points`; shadow ladder flips `sun.shadow`; sprites ladder uses the 2D `frame.sprite` path on the same page (switch camera); particles ladder uses `ParticleSystem` world space. No asset files.
- `scripts/bench.mjs`: Playwright on one project, reads `state.results` when `state.done`, renders a Markdown table, rewrites `docs/BENCH.md` wholesale. Non-interactive; exits non-zero if a rung throws or the GPU reports errors. No new dependency.
- The spec runs one tiny rung (100 instances, 30 frames) so the matrix stays fast; skipped on other rows.
- Docs: `docs/BENCH.md` first real run committed; root README one paragraph under the e2e/tools section ("Bench"); `src/render/README.md` Performance one sentence pointing at it; CHANGELOG.

## Files owned

`harness/bench.html`, `harness/bench.ts`, `harness/bench-state.ts`, `e2e/bench.spec.ts`, `scripts/bench.mjs`, `docs/BENCH.md`, `package.json` (one `bench` script line), root `README.md` (one paragraph), `src/render/README.md` (one sentence), `CHANGELOG.md`.

Nothing under `src/`. Branch from `main` (7574107 or later). Running alongside: ws/snap-gate is landing (`scripts/snap.mjs`, `package.json` scripts next to yours: expect a one-line conflict), ws/flake-input (`e2e/mesh.spec.ts`, `ui.spec.ts`), ws/sky, ws/pick, ws/look-zoom, ws/spot-lights, ws/skinning.
