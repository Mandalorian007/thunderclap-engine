# Make a 2D game

## What you'll build

This guide walks through the pieces a 2D game uses: sprites, the 2D camera, textures and atlases, your own shaders, flipbooks, tile maps, parallax, a following camera and particles. The `templates/puzzle` and `templates/platformer` folders use every one of them, so open them next to this page.

## The design space

Your game draws in a fixed design space of 1920 by 1080 units. The origin is the top-left corner and y points down. One unit is one design pixel. The engine scales that space to fit any screen and letterboxes the rest, so you never deal with the real canvas size.

`createGame` gives you `ctx.camera`, a `Camera.ortho2d(1920, 1080)`. With the camera at rest, a sprite at `x: 960, y: 540` sits in the middle of the screen. Pass `design: { width, height }` to `createGame` if you want a different size.

## Draw a sprite

A scene draws in `render(frame)`. The simplest draw is `frame.sprite(material, params)`. Pass `null` as the material for a flat coloured quad.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { Scene } from '@thunderclap-engine/engine/core';
import { type DrawParams, type Frame, hex } from '@thunderclap-engine/engine/render';

export function createSquareScene(ctx: EngineCtx): Scene<EngineCtx, Frame> {
  // Build draw params once. Mutate them each frame; never create them inside render.
  const square: DrawParams = { x: 960, y: 540, w: 200, h: 200, tint: hex('#3fe0ff') };
  return {
    name: 'square',
    update(dt) {
      square.rotation = (square.rotation ?? 0) + dt; // radians, clockwise
    },
    render(frame) {
      frame.clear(0.02, 0.02, 0.04);
      frame.sprite(null, square);
    },
  };
}
```

`DrawParams` fields:

- `x`, `y`: the centre of the quad. `w`, `h`: its size. A negative `w` flips the sprite horizontally, which is how the platformer turns its player around.
- `rotation`: radians, clockwise.
- `tint`: linear RGBA. `hex('#rrggbb', intensity)` builds one.
- `uv`: `[u0, v0, u1, v1]`, the part of the texture to show.
- `emissive`: how much of the colour goes to the glow target (see below).
- `params`: a free vec4 for your own shader.
- `order`: a sort key. Draws render by `order`, then in the order you submit them. Leave it at 0 unless something must go on top.
- `layers`: a bit mask matched against `camera.layers`.

Draws that share a material in a row are merged into one GPU call. Group your draws by material and you get a handful of calls for a whole level.

## Draw through a Transform

If you want parent and child objects, or a cached matrix, use a `Transform` instead of `x, y, w, h`. The engine's quad spans -0.5 to 0.5, so the transform's scale is the sprite's size in design pixels.

```ts
import { type Frame, hex, Transform } from '@thunderclap-engine/engine/render';

const ship = new Transform({ x: 960, y: 540, scaleX: 128, scaleY: 64 });
// A child is local to its parent: 0.5 is the ship's right edge, before scaling.
const light = new Transform({ x: 0.5, scaleX: 0.2, scaleY: 0.4, parent: ship });
const lightParams = { tint: hex('#ffcc66', 3), emissive: 1 };

export function drawShip(frame: Frame, dt: number) {
  ship.rotation += dt;
  frame.sprite(null, ship, { tint: hex('#8899aa') });
  frame.sprite(null, light, lightParams);
}
```

The third argument is `InstanceParams`: the same as `DrawParams` without `x`, `y`, `w`, `h` and `rotation`. The puzzle template draws each card this way and squeezes `setScale` along x to animate a flip.

## Make things glow

The renderer writes two images each frame: colour and emissive. The post stack blooms the emissive image and adds it back on top. Two things make a sprite glow:

- `emissive`: a factor from 0 up. With the built-in sprite shader, the emissive output is the sprite's colour times `emissive`.
- An HDR tint: colours above 1 are allowed. `hex('#3fe0ff', 4)` is four times brighter than the hex value and blooms strongly.

Bloom is on by default. Tune it through `ctx.post`:

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export function setupGlow(ctx: EngineCtx) {
  ctx.post.set({ bloom: { intensity: 1.2 } }); // merges into the current settings
}
```

You can also pass the same patch as `post` to `createGame`.

## Textures and atlases

Upload an image with `renderer.textureFromSource`, then wrap it in a sprite material. It accepts an `ImageBitmap`, `ImageData`, a canvas or an `HTMLImageElement`.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { DrawParams } from '@thunderclap-engine/engine/render';

export async function loadHero(ctx: EngineCtx, url: string) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const tex = ctx.renderer.textureFromSource(bitmap, 'hero');
  // 'nearest-clamp' keeps pixel art crisp. The default is 'linear-clamp'.
  const hero = ctx.renderer.createSpriteMaterial({ texture: tex, label: 'hero', sampler: 'nearest-clamp' });
  const draw: DrawParams = { x: 960, y: 540, w: 128, h: 128 };
  return { hero, draw };
}
```

Put many sprites in one texture (an atlas) so they share one material and batch into one call. Two ways to get UVs out of an atlas:

- **A grid.** If every cell is the same size, `atlasFrames({ cols, rows }, indices)` returns the UV rect of each listed cell (row-major). Add `inset: 0.5, width, height` (the texture size in texels) to pull every rect in by half a texel, so a neighbour cell never bleeds in. It allocates, so call it at load time.
- **Packed images.** `packAtlas` from `@thunderclap-engine/engine/assets` packs named images of any size into one sheet. `createAtlasTexture` uploads it. Each rect has `u0`, `v0`, `u1`, `v1`.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createAtlasTexture, packAtlas } from '@thunderclap-engine/engine/assets';
import type { DrawParams } from '@thunderclap-engine/engine/render';

export function buildSheet(ctx: EngineCtx, coin: ImageBitmap, gem: ImageBitmap) {
  const images = { coin, gem };
  const layout = packAtlas(images, { padding: 2 });
  // mips: false for pixel art.
  const sheet = createAtlasTexture(ctx.gpu.device, layout, images, { mips: false });
  const material = ctx.renderer.createSpriteMaterial({ texture: sheet.texture, label: 'sheet' });
  const r = sheet.rects.gem;
  const gemDraw: DrawParams = { x: 400, y: 300, w: r.w, h: r.h, uv: [r.u0, r.v0, r.u1, r.v1] };
  return { material, gemDraw };
}
```

The platformer paints its whole atlas on a canvas at boot (`templates/platformer/src/world/atlas.ts`): 8 by 8 cells of 64 px, every tile, frame and prop. With nearest sampling, inset each UV rect by half a texel so a neighbour cell never bleeds into a sprite's edge. Its `cellUv` helper does that; `atlasFrames` does the same with `inset`.

## Write your own shader

A material is a WGSL fragment shader. The engine prepends a prelude, so you only write `fs_main`. The prelude gives you:

- `VSOut`, the input to your shader. The useful fields for 2D: `uv` (texture coordinates), `local` (0 to 1 across the quad), `color` (the tint), `params` (your vec4), `emissive` and `world` (the design-space position).
- `FragOut`, with `color` and `emissive` outputs.
- `globals.time`, `globals.dt` and `globals.logicalSize`.
- Noise helpers: `engine_hash21`, `engine_noise`, `engine_fbm(p, octaves)`.

Your own bindings go in `@group(1)`: binding 0 is the uniform block, binding 1 the sampler, binding 2 onward the textures.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { type DrawParams, type Frame, hex } from '@thunderclap-engine/engine/render';

export function createPulseOrb(ctx: EngineCtx) {
  const orb = ctx.renderer.createMaterial({
    label: 'orb',
    blend: 'alpha',
    wgsl: /* wgsl */ `
      @fragment fn fs_main(in: VSOut) -> FragOut {
        let r = length(in.local * 2.0 - 1.0);
        let speed = in.params.x;
        let pulse = 0.5 + 0.5 * sin(globals.time * speed);
        let a = 1.0 - smoothstep(0.9, 1.0, r);
        var o: FragOut;
        o.color = vec4f(in.color.rgb, a);
        o.emissive = vec4f(in.color.rgb * in.emissive * pulse * (1.0 - r), a);
        return o;
      }`,
  });
  const draw: DrawParams = {
    x: 960, y: 540, w: 300, h: 300,
    tint: hex('#ff5af0', 2),
    emissive: 1.5,
    params: [3, 0, 0, 0], // in.params.x: pulse speed
  };
  return (frame: Frame) => frame.sprite(orb, draw);
}
```

Use `params` for a value that differs per sprite. For values shared by every draw of a material, add `uniformBytes: 16` and `@group(1) @binding(0) var<uniform> u: vec4f;`, then call `orb.setUniforms(new Float32Array([...]))` whenever they change. For a texture, add `textures: 1`, declare `@group(1) @binding(1) var samp: sampler;` and `@group(1) @binding(2) var tex: texture_2d<f32>;`, and call `orb.setTexture(0, tex)`.

`blend` is `'alpha'` (the default), `'premultiplied'`, `'additive'`, `'multiply'` or `'opaque'`.

## Animate with a flipbook

A flipbook steps through a list of UV rects over time. It is pure timing: you copy its `uv` into your draw params.

```ts
import { atlasFrames, createFlipbook, type DrawParams, type Frame, type Material } from '@thunderclap-engine/engine/render';

const grid = { cols: 8, rows: 8, inset: 0.5, width: 512, height: 512 }; // 64 px cells
const idle = atlasFrames(grid, [16, 17]);
const run = atlasFrames(grid, [18, 19, 20, 21]);
const book = createFlipbook({ frames: idle, fps: 4 });
const player: DrawParams = { x: 300, y: 800, w: 64, h: 64 };

export function stepPlayer(dt: number, running: boolean) {
  book.play(running ? run : idle); // play() restarts the clip, so call it only on a change
  book.fps = running ? 12 : 4;
  book.update(dt);
}

export function drawPlayer(frame: Frame, atlas: Material, facing: 1 | -1) {
  player.uv = book.uv;
  player.w = 64 * facing; // negative width flips
  frame.sprite(atlas, player);
}
```

Set `loop: false` for a one-shot clip. It holds its last frame and sets `done`. In real code, track the current state and only call `play` when it changes, as the platformer's `setBook` does.

## Build a tile map

`createTileLayer` draws a whole grid of atlas cells as one mesh in one draw call. Fill it from your level data, then draw it each frame.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createTileLayer, type Material } from '@thunderclap-engine/engine/render';

export function buildMap(ctx: EngineCtx, atlas: Material, level: string[]) {
  const map = createTileLayer(ctx.renderer, {
    material: atlas,
    tileW: 64,
    tileH: 64,
    columns: level[0]!.length,
    rows: level.length,
    atlas: { cols: 8, rows: 8 },
    label: 'map',
  });
  for (let row = 0; row < level.length; row++) {
    for (let col = 0; col < level[row]!.length; col++) {
      if (level[row]![col] === '#') map.set(col, row, 0); // atlas cell 0; -1 is empty
    }
  }
  return map; // in render: map.draw(frame). On exit: map.destroy().
}
```

- `fill(tiles)` sets every tile at once from an `Int16Array` or `number[]`, row-major.
- `origin` is the layer's top-left in world units. `scale` scales it.
- `draw(frame, params)` takes `tint`, `order`, `emissive` and the other draw fields.
- Only tiles you changed are uploaded, so editing a map at runtime is cheap.

The platformer's level format (`templates/platformer/src/levels/format.ts`) turns rows of characters like the ones above into tile kinds, and `world/world.ts` turns kinds into atlas cells.

## Add parallax

`createParallax` slides tile layers at a fraction of the camera's movement. A factor of 0 pins a layer to the screen; 1 moves it with the world. `wrapW` is the width of the repeating pattern, so a strip one view plus one period wide covers any scroll.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createParallax, type Frame, type TileLayer } from '@thunderclap-engine/engine/render';

export function buildSky(ctx: EngineCtx, mountains: TileLayer, hills: TileLayer) {
  const sky = createParallax(ctx.renderer, [
    { layer: mountains, factorX: 0.15, factorY: 0.15, wrapW: 28 * 64, params: { tint: [0.55, 0.55, 0.55, 1] } },
    { layer: hills, factorX: 0.4, factorY: 0.4, wrapW: 24 * 64 },
  ]);
  return (frame: Frame) => {
    sky.update(ctx.camera.x, ctx.camera.y); // after the camera moved
    sky.draw(frame); // far to near, one draw per layer
  };
}
```

Set each layer's `origin` before you call `createParallax`: that position is the base the parallax offsets from. See `templates/platformer/src/world/parallax.ts`.

## Follow the player with the camera

`camera.x` and `camera.y` pan the view (the view's top-left, in design px); `camera.zoom` zooms it. `createFollow2D` writes them for you, with a dead zone, look-ahead, smoothing and level bounds.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createFollow2D } from '@thunderclap-engine/engine/render';

export function createCameraRig(ctx: EngineCtx, worldW: number, worldH: number) {
  const follow = createFollow2D(ctx.camera, {
    deadZone: { w: 180, h: 240 }, // the target can move this much before the camera does
    lookAhead: { x: 260, y: 0 }, // lead in the direction of motion
    lookAheadSmoothing: 0.35, // seconds
    smoothing: 0.18, // seconds; 0 is instant
    bounds: { minX: 0, minY: 0, maxX: worldW, maxY: worldH },
  });
  return {
    // Call once per fixed step with the player's centre and a velocity sign.
    update: (dt: number, x: number, y: number, vx: number) => follow.update(dt, x, y, vx, 0),
    respawn: (x: number, y: number) => follow.teleport(x, y), // snap, no easing
  };
}
```

When you leave a level, zero the camera (`ctx.camera.x = 0; ctx.camera.y = 0`) so menus draw in the right place.

## Fit the world into the space the HUD leaves

The DOM HUD takes bars and side columns, and their size changes with the device. `ctx.ui.layout.freeRect` is the rectangle left for your world, in CSS pixels. `camera.fitFreeRect` frames a world rectangle inside it, converting units for you. Call it on enter and whenever the layout or the canvas changes.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { CameraPoint, CameraRect } from '@thunderclap-engine/engine/render';

export function frameBoard(ctx: EngineCtx, board: CameraRect) {
  const fit = () => ctx.camera.fitFreeRect(board, ctx.ui.layout.freeRect, ctx.surface);
  fit();
  const offs = [ctx.ui.layout.onChange(fit), ctx.surface.onResize(fit)];
  return () => offs.forEach((off) => off()); // call on exit
}

const hit: CameraPoint = { x: 0, y: 0, z: 0 };

/** A tap position (design px, as `ctx.gestures.tap` gives it) to world units. */
export function tapToWorld(ctx: EngineCtx): CameraPoint | null {
  const tap = ctx.gestures.tap;
  if (!tap) return null;
  return ctx.camera.screenToWorld(tap.x, tap.y, hit); // the point on the sprites' plane, z = 0
}
```

Once the camera has moved or zoomed, screen and world coordinates differ. Always convert a tap or `ctx.input.pointer` with `screenToWorld` before you test it against the world. Pass a reused `out` point so nothing is allocated. `worldToScreen` goes the other way. The [UI and HUD guide](ui-and-hud.md) covers the layout regions and `LayoutSpec` that decide how big the free rect is.

## Particles

`ctx.particles` is a shared GPU `ParticleSystem`. The engine steps it each fixed step; you emit into it and draw it.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { EmitParams } from '@thunderclap-engine/engine/fx';
import { type Frame, hex } from '@thunderclap-engine/engine/render';

const sparkle: EmitParams = {
  x: 0,
  y: 0,
  spread: Math.PI, // radians around `angle`
  speed: [120, 360], // [min, max] px/s
  life: [0.3, 0.7], // seconds
  size: [10, 2], // start, end
  colorStart: hex('#ffe066', 1.5), // HDR is fine
  gravity: [0, 600], // px/s², y down
  emissive: 1.2,
};

export function popCoin(ctx: EngineCtx, x: number, y: number) {
  sparkle.x = x;
  sparkle.y = y;
  ctx.particles.emit(sparkle, 14);
}

export function drawParticles(ctx: EngineCtx, frame: Frame) {
  frame.drawable(ctx.particles); // usually last, so they draw over the world
}
```

- Shapes: `shape: { kind: 'circle', radius }`, `rect`, `line` or the default point.
- `blend: 'alpha'` on the params gives soft smoke and dust instead of additive light.
- `ParticleEmitter` (from `@thunderclap-engine/engine/fx`) emits at a steady rate per second for fires and embers.
- `createGame({ particles: { capacity: 2048 } })` sizes the pool. When it is full, the oldest particles are reused.

Reuse one `EmitParams` object per effect and move it before each `emit`, as above.

## Next

- [render reference](../../src/render/README.md): the frame model, cameras, materials, textures, tile layers, parallax and follow in full
- [fx reference](../../src/fx/README.md): particles, sprite sheets, curves, forces and effect files
- [assets reference](../../src/assets/README.md): `packAtlas`, manifests and bundles
- [post reference](../../src/post/README.md): bloom and the rest of the post stack
- [Getting started](getting-started.md)
- [UI and HUD](ui-and-hud.md)
- [Input](input.md)
- [Style and post](style-and-post.md)
- [Testing your game](testing-your-game.md)
