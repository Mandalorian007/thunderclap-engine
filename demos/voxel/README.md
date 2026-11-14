# demos/voxel

A Forgewilds-class voxel world: 8×8 columns of 16³ chunks (128×64×128 blocks, 256 chunks) of
value-noise hills (the engine's `createNoise`), beaches, caves, trees and glowstone, meshed by the engine in a Web Worker and
walked in first person. Run it with `pnpm demo voxel` (or `pnpm exec vite demos/voxel --host
127.0.0.1`). `?still&time=0.25` parks the day cycle at noon (`time` in days, 0 = midnight).

**What it shows.** Click to take the pointer lock, then the mouse looks and WASD walks (Space
jumps; blocked steps auto-jump); a touch drags the view with a move stick on the left; the pad
walks and looks. A click (tap on the right half, right trigger) breaks the block under the
reticle; a right click, `E`, a long press or the left trigger places the hotbar block on the
looked-at face. `1`–`7`, the wheel or the pad shoulders pick the block. The day cycle drives the
sun, the `Sky`, the fog and the shadow; glowstone flickers into the bloom.

## What to look at

- The game is the blocks: `world.ts` writes the noise terrain (`createNoise(SEED)`: `fbm` over
  `value2` for the hills, `value3` for the caves; the world changed shape when it moved off its
  own value noise, terrain tops now 19..39, checked at boot against 16..44 with the spawn on
  grass above the sea, a console error otherwise; `WINDOW_Z` slides the world over the noise so
  the spawn looks north over flat grass), caves, trees and glowstone into a
  `createVoxelGrid` and declares the blocks as a voxel `format` (glowstone gives block light);
  `mesher.worker.ts` is the engine's section mesher Worker, `installSectionMesherWorker`.
- Since ws/core-passes the grid feeds `createVoxelWorld` (`feedVoxelGrid`; `sync()` re-puts what
  `grid.set` dirtied), the Worker meshes sections with AO, sky light and block light, the world
  streams them into the retained core's arenas, and the core draws its GPU-culled sets inside
  the `Renderer` frame (`renderer.core`). `__demo.remeshMs` is the round trip from the click to
  the first remeshed section on the GPU, `settleMs` to the relit neighbours too; `growths` stays 0 (arena allocations, no mesh growth).
- `__demo.drawCalls` counts the renderer's draws plus the core's bundles and direct draws;
  `chunksDrawn` and `chunksCulled` are the sections drawn and the ones cave culling hides.
- One fragment for every block (a `VoxelMaterial`): a `texture_2d_array` of eight
  canvas-painted textures under a nearest-mip repeat sampler, the layer from the block id and
  face, lit by the sun, the sky light, glowstone's block light and AO; the uv is in block units,
  so a merged quad tiles.
- `raycastVoxels` picks the block under the reticle and the face to place on; `Water` sits at
  sea level with its `origin` at the world's centre (the grid's corner is the origin) and is
  drawn in a second view for its depth fade and foam; `Sky` keeps an `ambientFloor` at night.

The first move (onto the engine's grid and chunk mesher) took the demo from 1619 lines of TypeScript (main 724, worker 278, world 498, textures
119) to 1071 (main 624, worker 9, world 319, textures 119).

## Known limits

No save, no infinite terrain, one block texture set. Since the move onto the core (ws/core-passes)
the terrain casts and receives no sun shadow and writes no emissive (glowstone's bloom is only
what passes the threshold): the core's sets draw in their own pass after the scene pass, and the
shadow cascade pass is still to come. The +z riser note and `riser.test.ts` went with the old
mesher.

**Engine modules.** `voxel` (`createVoxelGrid`, `defineVoxelFormat`, `createVoxelWorld`,
`feedVoxelGrid`, `installSectionMesherWorker`, `raycastVoxels`), `render` (`loadTextureArray`,
`createRenderCore` as `renderer.core`, perspective `Camera`, `Lights` for the sun, sky and
water), `fx` (`Sky`, `Water`, `flicker`), `post` (bloom,
vignette, grade), `input` (`Look` with keys, a touch move zone and the pad, `Gestures` for taps
and long presses, `Input` bindings for mouse, wheel, keys and pad), `ui` (`createOverlay`,
`reticle`, `slots`, toasts), `platform` (`boot`), `core` (`GameLoop`).

**What the spec checks** (`e2e/demos/voxel.spec.ts`, every matrix row, via the harness server's
`/demos/voxel/` route): boot with all 256 chunks meshed, no console errors and `drawCalls` < 200;
`__demo.aim(0, -1.2)` then a click (a CDP tap on touch rows) breaks the looked-at block
(`lookingAt` changes, `remeshMs` < 250 and `remeshFrameMs` within 50 ms of `idleFrameMs` on desktop rows, `growths` 0); a right click (`E` on touch
rows) places the hotbar block on a face of the looked-at block, as fast and with no growth; `W`
for 1 s moves `playerPos`; `?still&time=0.25` holds `timeOfDay`; desktop rows run above 20 fps.
`window.__demo` also carries `fps`, `chunks`, `triangles`, `selectedBlock`, `yaw`, `pitch`,
`edits`, `remeshes` and `gpuErrors`, and `blockAtWorld(x, y, z)`.
