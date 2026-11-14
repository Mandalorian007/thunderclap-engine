# `@thunderclap-engine/engine/voxel`

Streamed block worlds on the retained render core: block tables as data, a sparse section store, Worker meshers with light and cave connectivity, `createVoxelWorld` drawing GPU-culled sets, a `VoxelGrid` for small bounded worlds and picking rays.

## Quick use

<!-- snippet:check -->
```ts
import {
  createVoxelGrid,
  createVoxelHit,
  createVoxelWorld,
  defineBlockTable,
  defineVoxelFormat,
  feedVoxelGrid,
  raycastVoxels,
} from '@thunderclap-engine/engine/voxel';
import type { RenderCore } from '@thunderclap-engine/engine/render';

declare const core: RenderCore; // renderer.core inside a Renderer frame, or a bare core

const STONE = 1;
const format = defineVoxelFormat({
  sectionSize: 16,
  blocks: defineBlockTable([{ class: 'none' }, { class: 'opaque' }]),
});
const grid = createVoxelGrid({ sizeX: 64, sizeY: 32, sizeZ: 64, chunk: 16 });
grid.fill((_x, y) => (y < 8 ? STONE : 0)); // block ids are the game's
const world = createVoxelWorld(core, { format, radius: 4 });
const source = feedVoxelGrid(world, grid);

// Each tick, before core.prepare: the dirty chunks in, the finished meshes up.
source.sync();
world.update(32, 20, 32);

const hit = createVoxelHit();
if (raycastVoxels(grid, 32, 20, 32, 0, -1, 0, 8, hit)) grid.set(hit.x, hit.y, hit.z, 0);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createVoxelGrid(opts)` | block ids in chunks with dirty flags |
| `createVoxelWorld(core, opts)` | a streamed block world drawn in three GPU-culled sets of the retained core, with cave culling (*The world*) |
| `feedVoxelGrid(world, grid)` | a `VoxelGrid` as the world's source: a small bounded world |
| `raycastVoxels(grid, origin, dir, max, hit)` | the block under a ray, and the cell before it |
| `deserializeVoxelGrid(bytes)` | a grid back from `grid.serialize()` |
| `defineVoxelFormat({ blocks, vertex, cell })` | a streamed world's block table, vertex layout and cell layout (*Streamed sections*) |
| `createSectionStore(opts)` | sparse sections by key: readiness, nearest-first meshing, edits, Worker jobs |
| `SectionMeshPool` / `installSectionMesherWorker` | the two ends of the section mesher Workers |
| `raycastCells(probe, ...)` / `sectionRayProbe(store)` | picking through a streamed world |
| `SectionVisibility` | cave culling: which sections an eye can see through open cells |
| `voxelVertexWgsl(format)` / `VOXEL_DEFAULT_FRAGMENT` | the world's vertex stage and the engine's plain look |

## Overview

Streamed block worlds on the retained render core. Block tables, vertex and cell layouts as
data (`defineVoxelFormat`), a sparse section store, a pool of Worker section meshers with light
and connectivity, `createVoxelWorld` streaming the meshes into the core's arenas and drawing
them in GPU-culled sets with cave culling, a `VoxelGrid` for a small bounded world
(`feedVoxelGrid`) and picking rays (`raycastVoxels`, `raycastCells`). Noun-free: the game ships
the blocks (what each id is, how a face looks, what a click does); the engine ships the
geometry.

## Layout

| File | What |
| --- | --- |
| `grid.ts` | `VoxelGrid`: `Uint8Array` of block ids, chunk indexing, dirty flags, `serialize` / `deserializeVoxelGrid`, `subscribe` |
| `ray.ts` | `raycastVoxels`, `createVoxelHit`: cell-by-cell DDA picking |
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

## The chunk-mesh path (removed)

ws/core-passes removed `createVoxelChunks`, `meshChunk`, `countExposedFaces`,
`createChunkMeshOut`, `createVoxelMesher`, `installVoxelMesherWorker`, `packChunkMesh`,
`VOXEL_WGSL` and their types (`chunks.ts`, `mesher.ts`, `worker-client.ts`, `mesher-worker.ts`,
`wgsl.ts`): one `Mesh` per chunk in a 12-float vertex is superseded by *The world*, whose
sections share the core's arenas and draw in three GPU-culled sets. See *Demo migration recipe*.

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

**Block shape hooks (ws/render-fit).** These are data only, so they still cross to a Worker.
Without them a section meshes the same as before.
- `SectionMeshOptions.leafLod` is a level of detail for foliage and cross blocks. The game picks
  it per section by distance: `VoxelWorldOptions.leafLod(sx, sy, sz)`, or the pool's
  `leafLod(key)`. It reaches the Worker in the job request.
  - At 1, a `BlockDef.lodSolid` foliage block meshes into the opaque stream. Its faces carry the
    `solid` vertex field, and it hides the opaque faces it covers. Cross blocks drop their
    parts.
  - At 2, `lodSolid` faces across a one-cell gap to foliage or an opaque block are also
    dropped, and cross blocks are dropped too.
  - `SectionMesh.tiered` reports whether a section depends on the level at all. A tiered section
    needs meshing again when its level changes.
- `BlockDef.parts` (0..63) adds quads to a cross block at full detail, after its own `quads`.
  They carry the `part` field, and `quad` keeps counting, so declare `quad` wider than 3 bits if
  needed. With `partsReplace`, the block's own quads carry `twin`, so the shader can fade them
  into the parts.
- `SectionMeshOptions.insets`, or `SectionJob.insets` through Workers, overrides the inset of
  some `cutout` or `cross` cells. It is a list of (padded index, inset) pairs, for example a
  growing plant.
- `solid`, `part` and `twin` are listed in `VOXEL_VERTEX_OPTIONAL`.

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
- **Vertex hook (ws/render-fit).** `VoxelMaterial.vertex` adds the material's own WGSL vertex
  entry, and `vertexEntry` names it. The entry calls the world's `voxel_vertex(in, vi)`, then
  moves the result (sway, shrink, shaping part quads) and sets `out.clip` again. The stream
  draws and casts its shadow with this entry. The world's `vs` is unchanged.
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

A game with its own block mesher moves over in four steps (the voxel demo took them in
ws/core-passes):

1. Keep the block ids and the heightfield; pour them into a `VoxelGrid` with `fill` instead of
   its own array, and replace its mutation with `grid.set`. Dirty tracking comes with it.
2. Declare the blocks as a `defineVoxelFormat` table and draw with `createVoxelWorld` fed by
   `feedVoxelGrid` (`sync()` each tick re-puts the dirty chunks). The look is a `VoxelMaterial`
   fragment that reads the block id and face with `decode_voxel_vertex`, its texture array and
   uniforms in its own bind groups. Inside a `Renderer` frame, set `renderer.core` to the
   world's core (`createRenderCore(renderer, { depthFormat: DEPTH_FORMAT })`) and the sets draw
   in the scene pass's depth and colour.
3. Mesh off the thread: a Worker with `installSectionMesherWorker({ codec: RAW_SECTION_CODEC })`
   and `workers: [workerMesherPort(worker)]`.
4. Replace the custom pick with `raycastVoxels` from the eye along the view direction; break
   at `x, y, z`, place at `px, py, pz`.

`harness/voxel.html` is the same on a bare core: a 4 × 2 × 4-chunk grid fed into the world
(`harness/voxel.ts`, `harness/voxel-worker.ts`), pointer-lock look, a click breaks, the
secondary button places, with `e2e/voxel.spec.ts` checking the world, the view, picking and
that a place then break restores the quads.

`VoxelMaterial.writes` (ws/core-targets) names the core targets a material's fragment writes
at their fixed locations. The default fragments write roughMetal (rough, liquid smooth) and
velocity (`core_velocity(view, in.world)`): `VOXEL_DEFAULT_WRITES`. A material without `writes`
writes colour only.
