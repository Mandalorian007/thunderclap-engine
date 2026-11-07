# Animate a character

This guide takes a rigged, animated glTF character from a file to the screen. You draw the
skinned mesh, play and blend its clips, drive them from a state graph, attach a sword to its
hand, and follow it with a third-person camera.

`templates/third-person` does all of this in a small arena. Copy it when you start a real
game; this guide explains what its `src/character/` folder does. You should already know the
3D basics from [Make a 3D game](3d-game.md).

## What you need

- A `.glb` file with one skinned mesh, its skin (the joints) and some animations, for example
  `idle`, `walk`, `run` and `attack`.
- A scene with a perspective camera and a `Lights` object, as in the 3D guide.

Skinned characters use four modules: `assets` reads the file, `anim` computes poses,
`render` draws the mesh, and `input` gives you the camera.

## Load the skinned mesh

A skinned vertex carries joint indices and weights next to the usual position, normal and
uv. `interleaveSkinned` packs a glTF primitive into `VERTEX_LAYOUT_SKINNED`.
`skeletonFromSkin` reads the joint hierarchy. `SkinPalette` is the GPU buffer of joint
matrices the vertex shader reads, and `createStandardMaterial({ skin })` makes a PBR material
that uses it.

```ts
import type { AnimationClip } from '@thunderclap/engine/anim';
import { interleaveSkinned, parseGltf, skeletonFromSkin } from '@thunderclap/engine/assets';
import {
  createStandardMaterial,
  type Renderer,
  SkinPalette,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap/engine/render';

export async function loadHero(renderer: Renderer, url: string) {
  const doc = parseGltf(await (await fetch(url)).arrayBuffer());
  const skeleton = skeletonFromSkin(doc, 0);
  const prim = doc.meshes[0]!.primitives[0]!;

  const mesh = renderer.createMesh({
    label: 'hero',
    layout: VERTEX_LAYOUT_SKINNED,
    vertices: new Float32Array(interleaveSkinned(prim).vertices),
    indices: prim.indices,
    // A skinned mesh moves away from its rest shape, so give the cull a generous sphere.
    bounds: { center: [0, 0.9, 0], radius: 2 },
  });

  const jointCount = doc.skins[0]!.joints.length;
  const palette = new SkinPalette(renderer.device, { joints: jointCount, label: 'hero' });
  const material = createStandardMaterial(renderer, { label: 'hero', skin: palette, roughness: 0.7 });

  const clips = new Map<string, AnimationClip>(doc.animations.map((a) => [a.name, a]));
  return { doc, skeleton, mesh, palette, material, clips, jointCount };
}
```

If the model has several meshes or textured materials, `loadGltf(renderer, doc, { palette })`
builds all of them against one palette instead. The steps below are the same.

## Pose it every frame

The `AnimationMixer` plays clips and writes a pose (each joint's local position, rotation and
scale). `skinPose` turns that pose into the joint matrices the vertex shader reads, in one call
per frame. `skinPose(skeleton, mixer, palette, 0, dt)` does four things in order:

1. `mixer.update(dt)` advances the clips and samples them into `mixer.pose`.
2. `poseToWorld` turns the local joint poses into world matrices.
3. `skinMatrices` multiplies each by its inverse bind matrix, giving 12 floats per joint.
4. It writes those floats straight into `palette.write(0)`, slot 0's joint matrices in the
   palette itself.

Slot 0 is the first character. `skinPose` returns the world matrices, which you need for
sockets. Once every character is posed, call `palette.flush()` to upload the matrices. Then
draw the mesh with `palette.params(0)`, the draw parameters that name slot 0 (the slot goes in
the w of `params`).

```ts
import { AnimationMixer, type Skeleton, skinPose } from '@thunderclap/engine/anim';
import type { Frame, Material, Mesh, SkinPalette } from '@thunderclap/engine/render';
import { Transform } from '@thunderclap/engine/render';

export function createHeroRig(skeleton: Skeleton) {
  const mixer = new AnimationMixer(skeleton, { maxActions: 8 });
  const body = new Transform();

  // Returns the world matrices for sockets. Nothing here allocates per frame.
  function update(dt: number, palette: SkinPalette): Float32Array {
    return skinPose(skeleton, mixer, palette, 0, dt);
  }

  function render(frame: Frame, mesh: Mesh, material: Material, palette: SkinPalette) {
    palette.flush();
    frame.mesh(mesh, material, body, palette.params(0));
  }

  return { mixer, body, update, render };
}
```

`body` places the whole character. Move and turn it like any other `Transform`.

If you drive the mixer some other way, leave out `dt`. `skinPose` then poses whatever
`mixer.pose` holds and does not advance it. You need that in two cases. A state graph (below)
updates the mixer itself, so call `graph.update(dt)` and then `skinPose(skeleton, mixer,
palette, 0)`. Foot IK or a look-at edits the pose after sampling, so call `mixer.update(dt)`,
then the IK, then `skinPose` with no `dt`. You can also pass a bare `Pose` in place of the
mixer.

The world array `skinPose` returns is one array per skeleton, and the next call for that
skeleton overwrites it. With two characters on one rig, read the first one's sockets before
you pose the second. Or pass each character its own array as the last argument:
`skinPose(skeleton, mixer, palette, slot, dt, world)`.

## Play and blend clips

`mixer.play(clip, options)` starts a clip and returns an action. `crossFade` fades one action
out while another fades in, so a walk turns into a run with no pop.

```ts
import type { AnimationClip, AnimationMixer } from '@thunderclap/engine/anim';

export function blendDemo(mixer: AnimationMixer, clips: Map<string, AnimationClip>) {
  const idle = mixer.play(clips.get('idle')!);
  // Later, when the player starts moving:
  const walk = mixer.crossFade(idle, clips.get('walk')!, 0.25);

  // A wave on layer 1, mixed on top of whatever the legs are doing.
  mixer.play(clips.get('wave')!, { layer: 1, blend: 'additive', weight: 0.8 });

  // One-shot: loop false holds the last frame and sets action.finished.
  const swing = mixer.play(clips.get('attack')!, { loop: false, fadeIn: 0.08 });
  mixer.onEvent((name) => console.log('clip event', name));
  return { walk, swing };
}
```

Options are `layer`, `weight`, `loop`, `speed`, `fadeIn`, `blend` (`'override'` or
`'additive'`) and `startTime`. Higher layers apply after lower ones. `mixer.stop(action, seconds)`
fades an action out.

## Drive clips from a state graph

Calling `crossFade` by hand gets messy with more than a few clips. `createAnimGraph` puts a
state machine over the mixer. You set parameters, and the graph picks the state and handles
the fades.

```ts
import { type AnimationClip, type AnimationMixer, createAnimGraph } from '@thunderclap/engine/anim';

type Clips = Record<'idle' | 'walk' | 'run' | 'attack', AnimationClip>;

export function heroGraph(mixer: AnimationMixer, clips: Clips) {
  return createAnimGraph(mixer, {
    params: { speed: 0, attack: false },
    states: {
      idle: { clip: clips.idle },
      // A 1D blend space: speed 0.4 is all walk, 1 is all run, in between mixes them.
      move: { blend: { param: 'speed', points: [{ at: 0.4, clip: clips.walk }, { at: 1, clip: clips.run }] } },
      attack: { clip: clips.attack, loop: false },
    },
    transitions: [
      { from: '*', to: 'attack', when: (p) => p.attack === true, fade: 0.08 },
      { from: 'attack', to: 'idle', when: () => true, fade: 0.15, exitTime: 0.95 },
      { from: 'idle', to: 'move', when: (p) => (p.speed as number) > 0.05, fade: 0.15 },
      { from: 'move', to: 'idle', when: (p) => (p.speed as number) <= 0.05, fade: 0.2 },
    ],
    initial: 'idle',
  });
}
```

Each frame, set the parameters and update the graph instead of the mixer. The graph updates
the mixer for you.

```ts
import type { AnimGraph } from '@thunderclap/engine/anim';

export function tickGraph(graph: AnimGraph, dt: number, speed01: number, attackPressed: boolean) {
  graph.set('speed', speed01);
  if (attackPressed) graph.set('attack', true);
  graph.update(dt);
  graph.set('attack', false); // one-shot flag: clear it after the update that used it
  return graph.state; // 'idle' | 'move' | 'attack'
}
```

`exitTime` waits until the clip is that far through (0 to 1) before the transition may fire.
`graph.phase('attack')` tells you how far the current attack is, which is how the template
decides when a swing lands.

## Attach a sword to the hand

A socket is a point fixed to one joint, with an offset. `createSocket` names the joint.
`attachTransform` writes the socket's world matrix into a `Transform` after you pose the
skeleton. Then draw the prop with that transform.

```ts
import { attachTransform, createSocket, type Skeleton } from '@thunderclap/engine/anim';
import { type Frame, type Material, type Mesh, Transform } from '@thunderclap/engine/render';

export function swordSocket(skeleton: Skeleton) {
  const socket = createSocket(skeleton, 'hand.R', { position: [0, 0.1, 0] });
  const sword = new Transform();

  // Call after skinPose, with the world array it returned and the body's world matrix.
  function place(world: Float32Array, body: Transform) {
    attachTransform(socket, world, body.world, sword);
  }
  function draw(frame: Frame, mesh: Mesh, material: Material) {
    frame.mesh(mesh, material, sword);
  }
  return { place, draw };
}
```

Use the joint names from your file. The template swaps hats and weapons this way, one socket
per slot.

## Follow the character with the camera

`Look` reads the player's move and look input from keys, mouse, touch and gamepad. `Follow`
turns it into an orbit camera behind a target. Create both once at startup.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { Follow, Look } from '@thunderclap/engine/input';

export function setupCamera(ctx: EngineCtx) {
  const look = new Look({
    mode: 'orbit', // drag to turn the view; no pointer lock
    keys: { forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
    touch: { moveZone: 'left' },
    zoom: { wheel: true, pinch: true, pad: 'shoulders' },
  });
  ctx.input.setLook(look);

  const follow = new Follow(ctx.camera, {
    distance: 4.5,
    minDistance: 1.6,
    maxDistance: 9,
    shoulder: [0.45, 0], // over the right shoulder
    eyeHeight: 1.45,
    smoothing: 0.1,
    pitch: -0.28,
  });
  follow.setLook(look);
  return { look, follow };
}
```

Point the follow at the character. The target is any object with a `position` (feet, world
units) and an optional `yaw`. When the scene enters, call `follow.snap()` so the camera
starts in place instead of swinging in.

Move relative to the camera. `look.move.y > 0` is forward and `follow.yaw` is the camera's
heading, where 0 faces -z and positive turns right.

```ts
import type { Follow, Look } from '@thunderclap/engine/input';

const hero = { position: new Float32Array(3), yaw: 0 };

export function moveHero(look: Look, follow: Follow, dt: number) {
  follow.target = hero;
  const s = Math.sin(follow.yaw);
  const c = Math.cos(follow.yaw);
  const fwd = look.move.y;
  const right = look.move.x;
  const speed = 4;
  hero.position[0]! += (s * fwd + c * right) * speed * dt;
  hero.position[2]! += (-c * fwd + s * right) * speed * dt;
  if (fwd !== 0 || right !== 0) hero.yaw = Math.atan2(s * fwd + c * right, c * fwd - s * right);
  follow.update(dt); // after the target moved
}
```

Copy `hero.position` and `hero.yaw` into the body `Transform` before you pose the skeleton.
The length of `look.move` (0 to 1) is a good `speed` parameter for the graph.

## Going further

The `anim` module has more for a polished character:

- `extractRootMotion` splits forward motion out of a clip, so an attack lunge moves the
  controller instead of sliding the mesh. `applyRootMotionDelta` applies it.
- `createIkChain` and `twoBoneIk` plant the feet on uneven ground.
- `lookAt` turns the head towards a point.
- `createStandardMaterial({ skin, dissolve })` fades a defeated enemy out.

All four are in use in `templates/third-person/src/character/character.ts`.

## Next

- [anim reference](../../src/anim/README.md): mixer, graph, sockets, IK, root motion
- [assets reference](../../src/assets/README.md): glTF and skins
- [render reference](../../src/render/README.md): skinning and the standard material
- [input reference](../../src/input/README.md): `Look` and `Follow`
- [Make a 3D game](3d-game.md)
- [Input](input.md)
- [Style and post](style-and-post.md)
