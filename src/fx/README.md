# engine/fx

GPU particles and allocation-free light helpers. No dependencies.

## Particles

```ts
import { ParticleEmitter, ParticleSystem } from '@thunderclap/engine/fx';

const particles = new ParticleSystem(renderer, { capacity: 32768, floorY: 1000 });
// createGame builds one as ctx.particles (options: CreateGameOptions.particles) and updates it.

particles.emit({ x: 960, y: 540, shape: { kind: 'circle', radius: 20 }, colorStart: [4, 2, 0.5, 1] }, 64);

const embers = new ParticleEmitter(particles, { x: 400, y: 900, colorStart: [3, 1, 0.2, 1] }, 30);
embers.update(dt);           // 30 particles/s; mutate embers.params freely
embers.burst(20, { speed: [300, 600] });

// each frame, inside the scene's render:
frame.drawable(particles);   // order and layers optional, like any draw
```

- `ParticleSystem(renderer, opts?: ParticleSystemOptions)`: `capacity` (ring buffer, default
  65536; when full the oldest are overwritten), `maxSpawnsPerFrame` (256), `floorY` (a bouncy
  floor, logical y), `bounce` (0.35), `stretch` (velocity streak, 0.02 s). Spawn and integrate run
  in compute (`prepare(encoder)`, called by the renderer); `update(dt)` only advances time.
  `clear()` kills every particle on the next `prepare`; `destroy()` frees the buffers.
- Particles draw as additive, velocity-stretched quads into both scene targets (colour and
  emissive, so they bloom). With a depth camera (`frame.depthFormat` set) `draw` uses a pipeline
  that tests depth without writing it, built once per depth format.
- `EmitParams`: `x`, `y`, `shape` (`EmitShape`: `point`, `circle { radius }`, `rect { width,
  height }`, `line { dx, dy }`), `angle`, `spread`, `speed`, `life`, `size`, `colorStart`,
  `colorEnd`, `gravity`, `drag`, `emissive`. Colours are linear RGBA (HDR allowed); units are
  logical px and seconds.
- `blend: 'additive' | 'alpha'` (default additive; alpha is premultiplied, for smoke and dust).
  `countAlive: true` counts live particles on the GPU each frame and reads the count back into
  `alive` (a few frames late; -1 before the first readback).
- Box and sphere shapes (`box { width, height, depth }`, `sphere { radius }`) act as `rect` and
  `circle` in 2D, which stays pixel-identical to before.

### World space

```ts
const rain = new ParticleSystem(renderer, { space: 'world', floorY: 0, bounce: 0, stretch: 0.012 });
rain.emit({
  x: 0, y: 9, z: 0,
  shape: { kind: 'box', width: 18, height: 1, depth: 18 },
  angle: -Math.PI / 2, spread: 0.05, speed: [7, 9],
  gravity: [0, -9.8, 0], wind: [1.5, -9, 0], drag: 0.4,
  colorStart: [0.5, 0.6, 0.8, 0.7],
}, 50);
const dust = new ParticleSystem(renderer, { space: 'world', blend: 'alpha', lit: true, fade: { near: 14, far: 24 } });
frame.drawable(rain);        // under a depth camera (Camera.perspective)
```

- `space: 'world'`: positions in world units, y up. The same compute kernels run with three
  components; quads face the camera (built from the `camera.view` rows) and stretch along the
  velocity projected on screen. Depth test on, depth write off.
- `EmitParams` in world space: `z`, `vz` (added to the sampled velocity), `gravity` as
  `[x, y, z]` (a pair means z 0), `wind` (`[x, y, z]`, the velocity `drag` pulls towards),
  `drag`. `angle` is in the xy plane and `spread` opens a cone around it. Defaults are
  world-sized: angle up, spread a full sphere, `speed` [0.5, 2], `size` [0.1, 0.02], gravity
  [0, -9.8, 0].
- `floorY`: the plane y = `floorY` (default none).
- `lit` (default false): each particle is shaded as a small sphere through `engine_lambert`
  (`WGSL_LIGHTS`: `frame.lights` ambient, sun, point lights). `emissive` still goes to the
  emissive target.
- `fade: { near, far }`: fade out with distance to the camera (null for none).
- `softness` (default 0.25 world units; 0 off): soft particles. `prepare` copies the scene
  depth (`depthTarget ?? renderer.target`, its `SceneTarget.depth`) into the system's own
  `depth32float` texture and the fragment fades near it. The copy is the previous frame's
  depth; draw the system on its own layer in a second view of the same camera for same-frame
  depth. Without a depth camera or before the first depth frame it is skipped.

- `ParticleEmitter(system, params, rate = 0)`: continuous emission at `rate` per second while
  `active`, plus `burst(count, overrides?)`.

## Trails

Ribbon trails: a ring buffer of pushed points becomes a strip two vertices wide, rebuilt on
the CPU into one preallocated `Float32Array` each frame and uploaded with a single
`Mesh.update` (static index buffer; no allocation after construction). Drawn through
`frame.mesh` with an unlit material (`TRAIL_WGSL`, or `TRAIL_TEXTURED_WGSL` with a texture)
that fades toward the two long edges, so depth test and blending come from the renderer.

```ts
const trail = new Trail(renderer, {
  space: 'world',            // '2d' (default, logical px) or 'world'
  maxPoints: 64,             // ring buffer; the oldest drops when full
  width: 0.2,                // or widthCurve: [0.4, 0.1] (newest → oldest)
  color: [1, 0.6, 0.2, 1],   // or colorCurve: RGBA stops, newest → oldest
  lifetime: 0.5,             // seconds a point lives
  minDistance: 0.02,         // closer pushes only move the tip
  facing: 'camera',          // 'up' or a fixed [x, y, z] axis
  blend: 'additive',         // or 'alpha'
  uvMode: 'stretch',         // or 'tile' (one repeat per `width`), texture?: Texture
});
trail.push(x, y, z);         // once per update, wherever the thing is
trail.update(dt, camera);    // ages points, rebuilds the strip (camera for 'camera' facing)
trail.draw(frame);           // frame.mesh(trail.mesh, trail.material, trail.transform, trail.instance)
trail.clear();
```

- `Trail` (`TrailOptions`, `TrailFacing`, `TrailBlend`): `push(x, y, z = 0): boolean` (true
  when a point was stored), `update(dt, camera?)`, `draw(frame)`, `clear()`, `count`,
  `pointAt(i, out)` (0 = newest), `maxPoints`, `softness` (share of the half width that fades,
  default 0.5), `fade` (alpha over age, default `[1, 0]`, `null` for none), and the public
  `mesh`, `material`, `transform` and `instance` for a custom draw. `width`, `lifetime`,
  `facing` and `color` are live fields. `destroy()` frees the mesh (and a textured material).
- The newest push is always the ribbon's tip (age 0); a push closer than `minDistance` to the
  newest stored point moves the tip without storing, so a slow mover still gets a smooth end.
- Facing: `'camera'` turns each point's face toward `camera.position` in world space, or to the
  view axis in 2D (flat in the XY plane with no camera); `'up'` lies flat (+y); an axis is fixed.
- Untextured trails share one material per renderer and blend (`trail-additive`,
  `trail-alpha`); a textured trail owns its own (`linear-repeat` sampler for `'tile'`).
- `TrailBatch(renderer, size, opts)`: `size` ribbons in one mesh and one draw, with the same
  options and `push(i, …)`, `count(i)`, `pointAt(i, j, out)`, `clear(i?)`; it packs the ribbons
  contiguously and rewrites its index buffer each frame.

## Debug draw

World-space lines without a mesh: wire boxes and spheres, axes, arrows, rays, grids, circles,
paths and frustums, for a game, a demo or a test. Every call appends line segments (two
vertices of xyz + rgba, 7 floats each) to one CPU `Float32Array`; `draw(pass, frame)` uploads
the used range with a single `writeBuffer` and records one `'line-list'` draw with the pipeline
for `frame.depthFormat` (built on first use, so the same object works under a 2D camera and a
depth camera). Lines are 1 px wide (WebGPU `line-list`; no width, no anti-aliasing), unlit and
alpha blended, and never write depth.

```ts
const debug = createDebugDraw(renderer, {
  capacity: 16384,     // segments before the array and buffer grow by 1.5×
  depth: 'test',       // or 'always': no depth test, shows through walls
  retain: false,       // true keeps the segments after draw (static scenes)
});
debug.line(a, b, 0xff0000ff);                       // colours: 0xRRGGBBAA or [r, g, b, a]
debug.ray(origin, dir, 2, [1, 1, 0]);               // dir normalised here
debug.arrow(a, b, 0xffffffff, 0.2);                 // head length (default 15%)
debug.box(center, halfExtents, 0x00ff00ff, transform.quaternion);
debug.wireSphere(center, 0.5, 0x00ffffff, 12);      // 3 great circles of 2 × rings segments
debug.axes(transform, 1);                           // or a 3×4 row-major matrix; x red, y green, z blue
debug.grid([0, 0, 0], 20, 1, 0x404040ff);           // XZ plane
debug.circle(center, [0, 1, 0], 1, 0xffffffff, 32);
debug.path(points, 0xffffffff, 3, 0);               // Float32Array | number[], stride, offset, count?
debug.frustum(invViewProj, 0xff00ffff);             // column-major inverse view-projection
frame.drawable(debug);                              // inside the scene pass; clears unless retain
```

- `createDebugDraw(renderer, opts?: DebugDrawOptions)` returns a `DebugDraw` (a `Drawable`):
  the shape calls above, `clear()`, `draw(pass, frame)`, `destroy()`, and read-only `count`
  (segments appended), `capacity` (segments before the next growth) and `uploads`
  (`writeBuffer` calls so far). `DEBUG_VERTEX_FLOATS` is 7; `DEBUG_DRAW_WGSL` is the shader.
- Points (`DebugVec3`) are `[x, y, z]`, any typed array or an `{ x, y, z }` such as
  `Transform.position`; a rotation (`DebugQuat`) is `[x, y, z, w]` or `Transform.quaternion`.
  A `DebugColor` is `[r, g, b, a]` in linear 0..1 (alpha defaults to 1) or a packed
  `0xRRGGBBAA` whose bytes are divided by 255.
- Segment counts: `line` and `ray` 1, `arrow` 5, `box` and `frustum` 12, `wireSphere` `6 ×
  rings`, `axes` 3, `grid` `2 × (floor(size / step) + 1)`, `circle` `segments`, `path`
  `count - 1`.
- Growth happens on the CPU array when a call needs more room (1.5× until it fits); the GPU
  buffer is recreated at the next `draw`. After the capacity settles nothing allocates per
  frame. `draw` records nothing when there are no segments.
- `frame.drawable(debug, order)` places the lines in draw order like any drawable; with
  `depth: 'test'` they hide behind opaque geometry already drawn, so draw them after the scene.

## Billboards

`createBillboards(renderer, opts?: BillboardsOptions)` (or `new Billboards(renderer, opts)`) is one
batch of world-anchored, camera-facing quads: name plates, damage numbers, health bars, markers.
Each shows a region of the batch's text atlas or a solid colour, is sized in world units or in
screen px, optionally fades out over `life` and drifts by `velocity`. The batch is alpha blended,
depth tested without writing (`depth: 'test'`) or drawn over everything (`'always'`), sorted back
to front each `update`, and drawn in one or two calls through `frame.drawable(billboards)`.

```ts
import { createBillboards } from '@thunderclap/engine/fx';

const bb = createBillboards(renderer, { capacity: 256, atlas: { size: 1024, font: 'sans-serif' } });
const plate = bb.add({
  position: body.position,             // a Float32Array is followed live; a tuple is copied
  offset: [0, 2.2, 0],
  size: { px: [160, 40] },             // the same px size at any distance
  region: bb.text('Hero', { size: 28, stroke: '#000', strokeWidth: 4 }),
});
const hp = bb.add({ position: body.position, offset: [0, 1.9, 0], ...bb.bar(1, [1.4, 0.15], GREEN, DARK) });
hp.fraction = 0.6;
bb.add({                               // a damage number: rises, fades over the second half, removes itself
  position: [x, y, z], size: { px: [90, 40] }, region: bb.text('-37', { color: '#f44' }),
  life: 0.9, velocity: [0, 1.2, 0], depth: 'always',
});
bb.update(dt, camera);                 // in the update step
frame.drawable(bb, 10);                // in the render step, after the scene's meshes
```

- `BillboardDesc`: `position` (`Float32Array` or `[x, y, z]`), `offset?`, `size: BillboardSize`
  (`[w, h]` world units or `{ px: [w, h] }` logical px), `region?: AtlasRegion | null`, `color?`
  (straight-alpha RGBA, default white), `facing?: BillboardFacing` (`'camera'` or `'cameraY'`,
  upright and turning about y only), `depth?: BillboardDepth` (`'test'` or `'always'`), `life?`,
  `velocity?`, `bar?: { fraction, bg }`.
- `BillboardHandle`: `alive`, and setters `position`, `offset`, `color`, `size`, `region`,
  `fraction`. A dead handle's setters do nothing; `remove(handle)` is idempotent.
- `Billboards`: `add(desc)`, `remove(handle)`, `clear()`, `update(dt, camera?)` (ages, drifts,
  removes expired quads, touches their atlas regions, sorts back to front for `camera`),
  `prepare`/`draw` (the `Drawable` pair; `prepare` uploads the instances and, when the atlas
  changed, its canvas, once per frame at most), `text(text, style?: TextStyle): AtlasRegion`
  (throws when the string is larger than the atlas), `bar(fraction, size, fg, bg)` (a one-quad
  health bar: `fg` over `fraction` of the width, `bg` beyond; spread into `add` with a
  `position`), `count`, `atlasUsed`, `draws`, `atlasTexture` (the atlas as a `Texture`), `atlas`
  (the `TextAtlas`), `destroy()`.
- `BillboardsOptions`: `capacity` (default 1024; the arrays and the storage buffer double when
  `add` finds the batch full, never per frame otherwise), `atlas: TextAtlasOptions`, `label`.
- `pxToWorld(px, viewDistance, projection, viewportPx)`: the world span a `px` logical-px size
  covers at `viewDistance`, the CPU side of the shader's `{ px }` math.
- `BILLBOARD_WGSL` is the shader (six vertices per instance from a storage buffer, group 1:
  instances, `linear-clamp` sampler, atlas); `BILLBOARD_FLOATS` (20) and `BILLBOARD_BYTES` (80)
  are the instance stride, `BB_FLAG_PX`, `BB_FLAG_YAW`, `BB_FLAG_TEXTURED` and `BB_FLAG_BAR` the
  flag bits carried in `pos.w`. `{ px }` quads are placed in clip space from `camera.viewport`,
  `globals.targetSize` and `globals.logicalSize`; world quads take right and up from
  `camera.view`.

### Text atlas

`TextAtlas` (`new TextAtlas(opts?: TextAtlasOptions)`) rasterises strings once with the canvas
2D API into one square canvas, packed on shelves and cached by text and style; `Billboards`
owns one, and it works alone for any text-on-a-texture need.

- `TextAtlasOptions`: `size` (default 1024), `font` (default `'sans-serif'`), `canvas?:
  AtlasCanvas` (an `OffscreenCanvas` or `HTMLCanvasElement` by default; tests pass a stub whose
  `getContext('2d')` returns an `AtlasContext2D`, the subset of the 2D context the atlas uses).
- `TextStyle`: `font`, `size` (32), `color` (`'#fff'`), `stroke`, `strokeWidth`, `padding` (2);
  all part of the cache key.
- `text(text, style?): AtlasRegion | null` returns the cached region or draws a new one (`null`
  when the string is larger than the canvas). `AtlasRegion` is `u0, v0, u1, v1` (v down, as in
  the canvas) and `width, height` in atlas px.
- When the canvas is full the shelf whose newest entry is least recently used is cleared and
  reused (`evictions` counts them); `touch(region)` marks a region used now (`Billboards.update`
  does it for every live quad), `has(region)` says whether it is still valid, `clear()` forgets
  everything. `dirty` is set when the canvas has text the GPU has not seen; the owner uploads
  `canvas` and calls `markUploaded()`. `count` and `used` (shelf area share) describe the fill.

## Light helpers

Pure functions of time; feed the result into a tint, emissive or light intensity.

- `flicker(t, opts?: FlickerOptions)`: flame or torch flicker, two octaves of noise plus a rare
  dip. Options `seed`, `speed` (7), `amount` (0.3), `base` (1); returns `base * (1 - amount * n)`.
- `pulse(t, opts?: PulseOptions)`: cosine breathing between `min` (0.6) and `max` (1) over
  `period` seconds (2), offset by `phase` (0..1).
- `valueNoise1(x, seed = 0)`: smooth 1D value noise in [0, 1].

Tests: `particles.test.ts`, `particles-world.test.ts` (fake GPU), `trail.test.ts`,
`flicker.test.ts`. Demos: `harness/weather.html`, `harness/trails.html`.

## Sky

`Sky(renderer, opts?: SkyOptions)` is a `Drawable`: a procedural dome drawn as one fullscreen
triangle (`pass.draw(3)`), no asset, no instance. `frame.drawable(sky)` draws it.

```ts
import { Sky } from '@thunderclap/engine/fx';

const sky = new Sky(renderer, { stars: true });
// each frame
frame.lights = lights; // the sun and fog the sky follows
frame.drawable(sky);
sky.sunSize = 0.04; // every field is live
```

- Gradient `zenith` → `horizon` → `ground` by the ray's elevation; a band around the horizon
  mixes towards `lights.fog.color` (scaled by its density) so fogged geometry meets the sky.
- The sun disc (`sunSize`, angular radius in radians, default 0.03) and glow (`sunGlow`, default
  1) sit at `lights.sun`, tinted by its colour. Below the horizon the dome darkens and the stars
  come out; with no sun (colour zero) the dome is as set.
- `stars`: `true` for the defaults or `{ density, seed }` (`SkyStars`; default density 24, seed
  0); `null` for none. `exposure` multiplies the whole dome.
- Emissive: the sun disc and the stars are also written to the emissive target, so bloom picks
  them up.
- Depth: under a depth camera the triangle sits at the far plane with depth test on and depth
  write off, so geometry wins wherever it wrote depth whatever the order; `Camera.cull` is
  unaffected (nothing to cull). Without depth it paints the whole view: give it the lowest
  `order`.
- Uploads: the sun and fog come from the lights block; the sky's own upload is one 64-byte
  params block (`SKY_PARAMS_FLOATS` floats) per frame in `prepare`. No allocation per frame.
- `skyRay(camera, nx, ny, out)`: the world-space view direction through an NDC point, the same
  math the shader (`SKY_WGSL`) runs per pixel from `camera.proj` and `camera.view` (an analytic
  perspective inverse, off-centre terms included; an orthographic view gives its forward).

Tests: `sky.test.ts` (fake GPU, `skyRay` against `Camera.screenToWorld`). Demo:
`harness/sky.html` (`?still` parks the sun at noon).

## Water

`Water(renderer, opts?: WaterOptions)` is a `Drawable`: a flat plane of `geom.plane` in the 3D
vertex layout, shaded as a water surface, no asset, no instance. `frame.drawable(water, order,
layers)` draws it; `water.update(dt)` advances its waves.

```ts
import { Water, waterHeight } from '@thunderclap/engine/fx';

const water = new Water(renderer, { size: 60, segments: 64, displace: 0.1, level: 0 });
// each frame
water.update(dt);
frame.lights = lights; // the sun it glints under, the fog and sky tint
frame.drawable(water, 1);
water.foam = null; // every field is live
const y = waterHeight(water, boat.x, boat.z); // the surface under something floating
```

- `size` (100, or `[x, z]`) and `segments` (1, or `[x, z]`) build the plane once (`mesh`,
  centred on the origin at `level`); `level` is the resting height.
- Colour: `shallowColor` (0.1, 0.45, 0.45) at the shoreline fades to `deepColor` (0.01, 0.07,
  0.14) over `depthFade` (4) world units of water below the surface, measured from the scene
  depth (below). `fresnel` (0.6) scales a Schlick term that lerps that towards a sky colour
  (the fog colour at the horizon, bluer at the zenith; darkened at night, like `Sky`).
  `roughness` (0.08) sizes the sun's GGX highlight, which also goes to the emissive target so
  bloom picks it up. `opacity` (0.85) is the alpha away from the shore; the alpha ramps up from
  zero at the shoreline over a quarter of `depthFade`.
- `waves: WaterWave[]` (`scale`, `speed`, `amplitude`, `direction: [x, z]`): up to
  `WATER_MAX_WAVES` (4) analytic layers summed for the normal; `displace` (0) multiplies the sum
  into a vertex offset, so `displace: 0` is a flat mesh with animated shading. Two layers by
  default.
- `foam: { width (0.4), color }` draws a noisy foam line where the water is shallower than
  `width`; `null` for none.
- `waterHeight(water, x, z, t = water.time)` is the surface height at a point, the shader's
  formula in TypeScript (`level + displace × Σ amplitude × wave`), allocation-free.
- Depth: the water writes depth (`depthCompare: 'less-equal'`) and sorts with the blended
  draws. In `prepare` it copies the scene depth (`renderer.target.depth`, or
  `WaterOptions.depthTarget`) into its own `depth32float` texture, like soft particles, so
  the depth fade, shoreline alpha and foam follow the geometry under the surface. The copy is
  taken before the pass that draws the water, so in a single `renderer.render` view it holds
  the previous frame's depth, including the water's own surface; the shader treats a texel at
  its own depth as no information (deep, no foam). For a true shoreline draw the water in a
  second view of the same camera after the opaque one (`camera.layers` switched, water on its
  own layer, see `harness/water.ts`): its copy then holds this frame's opaque depth. Without a
  depth texture or under a camera without depth the surface is deep everywhere and foam is off.
- Uploads: one params block (`WATER_PARAMS_FLOATS` floats) per frame in `prepare`, plus the
  depth copy pass. No allocation per frame. `destroy()` releases the mesh, buffer and copy.
- `WATER_WGSL` (the surface, `WGSL_GLOBALS` + `WGSL_LIGHTS` + `WGSL_NOISE` + `WGSL_PBR`, group 1
  = params + depth copy) and `WATER_DEPTH_COPY_WGSL` (the copy pass) are exported for reuse.
  `WaterFoam` is the foam block's type.

Tests: `water.test.ts` (fake GPU, `waterHeight` against the WGSL formula). Demo:
`harness/water.html` (a basin with a ramp running into the water under a `Sky`; `?still` parks
the sun on the specular probe).
