# `@thunderclap-engine/engine/voxel`

Block grids into chunk meshes and onto the screen: a `VoxelGrid` with per-chunk dirty flags, a greedy mesher with baked AO that runs in a Worker, a chunk renderer that culls and remeshes in place, a picking ray and the WGSL prelude for block materials. The game ships the blocks: what each id is, which texture layer each face shows and what a click does. No allocation per frame after the first remeshes.

## Quick use

<!-- snippet:check -->
```ts
import { createVoxelChunks, createVoxelGrid, createVoxelHit, raycastVoxels } from '@thunderclap-engine/engine/voxel';
import type { Camera, Frame, Material, Renderer } from '@thunderclap-engine/engine/render';

declare const renderer: Renderer;
declare const material: Material; // a block material built on VOXEL_WGSL (Quick start below)
declare const frame: Frame;
declare const camera: Camera;

const STONE = 1;
const grid = createVoxelGrid({ sizeX: 64, sizeY: 32, sizeZ: 64, chunk: 16 });
grid.fill((_x, y) => (y < 8 ? STONE : 0)); // block ids are the game's
const chunks = createVoxelChunks(renderer, grid, { material, layerOf: (block) => block - 1 });

chunks.update(); // each tick: remesh dirty chunks
chunks.draw(frame, camera); // each view: cull and draw

const hit = createVoxelHit();
if (raycastVoxels(grid, 32, 20, 32, 0, -1, 0, 8, hit)) grid.set(hit.x, hit.y, hit.z, 0);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createVoxelGrid(opts)` | block ids in chunks with dirty flags |
| `createVoxelWorld(core, opts)` | a streamed block world drawn in three GPU-culled sets of the retained core, with cave culling (*The world*) |
| `feedVoxelGrid(world, grid)` | a `VoxelGrid` as the world's source: a small bounded world |
| `createVoxelChunks(renderer, grid, opts)` | superseded: one mesh per non-empty chunk; `update` and `draw` (the voxel demo's until the core draws inside `Renderer`) |
| `raycastVoxels(grid, origin, dir, max, hit)` | the block under a ray, and the cell before it |
| `meshChunk(...)` | the greedy mesher, pure |
| `createVoxelMesher / installVoxelMesherWorker` | the two ends of the Worker bridge |
| `VOXEL_WGSL` | the WGSL prelude a block material reads |
| `deserializeVoxelGrid(bytes)` | a grid back from `grid.serialize()` |
| `defineVoxelFormat({ blocks, vertex, cell })` | a streamed world's block table, vertex layout and cell layout (*Streamed sections*) |
| `createSectionStore(opts)` | sparse sections by key: readiness, nearest-first meshing, edits, Worker jobs |
| `SectionMeshPool` / `installSectionMesherWorker` | the two ends of the section mesher Workers |
| `raycastCells(probe, ...)` / `sectionRayProbe(store)` | picking through a streamed world |
| `SectionVisibility` | cave culling: which sections an eye can see through open cells |
| `voxelVertexWgsl(format)` / `VOXEL_DEFAULT_FRAGMENT` | the world's vertex stage and the engine's plain look |

## Overview

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
| `chunks.ts` | `createVoxelChunks` (superseded): one `Mesh` per non-empty chunk, remesh on dirty, cull, draw |
| `ray.ts` | `raycastVoxels`, `createVoxelHit`: cell-by-cell DDA picking |
| `wgsl.ts` | `VOXEL_WGSL`: `voxel_layer`, `voxel_ao`, `voxel_uv_wrap` |
| `blocks.ts` | `defineBlockTable`, `FACE_CLASS`, `CellLayout`: block behaviour as data |
| `schema.ts` | `defineVertexSchema`, `packVertexField`, `vertexSchemaWgsl`: the declared 2 × u32 vertex |
| `format.ts` | `defineVoxelFormat`, `sectionKey`, `SectionCodec`, `RAW_SECTION_CODEC` |
| `store.ts` | `createSectionStore`: sparse sections, readiness, priority, edits, jobs |
| `sources.ts` | `SectionJob`, `packSources`, `SectionInputBuilder`: a job's sources into the padded volume |
| `section-mesher.ts` | `SectionMesher`: greedy faces, AO, smooth sky and block light, cross quads, `meshPiece` |
| `light.ts` | `BlockLightFlood`: block light over the 27 sections around a job |
| `connectivity.ts` | `ConnectivityFlood`, `facePairBit`: which faces a section's open cells connect |
| `section-protocol.ts` | `installSectionMesherWorker`, the Worker messages |
| `pool.ts` | `SectionMeshPool`, `MesherPort`, `workerMesherPort`, `inThreadMesherPort` |
| `section-ray.ts` | `raycastCells`, `sectionRayProbe` |
| `world.ts` | `createVoxelWorld`: store, pool, upload into the core's arenas and sets, budgets, cave culling |
| `world-shaders.ts` | `voxelVertexWgsl`, `VoxelVarying`, `VOXEL_DEFAULT_FRAGMENT` |
| `visibility.ts` | `SectionVisibility`: Checchi-style connectivity search over sections, throttled |
| `grid-source.ts` | `feedVoxelGrid`: a `VoxelGrid`'s chunks as the world's sections |

## Quick start

```ts
import {
  createVoxelChunks, createVoxelGrid, createVoxelHit, raycastVoxels, VOXEL_WGSL,
} from '@thunderclap-engine/engine/voxel';

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
cell (`data`, x fastest, then y, then z: `index(x, y, z)`), block 0 being air. The sizes need
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
`'nearest-mip-repeat'` sampler (`@thunderclap-engine/engine/render`) is the one block faces want:
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
import { installVoxelMesherWorker } from '@thunderclap-engine/engine/voxel';
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

Superseded: `createVoxelWorld` with `feedVoxelGrid` replaces it (*The world*).

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

## Streamed sections

The grid above is a bounded demo world. A game whose world streams in from a server (or a
generator) as cubic sections uses the second half of the module: the CPU and Worker side of
any block game, generalized from Forge Wilds' mesher, and the world that draws it (*The world*
below).

**The format, as data.** `defineBlockTable(blocks, { hueMix })` (`BlockTableOptions`) compiles one `BlockDef` per id into a `BlockTable`:
its `FaceClass` (`none`, `opaque`, `liquid`, `cutout` an inset cube that hides nothing,
`foliage` drawn in its own stream and culled against its own kind, `cross` crossed quads),
`lightCost`, `emission` and `hue` (one of `LIGHT_HUES` = 8 colours; `hueMix` names the blend
where two meet, `NO_HUE_MIX` where none), `inset`, `quads` and constant vertex `fields`.
`defineVertexSchema(fields, { defaults })` (`VertexFieldDef`s, `VertexSchemaOptions`) lays out a `VertexSchema`: two u32 words (`SECTION_VERTEX_WORDS`),
`VOXEL_VERTEX_DEFAULTS` (`x y z face ao sky block id`) first, then the game's fields first-fit
or at a declared `word` and `shift`; the mesher also fills `VOXEL_VERTEX_OPTIONAL` (`side quad
inset hue`) when they are declared. Each placed `VertexField` packs with `packVertexField`,
reads with `vertexFieldValue` (`vertexField(schema, name)` finds it, `unpackSectionVertex`
reads them all) and `vertexSchemaWgsl(schema, opts)` (`VertexSchemaWgslOptions`) writes the
matching `struct VoxelVertex` and `fn decode_voxel_vertex(w0: u32, w1: u32)` include (no
`override`). A `CellLayout` says where the id sits in a cell (one u32) and which `CellField`s
reach the vertices (`fromFacing`: a flag on the air a face looks into, such as "dug out").
`defineVoxelFormat({ sectionSize, blocks, vertex, cell, skyFalloff, liquidSkyFalloff })`
(`VoxelFormatOptions`) checks and bundles them into a `VoxelFormat`.

<!-- snippet:check -->
```ts
import {
  createSectionStore,
  defineBlockTable,
  defineVertexSchema,
  defineVoxelFormat,
  encodeRawSection,
  RAW_SECTION_CODEC,
  vertexSchemaWgsl,
} from '@thunderclap-engine/engine/voxel';

const format = defineVoxelFormat({
  blocks: defineBlockTable([
    { class: 'none' },
    { class: 'opaque', fields: { material: 1 } },
    { class: 'opaque', emission: 12, hue: 2, fields: { material: 2 } },
  ]),
  vertex: defineVertexSchema([{ name: 'material', bits: 4 }]),
});
const decode = vertexSchemaWgsl(format.vertex); // prepend to the block shader
const store = createSectionStore({ format, codec: RAW_SECTION_CODEC, minSectionY: 0, maxSectionY: 3 });
store.putSection(0, 0, 0, encodeRawSection(Uint32Array.of(1))); // a uniform section of id 1
```

**The store.** `createSectionStore({ format, codec, air, minSectionY, maxSectionY, outside })`
(`SectionStoreOptions`) is a `SectionStore` holding sections by `sectionKey(sx, sy, sz)` (`sectionKeyX`, `sectionKeyY`,
`sectionKeyZ` take it apart; `sectionIndex` is a cell's local index) as the bytes they arrived in, decoding through
the game's `SectionCodec` (`RAW_SECTION_CODEC` and `encodeRawSection` are the engine's trivial
one) only to edit. `putSection` / `dropSection`, `has`, `cellAt`; a section is `ready` when all
26 around it are known; `setInterest` and `takeReady(out, max)` hand out dirty ready sections
nearest first; `edit(key, [index, cell, ...])` returns every section whose mesh changed (the
neighbours sharing the edited border, sky-lit rows below a moved column top, and all 27 around
when a glowing block is near); `jobFor(key)` packs a `SectionJob` with transferable buffers;
`stats()` is a `SectionStoreStats`. `HEIGHT_OPEN` and `HEIGHT_BLOCKED` mark column heights.

**The mesher.** A job holds its 27 sources (`SourceSection`: one cell, encoded bytes or cells;
`packSources`, `sourceIndex`, `jobTransfers`); `SectionInputBuilder(format, codec).build(job)`
makes the `SectionInput` (the padded volume, column heights, and near emitters the 27 sections
whole). `new SectionMesher(format).mesh(input, { greedy })` (`SectionMeshOptions`) returns a
`SectionMesh`: `opaque`, `liquid` and `foliage` streams of four-vertex quads (cross quads have
face `CROSS_FACE`), bounds, and connectivity. It ports Forge's rules unchanged: per-corner AO with
the flipped diagonal, smooth sky light (×4, falling off `skyFalloff` per block under a column's
top), block light from `BlockLightFlood` (Dial's algorithm over the wide volume, exact and
seamless for sections of 15 or more, the lower hue on a tie, half levels at the vertices) and
greedy merging only of faces whose id, fields, AO and light all match. `meshPiece(cells, sx, sy,
sz)` meshes a small free-standing grid (a held block). `ConnectivityFlood` reports a
`SectionConnectivity`: the 15 face pairs (`facePairBit`, `ALL_FACE_PAIRS`) the open cells
connect, for a renderer's cave culling; `uniformConnectivity` is a uniform section's.

**Workers.** The game's Worker script calls `installSectionMesherWorker({ codec })` (it answers
`SectionMesherRequest`s with `SectionMesherReply`s, a `SectionMeshResult` or a failure, over a
`SectionWorkerScopeLike`; `sectionReplyTransfers` lists what moves). On the page,
`new SectionMeshPool({ format, ports, build: (k) => store.jobFor(k), onMesh, respawn })`
(`SectionMeshPoolOptions`) queues sections by priority, builds a job only when a `MesherPort`
has room (`workerMesherPort(worker)`, or `inThreadMesherPort(codec)` without Workers), and
survives failures: a job the mesher throws on is counted (`SectionMeshPoolErrors`), a dead
Worker is replaced and its jobs rerun once. `stats` is a `SectionMeshPoolStats`.

**Picking.** `raycastCells(probe, ox, oy, oz, dx, dy, dz, maxDist, out)` is the DDA over a probe
that answers `RAY_PASS`, `RAY_HIT` or `RAY_UNKNOWN` per cell; `sectionRayProbe(store, hits)`
makes one over the store (a missing section is unknown, so a pick never goes through the
unloaded world). Both allocate nothing per call.

## The world

`createVoxelWorld(core, opts)` (`VoxelWorldOptions`) returns a `VoxelWorld` that draws a streamed world on the retained
render core (`createRenderCore`). It owns a `SectionStore` (or takes `store`), a
`SectionMeshPool` over `workers` (`MesherPort`s; none means one in-thread mesher), one vertex and
one instance arena, and three static, GPU-culled `DrawSet`s (`sets`): `opaque` (back faces
culled, the opaque pass), `foliage` (both sides, the cutout pass) and `liquid` (both sides,
alpha-blended in the transparent pass, unsorted: depth is read, not written). A section's three
streams share one instance (its origin) and its mesh's bounds are its cull sphere.

- **Feeding.** `putSection(sx, sy, sz, bytes)`, `dropSection`, `edit(key, changes)` (the
  remesh set), `setInterest(x, y, z)` (world blocks; the eye by default). `update(ex, ey, ez)`
  once a frame before `core.prepare`: ready sections go to the Workers nearest first (as many
  as keep `perWorker` jobs in flight each), and at most `uploadsPerFrame` (32) finished meshes
  upload, nearest first, into the arenas. A held world allocates nothing in `update`.
- **Cave culling.** `SectionVisibility` (`visibility`, on unless `caveCulling: false`; `SectionVisibilityOptions`, `SectionVisibilityStats`, its area a `SectionBox`) walks the
  sections the eye can reach through the connectivity bits (unknown sections count as open,
  no turning back against a direction taken, a cost for dark open cells) and hides the rest
  through their cull spheres; a search reruns when the eye changes section or a section's bits
  change, throttled (250 ms opening, 1 s closing).
- **Looks.** `materials: { opaque, foliage, liquid }` (keyed by `VoxelStream`), each a `VoxelMaterial`: a `fragment`
  (`@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f`; `decode_voxel_vertex`,
  `VoxelVarying` (`VOXEL_VARYING_WGSL`) and `view` are in scope), its `bindGroups` (from 1) and `blend`. A missing
  one is `VOXEL_DEFAULT_FRAGMENT[stream]`: a colour per id, sun, AO, sky and block light, haze.
- **Reading.** `raycast(...)` (`raycastCells` over the store), `settled`, `stats`
  (`VoxelWorldStats`: sections, drawn, hidden, pending, uploads, quads per stream, vertex bytes,
  update ms) and `dispose()`.

<!-- snippet:check -->
```ts
import { createRenderCore, createRenderView } from '@thunderclap-engine/engine/render';
import {
  createVoxelWorld,
  defineBlockTable,
  defineVoxelFormat,
  encodeRawSection,
  workerMesherPort,
} from '@thunderclap-engine/engine/voxel';

declare const device: GPUDevice;
declare const encoder: GPUCommandEncoder;
declare const worker: Worker; // its script: installSectionMesherWorker({ codec: RAW_SECTION_CODEC })

const core = createRenderCore(device);
const format = defineVoxelFormat({
  blocks: defineBlockTable([{ class: 'none' }, { class: 'opaque' }, { class: 'liquid' }]),
});
const world = createVoxelWorld(core, {
  format,
  workers: [workerMesherPort(worker)],
  minSectionY: 0,
  maxSectionY: 3,
  radius: 12,
});
world.putSection(0, 0, 0, encodeRawSection(Uint32Array.of(1))); // as sections arrive
const view = createRenderView();
world.update(8, 70, 8); // each frame, with the eye
core.prepare(encoder, [view]);
```

A bounded `VoxelGrid` feeds the same world: `feedVoxelGrid(world, grid, { outside })`
(`VoxelGridSourceOptions`) puts every chunk as a section (the format's `sectionSize` must be the
grid's `chunk`) and a ring of empty sections around them, and its `sync()` (a
`VoxelGridSource`) re-puts the chunks `grid.set` flagged, once a frame before `update`.

The engine pages: `harness/voxel-world.html` (scene S4: a generated world streamed at
`?radius=16` through Workers with a codec of its own, `e2e/voxel-world.spec.ts`) and
`harness/voxel.html` (a grid through `feedVoxelGrid`).

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

This recipe is the superseded chunk path (the voxel demo's until the core draws inside
`Renderer`). A new game uses *The world*: step 2 becomes `createVoxelWorld` with
`feedVoxelGrid`, the material a `VoxelMaterial` fragment that reads the block id with
`decode_voxel_vertex`. `harness/voxel.html` is that: a 4 × 2 × 4-chunk grid fed into the world
(`harness/voxel.ts`, `harness/voxel-worker.ts`), pointer-lock look, a click breaks, the
secondary button places, with `e2e/voxel.spec.ts` checking the world, the view, picking and
that a place then break restores the quads.
