# engine/render

A raw WebGPU renderer for 2D and 3D: HDR scene targets, instanced quads and meshes, depth,
lights, and materials that take custom WGSL. It has no runtime dependencies.

## Frame model

```
beginFrame(time, dt) → Frame
  frame.sprite / frame.mesh / frame.drawable   (record only; nothing hits the GPU yet)
render(frame, camera, target = renderer.target)   once per camera
  1. first call of the frame: pre-passes, then drawable.prepare() (compute, uploads)
  2. write this view's globals + camera + lighting blocks (one 1072 B buffer per view) and its instances
     (appended to the shared instance buffer)
  3. scene pass into the target: colour (@location 0) and emissive (@location 1), both
     rgba16float, plus depth24plus when camera.depthTest; the first view into a target
     clears it, later views load
endFrame(opts?)
  4. render(frame, renderer.camera) if nothing was rendered (the single-camera path)
  5. renderer.post (e.g. PostStack) or the built-in present pass: renderer.target → swapchain
     (skipped with { present: false }: an XR frame draws into the session's layer, not the canvas)
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
  a depth camera has rendered into it.
  `SceneTargetDesc` is `{ width, height, label? }`; both colour targets use `SCENE_FORMAT`
  (`rgba16float`).
- **External targets (XR).** `SceneTarget.external({ device, color, depth?, view?, viewport?,
  label? })` (`SceneTargetExternal`) wraps a colour texture someone else owns (a WebXR projection
  layer's `getViewSubImage` colour, one array layer through `view`) and optionally its depth,
  allocating only the emissive target; `isExternal`, `adoptedColor`, `viewport`
  (`SceneTargetViewport`, the sub-image rect in px) and `adopt(desc)` (re-point at the next
  frame's textures; a no-op when they are the same) are its extras; `resize` throws, `destroy`
  never destroys what it adopted. `XrSurface` in `@thunderclap/engine/platform` builds one per
  eye. `endFrame({ present: false })` skips the swapchain (post and present) for such a frame;
  the post stack is not applied per eye (the XR path renders the scene pass only).

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
  output)`, where `PostInputs` is `{ color, emissive, time, dt }`. `PostStack` is the engine's;
  a game writes its own only to replace the whole final stage.

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

`frame.mesh(...)` also carries the mesh's bounding sphere (`mesh.bounds`) through the instance
matrix into a world sphere: the centre by the matrix, the radius by the largest axis scale
(column length), so rotation and non-uniform scale stay conservative. A camera with `cull`
tests that sphere against its frustum. `frame.sprite(...)` records no sphere; sprites are
never culled.

### Instance format (28 floats, 112 bytes)

| floats | WGSL `VertexIn` | content |
| --- | --- | --- |
| 0..11 | `m0`, `m1`, `m2` (@location 3..5) | 3×4 world matrix rows |
| 12..15 | `uvRect` (@6) | u0, v0, u1, v1 |
| 16..19 | `tint` (@7) | linear RGBA |
| 20..23 | `params` (@8) | free vec4 |
| 24..27 | `misc` (@9) | emissive, flags (reserved, 0), size.x, size.y |

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
  projection (an `XRView.projectionMatrix`). `viewIndex` is the `view_index` the camera block
  carries (eye 0 / 1 in XR).
- `depthTest` and `depthWrite` (off for `ortho2d`, on for `perspective`) and the `layers` mask
  (u32, default all bits; `sees(mask)`) drive the render call's depth attachment and draw sort.
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
first `MAX_POINT_LIGHTS` = 16 uploaded) that the renderer writes as `EngineLights` at
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
falloff; `engine_lambert(n, p)` adds the ambient and the sun. Toon, rim or wrapped lighting
reads the same fields and ignores the helpers. `Lights.writeBlock(f32, u32, offset, shadow?)`
is the CPU layout (`LIGHTS_BLOCK_FLOATS` = 168 floats; `POINT_LIGHTS_OFFSET_FLOATS`,
`POINT_LIGHT_FLOATS`, `SUN_VIEW_PROJ_OFFSET_FLOATS`, `SHADOW_PARAMS_OFFSET_FLOATS`,
`FOG_OFFSET_FLOATS`), and allocates nothing; `lights.reset()` returns to the unlit default.
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
`engine_shadow_sampler` (`@binding(4)`). Without a shadow a 1×1 depth placeholder is bound, so
one bind group layout serves both. The block gains `lights.sun_view_proj` (`mat4x4f`) and
`lights.shadow_params` (bias, texel size, enabled, -).

- `engine_shadow(world_pos) -> f32`: 0 in shadow, 1 lit, 3×3 PCF; 1 outside the box or when no
  shadow was rendered. `engine_lambert` multiplies the sun term by it, so a material that uses
  `engine_lambert` is shadowed with no change.
- `InstanceParams.castShadow`: default true for meshes in a 3D vertex layout and false for
  `VERTEX_LAYOUT_2D` sprites and quads, so a 2D scene never renders a shadow pass; blended
  materials never cast. `InstanceParams.receiveShadow: false` sets instance flag bit 0, read as
  `in.flags & 1u` in the fragment shader (`VSOut.flags`); the engine helpers do not read it.
- `ShadowMap` (`SHADOW_FORMAT` = `depth32float`) is the renderer's piece: the texture, the
  sampler, the placeholder, `sunCamera`, `place(center, sunDir, shadow, size)`,
  `pipelineFor(layout)` and `ShadowUniforms` (`viewProj`, `bias`, `texelSize`), what
  `writeBlock` takes as its fourth argument. Games set `lights.sun.shadow`; drawables that
  render their own passes may use it directly.

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

## Custom materials

A material is your WGSL fragment shader plus an optional uniform block and textures. The
engine prepends a prelude that provides:

- `globals`: `logicalSize`, `targetSize`, `time`, `dt` at `@group(0) @binding(0)`
- `camera`: `view`, `proj`, `view_proj` (world → clip), `camera_pos`, `viewport` (scene target
  px) and `view_index` (from `camera.viewIndex`) at `@group(0) @binding(1)`
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
  blend: 'alpha',            // 'alpha' | 'premultiplied' | 'additive' | 'opaque'
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
  `label`, `wgsl`, `blend` (`BlendMode`: `alpha`, `premultiplied`, `additive`, `opaque`),
  `uniformBytes`, `textures`, `sampler` (`SamplerKind`: `linear-clamp`, `linear-repeat`,
  `nearest-clamp`), `perDrawUniforms`, `vertexEntry` and `fragmentEntry`.
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

- Blocks are staged on the CPU and uploaded in one `writeBuffer` per material in `endFrame`.
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
- `renderer.textureFromSource(source: TextureSource, label?, { linear? })` (`ImageBitmap`,
  `ImageData`, `HTMLCanvasElement`, `OffscreenCanvas` or `HTMLImageElement`)
  uploads colour as `rgba8unorm-srgb`. Pass `{ linear: true }` for data such as masks, height
  or normal maps, or noise, so the bytes are sampled exactly as written (`rgba8unorm`).
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
- `renderer.createSpriteMaterial(texture, label, { blend, sampler })`
- `SamplerKind` is `'linear-clamp'`, `'linear-repeat'`, `'nearest-clamp'`, `'linear-mip-repeat'`
  or `'nearest-mip-clamp'`. The two `-mip` kinds blend between mip levels: linear for tiling
  surfaces, nearest for pixel-art faces that stay crisp up close and calm far away.

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
  `@location(10)`). A `VertexLayout` is the buffer layout plus the WGSL that reads it;
  layouts compare by identity. `VERTEX_FLOATS`/`VERTEX_STRIDE` (8, 32 B) and
  `VERTEX3D_FLOATS`/`VERTEX3D_STRIDE` (12, 48 B) size a vertex, and `VERTEX_BUFFER_LAYOUT` and
  `VERTEX3D_BUFFER_LAYOUT` are the two `GPUVertexBufferLayout`s. `quadGeometry()` returns the
  unit quad (-0.5..0.5, white) as `{ vertices, indices }`. A material builds one pipeline per (vertex layout, depth mode) on first
  use (`material.pipelineFor(layout, depth)`).
- Dynamic meshes: `capacity: { vertices, indices }` reserves room (a mesh may start empty, with
  just a capacity); `mesh.capacity` (a `MeshCapacity`) reads it. `mesh.update(u: MeshUpdate)`
  (`{ vertices?, indices?, vertexCount?, indexCount? }`) takes any `ArrayBufferView`s and writes them with `queue.writeBuffer` straight
  from their own `buffer`/`byteOffset`, so a Worker can build a chunk into one `ArrayBuffer`,
  transfer it, and the page uploads it with no copy (see `harness/stream.ts`). Buffers are
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
  indexed mesh with `indexCount` 0 draws nothing (an empty streamed chunk); a non-indexed mesh
  draws `vertexCount`.
- `Drawable { prepare?(encoder, frame); draw(pass, frame) }` lets you run your own pipelines
  inside the scene pass. Build them with `layout: [renderer.globalsLayout, yours]` and
  `targets: renderer.sceneFormats`.
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
- `renderer.stats` (`RenderStats`) reports `{ drawCalls, instances, drawables, culled }` for the
  last frame; `culled` is the mesh draws the frustum test skipped, summed over the views.

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
- When the device has `timestamp-query` (`supportsTimestamps(device)`), `renderer.gpuTimer` is a
  `GpuTimer` and samples come from timestamps (`source: 'timestamp'`) with a per-pass breakdown
  (`GpuPassTimes`, label to ms); passes label themselves with `gpuTimer.pass(label)`, which a
  custom `PostProcessor` calls for its own passes (the class is exported for that type). Its
  `onResult` listeners get a `GpuTimerResult` (`totalMs`, `passes`, `samples`). Without the
  feature `gpuTimer` is null and timing falls back to the queue.
- `DynamicResolution` turns GPU-time samples into a scale. It drops after 1 s over budget
  (smoothed), raises only after 3 s with the predicted cost under 85% of budget, waits
  1.5 s after any change, and blocks a level for 20 s when raising to it was followed by a
  drop. That stops it pumping at the edge. `saturated` says it is at the floor and still
  over budget. `DynamicResolutionOptions`: `budgetMs` (14), `minScale` (0.5), `maxScale` (1),
  `step` (0.1), `dropAfterMs`, `raiseAfterMs`, `raiseMargin`, `cooldownMs`, `burnMs`, `smoothing`.
