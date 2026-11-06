# Brief: ws/perf-overlay

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-021; `src/render/renderer.ts` (`RenderStats`, `gpuTimer`, `GpuPassTimes`), `src/render/gpu-timer.ts`, `src/render/dynamic-resolution.ts`, `src/core/loop.ts` (frame timing, `dt`, any existing frame-time samples), `src/core/game.ts` (where a game can attach a per-frame hook), `src/ui/overlay.ts`, `src/ui/toast.ts`, `src/ui/styles.ts` (`BASE_CSS`, `ensureStyles`), `src/ui/README.md`, `harness/mesh.ts` and `mesh-state.ts` (what the pages already expose), `docs/BENCH.md`.

## Goal

A one-line call that shows frame time, GPU pass times, draw and instance counts, culled count, resolution scale and memory as a small DOM overlay, with a rolling graph, and the same numbers exposed as a plain object so demos, the bench and e2e read them without the DOM. Quality validation needs to see the cost on screen.

STATUS row, *done when*: `createPerfMonitor(opts?: { window?: number (frames, default 120) })` → `PerfMonitor { begin(nowMs?), end(nowMs?), sample(renderer): PerfSample (reads `renderer.stats` and the last `GpuPassTimes`; call once per frame after `renderer.endFrame`), frame: { last, avg, p95, max, fps }, gpu: { total, passes: Record<string, number> } | null, counts: { draws, instances, culled, shadowDraws?, batches? } (whichever `RenderStats` has: read dynamically, never hard-code the set), resolutionScale, history: Float32Array (ring, ms), reset() }`; `createPerfOverlay(monitor, opts?: { corner?: 'tl'|'tr'|'bl'|'br'; graph?: boolean; parent?: HTMLElement; updateEvery?: number (frames, default 10) })` → `PerfOverlay { el, update(), show(), hide(), toggle(), visible, destroy() }` renders numbers and a `<canvas>` sparkline of `history`, styled from `BASE_CSS` tokens, pointer-events none, `aria-hidden`; a key binding is NOT included (games bind it); harness pages `mesh.html`, `lights.html`, `pbr.html` show the overlay when `?perf` is in the URL (three-line change each: create, sample, update) and expose `perf: PerfSample` in state; `e2e/perf.spec.ts` on `mesh.html?perf` asserts the overlay is visible, `frame.avg > 0`, `counts.draws` matches `renderer.stats.draws`, and `history` fills after 130 frames; 2D goldens delta 0 (the overlay is off without `?perf`); documented.

## Scope

- `src/ui/perf.ts` (monitor: no DOM, pure; overlay: DOM) and `perf.test.ts` (ring buffer stats, p95, dynamic count keys with a fake `RenderStats`, overlay DOM under jsdom/happy-dom as the UI tests already do).
- Memory: `performance.memory?.usedJSHeapSize` when present, else omitted; never throw.
- Docs: `src/ui/README.md` *Perf*, `ARCHITECTURE.md` *UI* one clause, `CHANGELOG.md`, `docs/BENCH.md` one paragraph (how to read the overlay vs the bench numbers).

## Files owned

`src/ui/perf.ts`, `src/ui/perf.test.ts`, `src/ui/index.ts` (append), `src/ui/README.md` (*Perf*), `harness/mesh.ts`, `harness/lights.ts`, `harness/pbr.ts` and their `-state.ts` (the three-line `?perf` additions only; ws/pbr-lights also edits `harness/pbr.ts` to add lights: append your block at the end of setup and name the lines), `e2e/perf.spec.ts`, `ARCHITECTURE.md` (one clause), `CHANGELOG.md`, `docs/BENCH.md` (one paragraph; ws/batch-submit edits the numbers tables: add yours as a new section at the end).

Nothing under `src/render/`. Branch from `main` (c2b552d or later). Running alongside: ws/debug-draw, ws/billboards (`src/fx`), ws/pbr-lights, ws/batch-submit (render), ws/tween, demos. Use `E2E_PORT_OFFSET=270`.
