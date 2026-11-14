# `@thunderclap-engine/engine/models`

Procedural part models for asset-free 3D: a machine, a creature or a prop is a tree of parts (shapes, turns, moves, repeats) compiled against a material table the game declares, then drawn by instance with its motion and glow evaluated in the shader from named state channels. A turning sail or a walking leg costs no write per frame; only placing or re-placing an instance writes its slot.

## Quick use

<!-- snippet:check -->
```ts
import { compileModel, createModelScene, type MaterialCodeTable, type PartModel } from '@thunderclap-engine/engine/models';
import { type Renderer, Transform } from '@thunderclap-engine/engine/render';

declare const renderer: Renderer;

const materials: MaterialCodeTable = {
  wood: { color: [0.4, 0.25, 0.12] },
  lamp: { color: [1, 0.8, 0.4], emissive: [3, 2, 0.8] },
};
const mill: PartModel = {
  name: 'mill',
  channels: [{ name: 'spin', wrap: Math.PI * 2 }, 'light'],
  parts: [
    { material: 'wood', shape: { type: 'frustum', center: [0, 0, 0], bottom: 1.5, top: 1, height: 3 } },
    {
      name: 'sails',
      material: 'wood',
      motion: { type: 'spin', axis: 'z', pivot: [0, 3, 0.8], channel: 'spin' },
      repeat: { count: 4, turn: { axis: 'z', angle: Math.PI / 2, pivot: [0, 3, 0.8] } },
      shape: { type: 'box', from: [-0.1, 3, 0.8], to: [0.1, 5, 0.9] },
    },
    { name: 'window', material: 'lamp', glow: { channel: 'light' }, shape: { type: 'box', from: [-0.2, 1.6, 0.7], to: [0.2, 2, 0.75] } },
  ],
};

const scene = createModelScene(renderer, { materials, maxInstances: 256 });
const units = compileModel(mill, materials);
// Slots 0..units.units.length-1; spin is [value, rate per second], so it turns with no further writes.
scene.placeModel(units, 0, new Transform().setPosition(4, 0, 0), { channels: { spin: [0, 0.8], light: 1 } });
// Each frame: frame.drawable(scene);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `PartModel / Part / PartShape / PartMotion / PartGlow` | the spec: a part tree with shapes, `turn`, `move`, `repeat`, child `parts`, `material`, `color` (`'instance'`, `'instance2'` or RGB), `shade` |
| `MaterialCodeTable / ModelMaterial` | the game's materials: name to `{ color, emissive? }`; codes are declaration order |
| `compileModel(spec, materials)` | packs a spec into `ModelUnits`: one static unit plus one per moving or glowing top-level part; pure, throws on unknown names |
| `evaluateUnit(unit, values, out?)` | the CPU twin of the shader's pose (angle, offset, glow) for picking and tests |
| `createModelScene(renderer, opts)` | `ModelScene`, a `Drawable`: `place`, `placeModel`, `remove`, `removeRange`, `clear`, `stats` |
| `ModelInstances / createModelInstances` | the GPU-free packing: slots, draw order, dirty float ranges |
| `modelShaderWgsl(table, shade?) / MODEL_SURFACE_WGSL / materialConstantsWgsl` | the shader and the pieces a custom shade function sees |
| `ModelBuilder` | the triangle builder `compileModel` uses, for tools that want raw vertices |

## Smaller pieces

- Spec types: `PartVec3`, `PartRgb`, `PartAxis` (`'x' | 'y' | 'z'`), `PartTurn`, `PartRepeat`, `PartColor`, `ModelChannel`.
- Compiled: `ModelUnit` (one draw: vertex range, motion row, radius), `UnitPose` (what `evaluateUnit` returns), `channelOf(model, name)` (a channel's index), `materialCode(table, name)` and `materialConstName(name)` (the code and the WGSL constant name of a material).
- Layouts: `MODEL_VERTEX_FLOATS` and `COLOR_MODE` (vertex), `MODEL_UNIT_FLOATS` and `MOTION_KIND` (unit row), `MODEL_INSTANCE_FLOATS` and `MODEL_INSTANCE` (instance slot offsets).
- Instances: `ChannelInput` (a value or `[value, rate]`), `ModelInstanceState` (`channels`, `color`, `color2`, `user`), `ModelXform` (a `Transform` or 12 floats), `ModelDraw`, `ModelInstanceStats`, `ModelInstancesOptions`.
- Scene: `ModelSceneOptions` (`materials`, `maxInstances`, `shade`, `cull`, `label`), `ModelSceneStats` (`writes`, `bytes`, `instanceBytes`, `drawCalls`, `bindGroups`), and `MODEL_DEFAULT_SHADE_WGSL`, the Lambert shade used when none is given.

## Shapes

`box {from, to}`, `cylinder {center, axis, radius, length, sides?, cap?}`, `gear {center, axis, outer, root, teeth, length}`, `ring {center, axis, inner, outer, length, sides?}`, `prism {center, axis, radii, length, cap?}` (one radius per side), `frustum {center, bottom, top, height}` (square, open at the top), `wedge {from, to, cap?}` (a gable roof along x) and `geometry {geometry}` (any `geom` builder's output). Faces point outward; downward faces are shaded darker at compile time.

## Motion and glow

Only top-level parts move or glow, each as its own unit. `spin {axis, pivot?, channel, ratio?}` turns by the channel value; `swing` by `amplitude × sin(value + phase)`; `hinge` and `slide` map 0..1 to `from..to` (an angle or a distance); `bob` moves `amplitude × sin(value + phase)` along the axis. `glow` is a constant or `{channel, scale?, min?, max?}` and scales the material's emissive. A model has at most four channels (`MAX_MODEL_CHANNELS`); each is set per instance as a value or `[value, rate]`, and a `wrap` keeps a cyclic channel small. Nested motion (a hand on an arm) belongs in the game or a skeleton, not here.

## Style

The default shade is Lambert with fog. A game passes its own WGSL `fn model_shade(s: ModelSurface) -> ModelShaded` as `shade`; it can use `engine_lambert`, `engine_fog`, the noise helpers, `camera`, `globals` and a `MODEL_MAT_<NAME>` constant per material (`'hot metal'` is `MODEL_MAT_HOT_METAL`). Colour goes to the scene target and emissive to the bloom target, so emissive is not added to colour.

## Budget

One draw call per unit with instances; a frame where nothing is placed writes 16 bytes (the frame clock). Instances are 144 bytes; the channel clock rebases every 600 s (one write of every slot). See `scene.test.ts` for the fake-GPU budget and `harness/models.html` (`e2e/models.spec.ts`) for a toon windmill and a walking machine.
