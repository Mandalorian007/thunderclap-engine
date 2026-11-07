# Make a 3D game

## What you'll build

This guide walks you through a lit 3D scene. You set up a perspective camera, draw boxes and
spheres, load a glTF model, add lights, shadows and fog, switch to physically based materials,
and keep the frame cheap with LOD and frustum culling.

It assumes you have a game running from [Getting started](getting-started.md). The
`templates/first-person` and `templates/third-person` folders are complete 3D games you can
copy; this guide explains the pieces they use.

## Point a perspective camera

Every scene draws through `ctx.camera`. It starts as a 2D orthographic camera. Turn it into a
3D camera when your scene enters, then aim it with `lookAt`.

```ts
import type { EngineCtx } from '@thunderclap/engine';

export function aimCamera(ctx: EngineCtx) {
  const fovY = Math.PI / 3; // 60 degrees, vertical
  const aspect = ctx.design.width / ctx.design.height;
  ctx.camera.setPerspective(fovY, aspect, 0.1, 200);
  ctx.camera.lookAt([0, 4, 10], [0, 0, 0]); // eye, target; up defaults to +y
}
```

`setPerspective` also turns on depth testing, depth writes and frustum culling. Call `lookAt`
again every frame if the camera moves.

You do not replace `ctx.camera`. The game loop and the pointer router always use that same
object, so you change it in place. `Camera.perspective(fovY, aspect, near, far)` builds a
separate camera. Use it for a second view, such as a minimap you render yourself with
`renderer.render(frame, camera)`.

```ts
import { Camera } from '@thunderclap/engine/render';

const minimap = Camera.perspective(Math.PI / 4, 1, 0.5, 400);
minimap.lookAt([0, 120, 0.01], [0, 0, 0]);
```

## Draw meshes

A mesh is a vertex buffer on the GPU. The `geom` module builds the vertices for common
shapes. Each builder returns a description you pass to `renderer.createMesh`.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { box, sphere } from '@thunderclap/engine/geom';

export function buildMeshes(ctx: EngineCtx) {
  const crate = ctx.renderer.createMesh({ ...box({ size: 1 }), label: 'crate' });
  const ball = ctx.renderer.createMesh({ ...sphere({ radius: 0.5, segments: [32, 16] }), label: 'ball' });
  return { crate, ball };
}
```

The builders write `VERTEX_LAYOUT_3D`: 12 floats per vertex (position, normal, uv, rgba
colour). They also fill in `bounds`, the sphere the frustum cull tests. Other shapes are
`plane`, `icosphere`, `capsule`, `cylinder` and `torus`. `mergeGeometry` joins several into
one mesh, and `transformGeometry` moves one in place before you merge.

If you write your own vertices, pass the layout. `createMesh` computes the bounding sphere
from the positions for meshes under 65,536 vertices; pass `bounds` yourself when you already
know it or the mesh is larger.


```ts
import type { EngineCtx } from '@thunderclap/engine';
import { VERTEX_LAYOUT_3D } from '@thunderclap/engine/render';

export function triangle(ctx: EngineCtx) {
  // x y z   nx ny nz   u v   r g b a
  const vertices = new Float32Array([
    0, 1, 0, 0, 0, 1, 0.5, 0, 1, 1, 1, 1,
    -1, -1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
    1, -1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1,
  ]);
  return ctx.renderer.createMesh({
    label: 'triangle',
    layout: VERTEX_LAYOUT_3D,
    vertices,
    indices: new Uint16Array([0, 1, 2]),
    bounds: { center: [0, 0, 0], radius: 1.2 },
  });
}
```

## Place things with Transform

A `Transform` holds a position, a rotation and a scale. Build one per object when the scene
starts, then change it each frame. Rotation is a quaternion. `setAxisAngle` is the easy way
to set it.

```ts
import { Transform } from '@thunderclap/engine/render';

const t = new Transform();
t.setPosition(0, 0.5, 0);
t.setAxisAngle(0, 1, 0, Math.PI / 4); // 45 degrees about +y
t.setScale(2); // one number scales all three axes; setScale(x, y, z) sets each

const wheel = new Transform({ parent: t }); // follows t
wheel.setPosition(0.6, -0.3, 0);
```

`setQuaternion(x, y, z, w)` takes a quaternion directly and normalises it. `t.position`,
`t.quaternion` and `t.scale` are read-only views of the current values.

## Draw a frame

Put it together in a scene. `frame.mesh(mesh, material, transform)` draws one instance.
Until you add lights the scene is unlit, so you see flat colour.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import type { Scene } from '@thunderclap/engine/core';
import { box } from '@thunderclap/engine/geom';
import { createStandardMaterial, type Frame, type Mesh, type Material, Transform } from '@thunderclap/engine/render';

export function spinningCrate(): Scene<EngineCtx, Frame> {
  let crate: Mesh;
  let mat: Material;
  const t = new Transform();
  let angle = 0;
  return {
    name: 'crate',
    enter(ctx) {
      ctx.camera.setPerspective(Math.PI / 3, ctx.design.width / ctx.design.height, 0.1, 100);
      ctx.camera.lookAt([0, 2, 5], [0, 0, 0]);
      crate = ctx.renderer.createMesh({ ...box({ size: 1 }), label: 'crate' });
      mat = createStandardMaterial(ctx.renderer, { baseColorFactor: [0.8, 0.5, 0.2, 1] });
    },
    update(dt) {
      angle += dt;
      t.setAxisAngle(0, 1, 0, angle);
    },
    render(frame) {
      frame.clear(0.05, 0.06, 0.1);
      frame.mesh(crate, mat, t);
    },
  };
}
```

Push it with `ctx.stack.push(spinningCrate())`. A fourth argument to `frame.mesh` takes
per-instance options: `tint`, `emissive` (feeds bloom), `castShadow`, `receiveShadow`.

## Load a glTF model

`parseGltf` reads a `.glb` file. `loadGltf` uploads its meshes, textures and materials and
returns a `GltfScene` with one `Transform` per node. `draw(frame)` draws every node.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { loadGltf, parseGltf } from '@thunderclap/engine/assets';
import { Transform } from '@thunderclap/engine/render';

export async function loadTree(ctx: EngineCtx) {
  const bytes = await (await fetch('/models/tree.glb')).arrayBuffer();
  const doc = parseGltf(bytes);
  const tree = await loadGltf(ctx.renderer, doc);

  // To move the whole model, parent its root nodes (doc.scene) to a Transform you own.
  const root = new Transform();
  for (const i of doc.scene) {
    tree.transforms[i]!.parent = root;
  }
  root.setPosition(3, 0, -2);
  return { tree, root };
}
```

Then call `tree.draw(frame)` in `render`. The materials are standard PBR materials, so they
react to the lights below. `tree.bounds` gives the model's size, and `tree.destroy()` frees it.

## Add lights

Assign a `Lights` object to `frame.lights` each frame. It has an ambient colour, one sun,
up to 16 point lights and up to 8 spot lights.

```ts
import { Lights } from '@thunderclap/engine/render';

const lights = new Lights();
lights.ambient.set([0.15, 0.17, 0.22]);
lights.sun.direction = [-0.4, -1, -0.3]; // the direction the light travels
lights.sun.color = [1.2, 1.1, 0.95];

lights.points.push({ position: [2, 1.5, 0], color: [1, 0.6, 0.3], radius: 6 });
lights.spots.push({
  position: [0, 4, 0],
  direction: [0, -1, 0],
  color: [3, 3, 3],
  radius: 10,
  innerAngle: 0.3,
  outerAngle: 0.5,
});
```

`ambient` is a fixed array, so use `.set([...])`. The sun's `dir` and `color` you can assign.
Move a point light by changing its `position` in place each frame. `lights.reset()` clears
everything back to the unlit default.

In `render`, before you draw: `frame.lights = lights;`.

## Turn on sun shadows

Give the sun a shadow box. `extent` is the half-size of the box around the camera, in world
units. A larger box covers more ground but each shadow gets blurrier.

```ts
import { Lights } from '@thunderclap/engine/render';

const lights = new Lights();
lights.sun.shadow = { extent: 24, size: 2048 };
```

3D meshes cast shadows by default. Turn it off for things that only receive, such as a
large ground plane: `frame.mesh(ground, mat, t, { castShadow: false })`. Set
`lights.sun.shadow = null` to switch shadows off.

## Add fog

`lights.fog` fades distant surfaces towards a colour. Change its fields; do not replace it.

```ts
import { Lights } from '@thunderclap/engine/render';

const lights = new Lights();
lights.fog.color = [0.6, 0.7, 0.8];
lights.fog.density = 1;
lights.fog.near = 20; // linear fog from 20 to 80 units
lights.fog.far = 80;
```

With `far > near` the fog is linear between them. Otherwise it is exponential and
`density` sets how thick it is. Clear to the same colour as the fog so the horizon blends.

The post stack has a separate screen-space mist (`post.settings.mist`), a low haze drawn on
top of the finished image. It does not replace `lights.fog`; the two stack. The
[style and post guide](style-and-post.md) covers it.

## Use PBR materials

`createStandardMaterial` makes a physically based material that reads the lights, the sun
shadow and the fog. You can use plain numbers or textures.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { createStandardMaterial } from '@thunderclap/engine/render';

export function materials(ctx: EngineCtx) {
  const metal = createStandardMaterial(ctx.renderer, {
    label: 'metal',
    baseColorFactor: [0.9, 0.9, 0.95, 1],
    metallic: 1,
    roughness: 0.25,
  });
  const glow = createStandardMaterial(ctx.renderer, {
    label: 'lamp',
    baseColorFactor: [1, 1, 1, 1],
    emissiveFactor: [4, 2.5, 1],
  });
  const glass = createStandardMaterial(ctx.renderer, {
    label: 'glass',
    baseColorFactor: [0.6, 0.8, 1, 0.3],
    alphaMode: 'blend',
    roughness: 0.05,
  });
  return { metal, glow, glass };
}
```

Texture slots are `baseColor`, `metallicRoughness`, `normal`, `occlusion` and `emissive`.
The vertex colour multiplies the base colour, so the `geom` builders' `color` option tints
the mesh.

## Keep it fast with LOD

A level-of-detail chain swaps a mesh for simpler versions as it gets small on screen.
`createLodChain` makes the simpler geometry, and `renderer.createMeshLod` uploads every level.
Pass the result to `frame.mesh` in place of the mesh. The renderer picks the level.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { createLodChain, sphere } from '@thunderclap/engine/geom';
import type { MeshLod } from '@thunderclap/engine/render';

export function rockLod(ctx: EngineCtx): MeshLod {
  // Level 0 is the sphere itself; each ratio adds one coarser level: three levels here.
  const geometries = createLodChain(sphere({ radius: 1, segments: [48, 24] }), [0.5, 0.2]);
  return ctx.renderer.createMeshLod({
    geometries,
    thresholdsPx: [200, 60], // above 200 px tall: level 0; above 60: level 1; else level 2
    label: 'rock',
  });
}
```

`selectLod` returns the level index if you want to pick by hand. `renderer.stats.lodCounts`
shows how many draws used each level, and `camera.lodBias` shifts every choice.

## Frustum culling

A perspective camera skips any draw whose bounding sphere is outside the view. The `geom`
builders, `loadGltf` and `createMesh` set `mesh.bounds` for you. A mesh with more than 65,536
vertices of capacity and no `bounds` is never culled, so pass `bounds` for big meshes such as
terrain chunks.

Check how much was skipped:

```ts
import type { EngineCtx } from '@thunderclap/engine';

export function logStats(ctx: EngineCtx) {
  const s = ctx.renderer.stats;
  console.log(`draws ${s.drawCalls}, culled ${s.culled}, triangles ${s.triangles}`);
}
```

`camera.seesSphere(x, y, z, radius)` runs the same test for your own logic, such as pausing
AI that is off screen.

## Voxel worlds

For block worlds, `@thunderclap/engine/voxel` stores a voxel grid, meshes it in chunks
(optionally in a Worker), culls and draws the chunks, and raycasts for picking and editing.
See the [voxel reference](../../src/voxel/README.md). The first-person template shows chunked
meshes built in a Worker.

## Next

- [render reference](../../src/render/README.md): frames, cameras, lights, shadows, materials, LOD
- [geom reference](../../src/geom/README.md): shape builders and LOD chains
- [assets reference](../../src/assets/README.md): glTF loading
- [voxel reference](../../src/voxel/README.md)
- [Characters](characters.md): skinned models, animation and a follow camera
- [Style and post](style-and-post.md): bloom, tone mapping, sky, water, weather
- [Input](input.md): move the camera with `Look`
- [Testing your game](testing-your-game.md)
