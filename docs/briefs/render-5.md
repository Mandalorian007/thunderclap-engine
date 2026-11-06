# Brief: ws/render-5

Read `docs/briefs/common.md` first. Then read:
- `docs/VISION.md`, pillars 1–2 and the E-015 quality bar.
- These rows in `docs/STATUS.md`: ws/render-4, ws/assets-3 and ws/geom-3.
- The wish lines routed to ws/render-5: from ws/assets-3 (`occlusionStrength` and compressed upload), ws/geom-3 (renderer LOD pick), ws/demo-arpg (`dissolve`), and the ws/decals wishes (inverse view-projection in the camera block, `'multiply'` blend).
- `src/render/README.md` end to end.
- `src/render/{standard,material,renderer,texture,camera,blend,wgsl}.ts` and `src/render/fake-gpu.ts`.
- From `src/assets/`: `ktx2.ts` (`parseKtx2`, `ktx2ToWebGpuFormat`) and the `src/assets/README.md` *KTX2* section.
- From `src/geom/`: the LOD chain type in its README.

## Goal

The renderer takes what assets and geom now produce. KTX2 textures upload compressed. LOD chains pick per instance on screen size. The standard material carries the factors glTF hands it. Characters can dissolve on death. Every addition is opt-in, and the 2D goldens stay pixel-identical.

STATUS row, *done when*:

- **Compressed textures.**
  - The renderer requests `texture-compression-bc`, `-etc2` and `-astc` when the adapter has them, and `renderer.caps.compressed` reports which.
  - `uploadKtx2(renderer, ktx2, { srgb? })` creates the texture in the mapped format, writes each mip level with its block-aligned `bytesPerRow`, and returns a `Texture` the standard material takes.
  - When the format isn't supported, it throws a typed error naming the format and the caps. A transcoder is not in scope; the README says so.
  - Tests (fake GPU): BC7 levels are written with the right row pitch; an unsupported format throws; caps reflect the device features.
- **LOD pick.**
  - `frame.mesh` / instance lists accept a `MeshLod` (`{ levels: Mesh[], screenSizes: number[] }`, or whatever type geom-3 exports; reuse it).
  - The renderer picks a level per instance from projected bounding-sphere size, with `lodBias` on the camera or the renderer.
  - Instances are grouped per level, so draws don't multiply per instance.
  - `renderer.stats.lodCounts` is available.
  - Tests: picks at three distances; hysteresis so an instance does not flicker at a boundary; draw count is one per non-empty level.
- **Standard material gaps.**
  - `occlusionStrength`.
  - `dissolve: { amount, edgeColor, edgeWidth, noise? }`: a noise-threshold discard with an emissive edge that shadows respect.
  - Tests: the dissolve discards above the threshold; shadow casters discard the same pixels.
- **Decal and blend debts.**
  - Inverse view-projection added to the camera globals block. Keep the documented offsets of existing fields; append only.
  - `'multiply'` in `blendState`.
- **Harness.** New pages only: `harness/render5.html`, `render5.ts` and `render5-state.ts`.
  - `?ktx2`: a KTX2 built in the page. Use BC if the device has it, otherwise show the error path. State `format`, `uploaded`.
  - `?lod`: a field of 200 rocks with a geom LOD chain. State `lodCounts`, `drawCalls`.
  - `?dissolve`: a cycling dissolve with shadows. State `amount`.
  - `?still`.
  - `e2e/render5.spec.ts` (E-017). render4, pbr, mesh and post3 specs stay green, and `pnpm snap:check` stays at 0 px.
- **Docs.** Render README sections; the *Not yet* list; the types list; a CHANGELOG block; one ARCHITECTURE sentence; the root README harness list.

## Files owned

- `src/render/**` and its tests.
- New `harness/render5*`.
- `e2e/render5.spec.ts`.
- `ARCHITECTURE.md` (one sentence).
- `CHANGELOG.md`.
- The root `README.md` harness list.

Do not edit:
- `src/post/**`. ws/post-4 is in flight on render-4's inputs. If post needs something, make it a wish.
- `src/assets/**` and `src/geom/**`. Read their exports only.
- `src/ui/**` (ws/ui-5).
- `src/fx/**` (ws/fx-4).
- `demos/**` and `templates/**` (ws/adopt-sweep).

Branch from `main` (e23be4d or later). Running alongside: ws/post-4, ws/ui-5, ws/e2e-harden, ws/fx-4, ws/nav-5 and ws/adopt-sweep. Use `E2E_PORT_OFFSET=800`. Gate per E-031.
