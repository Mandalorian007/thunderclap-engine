# Brief: ws/geom

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` module list and *Transforms* (bounds); `src/render/mesh.ts` (`VERTEX_LAYOUT_3D` float layout: position, normal, uv, colour; `MeshBounds`, `MeshDesc`), `src/anim/index.ts` and `package.json` `exports` + `scripts/check-boundaries.mjs` (how a pure module is registered), `harness/mesh.ts` `cubeGeometry`, `harness/pick.ts` on ws/pick (`cubeGeometry`, `icosphereGeometry`), `harness/skin.ts` on ws/skinning (capped tubes), `templates/first-person/src/world/terrain.ts` on ws/template-first-person (heightfield sampling the template wrote for itself).

## Goal

Every harness and both 3D templates hand-build cubes, spheres and tubes. A pure `geom` module gives the engine its primitives once, in the engine's vertex layout, with bounds, plus a heightfield type with sampling and a ray test so a first-person game can stand on and click its ground without writing either.

STATUS row, *done when*: `@thunderclap-engine/engine/geom` exports `Geometry { vertices: Float32Array; indices: Uint16Array | Uint32Array; bounds: MeshBounds; layout: VertexLayout }` and builders `box(opts?)`, `plane(opts?)`, `sphere(opts?)` (UV sphere), `icosphere(opts?)`, `capsule(opts?)`, `cylinder(opts?)`, `torus(opts?)`, each with `{ size/radius..., segments..., color?: [r,g,b,a], uvScale? }` and correct smooth or flat normals as documented; `Heightfield { width; depth; heights: Float32Array; scale: [sx, sy, sz]; origin }` with `heightAt(hf, x, z): number` (bilinear), `normalAt(hf, x, z, out)`, `raycastHeightfield(hf, ray, out): number` (distance or -1; DDA or fixed-step marching with a refinement step, no allocation), `heightfieldGeometry(hf, opts?)`; `mergeGeometry(a, b, ...)` and `transformGeometry(g, world3x4)`; indices promote to Uint32 past 65535 vertices; tests; harness `geom.html`; documented; `renderer.createMesh(geometry)` accepts a `Geometry` as-is (it is already a `MeshDesc` superset: verify, add nothing to render if it is).

## Scope

- `src/geom/*.ts` pure arithmetic, no imports from `render` except types (`MeshBounds`, `VertexLayout`, `VERTEX_LAYOUT_3D`): check the boundaries script allows `geom → render` type-only; if not, allow it in the script and say so.
- Tests: vertex/index counts per builder, normals unit-length and outward (dot with position-from-centre > 0 on spheres), bounds tight, Uint32 promotion, heightfield bilinear against hand values, ray hits on a slope at the analytic distance, miss above, `mergeGeometry` offsets indices.
- Harness `harness/geom.html|ts|-state.ts`: every builder in a row, lit, slowly turning, over a heightfield ground built from a sine bump map; state exposes `shapes` count and `heightUnderCamera`. `e2e/geom.spec.ts`: page boots, shape count, a probe pixel on a shape is lit (not background), `heightUnderCamera` matches `heightAt` of the state's sampled point.
- Docs: `src/geom/README.md`, ARCHITECTURE module list + one paragraph *Geometry*, root README module table row + harness item, CHANGELOG, `package.json` export.
- Do not refactor the existing harness pages to use it (other streams own them); file that as a wish for ws/comment-sweep.

## Files owned

`src/geom/**`, `harness/geom.*`, `e2e/geom.spec.ts`, `package.json` (one `exports` line), `scripts/check-boundaries.mjs` (one allowance if needed), `ARCHITECTURE.md` (module list + one paragraph), root `README.md` (one table row, one harness item), `CHANGELOG.md`.

Branch from `main` (23e7cb8 or later). Running alongside: ws/sky (`src/fx`), ws/bench, ws/sockets, ws/texture-registry, ws/flake-input; two integrator chains touching render, input, fx, anim and the doc lists (append your entries at the end of lists).
