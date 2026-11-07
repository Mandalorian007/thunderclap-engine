# Style your game: post effects, sky, water and weather

## What you'll build

This guide changes how your game looks without changing what it draws. You tune the post
stack (bloom, tone mapping, colour grade and the rest), pick a quality tier per device, and
add effects: flickering lights, trails, decals, labels, a sky, water and falling snow.

It works for 2D and 3D. The sky, water and weather sections need a perspective camera, as in
[Make a 3D game](3d-game.md).

## The post stack

Your scene renders into an HDR image. `ctx.post` (a `PostStack`) turns that into the picture
on screen through a chain of passes. Set it up front through `createGame`, or change it at
any time.

```ts
import type { EngineCtx } from '@thunderclap/engine';

export function tunePost(ctx: EngineCtx) {
  // A patch merges per section. Fields you leave out keep their value.
  ctx.post.set({
    bloom: { intensity: 1.2, threshold: 1.0 },
    grade: { exposure: 1.1, saturation: 1.15, contrast: 1.05, tonemap: 'aces' },
    vignette: { intensity: 0.3 },
  });
  // Or change one field directly.
  ctx.post.settings.vignette.enabled = false;
}
```

Changing settings is cheap. It never rebuilds pipelines, so you can animate values every
frame.

The stack starts from `cinematicPostSettings()`, tuned for a dark, moody scene. Bloom, a
floor mist, god rays, a vignette and a colour grade are on. If your game looks hazy or too
dark, start from `neutralPostSettings()` instead, which turns the extras off and keeps only
the tone map, and add back what you want:

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { neutralPostSettings } from '@thunderclap/engine/post';

export function plainPost(ctx: EngineCtx) {
  ctx.post.set(neutralPostSettings());
  ctx.post.set({ bloom: { enabled: true, intensity: 0.6 } }); // then add back what you want
}
```

## The core passes

- **Bloom** makes bright pixels glow. A pixel blooms when it is brighter than `threshold`, or
  when a material writes `emissive`. `intensity`, `knee`, `scatter` and `levels` shape it.
- **Grade and tone map**: `grade.exposure` scales brightness. `tonemap` (`'aces'`,
  `'reinhard'` or `'none'`) maps HDR to the screen. `lift`, `gamma` and `gain` are RGB
  triples for shadows, midtones and highlights. `saturation` and `contrast` are plain numbers.
- **Vignette** darkens the edges: `intensity`, `radius`, `softness`, `color`.
- **God rays** stream from a light point: `x` and `y` in design pixels (they may be off
  screen), plus `intensity`, `decay`, `density`, `weight` and `color`. In 3D, set
  `direction` to the sun's direction (the same value as `lights.sun.direction`) and the rays
  follow the sun on screen as the camera turns, fading out when it is behind you.
- **Mist** (`mist`) is a screen-space haze rising from the bottom of the screen (`top`,
  `bottom`, `falloff`, `density`). It is not distance fog: for that, use `lights.fog`. You can
  use both; the mist goes on top of the fogged scene. Older code calls this section `fog`,
  which still works.

## 3D passes

These read the depth buffer. They are off by default. Turn them on when your scene is 3D.

```ts
import type { EngineCtx } from '@thunderclap/engine';

export function cinematic(ctx: EngineCtx) {
  ctx.post.set({
    ao: { enabled: true, radius: 0.5, intensity: 1 }, // contact shadows in corners
    dof: { enabled: true, focusDistance: 8, focusRange: 4, maxBlur: 6 }, // blur outside the focus band
    taa: { enabled: true }, // smooths jagged edges over frames
    ssr: { enabled: true }, // reflections on smooth surfaces
    motionBlur: { enabled: true, intensity: 0.6 },
    exposure: { mode: 'auto' }, // adapts like an eye between dark and bright areas
  });
}
```

Each one costs GPU time. Turn them on one at a time and check the frame time on your slowest
target device.

## Finishing passes

These run last and give a game its texture:

- `fxaa: { enabled: true }` is cheap anti-aliasing when TAA is off.
- `grain: { intensity }` adds film grain.
- `aberration: { intensity }` splits colour at the edges.
- `sharpen: { amount }` restores detail after TAA or a lower render scale.
- `outline: { enabled, color, thickness }` draws ink lines on depth and normal edges, for
  a toon look.
- `whiteBalance: { temperature, tint }` warms or cools the image.
- `lut: { texture, size, intensity }` applies a colour lookup table made with `createLutTexture`.

## Change the mood over time

`blendTo` eases settings to new values over a number of seconds. Use it for a day turning to
night, entering a cave or taking damage.

```ts
import type { EngineCtx } from '@thunderclap/engine';

export function enterCave(ctx: EngineCtx) {
  ctx.post.blendTo({ grade: { exposure: 0.6, saturation: 0.7 }, vignette: { intensity: 0.5 } }, 2);
}
```

## Pick a quality tier

Phones cannot run every pass at full size. `postQualityFor(tier)` returns sample counts and
sizes for `'phone'`, `'tablet'`, `'desktop'` or `'xr'`. Map the layout's form factor to a
tier when the game starts.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { postQualityFor } from '@thunderclap/engine/post';

export function applyQuality(ctx: EngineCtx) {
  const ff = ctx.ui.layout.formFactor;
  const tier = ff === 'desktop' ? 'desktop' : ff === 'tablet' ? 'tablet' : 'phone';
  ctx.post.setQuality(postQualityFor(tier));
  if (tier === 'phone') ctx.renderer.setResolution({ scale: 0.75 });
}
```

`setResolution({ scale })` renders the 3D scene at a fraction of the screen size and scales
it up. `sharpen` helps the result look crisp.

## Flickering and pulsing lights

`flicker` and `pulse` return a number for time `t`. Use them for torch light, warning lamps
or glowing pickups. They are pure functions, so the same `t` always gives the same value.

```ts
import { flicker, pulse } from '@thunderclap/engine/fx';
import { Lights } from '@thunderclap/engine/render';

const lights = new Lights();
const torch = { position: [2, 1.5, 0], color: [1, 0.6, 0.3], radius: 6 };
lights.points.push(torch);

export function tickLights(t: number) {
  const k = flicker(t, { seed: 1, speed: 8, amount: 0.35, base: 1 });
  torch.color[0] = 1 * k;
  torch.color[1] = 0.6 * k;
  torch.color[2] = 0.3 * k;
  return pulse(t, { min: 0.5, max: 2, period: 1.2 }); // use as a pickup's emissive strength
}
```

## Trails, decals and labels

A `Trail` draws a ribbon behind a moving point: a sword swing, a missile, a fast car.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import type { Camera, Frame } from '@thunderclap/engine/render';
import { Trail } from '@thunderclap/engine/fx';

export function createSwordTrail(ctx: EngineCtx) {
  const trail = new Trail(ctx.renderer, {
    space: 'world',
    maxPoints: 32,
    width: 0.2,
    color: [0.6, 0.8, 1, 1],
    lifetime: 0.25,
    blend: 'additive',
  });
  return {
    tick(tip: ArrayLike<number>, dt: number, camera: Camera) {
      trail.push(tip[0]!, tip[1]!, tip[2]!);
      trail.update(dt, camera);
    },
    draw(frame: Frame) {
      trail.draw(frame);
    },
  };
}
```

`Decals` stamps textures onto surfaces: scorch marks, footprints, bullet holes. Each decal has
a position, the surface normal, a size and a tile in the atlas. They fade out after
`lifetime` seconds.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { Decals } from '@thunderclap/engine/fx';
import type { TextureLike } from '@thunderclap/engine/render';

export function createScorch(ctx: EngineCtx, texture: TextureLike) {
  const decals = new Decals(ctx.renderer, { texture, atlas: { columns: 2, rows: 2 }, capacity: 64, lifetime: 20 });
  decals.add({ x: 1, y: 0, z: -2, nx: 0, ny: 1, nz: 0, size: 1.5, rotation: 0.7, tile: 0 });
  return decals; // each frame: decals.update(dt); frame.drawable(decals, 1);
}
```

Billboards are flat sprites or text that always face the camera, such as name tags over
characters. `bb.text` makes a text region in the billboard atlas.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { createBillboards } from '@thunderclap/engine/fx';

export function nameTag(ctx: EngineCtx) {
  const bb = createBillboards(ctx.renderer, { capacity: 32 });
  const tag = bb.add({ position: [0, 2.1, 0], size: { px: [120, 28] }, region: bb.text('Hero', { size: 24 }) });
  return { bb, tag }; // each frame: bb.update(dt, camera); frame.drawable(bb, 10);
}
```

For text that should look like the rest of your UI, pin a DOM element with `ui.anchors`
instead; see [UI and HUD](ui-and-hud.md).

## Sky and water

`Sky` draws a gradient sky with a sun disc and optional stars. It follows `lights.sun` and
`lights.fog`, so the sun in the sky matches your shadows and the horizon matches the fog.
Draw it first.

`Water` draws a plane of moving waves at a height. `waterHeight(water, x, z)` returns the wave
height at a point, so a boat can bob on it.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import type { Scene } from '@thunderclap/engine/core';
import { Sky, Water, waterHeight } from '@thunderclap/engine/fx';
import { type Frame, Lights, Transform } from '@thunderclap/engine/render';

export function coast(): Scene<EngineCtx, Frame> {
  const lights = new Lights();
  const boat = new Transform();
  let sky: Sky;
  let water: Water;
  return {
    name: 'coast',
    enter(ctx) {
      ctx.camera.setPerspective(Math.PI / 3, ctx.design.width / ctx.design.height, 0.1, 500);
      ctx.camera.lookAt([0, 6, 20], [0, 0, 0]);
      lights.sun.direction = [-0.3, -0.6, -0.5];
      lights.sun.color = [1.3, 1.15, 0.95];
      sky = new Sky(ctx.renderer, { stars: true });
      water = new Water(ctx.renderer, { size: 200, segments: 128, level: 0 });
    },
    update(dt) {
      water.update(dt);
      boat.setPosition(0, waterHeight(water, 0, 0), 0);
    },
    render(frame) {
      frame.lights = lights;
      frame.drawable(sky);
      frame.drawable(water, 1);
      // frame.mesh(boatMesh, boatMat, boat);
    },
  };
}
```

Change `sky.sunSize`, `sky.sunGlow` or `sky.exposure` at any time. Move `lights.sun.direction` over
the day and the sky follows.

## Weather

Rain and snow are world-space particles. Build a `ParticleSystem` in world space, and a
`ParticleEmitter` that spawns flakes in a box above the player. Move the emitter with the
player so the weather is always around them.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { ParticleEmitter, ParticleSystem } from '@thunderclap/engine/fx';
import type { Frame } from '@thunderclap/engine/render';

export function createSnow(ctx: EngineCtx) {
  const snow = new ParticleSystem(ctx.renderer, {
    space: 'world',
    capacity: 6144,
    blend: 'alpha',
    lit: true, // takes the sun and ambient
    fade: { near: 28, far: 48 }, // thins out with distance
    softness: 0.3, // no hard line where flakes meet the ground
    stretch: 0,
  });
  const flakes = new ParticleEmitter(
    snow,
    {
      x: 0, y: 14, z: 0,
      shape: { kind: 'box', width: 44, height: 2, depth: 44 },
      speed: [0, 0.3],
      life: [5, 7],
      size: [0.1, 0.08],
      colorStart: [1, 1, 1, 0.9],
      colorEnd: [1, 1, 1, 0.5],
      gravity: [0, -0.7, 0],
      wind: [0.5, -1.2, 0.2],
      drag: 1.5,
      emissive: 0,
    },
    700, // flakes per second
  );
  return {
    update(dt: number, player: ArrayLike<number>) {
      flakes.params.x = player[0]!;
      flakes.params.y = player[1]! + 14;
      flakes.params.z = player[2]!;
      flakes.update(dt);
      snow.update(dt);
    },
    draw(frame: Frame) {
      frame.drawable(snow, 1);
    },
  };
}
```

For rain, use `blend: 'additive'`, a `stretch` above 0 so drops streak along their motion,
faster gravity, and `floorY` so drops stop at the ground. The first-person template's snow is
the code above.

## Next

- [post reference](../../src/post/README.md): every setting and its default
- [fx reference](../../src/fx/README.md): particles, trails, decals, billboards, sky, water
- [render reference](../../src/render/README.md): lights, fog, resolution scale
- [Make a 3D game](3d-game.md)
- [Characters](characters.md)
- [UI and HUD](ui-and-hud.md)
- [XR](xr.md): what the post stack does in a headset
