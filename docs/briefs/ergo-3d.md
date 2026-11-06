# Brief: ws/ergo-3d

Read `docs/briefs/common.md` first, then `docs/STATUS.md` *Backlog* (every line that ends in "→ ws/ergo-3d" is yours; the exact wishes are there, with the branch that asked), DECISIONS E-015; then only the files each item names below.

## Goal

The ergonomics sweep for 3D games, collected from the first-person template, the three 3D demos, geom-2, audio-2, skinning, pick and texture-registry: small API additions and one-line fixes that each remove a copy-paste from a game. No new subsystem. Every change is backwards compatible; existing harness goldens stay pixel-identical (`pnpm snap:check`).

STATUS row, *done when*, by module:

- **render**: `RenderStats.triangles` (summed from indexed/non-indexed draw counts; bench reads it); `createStandardMaterial({ skinned: true })` (or `buffers`) so a skinned PBR/standard material needs no custom WGSL (compose the existing skinning vertex prelude the skin harness uses); `VertexLayout.positionOffset` so a layout goes straight to `meshTester`; `Mesh.update(reply: { buffer, vertexCount, indexCount?, bounds? })` overload accepting a worker's message (the stream harness shape); `Renderer.timing.ready(): Promise<void>` (resolves at the first GPU timing sample, or immediately when timing is unsupported); `SceneTarget.external` stops allocating the unused emissive in XR scene mode (xr-post wish; keep the API); `textureFromSource(src, { mips })`; render README *Vertex attribute locations* table (0..2 vertex, 3..9 instance, 11/12 skinning, 13 tangent) and the `Mesh` doc comment about empty indexed meshes corrected (the renderer skips them). Do **not** touch `standard.ts` default-texture dedupe or `Renderer.white` (ws/pbr-lights owns those; if it has landed, leave its result).
- **geom**: `mergeGeometry` and `transformGeometry` accept `VERTEX_LAYOUT_3D_TANGENT` (transform rotates the tangent xyz, keeps w); `sampleHeight(field, x, z)` and `rayHeightfield(field, origin, dir, out)` for the heightfield (first-person template wish).
- **anim**: `quatFromMat3(m, out)` in `quat.ts` (ik wish); `InstanceParams.skin` documented as the skin slot convention or a named constant `SKIN_PARAM = 'w'` where the skin harness and gltf-skin read `params.w` (skinning wish; a constant, not a layout change).
- **input**: `Look` option `lockOnFirstClick` (first-person template wish): the first pointerdown on the surface requests pointer lock; document alongside the existing lock behaviour.
- **audio** (`audio.ts`, after ws/audio-zones has landed; it is on chain 5): `mixer.voices(bus): readonly Voice[]` (live voices on a bus, allocation-free view), `Voice.sendTo(node: AudioNode, amount)` (a gain tap from the voice's output), and `mixer.register(source: AudioNode, bus)` so `createMusic` stems count as voices; update `duck.ts` to use `voices(bus)` when `trigger` is given and `music.ts` to `register` stems (both from ws/audio-2, landed or landing on chain 3: if not yet on main when you branch, skip the two call-site changes and say so).
- **harness**: replace the hand-built cube/ground/tube/icosphere in `harness/mesh.ts`, `pick.ts`, `skin.ts` and `templates/first-person` terrain with `geom` builders **only where the result is vertex-identical** (same vertex order and values; verify with a test or skip the file and say so, since the 2D goldens and 3D probes must not move).
- Tests for each addition; docs: each module README, CHANGELOG one block, ARCHITECTURE only if a public shape changed.

## Files owned

`src/render/{renderer.ts, frame.ts, mesh.ts, scene-target.ts, standard.ts (skinned option only), texture.ts, material.ts (positionOffset), README.md}`, `src/geom/{geometry.ts, heightfield.ts, README.md}` + tests, `src/anim/quat.ts` + test, `src/input/look.ts` + test, `src/audio/{audio.ts, duck.ts, music.ts}` + tests, `harness/{mesh,pick,skin}.ts`, `templates/first-person/src/**` (terrain only), `CHANGELOG.md`, module READMEs, `ARCHITECTURE.md`.

Branch from `main` **after ws/pbr-lights has landed** (the dispatch message names the hash). Running alongside: ws/morph (`gltf-load.ts`, `anim`; do not edit `src/assets/*`), ws/perf-overlay (`src/ui/perf.ts`; it reads `RenderStats`: adding a field is fine), ws/billboards and ws/debug-draw (`src/fx`; do not edit `src/fx`), ws/water, ws/decals (`src/fx`), ws/post-2 (`src/post`), ws/assets-2 (`src/assets`). Keep every change additive; where a file you own is also in a landing branch's shared-file list (STATUS row notes), make the smallest edit possible and say which lines.
