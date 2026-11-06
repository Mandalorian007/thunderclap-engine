# Brief: ws/debug-draw

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015, E-021; `src/fx/trail.ts` and `trail-wgsl.ts` (how a drawable owns its pipeline, buffers and `draw(pass, frame)`; the lazily built per-depth-format pipeline), `src/fx/particles.ts` (`ParticleSystem.draw`), `src/render/frame.ts` (`frame.depthFormat`, camera block binding), `src/render/README.md` *Frame*, *Instance format*, `src/geom/index.ts` (`icosphere`, `box` for wire shapes: use their vertex positions only), `src/nav/index.ts` on `ws/nav` (`NavPath`, `FlowField` shapes to draw), `harness/mesh.ts` (page skeleton).

## Goal

A game, a demo or a test draws lines in world space without building a mesh: wire boxes, spheres, axes, arrows, paths, grids, text-free labels as crosses. One drawable that collects line segments each frame and draws them in one call, over or under depth, in `fx`.

STATUS row, *done when*: `createDebugDraw(renderer, opts?: { capacity?: number (segments, default 16384, grows 1.5×); depth?: 'test' | 'always' (default 'test') })` → `DebugDraw { line(a, b, color), ray(origin, dir, length, color), arrow(a, b, color, headSize?), box(center, halfExtents, color, rotation?: quat), wireSphere(center, radius, color, rings = 12), axes(transform | matrix3x4, size), grid(center, size, step, color), circle(center, normal, radius, color, segments = 32), path(points: Float32Array | ArrayLike<number>, color, stride = 3, offset = 0, count?), frustum(invViewProj, color), clear(), draw(pass, frame), count, capacity }`; colours are `[r,g,b,a]` or packed `0xRRGGBBAA` numbers; every call appends to one CPU `Float32Array` of (xyz, rgba) line vertices and `draw` uploads once (`writeBuffer` of the used range only) and issues one `'line-list'` draw with a pipeline per `frame.depthFormat`, `depth: 'always'` writes no depth and tests none (for overlays that must show through walls); `clear()` is implicit after `draw` unless `opts.retain`; zero allocations per frame after capacity is reached; harness `debug.html` draws axes, a grid, a spinning wire box and sphere, an arrow following a sine path, and a `path(...)` from a static array, with state `{ segments, uploads, capacity }`; `e2e/debug.spec.ts` asserts coloured pixels along a known axis line and nothing drawn after `clear()` + `draw`; 2D goldens delta 0; documented.

## Scope

- `src/fx/debug-draw.ts` + `debug-wgsl.ts` (own vertex layout: position xyz + rgba as 7 floats; do not add a `VertexLayout` to render: this drawable owns its buffer and pipeline like `Trail`).
- Line width is 1 px (WebGPU `line-list`); document it. No anti-aliasing work.
- Tests: `src/fx/debug-draw.test.ts` on the fake GPU: growth, `writeBuffer` range, pipeline per depth format, counts for each shape, retain mode.
- Docs: `src/fx/README.md` *Debug draw*, `ARCHITECTURE.md` *FX* one sentence, `CHANGELOG.md`, root README harness list item.

## Files owned

`src/fx/debug-draw.ts`, `src/fx/debug-wgsl.ts`, `src/fx/debug-draw.test.ts`, `src/fx/index.ts` (append), `src/fx/README.md` (*Debug draw*), `harness/debug.*`, `e2e/debug.spec.ts`, root `README.md` (one list item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Nothing under `src/render/`. Branch from `main` (c2b552d or later). Running alongside: ws/pbr-lights, ws/batch-submit (render), ws/tween, four demos (`demos/`), ws/perf-overlay and ws/billboards (`src/ui`, `src/fx/billboard.ts`: stay out). Use `E2E_PORT_OFFSET=250`.
