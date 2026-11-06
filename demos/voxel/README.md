# demos/voxel

A Forgewilds-class voxel world: 8×8 columns of 16³ chunks (128×64×128 blocks, 256 chunks) of
value-noise hills, beaches, caves, trees and glowstone, greedy-meshed in a Web Worker and walked in
first person. Run it with `pnpm demo voxel` (or `pnpm exec vite demos/voxel --host 127.0.0.1`).
`?still&time=0.25` parks the day cycle at noon (`time` in days, 0 = midnight).

**What it shows.** Click to take the pointer lock, then the mouse looks and WASD walks (Space
jumps; blocked steps auto-jump); a touch drags the view with a move stick on the left; the pad
walks and looks. A click (tap on the right half, right trigger) breaks the block under the
reticle; a right click, `E`, a long press or the left trigger places the hotbar block on the
looked-at face. `1`–`7`, the wheel or the pad shoulders pick the block. The day cycle drives the
sun, the `Sky`, the fog and the shadow; glowstone flickers into the bloom.

## What to look at

- The mesher is game code (`mesher.worker.ts`): it owns the voxel grid, greedy-merges each
  chunk's faces per direction and slice and bakes four-neighbour ambient occlusion into the
  vertex colour; each chunk comes back as two transferred buffers that `Mesh.update` uploads in
  place (`__demo.growths` counts the 1.5× regrowths an edit forces).
- One material for every block: a `texture_2d_array` of eight canvas-painted 32×32 textures,
  the layer in the vertex colour's alpha, the uv in block units so a merged quad tiles.
- `camera.seesSphere` on each chunk's bounding sphere keeps the spawn view at ~80 draw calls
  for 256 chunks (`__demo.drawCalls`, `chunksDrawn`, `chunksCulled`).
- Breaking or placing re-meshes the touched chunk and its face neighbours only;
  `__demo.remeshMs` is the round trip from the click to the last upload.
- `Water` at sea level is drawn in a second view, so its depth fade and foam read this frame's
  terrain; the shoreline is where the beach sand meets it.

## Known limits

No block lighting beyond the baked AO (glowstone glows but lights nothing); the uv is wrapped by
hand in the shader because the sampler kinds have no nearest + mips + repeat; `Water` is always
origin-centred, so the world is too; no save, no infinite terrain, one block texture set. On some
1-block terrain steps the +z riser face shows as a triangle (half the quad hidden); the mesher's
output was checked quad by quad and is correct, so the cause is on the draw side and still open.

**Engine modules.** `render` (`createMesh` / `Mesh.update` with `VERTEX_LAYOUT_3D`,
`loadTextureArray`, a `texture_2d_array` material with uniforms, perspective `Camera` with
`seesSphere`, `Lights` with a sun shadow and fog), `fx` (`Sky`, `Water`, `flicker`), `post`
(bloom, vignette, grade), `input` (`Look` with keys, a touch move zone and the pad, `Gestures`
for taps and long presses, `Input` bindings for mouse, wheel, keys and pad), `ui`
(`createOverlay`, `reticle`, `slots`, toasts), `platform` (`boot`), `core` (`GameLoop`).

**What the spec checks** (`e2e/demos/voxel.spec.ts`, every matrix row, via the harness server's
`/demos/voxel/` route): boot with all 256 chunks meshed, no console errors and `drawCalls` < 200;
`__demo.aim(0, -1.2)` then a click (a CDP tap on touch rows) breaks the looked-at block
(`lookingAt` changes, `remeshMs` < 50 on desktop rows); a right click (`E` on touch rows) places
the hotbar block on a face of the looked-at block; `W` for 1 s moves `playerPos`;
`?still&time=0.25` holds `timeOfDay`; desktop rows run above 20 fps. `window.__demo` also carries
`fps`, `chunks`, `triangles`, `selectedBlock`, `yaw`, `pitch`, `edits`, `growths` and `gpuErrors`,
and `blockAtWorld(x, y, z)`.
