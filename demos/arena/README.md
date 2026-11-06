# Demo: arena

A third-person character runs around a lit stone arena and swings a sword. Everything is
procedural: the humanoid is sixteen joints of rigidly skinned boxes, the clips are sampled
curves, the stone is hashed texels. `pnpm demo arena`, or `/demos/arena/` on the harness server.
`?still` parks the idle bob and the dust so probes read a steady frame.

Controls: WASD, the left stick or a left-half touch stick runs (relative to the camera); the
mouse (click for the pointer lock), the right stick or a right-half drag looks; click, tap,
Space or the pad's A button swings; the wheel, a pinch or the shoulder buttons zoom.

To start a game of your own from this shape, `pnpm create-game` scaffolds a project on the same
public API.

## What to look at

- The run/idle blend: the mixer weights the two layer-0 clips by ground speed, so a half-pushed
  stick gives a half run.
- The sword rides a hand socket (`createSocket` + `attachTransform`) and its tip leaves an
  additive camera-facing `Trail`; the swing runs the mixer in sub-steps so the arc is sampled
  even on a stalled frame.
- The sun's shadow map over the pillars and the character, plus two coloured point lights and
  fog at the arena's edge.
- The ground, the pillars and the orbs are `geom` builders (`plane`, `box`, `cylinder`,
  `mergeGeometry`, `transformGeometry`); the stone albedo is `textureFromPixels` of hashed texels.
- Zoom comes from `Look.zoom` (wheel, pinch, shoulder buttons) read by `Follow`; the demo has no
  zoom bindings of its own.

## Known limits

The body mesh keeps a local skinned builder (`geom.ts`), since `geom`'s builders write the
unskinned 3D layout; there are no name plates, health bars or hit decals (fx billboards and
decals are not on main yet).

## Engine modules

- `@thunderclap/engine` `createGame`: loop, input, world-space particles, toasts, fixed-step sim.
- `anim`: `Skeleton` with `inverseBindFromRest`, `AnimationMixer` blending the idle and run clips
  by speed on layer 0 with the swing on layer 1, `poseToWorld` + `skinMatrices` into a
  `SkinPalette`, `createSocket` + `attachTransform` for the sword.
- `geom`: `plane` (ground), `box` + `cylinder` merged into a pillar and the sword, `cylinder` orbs.
- `render`: `VERTEX_LAYOUT_SKINNED`, a custom skinned PBR material on `WGSL_PBR`,
  `createStandardMaterial` with `textureFromPixels` stone, `Lights` (sun shadow, two point
  lights, fog), `renderer.stats`.
- `fx`: `Trail` (world space, camera facing, additive) from the blade tip; `ParticleSystem` dust.
- `input`: `Look` (keys, pointer lock, touch, pad, zoom axis) driving `Follow`; `{ gesture: 'tap' }`
  swings.

## What the spec checks (`e2e/demos/arena.spec.ts`)

Boot with WebGPU, draw calls within 4..40, shadow draws and triangles present, no GPU errors and
no console errors on every matrix row; fps above 20 on the desktop rows; a held `W` for 2 s of
sim moves the character more than 1.5 units at a run; a click starts a swing whose `trailPeak`
(the most trail points alive during the swing) exceeds 1, and the swing ends. Every probe reads
`window.__demo` after a `requestAnimationFrame` settle and polls moving values (E-017).
