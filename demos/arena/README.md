# Demo: arena

A third-person character runs around a lit stone arena and swings a sword. Everything is
procedural: the humanoid is sixteen joints of rigidly skinned boxes, the clips are sampled
curves, the stone is hashed texels. `pnpm demo arena`, or `/demos/arena/` on the harness server.

Controls: WASD, the left stick or a left-half touch stick runs (relative to the camera); the
mouse (click for the pointer lock), the right stick or a right-half drag looks; click, tap,
Space or the pad's A button swings; the wheel zooms.

## Engine modules

- `@thunderclap/engine` `createGame`: loop, input, world-space particles, toasts, fixed-step sim.
- `anim`: `Skeleton` with `inverseBindFromRest`, `AnimationMixer` blending the idle and run clips
  by speed on layer 0 with the swing on layer 1, `poseToWorld` + `skinMatrices` into a
  `SkinPalette`, `createSocket` + `attachTransform` for the sword.
- `render`: `VERTEX_LAYOUT_SKINNED`, a custom skinned PBR material on `WGSL_PBR`,
  `createStandardMaterial` with `textureFromPixels` stone, `Lights` (sun shadow, two point
  lights, fog), `renderer.stats`.
- `fx`: `Trail` (world space, camera facing, additive) from the blade tip; `ParticleSystem` dust.
- `input`: `Look` (keys, pointer lock, touch, pad) driving `Follow`; `{ gesture: 'tap' }` swings.

## What the spec checks (`e2e/demos/arena.spec.ts`)

Boot with WebGPU, draw calls within 4..40, shadow draws and triangles present, no GPU errors and
no console errors on every matrix row; fps above 20 on the desktop rows; a held `W` for 2 s of
sim moves the character more than 1.5 units at a run; a click starts a swing that leaves trail
points and ends.
