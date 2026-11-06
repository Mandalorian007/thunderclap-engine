# Brief: ws/pick

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `ARCHITECTURE.md` *Input* (rays, hit testers), *Transforms*; `src/input/rays.ts` (`Ray`, `Hit`, `HitTester`, `planeTester`, the box tester), `src/input/pointer-router.ts` (how testers are registered and hits reused), `src/input/README.md` *Rays*, `src/render/mesh.ts` (`MeshBounds`, `MeshDesc.vertices`, `VertexLayout.wgslPosition`, the float layout), `src/render/transform.ts` (3×4 world matrix, `multiplyMatrix3x4`), `harness/mesh.ts`.

## Goal

A game clicks on a 3D thing. Three testers in `input`: against a transformed bounding sphere, against a transformed box, and against the triangles of a mesh whose positions the game keeps on the CPU. A `GltfScene` or a chunk pipeline registers one per node; the router does the rest. CPU side only: no GPU id buffer, nothing in `renderer.ts`.

STATUS row, *done when*: `sphereTester(transform, bounds, target)`, `obbTester(transform, halfExtents, target)` and `meshTester(transform, positions: Float32Array, indices: Uint16Array | Uint32Array | null, target, opts?: { bounds?: MeshBounds; cullBack?: boolean })` return `HitTester<T>` with `point`, `normal`, `distance` filled; `meshTester` rejects on the bounds sphere first and tests triangles with Möller–Trumbore; `transform` is read each call (moving objects pick correctly without re-registering); harness `pick.html` on the matrix; documented.

## Scope

- `src/input/rays.ts`: the three testers plus `transformRayInto(ray, worldMatrix3x4, outRay)` (inverse of a 3×4 with non-uniform scale: invert the 3×3 and translate; scale the hit distance back to world units) and `rayTriangle(ray, a, b, c, cullBack, out): number` (distance or -1). Testers accept `Pick<Transform, 'world'>` or whatever read-only slice gives the 3×4 matrix: name it `RayTransform`. Zero allocations per call after construction (scratch vectors per tester).
- `meshTester` positions: pass the interleaved vertex buffer and the layout's float stride and position offset (`{ stride, offset }` from `VertexLayout`; default `VERTEX_LAYOUT_3D`'s), so a game hands it the same `Float32Array` it uploaded.
- Tests `src/input/rays.test.ts`: each tester hit and miss, scaled/rotated transforms, back-face culling, nearest triangle wins, bounds rejection path, inside-sphere `normal: null` rule, distance in world units under scale.
- Harness `harness/pick.html` + `pick.ts` + `pick-state.ts`: six spinning meshes (cubes, an icosphere) each with a `meshTester`, click/tap highlights the hit one (vertex colour tint through an instance param), state exposes `hit: string | null`, `hitPoint`, `instances`, `culled`. `e2e/pick.spec.ts`: a click at the centre of a known mesh's screen position (compute from state's `screenPositions`) hits that mesh; a click on empty sky hits nothing; works on touch rows (tap).
- Docs: `src/input/README.md` *Rays* (three testers, the stride/offset rule, costs), ARCHITECTURE *Input* one sentence, CHANGELOG, root README harness list.

## Files owned

`src/input/rays.ts`, `src/input/rays.test.ts`, `src/input/index.ts` (append), `src/input/README.md` (*Rays*), `harness/pick.*`, `e2e/pick.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Nothing under `src/render/`. Branch from `main` (3813f8c or later). Running alongside: ws/look-zoom (`look.ts`, `follow.ts`, both in `input`: stay out of them), ws/spot-lights, ws/snap-gate, ws/pbr, ws/skinning, ws/anim, ws/trails, ws/xr-post, ws/template-first-person, ws/doc-sweep-3 (edits README tables; add your item at the end of the harness list).
