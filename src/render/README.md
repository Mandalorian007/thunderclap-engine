# engine/render

A raw WebGPU renderer for 2D and 3D: HDR scene targets, instanced quads and meshes, depth,
lights, and materials that take custom WGSL. It has no runtime dependencies.

## Frame model

```
beginFrame(time, dt) → Frame
  frame.sprite / frame.mesh / frame.drawable   (record only; nothing hits the GPU yet)
render(frame, camera, target = renderer.target)   once per camera
  1. first call of the frame: pre-passes and the per-draw uniform upload; every call: drawable.prepare()
     for each drawable in this view not yet prepared this frame (compute, uploads)
  2. write this view's globals + camera + lighting blocks (one 2032 B buffer per view) and its instances
     (appended to the shared instance buffer)
  3. scene pass into the target: colour (@location 0) and emissive (@location 1), both
     rgba16float, plus depth24plus when camera.depthTest; the first view into a target
     clears it, later views load. When a visible drawable has `readsDepth` (and the view
     has depth), the pass splits at the opaque/blended boundary: opaque pass, depth copy,
     drawable.afterOpaque(encoder, view), blended pass ("Depth hooks" below)
endFrame(opts?)
  4. render(frame, renderer.camera) if nothing was rendered (the single-camera path)
  5. renderer.post (e.g. PostStack) or the built-in present pass: renderer.target → swapchain
     (skipped with { present: false }: an XR frame resolved each eye into the session's layer
     with renderer.resolve(target, outView, viewport?) during step 3, not the canvas)
  6. submit
```

```ts
const frame = renderer.beginFrame(time, dt);
frame.sprite(null, { x, y, w, h });
renderer.render(frame, world);   // world.screen = { x: 0, y: 0, width: 0.5, height: 1 }: left half
renderer.render(frame, hud);     // hud.layers picks the UI draws; full screen, loads over world
renderer.endFrame();
```

- **Views.** `camera.screen` places the view: a rect inside the unit square is a fraction of
  the target (viewport and scissor), anything else is logical px (the `ortho2d` default, the
  whole target). Each view has its own uniform buffer and bind group (`engine-globals`,
  `engine-globals-1`, …), pooled across frames, so two cameras per frame allocate nothing in
  steady state. `renderer.stats` sums over the views.
- **Frustum culling.** With `camera.cull` (on for `perspective`, off for `ortho2d`), a mesh
  draw whose world bounding sphere (`mesh.bounds` through its instance matrix) is outside any
  of the camera's six `frustum` planes is dropped before sorting and counted in
  `renderer.stats.culled`. Sprites and meshes without bounds are never culled.
- **Targets.** `renderer.target` is the `SceneTarget` the post stack reads;
  `renderer.createSceneTarget({ width, height, label? })` makes an offscreen one (a portal, a
  minimap) whose `color` and `emissive` are sampleable `Texture`s. `target.depth` exists once
  a depth camera has rendered into it (or as soon as an external target adopts a depth texture).
  `SceneTargetDesc` is `{ width, height, label? }`; both colour targets use `SCENE_FORMAT`
  (`rgba16float`).
- **External targets (XR).** `SceneTarget.external({ device, color, depth?, view?, viewport?,
  label? })` (`SceneTargetExternal`) wraps a colour texture someone else owns (a WebXR projection
  layer's `getViewSubImage` colour, one array layer through `view`) and optionally its depth,
  allocating only the emissive target (and its own depth, if none was adopted, on first depth use); every
  external target of one size on a device shares one emissive texture, stored with `discard`, released by the last
  (`sharedEmissiveCount(device)` reads the pool size; two XR eyes allocate one, ws/ergo-3d); `isExternal`, `adoptedColor`, `viewport`
  (`SceneTargetViewport`, the sub-image rect in px) and `adopt(desc)` (re-point at the next
  frame's textures; a no-op when they are the same) are its extras; `resize` throws, `destroy`
  never destroys what it adopted. `XrSurface` in `@thunderclap/engine/platform` builds one per
  eye. `endFrame({ present: false })` skips the swapchain (post and present) for such a frame.
- **Resolve (XR post, ws/xr-post).** `renderer.resolve(target, out: GPUTextureView, viewport?:
  SceneTargetViewport)` runs `renderer.post` (or the built-in present) from any `SceneTarget`
  into any view now, inside the frame, after at least one `render`: what `endFrame` does from
  `renderer.target` to the swapchain. `viewport` confines the result to that rect of `out`
  (texture px) and loads the rest. The target is consumed: its next `render` this frame clears
  again, so one eye-sized HDR target serves both eyes in turn (`render(eye0) → resolve →
  render(eye1) → resolve`, all on the frame's one encoder). `PostProcessor.encode` gains the
  optional `viewport` and must size itself to the inputs it is given. The present group for a
  resolved target is cached, so steady state allocates nothing.

- **Logical space** is 1920×1080 by default, with the origin at top-left and y pointing down.
  `renderer.camera` is a matrix `Camera` (`Camera.ortho2d(1920, 1080)` by default); its
  `x`, `y`, `zoom` and `rotation` pan, zoom and turn the 2D view. See "Camera" below.
- **Draw order is `order`, then submission order.** Every draw takes an optional `order`
  (sort key, default 0), so by default draws render in submission order. Consecutive draws
  that use the same material and mesh merge into one instanced draw call, so draws batch best
  when grouped by material.
- **Layers.** Every draw takes `layers` (u32 mask, default 1). When `renderer.camera.layers`
  is set, draws with `layers & camera.layers === 0` are skipped; without it, all draw.
- **Depth is opt-in.** With `camera.depthTest = true` the scene pass gets a `depth24plus`
  attachment (allocated on first use), and draws sort by `order`, then opaque (front-to-back)
  before blended (back-to-front), by clip-space depth, so the sort agrees with the depth
  buffer. `camera.depthWrite` (off for `ortho2d`, on for `perspective`) lets opaque draws
  write depth. `frame.depthFormat` tells drawables which format to declare; `ParticleSystem`
  builds a depth pipeline per format from it.
- **The emissive target feeds bloom.** Anything written to it glows. The final image is
  colour + emissive + bloom.
- **Depth hooks (ws/render-hooks).** A drawable with `readsDepth: true` gets this frame's
  opaque depth: the view's scene pass is encoded as an opaque pass (`scene`), a copy of the
  depth attachment into `target.depthCopy`, the drawable's `afterOpaque(encoder, view)`, then
  a blended pass (`scene-blend`) that loads colour, emissive and depth. Without a hooked
  drawable a frame encodes exactly the passes it did before. `renderer.stats.passes` counts
  scene passes (two for a split view).
- In steady state the renderer allocates nothing per frame. The instance buffer doubles in
  size when it runs out of room. Reuse your `DrawParams` objects.

## Setup

```ts
import { boot } from '@thunderclap/engine/platform';
import { Renderer, installGpuErrorLogging } from '@thunderclap/engine/render';
import { PostStack } from '@thunderclap/engine/post';

const res = await boot(document.getElementById('app')!, { title: 'My Game' });
if (!res.ok) return; // unsupported screen already shown
installGpuErrorLogging(res.gpu.device);
const renderer = new Renderer(res.gpu); // 1920×1080 logical
renderer.post = new PostStack(renderer);
res.surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));
```

- `new Renderer(gpu: RendererGpu, opts?: RendererOptions)`. `RendererGpu` is `{ device, context,
  format }` (what `boot` returns as `res.gpu`); `RendererOptions` has `logicalWidth` and
  `logicalHeight` (1920×1080) and `initialInstances` (4096, doubles when full).
- `renderer.post` takes any `PostProcessor`: `resize(width, height)` and `encode(encoder, inputs,
  output)`, where `PostInputs` is `{ color, emissive, time, dt, depth, projection }`: `depth` is
  the target's depth texture and `projection` a `PostProjection` (`{ near, far, proj }`, `far`
  `Infinity` for an infinite far plane) when a depth camera rendered into it this frame, both
  `null` otherwise (the 2D path). `PostStack` is the engine's; a game writes its own only to
  replace the whole final stage.

## Drawing

```ts
const dp: DrawParams = { x: 960, y: 540, w: 200, h: 200 }; // quad: x,y = centre, w,h = size
const frame = renderer.beginFrame(time, dt);
frame.clear(0, 0, 0);
frame.sprite(null, dp);                       // default sprite: white texture × tint
dp.tint = hex('#3fe0ff', 2); dp.emissive = 1; // HDR tint, glows
frame.sprite(spriteMat, dp);
frame.mesh(myMesh, myMat, dp);                // custom geometry, same instance params
frame.drawable(particles);                    // anything implementing Drawable
renderer.endFrame();
```

`DrawParams` fields: `x, y, w, h, rotation` (radians, clockwise), `tint` (linear RGBA),
`uv` (u0, v0, u1, v1), `params` (a free vec4 passed to your shader), `emissive`, `uniforms`,
`layers` and `order`.

### Tile layers and flipbooks

```ts
const atlas = renderer.createSpriteMaterial(atlasTex, 'tiles', { sampler: 'nearest-clamp' });
const layer = createTileLayer(renderer, {
  material: atlas, tileW: 32, tileH: 32, columns: 60, rows: 34, atlas: { cols: 8, rows: 8 },
});
layer.fill(mapData);           // Int16Array | number[], row-major; -1 = empty
layer.set(col, row, 17);       // one atlas cell; -1 collapses the quad
layer.origin.x = -camX; layer.scale = 2;
layer.draw(frame, { order: -1 }); // one frame.mesh draw

const walk = createFlipbook({ frames: atlasFrames({ cols: 8, rows: 8 }, [0, 1, 2, 3]), fps: 10 });
walk.update(dt); dp.uv = walk.uv; frame.sprite(atlas, dp);
```

`createTileLayer(renderer, TileLayerOptions)` builds a `TileLayer`: one `Mesh` of
`columns × rows` quads authored in logical px (tile `(col, row)` spans `col × tileW ..`), whose
UVs select a cell of the atlas grid (indices row-major). `set(col, row, tileIndex | -1)`, `get`,
`fill(tiles)` rewrite tiles in a preallocated vertex array; `draw(frame, params?)` uploads only
the dirty tile range (one `writeBuffer`) and records one `frame.mesh` draw at `origin` (top-left
corner, mutate in place) and `scale`, carrying `params` (tint, order, layers, emissive, params,
uniforms, shadow flags) on the layer's own `DrawParams`. `count` is the non-empty tiles; `mesh`
and `destroy()` are there. Nothing is allocated per frame, and `frame.draw` itself is unchanged.

**Painter mode, diamonds, elevation, depth keys** (ws/ergo-2d-2). `order: 'painter'`
(`TileLayerOrder`; `'grid'` is the default above and untouched) builds one mesh per diagonal
`col + row` (`meshes`, `columns + rows - 1` of them; `mesh` is the first) and `draw` records the
non-empty bands back to front at `order = (params.order ?? 0) + col + row`, so the layer occupies
`base .. base + columns + rows - 2` in the frame's order. `elevation: (col, row) => steps` is
read when a tile is set or filled and lifts its quad `elevH × steps` px (`elevH` defaults to
`iso.elevH` with `diamond`, else `tileH / 2`); `elevationAt(col, row)` reads it back and
`refresh(col?, row?)` re-reads one tile or all of them when the map's heights change (only the
quads that moved upload). `diamond: true` with `iso: Iso` (from `./geom`'s `createIso`) lays
each `tileW × tileH` quad on the lattice with the diamond centre `iso.toScreen(col, row, elev)`
at `(tileW / 2, iso.tileH / 2)` from its top-left, so a cell taller than `iso.tileH` hangs a wall
under its top. A tile's painter's key is `depthOf(tx, ty, elev?)` = `tx + ty + elev ×
ISO_ELEV_DEPTH`, the same number as `Iso.depth`; the tiles of one diagonal never overlap, so a
sprite between tiles is one `frame.sprite` after `layer.draw`:

```ts
const iso = createIso({ tileW: 64, tileH: 32, elevH: 16, originX: 960, originY: 200 });
const map = createTileLayer(renderer, {
  material, tileW: 64, tileH: 64, columns: 12, rows: 12, atlas: { cols: 2, rows: 2 },
  order: 'painter', diamond: true, iso, elevation: (tx, ty) => heights[ty * 12 + tx],
});
map.draw(frame, { order: 100 });
iso.toScreen(tx, ty, elev, dp);                       // the sprite's feet
dp.order = 100 + map.depthOf(tx, ty, elev);           // over its tile, under the next band
frame.sprite(material, dp);
```

Fractional `tx`, `ty` work (a walker between two tiles sorts between their bands); an integer key
ties with its band and wins by submission order.

### Parallax

```ts
const sky = createParallax(renderer, [
  { layer: far, factorX: 0.2, factorY: 0.2, wrapW: 8 * 60 },
  { layer: hills, factorX: 0.5, factorY: 0.5, wrapW: 6 * 60, params: { tint } },
  { layer: trees, factorX: 0.8, factorY: 0.8, wrapW: 5 * 60 },
]);
sky.update(camera.x, camera.y); // once per frame, after the camera moved
sky.draw(frame);                // far to near, one layer.draw each
```

`createParallax(renderer, ParallaxLayerOptions[])` builds a `Parallax` over tile layers
(ws/ergo-2d-2). `update(cameraX, cameraY)` (the ortho2d camera's `x`, `y`: the view's top-left)
sets each layer's `origin` to its base (the origin it had when the parallax was made) plus
`parallaxOffset(camera, factor, wrap?)`: `camera × (1 - factor)` (0 pins the layer to the view,
1 moves it with the world), or with a `wrapW` / `wrapH` pattern period `camera - (camera × factor
mod wrap)`, which stays within one period behind the camera so a strip a little wider than the
view plus one period covers any scroll. `layers` lists the `ParallaxLayer`s (the options plus
`baseX`, `baseY`, `offsetX`, `offsetY`); `draw(frame)` draws them in order with their `params`;
`destroy()` destroys the layers. No allocation per frame.

### 2D camera follow

```ts
const camera = Camera.ortho2d(1920, 1080);
renderer.camera = camera;
const follow = createFollow2D(camera, {
  deadZone: { w: 400, h: 200 }, lookAhead: { x: 160, y: 0 }, lookAheadSmoothing: 0.3,
  smoothing: 0.15, bounds: { minX: 0, minY: 0, maxX: level.w, maxY: level.h },
});
follow.update(dt, hero.x, hero.y, hero.vx, hero.vy); // each fixed step
follow.teleport(spawn.x, spawn.y);                     // a respawn: no easing
```

`createFollow2D(camera: Follow2DCamera, Follow2DOptions)` builds a `Follow2D` (ws/ergo-2d-2),
the platformer camera: it writes `camera.x` and `camera.y` only (an ortho2d `Camera`'s pan
setters: the view's top-left in design px) and reads `camera.screen` and `camera.zoom` for the
view size. Each `update(dt, targetX, targetY, velX?, velY?)` moves the anchor just enough to keep
the target inside `deadZone` (`{ w, h }` world px around it; a target inside it moves nothing),
eases the look-ahead toward `sign(vel) × lookAhead` with time constant `lookAheadSmoothing`
(default 0.25 s; 0 is instant), eases the view centre toward `anchor + lookAhead` with
`smoothing` (default 0: instant), clamps the view rect inside `bounds` (`Follow2DBounds`; a
view wider than the bounds is centred; `follow.bounds` is live) and writes the camera. Every
easing is `1 - exp(-dt / tau)`, so two half steps equal one whole one. `snapOnStart` (default
true) makes the first `update` a `teleport(x, y)`, which puts the anchor and the view at a point
with no easing and no look-ahead. `x`, `y` are the view centre, `anchorX`, `anchorY` the dead
zone's centre, `lookX`, `lookY` the current look-ahead; `deadZone`, `lookAhead`,
`lookAheadSmoothing` and `smoothing` are live.

`createFlipbook(FlipbookOptions)` builds a `Flipbook`: pure timing over `frames: readonly UvRect[]`
(`UvRect` is `[u0, v0, u1, v1]`, what `DrawParams.uv` takes) at `fps` (default 12), `loop`
(default true). `update(dt)` advances; `uv` and `frame` are the current frame; a non-looping book
holds its last frame and sets `done`; `reset()` and `play(frames?)` start over. `fps` and `loop`
are live. `atlasFrames({ cols, rows }, indices?)` lists a grid atlas's cells as `UvRect`s (every
cell row-major, or those indices in order); it allocates, so call it at load time.

### Transforms

```ts
const ship = new Transform({ x: 960, y: 540, scaleX: 64, scaleY: 64 });
const turret = new Transform({ x: 0.3, parent: ship }); // local to the ship
ship.rotation += dt;                                     // radians about +Z
frame.sprite(shipMat, ship, { tint });                   // InstanceParams: no x/y/w/h
frame.sprite(turretMat, turret);
frame.mesh(cube, litMat, cubeT.setAxisAngle(0, 1, 0, t)); // 3D rotation (quaternion)
```

A `Transform` has position xyz, a rotation (`rotation` about Z for 2D, or
`setQuaternion` / `setAxisAngle` for 3D), scale xyz and an optional parent. Its `world` is a
cached 3×4 row-major matrix that recomputes only when it or an ancestor changed. The quad
spans -0.5..0.5, so a transform's scale is the sprite's size.
`transform.position`, `scale` (`ReadonlyVec3`) and `quaternion` (`ReadonlyQuat`) are
read-only views; set them through the transform's setters.
`Transform.setMatrix(m)` takes a raw 3×4 (sockets write through it); later setters rebuild
T·R·S from the decomposed values.

`frame.mesh(...)` also carries the mesh's bounding sphere (`mesh.bounds`) through the instance
matrix into a world sphere: the centre by the matrix, the radius by the largest axis scale
(column length), so rotation and non-uniform scale stay conservative. A camera with `cull`
tests that sphere against its frustum. `frame.sprite(...)` records no sphere; sprites are
never culled.

### Drawing many things

Three ways to draw many instances of one mesh and material (ws/batch-submit; `docs/BENCH.md`
has their numbers):

```ts
// 1. frame.mesh: one call per instance, each with its own Transform and InstanceParams.
for (const t of transforms) frame.mesh(cube, lit, t, { tint });

// 2. frame.meshes: one call per batch; the game owns the typed arrays.
const batch: InstanceBatch = {
  count: n,
  matrices: new Float32Array(n * MATRIX3X4_FLOATS), // 3×4 row-major, 12 floats each
  params: new Float32Array(n * INSTANCE_PARAM_FLOATS), // uv, tint, params, emissive, flags, size
  bounds: null, // a world sphere: one cull test for the batch; null: per instance
};
writeInstanceParams(batch.params, i * INSTANCE_PARAM_FLOATS, { tint }, sizeX, sizeY);
frame.meshes(cube, lit, batch);

// 3. frame.list: a retained list in its own GPU buffer; set/remove by index.
const list = renderer.createInstanceList(cube, lit, 50_000);
list.set(list.count, transform, { tint }); // appends; set(i, matrix | Transform, params?)
const moved = list.remove(i); // swap-remove: the old last index now lives at i (or -1)
frame.list(list);
```

- `frame.mesh` for anything that changes shape every frame and needs per-draw uniforms,
  blending order per instance or a different material each. The renderer copies each instance
  into the shared buffer, culls and depth-sorts it on its own.
- `frame.meshes` when the game already keeps its instances in typed arrays (a simulation, a
  chunk of a world): the matrices and `params` (`INSTANCE_PARAM_FLOATS` floats each, in the
  instance format from `uvRect` on; null for the defaults, with size from the matrix's column
  lengths) are copied straight into the frame's upload with no per-instance objects. The batch
  is one sort key (`order`, then the depth of its `bounds` centre or first instance) and one
  draw; without `bounds` each instance is culled through the mesh's sphere (the same test
  `frame.mesh` makes) over the typed array, allocating nothing; with `bounds` the batch is
  culled as a whole and no instance is tested (`stats.culled` then adds `count`). `layerBits`
  and `castShadow` (default: 3D layouts yes) apply to the batch; the shadow pass draws it.
- `frame.list` when most instances stay the same from frame to frame (scenery, a crowd that
  moves a little): `InstanceList` keeps `matrices` and `params` on the CPU and the instance
  format in its own vertex buffer, tracks the dirty index range (`set`, `remove`, `touch(i)`
  after writing the arrays directly; `dirty`) and uploads only that range once per frame when
  `frame.list` records it, so an unchanged list costs no CPU and no `writeBuffer`. It is
  culled as one unit by `bounds`: computed from the mesh sphere through every instance when
  they change (null for a mesh without bounds), or fixed by `setBounds(sphere | null)`.
  `clear()`, `capacity`, `layerBits`, `order`, `castShadow`, `destroy()`.

A batch or list cannot use a material with `perDrawUniforms` (both throw). `stats.batches`
counts the batches and lists drawn; `stats.instances` counts their instances too.

### Instance format (28 floats, 112 bytes)

| floats | WGSL `VertexIn` | content |
| --- | --- | --- |
| 0..11 | `m0`, `m1`, `m2` (@location 3..5) | 3×4 world matrix rows |
| 12..15 | `uvRect` (@6) | u0, v0, u1, v1 |
| 16..19 | `tint` (@7) | linear RGBA |
| 20..23 | `params` (@8) | free vec4 |
| 24..27 | `misc` (@9) | emissive, flags (bit 0 = does not receive shadow, bits 1..23 = the instance's layer mask, packed by `packInstanceFlags`; the rest reserved), size.x, size.y |

`INSTANCE_OFFSET` names these offsets. A custom vertex entry that wraps `engine_vertex(v)`
needs no change; one that read the old 20-float fields (`v.xform`, the old `v.misc`, or the
old locations of `uvRect`/`tint`/`params`) must switch to `engine_world_position(v)` or the
matrix rows.
`INSTANCE_FLOATS` (28) and `INSTANCE_STRIDE` (112) size one instance, and
`INSTANCE_BUFFER_LAYOUT` is its vertex buffer layout (locations 3..9, step mode instance), for
a `Drawable` that builds its own pipeline over the shared instance format.

## Camera

`Camera` holds `view`, `projection` and `viewProjection` (column-major `Float32Array(16)`,
built with `mat4` from `@thunderclap/engine/core`), cached until something changes. The renderer
uploads `renderer.camera` to the camera block every frame.

```ts
import { Camera } from '@thunderclap/engine/render';

const cam = renderer.camera;               // Camera.ortho2d(1920, 1080): 1 unit = 1 design px
cam.x = 120; cam.zoom = 1.5;               // the 2D controls, as before
cam.fitRect({ x: 0, y: 0, width: 800, height: 600 },     // frame a world rect…
            { x: 400, y: 0, width: 1520, height: 1080 }); // …into part of the screen
const p = surface.clientToLogical(e.clientX, e.clientY);
const world = cam.screenToWorld(p.x, p.y, 0, hit);        // touch aiming; pass `out` per frame

const eye = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 500).lookAt([0, 4, 10], [0, 0, 0]);
eye.setViewMatrix(xrView.transform.inverse.matrix); // or: a view matrix from elsewhere (XR)
eye.screen.width = 1920; eye.screen.height = 1080;      // screen units for worldToScreen
renderer.render(frame, eye);                              // or renderer.camera = eye
```

- `worldToScreen(x, y, z?)` returns screen units (the `screen` rect; the design space for
  `ortho2d`) and clip depth in `z`. `screenToWorld(sx, sy, depth?)` inverts it; depth 0 and 1
  give a pick ray.
- `ortho2d` looks down +z: larger z is farther, and world z in ±`ORTHO2D_HALF_DEPTH` (1024)
  survives the near and far planes (z = 0 is clip depth 0.5). x and y are the old 2D camera's.
- `setView(m)` / `setViewMatrix(m)` take a world → view matrix as is (`setViewMatrix` is the
  name `XrSurface` uses for an `XRView`'s `transform.inverse.matrix`); `setProjection(m)` the
  projection (an `XRView.projectionMatrix`), raw: no flag changes. `setPerspective(fovY,
  aspect, near, far)` replaces the projection *and* turns `depthTest`, `depthWrite` and `cull`
  on, exactly what `Camera.perspective` does (ws/camera-ergo), so `renderer.camera.setPerspective(…)`
  on the default 2D camera renders like a fresh perspective one. `viewIndex` is the
  `view_index` the camera block carries (eye 0 / 1 in XR).
- `depthTest` and `depthWrite` (off for `ortho2d`, on for `perspective`) and the `layers` mask
  (u32, default all bits; `sees(mask)`) drive the render call's depth attachment and draw sort.
- Per-frame helpers, none allocating (ws/camera-ergo): `viewZ(x, y, z)` is the view-space
  depth of a world point, positive in front of the eye (the negated third row of `view`; for
  `ortho2d`, which looks down +z, it is `-z` at rest). `invViewProj` is `viewProjection⁻¹`,
  column-major, cached and recomputed lazily after any view or projection change (identity
  if singular; `screenToWorld` reads it). `projectMany(points, out, count?, stride = 3)`
  is `worldToScreen` over `count` points at `points[i * stride]`, writing screen x, screen y
  and clip depth as 3 floats per point into `out`, and returns how many landed inside the
  viewport (in front of the eye, within `screen`, depth 0..1); project every HUD label or
  billboard in one call. `frustumCorners(out)` fills 24 floats with the eight world-space
  corners from `invViewProj`: near plane then far, each bottom-left, bottom-right, top-right,
  top-left in clip space (an infinite far plane yields directions, not points).
- `cull` (off for `ortho2d`, on for `perspective`) turns frustum culling on for the render
  call. `frustum` is the six planes of `viewProjection` as one flat `Float32Array` of
  `FRUSTUM_FLOATS` (24): left, right, bottom, top, near, far, each `(a, b, c, d)` with a unit
  normal pointing inwards, cached like the matrices. `seesSphere(x, y, z, radius)` tests a
  world sphere against them (true when it touches the frustum); the renderer runs the same
  test per draw on the flat array, so a frame culls without allocating. An infinite far plane
  (`perspective(..., Infinity)`) never rejects.
- A 2D game frames the space the UI leaves (`ui.layout.freeRect`, CSS px) with
  `cam.fitRect(worldRect, viewportInLogicalPx)`; convert the rect's corners with
  `surface.clientToLogical`.
- `CameraRect` (`x`, `y`, `width`, `height`, y down) is the type of `screen` and of the
  `fitRect`/`fitFreeRect` arguments; `CameraPoint` (`x`, `y`, `z`) is what `worldToScreen` and
  `screenToWorld` fill. `ALL_LAYERS` (`0xffffffff`) is the default `layers` mask.

## Lighting

The engine supplies the lights; the style is your WGSL. `frame.lights` is a `Lights` (ambient
rgb, one `sun { dir, color }`, `points: PointLight[]` with `position`, `color`, `radius`, the
first `MAX_POINT_LIGHTS` = 16 uploaded, `spots: SpotLight[]`, the first `MAX_SPOT_LIGHTS` = 8
uploaded, each light with an optional `layers` mask) that the renderer writes as `EngineLights` at
`@group(0) @binding(2)` with every view, in the same upload as the globals and the camera. The
default is unlit (ambient 1, no sun, no points), so a material that never reads the block, or
one that multiplies by `engine_lambert`, draws exactly as before until the game sets lights.

```ts
const lights = new Lights();                       // or mutate frame.lights in place
lights.ambient.set([0.18, 0.18, 0.2]);
lights.sun.dir = [-0.45, -1, -0.65];              // the direction the light travels; normalised on upload
lights.sun.color = [0.8, 0.8, 0.78];
const lamp = { position: new Float32Array(3), color: [1.6, 0.9, 0.4], radius: 5 };
lights.points.push(lamp);                         // keep the object; move lamp.position per frame
frame.lights = lights;                            // once; the Frame persists
```

```wgsl
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * engine_lambert(n, in.worldPos), 1.0);  // ambient + sun + points
  o.emissive = vec4f(0.0);
  return o;
}
```

In WGSL the block is `lights.ambient`, `lights.point_count` (u32), `lights.sun_dir`
(normalised), `lights.sun_color` and `lights.points[i].position / radius / color`.
`engine_point_lights(n, p)` sums the point lights' Lambert diffuse with a `(1 - d/radius)²`
falloff; `engine_lambert(n, p)` adds the ambient and the sun (and the spot lights: it is the
shared `wgslLightLoop` under "Spot lights and layer masks"). Toon, rim or wrapped lighting
reads the same fields and ignores the helpers. `Lights.writeBlock(f32, u32, offset, shadow?)`
is the CPU layout (`LIGHTS_BLOCK_FLOATS` = 316 floats; `POINT_LIGHTS_OFFSET_FLOATS`,
`POINT_LIGHT_FLOATS`, `SUN_VIEW_PROJ_OFFSET_FLOATS`, `SHADOW_PARAMS_OFFSET_FLOATS`,
`FOG_OFFSET_FLOATS`, `LAYERS_OFFSET_FLOATS`, `POINT_LAYERS_OFFSET_FLOATS`,
`SPOT_LIGHTS_OFFSET_FLOATS`, `SPOT_LIGHT_FLOATS`), and allocates nothing; `lights.reset()`
returns to the unlit default.
Drawables that want the block add `WGSL_LIGHTS` to their shader (it also declares bindings 3
and 4 below); `renderer.globalsLayout` already has bindings 2 to 4.
`lights.sun` is a `DirectionalLight`: `dir` (the direction the light travels, any length),
`color` (linear RGB; all zero means no sun) and `shadow`.

### Shadows

`lights.sun.shadow` (a `SunShadow`, default `null`) turns on one shadow map for the sun:
`extent` (half-width of the orthographic box, world units, centred on the camera's position),
optional `size` (1024, 2048 or 4096 texels; `DEFAULT_SHADOW_SIZE` = 2048), `near`/`far` (depth
along the light from the camera position; default `-extent..extent`) and `bias` (NDC depth;
`DEFAULT_SHADOW_BIAS` = 0.0015). With it set, every `render` whose frame has an opaque caster
encodes a depth-only pass (`'shadow'`, before the `'scene'` pass) over the view's draws through
the same `engine_vertex` as the scene, then binds the map as `engine_shadow_map`
(the shadow list is culled against the sun's box, not the view frustum, so an off-screen caster
on the camera's layers still shadows what the view sees; it is sorted by mesh then material,
its instances are uploaded after the scene's, and `renderer.stats.shadowDraws` counts them)
(`texture_depth_2d`, `@group(0) @binding(3)`) with the comparison sampler
`engine_shadow_sampler` (`@binding(4)`). Until the first shadow pass a 1×1 depth placeholder is bound (afterwards the last map stays bound and `shadow_params.z` = 0 makes `engine_shadow` return 1), so
one bind group layout serves both. The block gains `lights.sun_view_proj` (`mat4x4f`) and
`lights.shadow_params` (bias, texel size, enabled, -).

- `engine_shadow(world_pos) -> f32`: 0 in shadow, 1 lit, 3×3 PCF; 1 outside the box or when no
  shadow was rendered. `engine_lambert` multiplies the sun term by it, so a material that uses
  `engine_lambert` is shadowed with no change.
- `InstanceParams.castShadow`: default true for meshes in a 3D vertex layout and false for
  `VERTEX_LAYOUT_2D` sprites and quads, so a 2D scene never renders a shadow pass; blended
  materials never cast. `InstanceParams.receiveShadow: false` sets instance flag bit 0, read as
  `in.flags & 1u` in the fragment shader (`VSOut.flags`); the engine helpers do not read it.
- `ShadowMap` (`SHADOW_FORMAT` = `depth32float`) is the renderer's piece: `view` (the map's
  view, or the placeholder before a pass has rendered), the sampler, `sunCamera`, `place(center, sunDir, shadow, size)`,
  `pipelineFor(layout)` and `ShadowUniforms` (`viewProj`, `bias`, `texelSize`), what
  `writeBlock` takes as its fourth argument. Games set `lights.sun.shadow`; the renderer's
  instance is private, so a drawable that renders its own shadow pass builds its own `ShadowMap`.

### Spot lights and layer masks

`lights.spots` holds `SpotLight`s: `position`, `direction` (the way the light travels, any
length; normalised on upload), `color`, `radius` (distance falloff, as for points),
`innerAngle` and `outerAngle` (radians from the axis: full inside the inner, gone outside the
outer, a smooth Hermite step between; `spotCone(cosTheta, cosOuter, cosInner)` is the CPU twin
of `engine_spot_cone`). The first `MAX_SPOT_LIGHTS` = 8 reach the shader as `lights.spots[i]`
(`position`, `radius`, `direction`, `cos_outer`, `color`, `cos_inner`, `layers`) with
`lights.spot_count`.

Every light takes an optional `layers` mask (u32; default `ALL_LIGHT_LAYERS` = all bits):
`DirectionalLight.layers` (`lights.sun_layers`), `PointLight.layers` (`lights.point_layers`,
an `array<vec4u, 4>`: the mask of point `i` is `point_layers[i >> 2u][i & 3u]`) and
`SpotLight.layers`. A light reaches an instance when the two masks share a bit, against the
instance's `InstanceParams.layers` (the same mask the camera culls by). The instance's low
`INSTANCE_LAYER_BITS` = 23 layer bits travel in the instance flags float above the shadow bit
(`packInstanceFlags(receiveShadow, layers)`, `INSTANCE_LAYER_SHIFT` = 1), so a fragment shader
reads them as `engine_instance_layers(in.flags)`; layers above bit 22 still cull but are
invisible to lights.

- `engine_light_accum(world_pos, normal, layer_mask) -> vec3f`: the sun (× `engine_shadow`),
  point and spot Lambert terms of every light whose mask shares a bit with `layer_mask`; no
  ambient. Custom WGSL (toon) builds on it.
- The loop is generated, not hand-written, and shared: `wgslLightLoop(name, brdf, params?)`
  returns the WGSL of `fn name(world_pos, normal, layer_mask[, params]) -> vec3f` that walks
  the sun (× shadow), the points (`(1 - d/radius)²`) and the spots (× cone), skipping lights
  whose mask misses `layer_mask`, and multiplies each light's colour by the expression `brdf`,
  which may use `normal`, `l` (the unit vector to the light), the function's own parameters and
  anything in scope, and must evaluate to a `vec3f` (WGSL has no function pointers, so the
  BRDF is inlined once per light kind). `engine_light_accum` is
  `wgslLightLoop('engine_light_accum', WGSL_LAMBERT_BRDF)` with `WGSL_LAMBERT_BRDF` =
  `'vec3f(max(dot(normal, l), 0.0))'`; the standard material's `engine_pbr_accum` is the same
  generator over `engine_brdf`, so a light the Lambert path sees, the PBR path sees. A custom
  BRDF prepends its own instance (`wgslLightLoop('my_accum', 'my_brdf(normal, l, v)', ', v: vec3f')`)
  under a name the prelude does not use.
- `engine_lambert_layers(normal, world_pos, layer_mask)`: ambient + `engine_light_accum`.
- `engine_lambert(normal, world_pos)`: the same over every layer (`0xffffffffu`), so a material
  that ignores masks keeps its two-argument call; `engine_point_lights` likewise sums every
  point light.

```ts
lights.spots.push({ position: [0, 5, 3], direction: [0, -1, 0], color: [3, 2.6, 1.8],
  radius: 12, innerAngle: 0.18, outerAngle: 0.3 });              // a torch cone
lights.points.push({ position: [0, 3, -1], color: [2.4, 2, 1.5], radius: 7, layers: 0b10 });
frame.mesh(cube, lit, t, { layers: 0b10 });                      // only this cube sees the lamp
```

```wgsl
let light = engine_lambert_layers(n, in.worldPos, engine_instance_layers(in.flags));
```

`harness/lights.html` sweeps a spot over the ground beside two cubes on different layers with a
point light masked to one of them; `e2e/lights.spec.ts` samples both effects on the matrix.

### Fog

`lights.fog` is a `Fog`: `color` (linear RGB), `density` (0, the default, is no fog), `near`
and `far` (distance from the camera position). With `far > near` the fog is linear from `near`
to `far` scaled by `density` (≤ 1); otherwise it is exponential, `1 - exp(-density × (d -
near))`. In WGSL the block has `lights.fog` (rgb, density) and `lights.fog_range` (near, far),
and `engine_fog(color, world_pos) -> vec3f` mixes `color` towards the fog colour; it is the
identity at density 0, and materials call it on their final colour (the engine does not).

```ts
lights.sun.shadow = { extent: 20, size: 2048 };
lights.fog = { color: [0.6, 0.65, 0.75], density: 1, near: 6, far: 24 };
```

```wgsl
o.color = vec4f(engine_fog(albedo * engine_lambert(n, in.worldPos), in.worldPos), 1.0);
```

### Skinning

`VERTEX_LAYOUT_SKINNED` is the 3D layout plus four joint indices and four weights per vertex:
`VERTEX_SKINNED_FLOATS` = 14 (`VERTEX_SKINNED_STRIDE` = 56 bytes): the 12 floats of
`VERTEX_LAYOUT_3D`, then joints as `uint8x4` at byte `SKIN_JOINTS_BYTE_OFFSET` (48, `@location(11)
joints: vec4u`) and weights as `unorm8x4` at `SKIN_WEIGHTS_BYTE_OFFSET` (52, `@location(12)
weights: vec4f`); `VERTEX_SKINNED_BUFFER_LAYOUT` is its `GPUVertexBufferLayout`. Write the two
packed words through a byte view, not as floats: `setVertexSkin(bytes, vertex, joints, weights)`
normalises the weights so the four bytes sum to 255. `VertexLayout.skinned` marks such a layout.

A `SkinPalette(device, { joints, instances?, label? })` (`SkinPaletteDesc`) is the storage buffer
the vertex shader reads: a 16-byte header (`SKIN_PALETTE_HEADER_FLOATS` = 4: joints per instance,
instances) and then `instances × joints` joint matrices of `JOINT_FLOATS` = 12 floats each, the
3×4 row-major affine layout the instance matrix and `anim`'s `skinMatrices` (world × inverse
bind, one per joint) use, so an `anim` output goes in with one call. `palette.set(slot, matrices,
offset = 0)` copies one instance's block into CPU staging (`palette.offsetOf(slot)` is its float
offset; `setIdentity(slot)` is the bind pose, every slot's initial state), and `palette.flush()`
uploads the dirty slot range in one `writeBuffer`, once per frame, allocating nothing
(`isDirty` says whether it would; `destroy()` frees the buffer). Bind it to the material as a
storage buffer: `createMaterial({ ..., buffers: [palette.buffer] })` (`BindingDesc.buffers`:
read-only storage buffers at `@group(1) @binding(BUFFER_BINDING_BASE + i)`, `BUFFER_BINDING_BASE`
= 16, in the same group as the material's uniform and textures; `BindingSet.setBuffer(slot,
buffer)` swaps one later). The palette is slot 0, `SKIN_PALETTE_BINDING` = 16; a material has one
palette, and two skinned materials take two palettes or share one buffer.

A draw names its palette slot in `InstanceParams.params[3]` (`params.w`, read as `u32`;
`SKIN_PARAM` = 3 names the index, ws/ergo-3d); several draws may share a slot.
`createStandardMaterial(renderer, { skin: palette })` (a `SkinPalette` or its `GPUBuffer`) binds
the palette as `buffers[0]`, so a skinned PBR character needs no custom WGSL. For a skinned layout `materialPrelude` emits `WGSL_SKIN` after `VertexIn`:
the `engine_skin_palette` binding and `engine_skin(v, position, normal) -> EngineSkinned`
(`position`, `normal`), the four weighted joint matrices applied in object space before the
instance matrix; the layout's `engine_local_position` / `engine_local_normal` call it, so
`engine_vertex`, `vs_main` and every `fs_main` are unchanged and the 2D and 3D preludes keep
their exact text. The shadow pass builds its depth pipeline from the same prelude, so a skinned
caster's shadow pipeline skins too: for a skinned layout its pipeline layout holds the material
group as group 1 and the pass binds it, so a skinned caster's shadow follows the pose. `harness/skin.html` drives two tubes, 24 rings over three joints, from one
palette; `e2e/skin.spec.ts` checks the tip moves.

```ts
const palette = new SkinPalette(renderer.device, { joints: 3, instances: 2 });
const mat = renderer.createMaterial({ wgsl, blend: 'opaque', buffers: [palette.buffer] });
const mesh = renderer.createMesh({ vertices, indices, layout: VERTEX_LAYOUT_SKINNED });
// each frame
palette.set(0, skinMatrices0);
palette.flush();
frame.mesh(mesh, mat, transform, { params: [0, 0, 0, 0] });
```

## Standard material

A metallic-roughness PBR material a game uses without writing WGSL, the glTF 2.0 model: GGX
distribution, height-correlated Smith visibility, Schlick Fresnel, Lambert diffuse, lit by the
frame's `Lights` (ambient, sun with its shadow map, point lights, spot lights, per-light layer
masks, fog) in the same units as `engine_lambert`: the lights run through the same generated
loop (`wgslLightLoop`) as the prelude's Lambert helpers, with the GGX BRDF in place of N·L.

```ts
import { createStandardMaterial } from '@thunderclap/engine/render';

const skin = createStandardMaterial(renderer, {
  baseColor: albedoTex,         // sRGB; default 1×1 white
  metallicRoughness: mrTex,     // G roughness, B metallic (glTF); default white
  metallic: 0, roughness: 0.6,  // factors multiplied into the map
  normal: normalTex,            // tangent space, +Y up (OpenGL / glTF); default flat
  occlusion: aoTex,             // R; default white
  emissive: glowTex, emissiveFactor: [1, 1, 1],
  alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true,
});
frame.mesh(mesh, skin, transform, { tint: [1, 0.9, 0.8, 1] });
```

- `createStandardMaterial(renderer, desc: StandardMaterialDesc): Material` returns an ordinary
  `Material` (`setUniforms`, `setTexture`, `perDrawUniforms` off). Every field of the desc is
  optional; `label` defaults to `'standard'`. Defaults: `baseColorFactor` [1,1,1,1], `metallic`
  0, `roughness` 0.5, `normalScale` 1, `alphaCutoff` 0.5, `emissiveFactor` [1,1,1] when an
  `emissive` map is given and [0,0,0] otherwise, `alphaMode` `'opaque'`, `doubleSided` false.
- Per-instance: `tint` multiplies the base colour (and vertex colour), `uv` picks the sub-rect
  of every map, `emissive` adds `base × emissive` to the emissive target, `receiveShadow` and
  `castShadow` as for any material.
- Maps are sampled with `'linear-mip-repeat'` (trilinear when the map has mips). Missing maps
  bind the device's `defaultTextures`: `white` for base colour, metallic-roughness and
  occlusion (sRGB 255 reads 1.0, so the factors pass through), `flatNormal` and `black` for
  emissive; nothing is created per material or per renderer.
- Lights reach an instance by its `InstanceParams.layers` (`engine_instance_layers(in.flags)`),
  as for `engine_lambert_layers`: a lamp with `layers: 0b10` lights only the instances on
  layer 2.
- `alphaMode: 'mask'` discards below `alphaCutoff` (the shadow pass has no fragment stage, so
  a masked object still casts its whole silhouette); `'blend'` uses `blend: 'alpha'`, so it
  draws after the opaque draws, writes no depth and casts no shadow. `doubleSided` flips the
  normal on back faces; materials never cull, so single-sided only changes the lighting.
- Tangents come from screen-space derivatives (`dpdx` / `dpdy` of world position and uv), so
  `VERTEX_LAYOUT_3D` (which has no tangent slot) and any mesh without tangents normal-map as is.
- `STANDARD_WGSL` is the fragment shader (entry `fs_main`); `STANDARD_TEXTURE_SLOTS` names the
  five texture slots (`baseColor` 0 … `emissive` 4, at `@group(1) @binding(2 + slot)`);
  `packStandardUniforms(desc, out?)` fills the `STANDARD_UNIFORM_FLOATS` (12) block the shader
  reads: base rgba, metallic, roughness, normal scale, alpha cutoff, emissive rgb, flags
  (1 double-sided, 2 mask, 4 blend). Pass the packed block to `material.setUniforms` to change a
  factor later.
- `WGSL_PBR` is the helper text a custom material can prepend to its own WGSL:
  `engine_pbr(base, metallic, roughness, n, v, world_pos, ao, emissive) -> vec3f` (lit, fogged
  colour, every layer), `engine_pbr_layers(..., layer_mask)` (the same, lit only by the lights
  sharing a bit with the mask), `engine_pbr_accum(world_pos, n, layer_mask, v, diffuse_color,
  f0, a2, n_dot_v)` (the generated light loop over `engine_brdf`, no ambient), `engine_brdf`,
  `engine_d_ggx`, `engine_v_smith_ggx`, `engine_f_schlick` and
  `engine_perturb_normal(n, world_pos, uv, map_texel, scale)`.

`harness/pbr.html` draws a 5×5 metallic × roughness sphere grid through one material, a
normal-mapped tile from a procedural height map, a spot light on the floor and a pair of
spheres on different layers beside a lamp masked to one of them; `e2e/pbr.spec.ts` checks the
highlight, the bump, the spot's cone and the mask on every matrix row.

## Custom materials

A material is your WGSL fragment shader plus an optional uniform block and textures. The
engine prepends a prelude that provides:

- `globals`: `logicalSize`, `targetSize`, `time`, `dt` at `@group(0) @binding(0)`
- `camera`: `view`, `proj`, `view_proj` (world → clip), `camera_pos`, `viewport` (scene target
  px), `view_index` (from `camera.viewIndex`) and `inv_view_proj` (clip → world, the inverse
  of `view_proj`: `camera.invViewProj`, at float `CAMERA_INV_VIEW_PROJ_OFFSET` = 60 of the
  `CAMERA_BLOCK_FLOATS` block, for reconstructing world positions from depth) at
  `@group(0) @binding(1)`
- `lights`: `ambient`, `point_count`, `sun_dir`, `sun_color`, `points[16]` (`position`,
  `radius`, `color`), `sun_view_proj`, `shadow_params`, `fog` and `fog_range` at
  `@group(0) @binding(2)`, the sun's shadow map `engine_shadow_map` and comparison sampler
  `engine_shadow_sampler` at bindings 3 and 4, with `engine_lambert(normal, world_pos)`,
  `engine_point_lights(normal, world_pos)`, `engine_shadow(world_pos)` and
  `engine_fog(color, world_pos)`. See "Lighting" above.
- noise helpers: `engine_hash21`, `engine_hash22`, `engine_noise`, `engine_fbm(p, octaves)`,
  `engine_luma`
- `VSOut { clip, uv, local, color, params, world, emissive, size, normal, worldPos, flags }`,
  where `local` is 0..1 across the quad, `world` is the logical position (xy), `normal` is the
  world-space normal (`(0, 0, -1)` for 2D meshes), `worldPos` the world xyz and `flags` the
  instance flag bits (bit 0: `receiveShadow: false`)
- `engine_local_position(v)`, `engine_local_normal(v)`, `engine_world_position(v)` and
  `engine_vertex(v)`, the same for every vertex layout
- `FragOut { color: @location(0), emissive: @location(1) }`
- the default vertex shader `vs_main`

You write `@fragment fn fs_main(in: VSOut) -> FragOut`. Your own bindings go in `@group(1)`:
`binding(0)` is the uniform block, `binding(1)` the sampler, and `binding(2 + i)` texture i.

```ts
const orb = renderer.createMaterial({
  label: 'orb',
  blend: 'alpha',            // 'alpha' | 'premultiplied' | 'additive' | 'multiply' | 'opaque'
  uniformBytes: 16,          // optional
  textures: 1,               // optional
  sampler: 'linear-clamp',   // 'linear-repeat' | 'nearest-clamp'
  wgsl: /* wgsl */ `
    @group(1) @binding(0) var<uniform> u: vec4f;
    @group(1) @binding(1) var samp: sampler;
    @group(1) @binding(2) var tex: texture_2d<f32>;
    @fragment fn fs_main(in: VSOut) -> FragOut {
      let r = length(in.local * 2.0 - 1.0);
      var o: FragOut;
      o.color = vec4f(in.color.rgb, 1.0 - smoothstep(0.95, 1.0, r));
      o.emissive = vec4f(in.color.rgb * in.emissive * (1.0 - r), o.color.a);
      return o;
    }`,
});
orb.setUniforms(new Float32Array([1, 0, 0, 0])); // queue.writeBuffer; call whenever
orb.setTexture(0, someTexture);                   // bind group rebuilt lazily, only on change
```

A material can also override the vertex stage with `vertexEntry`. Use `engine_vertex(v)`
inside it to keep the standard transform.

- `renderer.createMaterial(desc: MaterialDesc)` returns a `Material`. `MaterialDesc` takes
  `label`, `wgsl`, `blend` (`BlendMode`: `alpha`, `premultiplied`, `additive`, `multiply`
  (`dst × rgb`, destination alpha kept), `opaque`; `blendState(mode)` is the `GPUBlendState`),
  `uniformBytes`, `textures`, `sampler` (`SamplerKind`: `linear-clamp`, `linear-repeat`, `linear-mip-repeat`, `nearest-mip-clamp`,
  `nearest-mip-repeat`, `nearest-clamp`), `perDrawUniforms`, `vertexEntry` and `fragmentEntry`.
- `material.pipelineFor(layout, depth)` returns the pipeline for a `VertexLayout` and a
  `DepthMode` (0 = no depth attachment, the 2D path; 1 = test without writes, for blended draws;
  2 = test and write, for opaque draws). Depth pipelines use `DEPTH_FORMAT` (`depth24plus`).
  `DepthMode` is exported so a `Drawable` that records with a material's pipeline can type the
  argument (from `frame.depthFormat`).
- `SPRITE_WGSL` is the built-in sprite fragment (`texture × vertex colour × tint`), the shader
  behind `createSpriteMaterial`.
- The WGSL pieces, for a `Drawable` that compiles its own shader against the engine's bindings:
  `WGSL_GLOBALS` (the `globals` and `camera` blocks), `WGSL_LIGHTS`, `WGSL_NOISE` (the
  `engine_hash*`/`engine_noise`/`engine_fbm`/`engine_luma` helpers), `materialPrelude(layout)`
  (the whole prelude for a vertex layout; `materialPrelude(VERTEX_LAYOUT_2D)` for the 2D path).

### Per-draw uniforms

Set `perDrawUniforms: true` so one material can draw many objects with different uniforms in
one frame. Pass each draw's block as `DrawParams.uniforms`, an array of f32 values. The rest
of the block reads 0, and the shader code stays the same.

```ts
const glow = renderer.createMaterial({ label: 'glow', wgsl, uniformBytes: 32, perDrawUniforms: true });
glow.setUniforms(shared);                            // used by draws without `uniforms`
frame.sprite(glow, { x, y, w, h, uniforms: obj.u });  // own block, bound at a dynamic offset
```

- Blocks are staged on the CPU and uploaded in one `writeBuffer` per material in the frame's first
  `render()` call (or in the `render` that `endFrame` runs itself when nothing rendered).
  The buffer doubles when it runs out of room, so a steady scene allocates nothing.
- Draws only batch together when they share a block. Draws without `uniforms` use the shared
  block (`setUniforms`) and still merge with each other.
- Passing `uniforms` to a material without the flag throws, and so does a block bigger than
  `uniformBytes`.
- Each block costs `minUniformBufferOffsetAlignment` bytes (256 on most devices), which is
  fine for hundreds of draws.

Bind groups are cached per texture set (the last 4 sets). Flipping a material between two
textures every frame, as ping-pong does, builds no new bind groups after the first round.

## Textures

- `renderer.createTexture(desc)` and `renderer.createRenderTarget(desc)`, where `TextureDesc` is
  `{ width, height, format?, usage?, label? }`. Anything with a `view`, `width` and `height`
  (`TextureLike`) can be bound with `setTexture`.
- `renderer.textureFromSource(source: TextureSource, label?, { linear?, mips? })` (`ImageBitmap`,
  `ImageData`, `HTMLCanvasElement`, `OffscreenCanvas` or `HTMLImageElement`)
  uploads colour as `rgba8unorm-srgb`. Pass `{ linear: true }` for data such as masks, height
  or normal maps, or noise, so the bytes are sampled exactly as written (`rgba8unorm`), and
  `{ mips: true }` for a full mip chain (generated as `loadTexture` does, so a `linear-mip-*`
  sampler filters a distant PBR map instead of shimmering). The options may also come second
  (`textureFromSource(src, { mips: true, label })`, `TextureFromSourceOptions`), ws/ergo-3d.
- `renderer.textureFromPixels({ width, height, data, format?, label?, usage? })` uploads raw
  typed pixels. It defaults to linear `rgba8unorm` and also takes `r8unorm`, `rg8unorm`,
  `r16float`, `rgba16float`, `r32float`, `rgba32float` and others; `bytesPerTexel(format)`
  lists them. `data` is `PixelData` (`Uint8Array`, `Uint8ClampedArray`, `Uint16Array` or
  `Float32Array`). `renderer.writePixels(tex, data)` refreshes it later and checks the size.
- `renderer.createPingPong({ width, height, format?, label? })` returns two same-size render
  targets (a `PingPong`) for feedback effects such as fluid sims or trails. The format defaults to
  `rgba16float`. Each `pp.step(encoder, pass, opts?: PingPongStepOptions)` (`{ slot?, clear? }`) reads `pp.read` in texture
  `slot` (default 0), writes `pp.write`, then swaps. Run it inside a `frame.prePass` and then
  call `material.setTexture(0, pp.read)` to show the newest state. `pp.resize(w, h)` and
  `pp.destroy()` handle the rest. It replaces hand-rolled A/B plus `copyTextureToTexture`.
- `renderer.textureFromShader({ width, height, wgsl, uniforms? })` runs a WGSL
  `fn shade(uv: vec2f) -> vec4f` once into a texture. Use it for procedural stone, noise,
  and glyphs. The default format is `rgba8unorm-srgb`, and `shade` returns linear colour.
- `loadTexture(device, source: TextureLayerSource, opts?: LoadTextureOptions)` is the one-call
  path for a single 2D texture from an image (`TextureSource`, copied on the GPU) or pixels
  (`PixelSource`, `writeTexture`): it creates the texture, writes level 0 and, with `mips`
  (default true), allocates `mipLevelCount(width, height)` levels (odd sizes included) and
  fills them with `generateMipmaps`. Options: `mips`, `filter` (`MipFilter`, default
  `'linear'`), `format` (default `rgba8unorm-srgb`; use `rgba8unorm` for data such as normal
  maps), `label`. Pair it with a `-mip` sampler. `Texture.destroy()` frees it.
- `defaultTextures(device): DefaultTextures` are the textures a material slot reads when the
  game sets nothing, built on first call and cached per device (`WeakMap`): `white` (1×1
  `255,255,255,255`, sRGB), `black` (1×1 `0,0,0,255`, sRGB), `flatNormal` (1×1 `128,128,255`,
  linear: a normal map that leaves the mesh normal alone), `metalRough` (1×1 `255,255,0`,
  linear, glTF channels G roughness and B metallic: a dielectric, fully rough surface) and
  `checker` (8×8 magenta/black squares of 2×2 texels, mipmapped, for "texture missing"). Every
  unset 2D texture slot of a material or fullscreen pass is bound to a white texture, so a
  material with four or five slots draws with none of them set; a slot set later rebuilds the
  bind group as before. For a metallic-roughness material: base colour, occlusion and emissive
  take `white` (emissive `black` when it should not glow), the normal slot `flatNormal`, the
  metal-rough slot `white` (glTF's default: metallic × factor) or `metalRough` (no metal, full
  roughness, whatever the factors say).
- `renderer.createSpriteMaterial(texture, label, { blend, sampler })`
- `SamplerKind` is `'linear-clamp'`, `'linear-repeat'`, `'nearest-clamp'`, `'linear-mip-repeat'`
  `'nearest-mip-clamp'` or `'nearest-mip-repeat'`. The `-mip` kinds blend between mip levels:
  linear for tiling surfaces, nearest for pixel-art faces that stay crisp up close and calm far
  away (`-repeat` when the face tiles its texture, as a block material's quads do).

### Texture arrays and mipmaps

A voxel or tile game binds one `texture_2d_array` of block faces and picks a face by layer
index, instead of an atlas whose tiles bleed into each other at a distance.

- `TextureDesc` also takes `layers?: number` (set, even to 1, it makes a 2D array texture whose
  view is `'2d-array'`) and `mips?: boolean` (allocate the full chain, `mipLevelCount(width,
  height)` levels). A `Texture` reports `layers`, `mipLevels` and `viewDimension`
  (`'2d' | '2d-array'`).
- `createTextureArray(device, desc: TextureArrayDesc)` (`{ width, height, layers, mips?, format?,
  usage?, label? }`) makes an empty array you fill yourself (`writeTexture` with `origin.z` as
  the layer).
- `loadTextureArray(device, sources: TextureLayerSource[], opts?: LoadTextureArrayOptions)`
  uploads one source per layer, in order: an image (`TextureSource`) through
  `copyExternalImageToTexture`, or pixel data (`PixelSource`: `{ width, height, data }`, which
  `ImageData` also is) through `writeTexture`. All sources must share the first one's size (it
  throws otherwise). Options: `mips` (default true: the full chain is generated on the GPU),
  `mipFilter` (`'linear'` default, or `'nearest'`), `format` (default `rgba8unorm-srgb`) and
  `label`.
- `generateMipmaps(device, texture, { filter?: MipFilter })` fills levels 1.. of any `Texture`
  created with `mips: true` (2D or array), each from the level above, layer by layer, with a
  tiny blit pipeline per format and filter cached per device. `'linear'` averages each 2×2 block
  (in linear space for sRGB formats); `'nearest'` keeps one texel. The texture needs
  `TEXTURE_BINDING | RENDER_ATTACHMENT` usage (the default) and a renderable float format. Run it
  after uploading level 0; it allocates, so do it at load time. Options type:
  `GenerateMipmapsOptions`.
- A material or fullscreen pass binds an array through `viewDimension` on its `MaterialDesc` or `FullscreenPassDesc` (`'2d-array'` for every slot, or
  one value per slot): the slot becomes `texture_2d_array<f32>`, and reads a 1-layer white array
  until `setTexture` binds yours.

```ts
const blocks = loadTextureArray(renderer.device, [grass, sand, clay, stone], { label: 'blocks' });
const mat = renderer.createMaterial({
  label: 'blocks', blend: 'opaque', wgsl, textures: 1,
  viewDimension: '2d-array', sampler: 'nearest-mip-clamp',
});
mat.setTexture(0, blocks);
```

```wgsl
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;
// in fs_main: the layer rides in the vertex colour's alpha (see below)
let albedo = textureSample(blocks, blockSampler, in.uv, u32(round(in.color.a)));
```

**Layer convention for `VERTEX_LAYOUT_3D`.** The 3D layout has `uv` only, so a mesher writes the
face's layer as a whole number in the vertex colour's alpha (all four corners of a face alike)
and the material reads `u32(round(in.color.a))`. `VSOut.color` is vertex colour × tint, so draw
such meshes with tint alpha 1 (the default); the rgb stays free. `harness/stream.html` textures
its Worker-meshed chunks this way.
- Colour helpers: `hex('#rrggbb', intensity)` returns linear RGBA; also `rgba`, `scaleRgb`,
  `srgbToLinear`, `linearToSrgb`.

## Lower-level pieces

- `renderer.createFullscreenPass(desc: FullscreenPassDesc)` (`label`, `wgsl`, `targets`,
  `blend`, `fragmentEntry`, `uniformBytes`, `textures`, `sampler`) returns a `FullscreenPass`,
  the building block for post effects. Its WGSL follows `WGSL_FULLSCREEN_PRELUDE`:
  `vs_fullscreen` with `FullscreenIn { pos, uv }`. `pass.encode(encoder, view, opts?:
  FullscreenEncodeOptions)` takes `clear` (`null` loads), an explicit `bindGroup`,
  `blendConstant` and `timestampWrites`; `setUniforms`, `setTexture`, `createBindGroup` and
  `destroy` as on a material.
- `renderer.createMesh(desc: MeshDesc)` returns a `Mesh` (`MeshDesc`: `vertices?`, `indices?`,
  `layout?`, `capacity?`, `indexFormat?`, `label?`). With the
  default `VERTEX_LAYOUT_2D` a vertex is `pos.xy, uv.xy, color.rgba` (8 floats); with
  `VERTEX_LAYOUT_3D` it is `pos.xyz, normal.xyz, uv.xy, color.rgba` (12 floats, normal at
  `@location(10)`). `VERTEX_LAYOUT_3D_TANGENT` (ws/geom-2) is the 3D layout plus `tangent: vec4f`
  at `@location(13)` (xyz along +u, w the handedness ±1; 16 floats, 64 B), the layout
  `geom`'s `computeTangents` returns. A `VertexLayout` is the buffer layout plus the WGSL that
  reads it; layouts compare by identity. `VERTEX_FLOATS`/`VERTEX_STRIDE` (8, 32 B) and
  `VERTEX3D_FLOATS`/`VERTEX3D_STRIDE` (12, 48 B) size a vertex, and `VERTEX_BUFFER_LAYOUT` and
  `VERTEX3D_BUFFER_LAYOUT` are the two `GPUVertexBufferLayout`s. `quadGeometry()` returns the
  unit quad (-0.5..0.5, white) as `{ vertices, indices }`. A material builds one pipeline per (vertex layout, depth mode) on first
  use (`material.pipelineFor(layout, depth)`).

  **Vertex attribute locations.** Every layout and the instance buffer share one numbering, so
  a custom layout (or a `Drawable`'s own pipeline) picks a free slot:

  | location | attribute | buffer | layouts |
  |---|---|---|---|
  | 0 | `pos` (`vec2f` 2D, `vec3f` 3D) | vertex | all |
  | 1 | `uv: vec2f` | vertex | all |
  | 2 | `color: vec4f` | vertex | all |
  | 3..5 | `m0`, `m1`, `m2` (3×4 world matrix rows) | instance | all |
  | 6 | `uvRect` | instance | all |
  | 7 | `tint` | instance | all |
  | 8 | `params` (`params.w` = skin palette slot, `SKIN_PARAM`) | instance | all |
  | 9 | `misc` (emissive, flags, size) | instance | all |
  | 10 | `normal: vec3f` | vertex | 3D, tangent, skinned |
  | 11 | `joints: vec4u` (`uint8x4`) | vertex | skinned |
  | 12 | `weights: vec4f` (`unorm8x4`) | vertex | skinned |
  | 13 | `tangent: vec4f` (xyz along +u, w handedness) | vertex | tangent |

  Locations 14 and 15 are free for a custom layout.
- Dynamic meshes: `capacity: { vertices, indices }` reserves room (a mesh may start empty, with
  just a capacity); `mesh.capacity` (a `MeshCapacity`) reads it. `mesh.update(u: MeshUpdate)`
  (`{ vertices?, indices?, vertexCount?, indexCount? }`) takes any `ArrayBufferView`s and writes them with `queue.writeBuffer` straight
  from their own `buffer`/`byteOffset`, so a Worker can build a chunk into one `ArrayBuffer`,
  transfer it, and the page uploads it with no copy (see `harness/stream.ts`). It also takes the
  Worker's reply as-is (`MeshReply`, ws/ergo-3d: `{ buffer, vertexCount, indexCount?, indexOffset?,
  bounds? }`, the vertices from byte 0 and the indices at `indexOffset`, default right after the
  vertices rounded up to 4 bytes; an indexed mesh given no `indexCount` draws nothing), so the
  page never builds views; extra fields such as a chunk id are ignored. Buffers are
  reused while the counts fit the capacity and grow 1.5× only when they do not or the index
  format changes; `update` returns true then and `mesh.growths` counts it. Counts alone
  (`{ indexCount: n }`) move the draw range, so a chunk shrinks without touching the GPU.
  Typed `Uint16Array`/`Uint32Array` views set the index format; other views keep it.
  `mesh.bounds` (a `MeshBounds`, `{ center: [x, y, z], radius }` in mesh space) is the sphere
  the renderer frustum-culls the mesh's draws by: `MeshDesc.bounds` or `MeshUpdate.bounds` set
  it (copied; a Worker that meshed the chunk knows them), otherwise it is computed from the
  uploaded positions when `autoBounds` is on, which `MeshDesc.autoBounds` defaults to for a
  capacity under `AUTO_BOUNDS_MAX_VERTICES` (65536) vertices and off above (a big streamed
  mesh passes its own). A mesh with no bounds yet has `radius` Infinity and is never culled. An
  indexed mesh with `indexCount` 0 is skipped entirely, no draw call and nothing in `stats` (an
  empty streamed chunk); a non-indexed mesh draws `vertexCount`. Every shipped layout has
  `positionOffset` 0 (ws/ergo-3d): a custom layout that puts something before `pos` sets it so a
  picker reads `meshTester(..., { stride: layout.floats, offset: layout.positionOffset })`
  without knowing the layout.
- `Drawable { prepare?(encoder, frame); draw(pass, frame) }` lets you run your own pipelines
  inside the scene pass. Build them with `layout: [renderer.globalsLayout, yours]` and
  `targets: renderer.sceneFormats`.

### Depth hooks

A drawable that reads the scene depth (soft particles, water, decals) sets `readsDepth: true`
and may implement `afterOpaque?(encoder: GPUCommandEncoder, view: ViewInfo): void`. For each
view with `camera.depthTest` that sees such a drawable, the renderer ends the scene pass after
the opaque draws (plus every draw of a lower `order`), copies the depth attachment with
`copyTextureToTexture` into the target's `depthCopy` (a `depth24plus` texture usable as a
`texture_depth_2d` binding) and calls `afterOpaque` once per hooked drawable before the
blended pass. `ViewInfo { camera, target, depthCopy, depthView, viewport }` is valid until that
view's blended pass ends; bind `depthView` (a new bind group only when the texture changed) and
draw as usual. `ortho2d` cameras never split. `SceneTarget.depthCopy` (null until a view split
into it), `canCopyDepth` (false for an adopted XR depth without `COPY_SRC`, in which case the
view does not split and the hook is not called), `copyDepth(encoder)` and `blendPassDesc` are
the pieces. `Water` and `ParticleSystem` take `readsDepth` and then skip their own copy.
- `frame.prePass(fn)` runs before the scene pass, for things like render-to-texture.
- `SnapshotRenderer(device, format, opts: SnapshotOptions)` is a second `Renderer` on the same
  device that draws one frame into an `OffscreenCanvas`: `shot.capture(draw, time?)` returns an
  `ImageBitmap` for baking icons, thumbnails and previews with real materials. `SnapshotOptions`
  is `{ width, height }`, which is also its logical size. Its materials belong to
  `shot.renderer`.
- `ParticleSystem.clear()` (in `engine/fx`) drops every live particle and any emits queued
  this frame. The particle buffer is zeroed on the GPU in the next `prepare`, so nothing
  allocates. Particles emitted after `clear()` in the same frame survive.
- Tests: `engine/render/fake-gpu.ts` (imported as `@thunderclap/engine/testing`) provides a recording fake `GPUDevice`, created with
  `createFakeDevice()` and wrapped with `fakeRendererGpu()`. It checks buffer and texture
  usage flags such as COPY_DST, catches writes past the end of a buffer, and records pass
  commands such as `setBindGroup` offsets and draws. That means `new Renderer(...)` and the
  props run in Node. It is test-only and not exported from the index.
  `installGpuGlobals()` defines `GPUBufferUsage`, `GPUTextureUsage` and `GPUShaderStage` in Node;
  `fakeCanvasContext(fake)` is the context `fakeRendererGpu` uses. What a test inspects on a
  `FakeDevice`: `buffers` (`FakeBuffer`: `size`, `usage`, `destroyed`), `textures`
  (`FakeTexture`, whose views are `FakeView`s), `bindGroups` (`FakeBindGroup`: layout and
  entries), `writes`, `textureWrites`, `passes` (`FakePass`: `kind`, `label`, `commands`) and
  `errors`. A `PassCommand` is one recorded `setPipeline`, `setBindGroup`, `draw`, `drawIndexed`,
  `dispatch` or other call.

## Diagnostics

- `createShaderModule` logs every WGSL compile message with its line and a caret pointing at
  the problem.
- `installGpuErrorLogging(device)` loudly logs `uncapturederror` events. The errors also
  collect in `gpuDiagnostics.errors` and `gpuDiagnostics.errorCount`, which headless tests
  can check. `onGpuError(fn)` subscribes to them (a dev toast; returns the unsubscribe), and
  `reportGpuError(message)` logs and records one (`createShaderModule` reports compile errors
  through it; a game can report its own GPU failures the same way).
- `renderer.stats` (`RenderStats`) reports `{ drawCalls, instances, drawables, culled, batches,
  shadowDraws, triangles, passes }` for the last frame; `culled` is the mesh instances the frustum test skipped
  and `batches` the `frame.meshes` batches and `frame.list` lists drawn, summed over the views.
  `triangles` (ws/ergo-3d) is the triangles the scene passes drew (index or vertex count ÷ 3,
  times the instance count), summed over the views; drawables and the shadow pass are not
  counted, so a demo's readout needs no per-mesh arithmetic. `passes` (ws/render-hooks) is the
  scene passes encoded (one per view, two per view split by a depth hook).

## Resolution and timing

The HDR scene targets can be smaller than the output (the canvas backbuffer). The post
processor upscales by UV while compositing at full output resolution, so edges stay sharp
enough and the DOM overlay is untouched.

```ts
renderer.setResolution({ maxPixels: 1280 * 720 }); // pixel budget for the scene targets
renderer.setResolution({ scale: 0.8 });            // extra scale on top (0.25..1)
renderer.resolutionScale;                          // scene width / output width
```

- `ResolutionOptions` is `{ scale?, maxPixels? }`; `scale` is clamped to
  `MIN_RESOLUTION_SCALE` (0.25)..1.
- `sceneSize(outW, outH, opts)` is the pure helper behind it (even sizes, full size when the
  scale rounds to 1). `onResize` listeners get the **scene** size.
- `renderer.timingEvery = N` samples GPU time every N frames, measured from submit to
  `queue.onSubmittedWorkDone()` (no timestamp-query feature needed; one sample in flight).
  Subscribe with `renderer.onGpuTime(ms => ...)`; `renderer.timing` (`FrameTiming`: `gpuMs`,
  `source`, `passes`, `cpuMs`, `samples`) holds the last value. Off (0) by default.
  `renderer.timing.ready()` (ws/ergo-3d) resolves once the first sample has landed (at once when
  `samples` > 0, the renderer is destroyed, or the device can time nothing), so a bench awaits a
  real `gpuMs` instead of polling; set `timingEvery` first, since with timing off no sample ever
  comes.
- When the device has `timestamp-query` (`supportsTimestamps(device)`), `renderer.gpuTimer` is a
  `GpuTimer` and samples come from timestamps (`source: 'timestamp'`) with a per-pass breakdown
  (`GpuPassTimes`, label to ms); passes label themselves with `gpuTimer.pass(label)`, which a
  custom `PostProcessor` calls for its own passes (the class is exported for that type). Its
  `onResult` listeners get a `GpuTimerResult` (`totalMs`, `passes`, `samples`). Without the
  feature `gpuTimer` is null and timing falls back to the queue.
  `pnpm bench` (`harness/bench.html`, `scripts/bench.mjs`) uses these to record what a frame
  affords on one machine, per scene rung, in `docs/BENCH.md`.
- `DynamicResolution` turns GPU-time samples into a scale. It drops after 1 s over budget
  (smoothed), raises only after 3 s with the predicted cost under 85% of budget, waits
  1.5 s after any change, and blocks a level for 20 s when raising to it was followed by a
  drop. That stops it pumping at the edge. `saturated` says it is at the floor and still
  over budget. `DynamicResolutionOptions`: `budgetMs` (14), `minScale` (0.5), `maxScale` (1),
  `step` (0.1), `dropAfterMs`, `raiseAfterMs`, `raiseMargin`, `cooldownMs`, `burnMs`, `smoothing`.
