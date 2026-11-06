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
  height }`, `line { dx, dy }`, and `mesh`, see *Mesh emission*), `angle`, `spread`, `speed`,
  `life`, `size`, `colorStart`, `colorEnd`, `gravity`, `drag`, `emissive`. Colours are linear
  RGBA (HDR allowed); units are logical px and seconds. The fields from `tile` on need the
  extended kernel (*The extended kernel*).
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
  depth. Without a depth camera or before the first depth frame it is skipped. With
  `readsDepth: true` (ws/render-hooks) the system makes no copy of its own: the renderer splits
  the view's scene pass and hands it this frame's opaque depth through `afterOpaque` (see the
  render README, "Depth hooks"); in a view that does not split the fade is off.

- `ParticleEmitter(system, params, rate = 0)`: continuous emission at `rate` per second while
  `active`, plus `burst(count, overrides?)`.

### The extended kernel (ws/fx-3)

World space, and a 2D system with `extended: true` (implied by `texture`, `forces` or
`collide`), run the extended kernel: a 160-byte particle (`FX_PARTICLE_FLOATS`), a 52-float
spawn record (`FX_SPAWN_FLOATS`), a sim block of `FX_SIM_FLOATS` (`MAX_FORCES` × 12 of them the
forces), a request ring of `FX_REQUEST_FLOATS` per sub-emission request, and four compute
entry points (`spawn`, `advance`, `update`, `subspawn`; the ring head lives on the GPU). A plain
2D system keeps the original kernel byte for byte (`PARTICLE_COMPUTE_WGSL`,
`PARTICLE_RENDER_WGSL`, E-008) and ignores the fields below with one warning. The sources are
exported for reuse: `PARTICLE_EXT_COMPUTE_WGSL` / `PARTICLE_EXT_RENDER_WGSL` (2D),
`PARTICLE_WORLD_COMPUTE_WGSL` / `PARTICLE_WORLD_RENDER_WGSL`, `PARTICLE_COLLIDE_WGSL`,
`PARTICLE_COUNT_WGSL`. `Range` is the `[min, max]` pair type the ranged fields take.

#### Sprite sheets

```ts
const sprites = new ParticleSystem(renderer, {
  space: 'world', blend: 'alpha', texture: sheet, atlas: { columns: 4, rows: 4 },
});
sprites.emit({ ...p, tile: [0, 15], tileRate: 12, rotation: [0, Math.PI * 2], spin: [-2, 2], alignToVelocity: false }, 8);
```

- `texture` (any `TextureLike`) replaces the radial falloff: the tile's alpha and colour
  multiply the particle's, in both blend modes. `atlas` is the grid, row-major from the top
  left (default 1 × 1). Untextured systems bind a 1 × 1 white texel and draw exactly as before.
- `EmitParams.tile`: one tile index, or `[from, to]` played once over the particle's life, or
  looped at `tileRate` frames per second. `rotation` (initial, radians about the view axis) and
  `spin` (rad/s) are `[min, max]` pairs; `alignToVelocity` (default true, the streaks) set to
  false keeps the quad upright plus its rotation, for sprites.

#### Curves

- `sizeCurve`: 2..`MAX_CURVE_STOPS` (8) evenly spaced sizes over life, replacing `size` (the
  per-particle jitter still applies). `colorCurve`: 2..8 RGBA stops replacing
  `colorStart`/`colorEnd`. Both are cached by array identity and rewritten on every emit, so
  mutate the array to animate; a system holds `maxCurves` (32) distinct arrays of each and
  reuses slots beyond that with a warning. The GPU table is `SIZE_CURVE_FLOATS` (12) per size
  curve and `COLOR_CURVE_FLOATS` (36) per colour curve.
- `evaluateCurve(stops, stride, t, out)` is the CPU reference (`stride` 1 for sizes, 4 for
  colours), the same piecewise-linear lookup the kernel does.

#### Forces and collision

```ts
const motes = new ParticleSystem(renderer, { space: 'world', forces: [] });
motes.forces.push({ kind: 'attract', x: 0, y: 2, z: 0, strength: 3, radius: 8 });
motes.forces.push({ kind: 'vortex', axis: [0, 1, 0], x: 0, y: 2, z: 0, strength: 1 });
motes.forces.push({ kind: 'turbulence', frequency: 0.5, strength: 2, seed: 7 });
motes.forces.push({ kind: 'drag', amount: 0.5 });
const rain = new ParticleSystem(renderer, { space: 'world', readsDepth: true, collide: { bounce: 0.2, friction: 0.6 } });
```

- `ParticleSystem.forces` is a live array of `ParticleForce` (`attract`, `vortex`,
  `turbulence`: the curl of value noise, divergence-free gusts; `drag`), uploaded each frame,
  at most `MAX_FORCES` (8). `applyForces(forces, pos, vel, dt)` is the CPU reference of the
  kernel's force step, for shadow simulations and tests.
- `collide: { bounce, friction, thickness? }` (world space with `readsDepth`): after the opaque
  pass each particle found behind this frame's scene depth, within `thickness` (1) units along
  its view ray, is put back on the surface; the normal velocity is scaled by `bounce`, the
  tangential by `1 - friction`. Deeper than `thickness`, the test is swept: a particle that was
  in front of the scene one step back (`pos - vel * dt`) crossed it this frame and goes back to
  that point, so a slow frame or a grazing view does not tunnel. The normal comes from the depth neighbours. Independent of
  `softness`; `ParticleSystem.collide` can be changed or set to null at any time.
- `countBelowY` (with `countAlive`): live particles below that y are also counted, into
  `below`.

#### Sub-emission

- `onDeath: { params, count }` emits `count` particles of `params` where a particle dies;
  `onLife: { params, rate }` emits `rate` per second along its path. `inherit` is the fraction
  of the parent's velocity the children start with. One level deep: a child's own
  `onDeath`/`onLife` is ignored. Requests are budgeted by `maxSpawnsPerFrame` per frame; a
  system holds `maxSubEmitters` (16) distinct descriptors (cached by object identity, rewritten
  on every emit).

#### Mesh emission

```ts
import { buildEmitSurface } from '@thunderclap/engine/fx';
const surface = buildEmitSurface(sphere({ radius: 1 }), { alongNormal: true });
glow.emit({ x, y, z, shape: surface, speed: [0.1, 0.3] }, 50);
```

- `EmitShape` `{ kind: 'mesh', positions, normals?, indices?, alongNormal? }` (a
  `MeshShapeSource`) births particles uniformly over a triangle mesh's area, offset by (x, y, z);
  `alongNormal` launches along the surface normal instead of `angle`/`spread`.
- `buildEmitSurface(geometry | source, { alongNormal? })` builds the cumulative-area table once
  (`EmitSurface`: `table`, `triangles`, `area`; `SURFACE_TRI_FLOATS` per triangle) and is itself
  a mesh shape; raw arrays passed as a shape are built and cached by identity on first use.
  `sampleEmitSurface(surface, u, v, w, out)` is the CPU mirror of the kernel's sampling.

#### Effects

```ts
import { createEffect, HIT_SPARK_EFFECT, MAGIC_AURA_EFFECT } from '@thunderclap/engine/fx';
const sparks = createEffect(renderer, HIT_SPARK_EFFECT);
sparks.play({ x: 640, y: 360 });              // one instance; play again for another
const aura = createEffect(renderer, MAGIC_AURA_EFFECT, { textures: {} });
const inst = aura.attach((out) => out.set(wandTip));
inst.stop();                                  // the particles already born die on their own
// each frame
sparks.update(dt); aura.update(dt);
sparks.draw(frame); aura.draw(frame, 2);
```

- `EffectDesc` is plain JSON: `systems` (`EffectSystemDesc`: `name`, `options`:
  `EffectSystemOptions`, the system options with `texture` as a name; `emitters`:
  `EffectEmitterDesc`: `params`, `rate`, `duration`, `delay`, `burst`), `duration`, `loop`.
  `validateEffectDesc(json, { textures? })` returns the problems (stop counts, unknown texture
  names, missing colours, negative numbers, a second level of sub-emission) as strings;
  `createEffect(renderer, desc, { textures? })` throws them as one readable `Error` and resolves
  texture names through the map.
- `Effect`: `systems`, `instances` (pooled `EffectInstance`s: `position`, `time`, `done`,
  `attach(fn)`, `stop()`), `duration`, `loop`, `play(at?: EffectPoint)`, `attach(fn:
  EffectFollow)`, `stop()`, `update(dt)` (drives the emitters and the systems; no allocation
  after the first play), `draw(frame, order?)`, `destroy()`.
- Bundled descriptors (`src/fx/effects/*.json`): `HIT_SPARK_EFFECT` (2D, a burst of streaked
  sparks on curves plus a flash), `SMOKE_PUFF_EFFECT` (2D alpha, growing spinning puffs),
  `MAGIC_AURA_EFFECT` (world, looping motes that trail through `onLife`). A game's own go
  through `createBundle` as `{ kind: 'json', uri }` and `validateEffectDesc`.

Harness: `fx3.html` (`?sheet`, `?forces`, `?collide`, `?sub`, `?effect`, `?still`) with
`e2e/fx3.spec.ts`. Tests: `particles-world.test.ts` (the extended kernel on the fake GPU),
`emit-surface.test.ts`, `effect.test.ts`.

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
  0); `null` for none. `exposure` multiplies the whole dome. `ambientFloor` (0.06) is how dark
  the dome goes at night, as a fraction of its daytime colour.
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

## Decals

`Decals(renderer, opts: DecalsOptions)` is a `Drawable`: an atlas stamped onto scenery, every
live decal in one instanced draw. `frame.drawable(decals, order)` draws them after the geometry
they sit on; `decals.update(dt)` ages them.

```ts
import { Decals } from '@thunderclap/engine/fx';

const decals = new Decals(renderer, {
  texture: atlas, // any TextureLike
  atlas: { columns: 2, rows: 2 },
  capacity: 256,
  blend: 'alpha', // | 'multiply' | 'additive'
  fade: [1, 0], // alpha at age 0 and at the lifetime
  lifetime: 8, // seconds, default Infinity
});
const h = decals.add({ x, y, z, nx, ny, nz, size: 1.5, rotation: 0.3, tile: 2, color: [1, 0.2, 0.2, 1] });
// each frame
decals.update(dt);
frame.drawable(decals, 1);
decals.remove(h);
```

- `add(desc: DecalDesc): number` returns a handle (ids increase; `has(handle)`, `ageOf(handle)`).
  The decal is a `size`-wide square facing along the normal, spun by `rotation` about it, sampling
  atlas `tile` (row-major) times `color`. When `capacity` is full the oldest live decal is
  overwritten. `remove(handle)` marks it dead; `update(dt)` (or the next `prepare`) compacts the
  live decals to the front and keeps the handle → slot map, so nothing allocates per frame when
  nothing died. `clear()` empties it; `count` is the live number.
- Two implementations behind one API, `mode: 'auto' | 'box' | 'quad'` (`DecalMode`, default
  `auto`: `box` under a depth camera, else `quad`; `activeMode` is the one the last frame used).
  - **Box**: each decal is a unit box in its own frame. The fragment reconstructs the world
    position under the pixel from a copy of the scene depth (`inv_view_proj × (ndc, depth)`),
    maps it into the box, rejects what is outside, samples the atlas by the local xy and fades
    over the outer `fadeEdge` share of the box's half depth (default 0.2) and by `normalBias`
    (default 0.3): a surface whose normal, from `dpdx`/`dpdy` of the reconstructed position,
    makes a cosine below it with the decal's is skipped. Depth test and write off, so the decal
    wraps corners and steps. The copy (an own `depth32float` texture, as the particles' soft
    depth) is taken in `prepare`, before this frame's scene pass, so it holds the **previous
    frame's** depth: a decal placed this frame appears next frame, and a camera cut shows one
    frame of mismatch. Nothing is drawn until the scene has rendered depth once.
  - **Quad**: a camera-independent quad lifted along the normal by `offset` (default 0.01),
    depth test on, write off. The fallback without depth, or by `mode: 'quad'`.
- Blend `DecalBlend`: `alpha` (default), `additive`, or `multiply` (the shader lerps its colour
  towards white by alpha and the blend multiplies the destination). `fade: [a0, a1]` is the alpha
  over normalised age; decals that live forever keep `a0`.
- Instances: `DECAL_INSTANCE_FLOATS` (24) floats each in a preallocated `Float32Array`, uploaded
  once per frame: the world → local 3×4 matrix (rows at `@location(3..5)`), the atlas rect, the
  colour and age / lifetime. The params block (`DECAL_PARAMS_FLOATS`: the camera's
  `invViewProj`, the shape values, the fade) is 96 bytes. `WGSL_DECAL_BOX`, `WGSL_DECAL_QUAD`
  and `WGSL_DECAL_DEPTH_COPY` are exported.

Tests: `decals.test.ts` (fake GPU: ring buffer order, compaction, mode by `frame.depthFormat`,
instance layout, expiry). Demo: `harness/decals.html` (click to stamp; `?mode=box|quad`).

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
  centred on `origin` (`[0, 0, 0]`) at `level`); `level` is the resting height above the
  origin's y. A world whose corner is the origin puts its water at `origin: [sizeX / 2, 0,
  sizeZ / 2]`.
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
  With `readsDepth: true` (ws/render-hooks, `harness/water.html?hook=1`) the water makes no
  copy: the renderer splits the view's scene pass at the water and hands it this frame's opaque
  depth through `afterOpaque`, so one view gives a true shoreline; in a view that does not split
  the surface is deep everywhere. Decals will use the same hook when they land (ws/decals).
- Uploads: one params block (`WATER_PARAMS_FLOATS` floats) per frame in `prepare`, plus the
  depth copy pass. No allocation per frame. `destroy()` releases the mesh, buffer and copy.
- `WATER_WGSL` (the surface, `WGSL_GLOBALS` + `WGSL_LIGHTS` + `WGSL_NOISE` + `WGSL_PBR`, group 1
  = params + depth copy) and `WATER_DEPTH_COPY_WGSL` (the copy pass) are exported for reuse.
  `WaterFoam` is the foam block's type.

Tests: `water.test.ts` (fake GPU, `waterHeight` against the WGSL formula). Demo:
`harness/water.html` (a basin with a ramp running into the water under a `Sky`; `?still` parks
the sun on the specular probe).
