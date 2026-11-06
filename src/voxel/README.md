# `@thunderclap/engine/voxel`

Block grids into chunk meshes and onto the screen. A `VoxelGrid` of block ids with a dirty flag
per chunk, a greedy mesher with baked ambient occlusion (`meshChunk`: pure arithmetic, so it
runs in a Worker), the Worker bridge around it (`createVoxelMesher` on the page,
`installVoxelMesherWorker` in the Worker), a chunk renderer that owns one `Mesh` per non-empty
chunk, rewrites it in place as the grid changes and frustum-culls it (`createVoxelChunks`), a
block-picking ray (`raycastVoxels`) and the WGSL prelude a block material reads the vertex
convention with (`VOXEL_WGSL`). Noun-free: the game ships the blocks (what each id is, which
texture layer each face shows, what a click does); the engine ships the geometry.

Each grid cell is one world unit with the grid's corner at `origin` (default the world origin).
No allocation per frame after the first remeshes: the mesher's buffers grow with slack and
stay, the chunk meshes are sized with `slack` on their first upload and the per-frame paths
write into state they own.

## Layout

| File | What |
| --- | --- |
| `grid.ts` | `VoxelGrid`: `Uint8Array` of block ids, chunk indexing, dirty flags, `serialize` / `deserializeVoxelGrid`, `subscribe` |
| `mesher.ts` | `meshChunk` (greedy quads per face, AO baked), `countExposedFaces`, `createChunkMeshOut`, the vertex convention constants |
| `worker-client.ts` | `createVoxelMesher`: the page side; in-thread or over a Worker, coalescing; `packChunkMesh` |
| `mesher-worker.ts` | `installVoxelMesherWorker`: the Worker side (a grid mirror answering `mesh` requests) |
| `chunks.ts` | `createVoxelChunks`: one `Mesh` per non-empty chunk, remesh on dirty, cull, draw |
| `ray.ts` | `raycastVoxels`, `createVoxelHit`: cell-by-cell DDA picking |
| `wgsl.ts` | `VOXEL_WGSL`: `voxel_layer`, `voxel_ao`, `voxel_uv_wrap` |

## Quick start

```ts
import {
  createVoxelChunks, createVoxelGrid, createVoxelHit, raycastVoxels, VOXEL_WGSL,
} from '@thunderclap/engine/voxel';

const grid = createVoxelGrid({ sizeX: 64, sizeY: 32, sizeZ: 64, chunk: 16 });
grid.fill((x, y, z) => (y < heightAt(x, z) ? STONE : 0)); // block ids are the game's

const material = renderer.createMaterial({
  label: 'blocks',
  blend: 'opaque',
  wgsl: `${VOXEL_WGSL}
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;
@fragment fn fs_main(in: VSOut) -> FragOut {
  let albedo = textureSample(blocks, blockSampler, voxel_uv_wrap(in.uv), voxel_layer(in.color)).rgb;
  var o: FragOut;
  o.color = vec4f(albedo * engine_lambert(normalize(in.normal), in.worldPos) * voxel_ao(in.color), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`,
  textures: 1,
  viewDimension: '2d-array',
  sampler: 'nearest-mip-repeat',
});
material.setTexture(0, loadTextureArray(renderer.device, blockFaces));

const chunks = createVoxelChunks(renderer, grid, { material, layerOf: (block) => block - 1 });

// Each tick: finished remeshes in, dirty chunks out; each view: cull and draw.
chunks.update();
chunks.draw(frame, camera);

// A click: pick along the view ray, then edit; the chunk (and a neighbour on a border) goes
// dirty and is remeshed by the next update, rewriting its mesh in place.
const hit = createVoxelHit();
if (raycastVoxels(grid, ex, ey, ez, fx, fy, fz, 8, hit)) {
  if (breaking) grid.set(hit.x, hit.y, hit.z, 0);
  else grid.set(hit.px, hit.py, hit.pz, STONE);
}
```

Without a `mesher` option the chunks mesh on the main thread (a microtask per chunk). The
*Worker recipe* below moves that off the thread with two lines.

## Grid

`createVoxelGrid({ sizeX, sizeY, sizeZ, chunk = 16 })` (`VoxelGridOptions`) holds one byte per
cell (`data`, x fastest, then z, then y: `index(x, y, z)`), block 0 being air. The sizes need
not be multiples of `chunk`; the last chunk on an axis is ragged. `get(x, y, z, outside = 0)`
returns `outside` beyond the grid; `set(x, y, z, block)` returns whether the cell changed and
marks its chunk dirty, and a neighbouring chunk too when the cell lies on a border (the
neighbour's faces and ambient occlusion depend on it); `setMany(flat)` takes `x, y, z, block`
quadruples and returns how many changed; `fill(fn)` rewrites every cell. `version` bumps on
every change.

Chunks are indexed `chunkIndex(cx, cy, cz)` over `chunksX × chunksY × chunksZ`
(`chunkCount`); `chunkAt(x, y, z)` maps a cell to its chunk and `chunkCoords(chunk, out)` back
to chunk coordinates; `chunkEmpty(chunk)` scans it. The dirty flags (`dirty`, all set on
creation) drive remeshing: `isDirty`, `markDirty`, `markAllDirty`, `clearDirty`, and
`forEachDirtyChunk(fn)` clears each as it visits it and returns the count.

`serialize()` packs the header and cells into one transferable `ArrayBuffer`;
`deserializeVoxelGrid(buffer)` rebuilds a grid from it (what the Worker does) and
`deserialize(buffer)` reloads an existing grid of the same shape. `subscribe({ set?, reset? })`
(`VoxelGridListener`) reports each changed cell and each whole-grid rewrite and returns the
unsubscribe; the Worker bridge is one subscriber, a save system can be another.

## Vertex convention

`meshChunk` writes `VERTEX_LAYOUT_3D` (`VOXEL_VERTEX_FLOATS` = 12 floats: position, normal,
uv, rgba) with uint32 indices, in chunk-local units (the chunk's corner at 0):

| Channel | Carries |
| --- | --- |
| position | Chunk-local corners of the merged quad, world units |
| normal | The face's outward axis (`VOXEL_FACE_NORMALS[face]`) |
| uv | Block units across the quad: a merged 3×2 quad spans 0..3 × 0..2, v downward from the quad's top (a texture's row 0 is its top); the material wraps it |
| rgb | Baked ambient occlusion, 1 = open (`ao: false` writes 1) |
| a | The face's texture-array layer, a whole number (`layerOf(block, face)`, default `block - 1`) |

Faces (`VoxelFace`) are `0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z`. Ambient occlusion is the
four-neighbour rule: each quad corner looks at the two side cells and the diagonal beyond the
face, its level is `3 − solid`, and `aoCurve[level]` (default `VOXEL_AO_CURVE`
`[0.42, 0.62, 0.82, 1]`) is the brightness written. Quads merge only where the layer and the
four corner levels agree, and a quad whose opposite corners differ is split along the diagonal
that joins the darker pair, so creases read as creases. Draw with tint alpha 1 and the vertex
alpha reaches the fragment shader intact.

`VOXEL_WGSL` is the prelude a block material prepends to its own WGSL: `voxel_layer(color)`
(the layer, `u32`), `voxel_ao(color)` (the brightness) and `voxel_uv_wrap(uv)` (`fract`, for
atlases that cannot use a `repeat` sampler). It declares no bindings or entry points. The
`'nearest-mip-repeat'` sampler (`@thunderclap/engine/render`) is the one block faces want:
nearest texels, linear mips, wrapping.

`meshChunk(grid, cx, cy, cz, opts, out)` (`MeshChunkOptions`: `ao`, `aoCurve`, `layerOf`,
`outside`, the last a block id or a function of the cell for what lies beyond the grid)
fills a `ChunkMeshOut` from `createChunkMeshOut(quads)`, growing its arrays when a chunk needs
more and keeping them, and sets `vertexCount`, `indexCount` and the chunk-local bounding
sphere `bounds`. `countExposedFaces(grid, cx, cy, cz, outside)` is the unmerged face count,
the number brute-force tests and budget estimates want.

## Worker recipe

The mesher is pure over a grid, so the Worker owns a mirror of the grid and the page keeps it
in sync through the grid's own `subscribe`. In the Worker script:

```ts
// blocks-worker.ts
import { installVoxelMesherWorker } from '@thunderclap/engine/voxel';
installVoxelMesherWorker({ layerOf: (block) => block - 1 });
```

On the page:

```ts
const worker = new Worker(new URL('./blocks-worker.ts', import.meta.url), { type: 'module' });
const mesher = createVoxelMesher(grid, { worker });
const chunks = createVoxelChunks(renderer, grid, { material, mesher });
```

`createVoxelMesher(grid, opts)` returns a `VoxelMesher` (`VoxelMesherOptions`: the `MeshChunkOptions` plus `worker`, a
`VoxelWorkerLike`: `postMessage` with transfer and `addEventListener`) sends the serialized grid
once, mirrors every `set` and resends the grid after a `fill` or `deserialize` (`sync()` does it
by hand). `remesh(chunk)` returns a promise of a `ChunkMesh`: the `MeshReply` shape
`mesh.update` takes (`buffer`, `vertexCount`, `indexCount`, `indexOffset`, `bounds`) plus the
`chunk`, vertices then uint32 indices in one transferred buffer, so the upload copies nothing
on the main thread. Requests for a chunk already in flight coalesce into one follow-up that
runs after the reply (the same promise for every caller), so a burst of edits costs one extra
remesh. `pending` counts the open requests; `offThread` says whether a Worker is in use;
`dispose()` unsubscribes and stops listening. Without `worker` the same interface meshes on a
microtask in-thread with a `ChunkMeshOut` it keeps.

The protocol (`VoxelMesherRequest`: `grid` with the buffer, `set` with a cell, `mesh` with a
chunk index; `VoxelMesherReply`: a `ChunkMesh` tagged `mesh`) and `packChunkMesh(out, chunk)`
(a `ChunkMeshOut` into one `ChunkMesh`) are exported for a game that wants its own Worker
loop, for instance one that also generates terrain there.
`installVoxelMesherWorker(opts, scope = self)` (`VoxelWorkerScopeLike`) returns the handler it
installed, so a test can feed it requests directly.

## Chunk renderer

`createVoxelChunks(renderer, grid, opts)` (`VoxelChunksOptions`: `material`, the
`MeshChunkOptions`, `mesher`, `slack = 1.5`, `minQuads = 64`, `origin`, `params`, `now`)
returns a `VoxelChunks`. `update()` (once per tick) uploads every finished remesh into its
chunk's mesh and requests one for every dirty chunk; `draw(frame, camera)` (once per view)
tests each non-empty chunk's bounding sphere against the camera and pushes the visible ones
through `frame.mesh(mesh, material, transform, params)`; `dispose()` destroys the meshes (and
the mesher when this made it). `meshes` and `transforms` are per chunk index, for a game that
wants to draw a chunk itself or attach to it.

A chunk's mesh is created on its first non-empty remesh with `slack` times that reply's counts
of room (`minQuads` at least), `autoBounds` off and the reply's chunk-local sphere, offset by
the chunk origin, as its cull sphere. Later remeshes rewrite it in place; `Mesh.growths` stays 0
until a chunk outgrows its slack, when the mesh reallocates once at 1.5× as any `Mesh` does.
The world's one-click edits (a block placed, a block broken) keep `growths` at 0: that is what
the gate checks. A chunk that empties keeps its mesh and draws nothing until it fills again.

`stats` (`VoxelChunksStats`, also the return of `draw` as `VoxelDrawStats`): `drawn`, `culled`
and `triangles` of the last draw, `chunks` (non-empty), `growths` (summed over the meshes),
`pending` (requested, not yet applied), `remeshes` (applied so far) and `remeshMs` (request to
upload, last applied). A chunk edited by the player should show a `remeshMs` of one or two
frames; a `pending` that climbs means the Worker is behind.

## Picking

`raycastVoxels(grid, ox, oy, oz, dx, dy, dz, maxDist, out)` walks the ray cell by cell
(Amanatides & Woo) from the origin along the direction for up to `maxDist` in units of the
direction's length (world units for a unit vector) and returns true at the first solid cell,
filling the `VoxelHit` from `createVoxelHit()`: the cell `x, y, z`, the outward normal
`nx, ny, nz` of the face it entered, the empty cell `px, py, pz` in front of that face (where a
placed block goes) and `distance`. Cells outside the grid are air; a ray that starts inside a
block hits it at distance 0 with a zero normal and `p` equal to the cell, so a placement there
is for the game to refuse. Grid units are world units from the grid's corner: subtract the
world's `origin` from the ray first when it is not at the world origin. No allocation.

## Demo migration recipe

A game with its own block mesher moves over in four steps:

1. Keep the block ids and the heightfield; pour them into a `VoxelGrid` with `fill` instead of
   its own array, and replace its mutation with `grid.set`. Dirty tracking comes with it.
2. Replace the mesher with `createVoxelChunks` and a `layerOf` mapping block and face to the
   texture layer; drop the per-chunk mesh bookkeeping (creation, bounds, the cull loop).
   The material keeps its texture array and sampling; it prepends `VOXEL_WGSL` and reads
   the layer and AO through it instead of its own `round(in.color.a)`.
3. Move the mesher off the thread with the *Worker recipe*: a three-line Worker script and a
   `mesher` option; the grid's `subscribe` keeps the mirror in sync.
4. Replace the custom pick with `raycastVoxels` from the eye along the view direction; break
   at `x, y, z`, place at `px, py, pz`.

The engine page `harness/voxel.html` is this recipe end to end: a 4 × 2 × 4-chunk world
(`harness/voxel.ts`, `harness/voxel-worker.ts`), pointer-lock look, a click breaks, the
secondary button places, with `e2e/voxel.spec.ts` checking draw and cull counts, picking and
that an edit leaves `growths` at 0.
