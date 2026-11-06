# demos/voxel

A Forgewilds-class voxel world: 8×8 columns of 16³ chunks (128×64×128 blocks, 256 chunks) of
value-noise hills, beaches, caves, trees and glowstone, meshed by the engine in a Web Worker and
walked in first person. Run it with `pnpm demo voxel` (or `pnpm exec vite demos/voxel --host
127.0.0.1`). `?still&time=0.25` parks the day cycle at noon (`time` in days, 0 = midnight).

**What it shows.** Click to take the pointer lock, then the mouse looks and WASD walks (Space
jumps; blocked steps auto-jump); a touch drags the view with a move stick on the left; the pad
walks and looks. A click (tap on the right half, right trigger) breaks the block under the
reticle; a right click, `E`, a long press or the left trigger places the hotbar block on the
looked-at face. `1`–`7`, the wheel or the pad shoulders pick the block. The day cycle drives the
sun, the `Sky`, the fog and the shadow; glowstone flickers into the bloom.

## What to look at

- The game is the blocks: `world.ts` writes the noise terrain, caves, trees and glowstone into a
  `createVoxelGrid` and names the block rules (`blockLayer` per face, `outsideBlock` for the
  world's edges); `mesher.worker.ts` is the engine's Worker recipe, `installVoxelMesherWorker`
  with those two rules.
- `createVoxelMesher` mirrors the grid in the Worker and `createVoxelChunks` keeps one mesh per
  non-empty chunk, remeshes what `grid.set` dirtied (the chunk and its face neighbours) and
  rewrites each mesh in place: `__demo.growths` stays 0 through breaks and places,
  `__demo.remeshMs` is the round trip from the click to the last upload.
- `chunks.draw(frame, camera)` frustum-culls on each chunk's bounding sphere: the spawn view is
  ~73 draw calls for 256 chunks (`__demo.drawCalls`, `chunksDrawn`, `chunksCulled`).
- One material for every block: a `texture_2d_array` of eight canvas-painted textures under the
  `nearest-mip-repeat` sampler, `VOXEL_WGSL`'s `voxel_layer` and `voxel_ao` reading the layer and
  the baked ambient occlusion out of the vertex colour; the uv is in block units, so a merged
  quad tiles.
- `raycastVoxels` picks the block under the reticle and the face to place on; `Water` sits at
  sea level with its `origin` at the world's centre (the grid's corner is the origin) and is
  drawn in a second view for its depth fade and foam; `Sky` keeps an `ambientFloor` at night.

The move took the demo from 1619 lines of TypeScript (main 724, worker 278, world 498, textures
119) to 1071 (main 624, worker 9, world 319, textures 119).

## Known limits

No block lighting beyond the baked AO (glowstone glows but lights nothing); no save, no infinite
terrain, one block texture set. On some 1-block terrain steps the +z riser face shows as a
triangle from some viewpoints, the hidden half showing a top face: the engine mesher's output was
checked quad by quad and cell by cell and is correct (`riser.test.ts`, skipped with the evidence
and the suspected draw-side lines); open as a wish for ws/voxel-2.

**Engine modules.** `voxel` (`createVoxelGrid`, `createVoxelMesher`, `installVoxelMesherWorker`,
`createVoxelChunks`, `raycastVoxels`, `VOXEL_WGSL`), `render` (`loadTextureArray`, a
`texture_2d_array` material with uniforms and the `nearest-mip-repeat` sampler, perspective
`Camera`, `Lights` with a sun shadow and fog), `fx` (`Sky`, `Water`, `flicker`), `post` (bloom,
vignette, grade), `input` (`Look` with keys, a touch move zone and the pad, `Gestures` for taps
and long presses, `Input` bindings for mouse, wheel, keys and pad), `ui` (`createOverlay`,
`reticle`, `slots`, toasts), `platform` (`boot`), `core` (`GameLoop`).

**What the spec checks** (`e2e/demos/voxel.spec.ts`, every matrix row, via the harness server's
`/demos/voxel/` route): boot with all 256 chunks meshed, no console errors and `drawCalls` < 200;
`__demo.aim(0, -1.2)` then a click (a CDP tap on touch rows) breaks the looked-at block
(`lookingAt` changes, `remeshMs` < 50 on desktop rows, `growths` 0); a right click (`E` on touch
rows) places the hotbar block on a face of the looked-at block, as fast and with no growth; `W`
for 1 s moves `playerPos`; `?still&time=0.25` holds `timeOfDay`; desktop rows run above 20 fps.
`window.__demo` also carries `fps`, `chunks`, `triangles`, `selectedBlock`, `yaw`, `pitch`,
`edits`, `remeshes` and `gpuErrors`, and `blockAtWorld(x, y, z)`.
