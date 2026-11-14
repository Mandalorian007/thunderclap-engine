# Brief: ws/budget (A2)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/bar.md` §1.1 (gates G3–G5) and §2, `docs/design/2.0/architecture.md` §2.17 and P9, `src/testing/index.ts`, `src/render/fake-gpu.ts` (read only; B1 owns it), `harness/bench*` and `docs/BENCH.md`. Forge's harness to generalize: `FW:../test/client-budget-harness.ts` and `FW:../test/client-budget-frame.test.ts` (read only).

## Goal

Counted work becomes the engine's product. STATUS *done when*: "`budget()` usable from any unit test; bench rungs carry budgets; baseline table in docs/BENCH.md."

1. `@thunderclap-engine/engine/testing` gains a counted-work API (name it well, e.g. `countFrame` / `budget`): over N steady frames it reports per frame the GPU commands (by kind: draw, drawIndexed, drawIndirect, setPipeline, setBindGroup, writeBuffer bytes, createBuffer/Texture/BindGroup, submit, beginRenderPass/ComputePass, dispatch), typed-array allocations (constructor proxy), `performance.now`/`Date.now` reads, and per-view splits when a frame renders several views. Plus `expectProportional(run, sizes)` (the count is flat / proportional to change as N grows), and a call-trace golden helper (`traceGolden`, sha256 of the normalized trace, like Forge's `fixtures/frame-trace.json`).
2. It wraps the fake device from your own file (Proxy), so B1 can extend `fake-gpu.ts` at the same time; if you need a hook inside fake-gpu.ts, write it in your report.
3. Apply it to today's bench rungs and 2D harness scenes as tests that pin today's numbers (the baseline), and write the table into `docs/BENCH.md` ("Counted work, 1.3 baseline"). These tests are the guard the render core must beat or explain.
4. Forge's harness is the reference for rigor; generalize, don't copy nouns.

## Files owned

`src/testing/budget.ts` (+ tests), `src/testing/index.ts`, new `src/**/*.budget.test.ts` files you add, `harness/bench*`, `docs/BENCH.md`.

## Gate

common.md.
