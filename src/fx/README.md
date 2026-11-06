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
