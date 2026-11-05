# engine/render

A raw WebGPU 2D renderer: HDR scene targets, instanced quads and meshes, and materials that
take custom WGSL. It has no runtime dependencies.

## Frame model

```
beginFrame(time, dt) → Frame
  frame.sprite / frame.mesh / frame.drawable   (record only; nothing hits the GPU yet)
endFrame()
  1. write globals + all instance data (one writeBuffer each)
  2. pre-passes, then drawable.prepare() (compute, uploads); each runs once per frame
  3. scene pass → two rgba16float targets: colour (@location 0) and emissive (@location 1)
  4. renderer.post (e.g. PostStack) or the built-in present pass → swapchain
  5. submit
```

- **Logical space** is 1920×1080 by default, with the origin at top-left and y pointing down.
  `renderer.camera` holds `{ x, y, zoom, rotation }`.
- **Draw order is `order`, then submission order.** Every draw takes an optional `order`
  (sort key, default 0), so by default draws render in submission order. Consecutive draws
  that use the same material and mesh merge into one instanced draw call, so draws batch best
  when grouped by material.
- **Layers.** Every draw takes `layers` (u32 mask, default 1). When `renderer.camera.layers`
  is set, draws with `layers & camera.layers === 0` are skipped; without it, all draw.
- **Depth is opt-in.** With `renderer.camera.depthTest = true` the scene pass gets a
  `depth24plus` attachment (allocated on first use), and draws sort by `order`, then opaque
  (front-to-back) before blended (back-to-front), by distance to `camera.position` (or by
  world z without one). `camera.depthWrite = false` keeps opaque draws from writing depth.
  `frame.depthFormat` tells drawables which format to declare.
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

## Custom materials

A material is your WGSL fragment shader plus an optional uniform block and textures. The
engine prepends a prelude that provides:

- `globals`: `viewProj`, `logicalSize`, `targetSize`, `time`, `dt` at `@group(0) @binding(0)`
- noise helpers: `engine_hash21`, `engine_hash22`, `engine_noise`, `engine_fbm(p, octaves)`,
  `engine_luma`
- `VSOut { clip, uv, local, color, params, world, emissive, size, normal, worldPos }`, where
  `local` is 0..1 across the quad, `world` is the logical position (xy), `normal` is the
  world-space normal (`(0, 0, -1)` for 2D meshes) and `worldPos` the world xyz
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

- `renderer.createTexture(desc)` and `renderer.createRenderTarget(desc)`
- `renderer.textureFromSource(ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement, label?, { linear? })`
  uploads colour as `rgba8unorm-srgb`. Pass `{ linear: true }` for data such as masks, height
  or normal maps, or noise, so the bytes are sampled exactly as written (`rgba8unorm`).
- `renderer.textureFromPixels({ width, height, data, format?, label?, usage? })` uploads raw
  typed pixels. It defaults to linear `rgba8unorm` and also takes `r8unorm`, `rg8unorm`,
  `r16float`, `rgba16float`, `r32float`, `rgba32float` and others; `bytesPerTexel(format)`
  lists them. `renderer.writePixels(tex, data)` refreshes it later and checks the size.
- `renderer.createPingPong({ width, height, format?, label? })` returns two same-size render
  targets for feedback effects such as fluid sims or trails. The format defaults to
  `rgba16float`. Each `pp.step(encoder, pass, { slot?, clear? })` reads `pp.read` in texture
  `slot` (default 0), writes `pp.write`, then swaps. Run it inside a `frame.prePass` and then
  call `material.setTexture(0, pp.read)` to show the newest state. `pp.resize(w, h)` and
  `pp.destroy()` handle the rest. It replaces hand-rolled A/B plus `copyTextureToTexture`.
- `renderer.textureFromShader({ width, height, wgsl, uniforms? })` runs a WGSL
  `fn shade(uv: vec2f) -> vec4f` once into a texture. Use it for procedural stone, noise,
  and glyphs. The default format is `rgba8unorm-srgb`, and `shade` returns linear colour.
- `renderer.createSpriteMaterial(texture, label, { blend, sampler })`
- Colour helpers: `hex('#rrggbb', intensity)` returns linear RGBA; also `rgba`, `scaleRgb`,
  `srgbToLinear`, `linearToSrgb`.

## Lower-level pieces

- `renderer.createFullscreenPass({ label, wgsl, targets, blend, uniformBytes, textures })` is
  the building block for post effects. It uses `vs_fullscreen` with `FullscreenIn { pos, uv }`.
- `renderer.createMesh({ vertices, indices, layout? })`. With the default
  `VERTEX_LAYOUT_2D` a vertex is `pos.xy, uv.xy, color.rgba` (8 floats); with
  `VERTEX_LAYOUT_3D` it is `pos.xyz, normal.xyz, uv.xy, color.rgba` (12 floats, normal at
  `@location(10)`). `mesh.update()` replaces the data. A material builds one pipeline per
  (vertex layout, depth mode) on first use (`material.pipelineFor(layout, depth)`).
- `Drawable { prepare?(encoder, frame); draw(pass, frame) }` lets you run your own pipelines
  inside the scene pass. Build them with `layout: [renderer.globalsLayout, yours]` and
  `targets: renderer.sceneFormats`.
- `frame.prePass(fn)` runs before the scene pass, for things like render-to-texture.
- `ParticleSystem.clear()` (in `engine/fx`) drops every live particle and any emits queued
  this frame. The particle buffer is zeroed on the GPU in the next `prepare`, so nothing
  allocates. Particles emitted after `clear()` in the same frame survive.
- Tests: `engine/render/fake-gpu.ts` (imported as `@thunderclap/engine/testing`) provides a recording fake `GPUDevice`, created with
  `createFakeDevice()` and wrapped with `fakeRendererGpu()`. It checks buffer and texture
  usage flags such as COPY_DST, catches writes past the end of a buffer, and records pass
  commands such as `setBindGroup` offsets and draws. That means `new Renderer(...)` and the
  props run in Node. It is test-only and not exported from the index.

## Diagnostics

- `createShaderModule` logs every WGSL compile message with its line and a caret pointing at
  the problem.
- `installGpuErrorLogging(device)` loudly logs `uncapturederror` events. The errors also
  collect in `gpuDiagnostics.errors` and `gpuDiagnostics.errorCount`, which headless tests
  can check.
- `renderer.stats` reports `{ drawCalls, instances, drawables }` for the last frame.

## Resolution and timing

The HDR scene targets can be smaller than the output (the canvas backbuffer). The post
processor upscales by UV while compositing at full output resolution, so edges stay sharp
enough and the DOM overlay is untouched.

```ts
renderer.setResolution({ maxPixels: 1280 * 720 }); // pixel budget for the scene targets
renderer.setResolution({ scale: 0.8 });            // extra scale on top (0.25..1)
renderer.resolutionScale;                          // scene width / output width
```

- `sceneSize(outW, outH, opts)` is the pure helper behind it (even sizes, full size when the
  scale rounds to 1). `onResize` listeners get the **scene** size.
- `renderer.timingEvery = N` samples GPU time every N frames, measured from submit to
  `queue.onSubmittedWorkDone()` (no timestamp-query feature needed; one sample in flight).
  Subscribe with `renderer.onGpuTime(ms => ...)`; `renderer.timing` holds the last value.
  Off (0) by default.
- `DynamicResolution` turns GPU-time samples into a scale. It drops after 1 s over budget
  (smoothed), raises only after 3 s with the predicted cost under 85% of budget, waits
  1.5 s after any change, and blocks a level for 20 s when raising to it was followed by a
  drop. That stops it pumping at the edge. `saturated` says it is at the floor and still
  over budget.
