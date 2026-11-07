# Ember Reach: a ThunderClap third-person template

This folder is a complete, copyable third-person action game on `@thunderclap/engine`: a skinned
biped on a rolling heightfield with an orbit camera, an attack with root motion, foot IK, a head
that watches the nearest enemy, three cosmetic sockets and four roaming enemies with name plates.
To start a new game: copy it, rename the package in `package.json`, replace the rig or the arena,
keep the shape. Everything an agent needs to extend it is in this file; it should not have to
read the engine.

The character is **generated, not loaded**: `character/rig.ts` writes a glb (`buildCharacterGlb`)
with a 14-joint skeleton, a boxy skinned mesh and five clips, and the scene parses it through
`@thunderclap/engine/assets` exactly as it would parse a file. No binary asset is committed. To use
a real model, replace the `buildCharacterGlb()` call in `character/character.ts` with
`await fetch(url).then(r => r.arrayBuffer())` and keep the joint and clip names (`rig.ts`).

## Commands

- `pnpm dev`: Vite dev server at `http://127.0.0.1:5173` (from the repo root: `pnpm template:third-person`). WASD moves in the camera frame, Shift runs, Space or F attacks, a mouse drag orbits, the wheel zooms, 1 / 2 / 3 cycle the head, back and hand cosmetics (or the HUD buttons), R respawns. On a phone the left half is a move stick, the right half orbits, a pinch zooms and a tap attacks; on a pad the sticks move and orbit, A attacks, L3 runs, the shoulders zoom, X / Y / B cycle cosmetics. The repo's `pnpm test:e2e` boots the page once per device row (`e2e/templates.spec.ts`) and reads `window.__template` (`{ scene, frames, ... }`, set in `main.ts`).
- `pnpm bake`: bakes `assets/stones.json` into `public/baked/stones.coll` through the engine's `scripts/bake.mjs` (`bake.config.json`; `pnpm bake --check` exits 1 when the input changed since the last bake). The folder is gitignored and optional: the scene builds the same collider at runtime when the file is missing. When the blocks in `world/ground.ts` change, regenerate the JSON from `stoneGeometryJson(createGround())` (`stones.test.ts` fails until the file matches) and bake again.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: `tsc`, Biome (the repo's `biome.json`), Vitest. `pnpm check` runs all three; the repo root's `pnpm check` runs it too (`check:template-third-person`).
- Tests are product tests only (`src/**/*.test.ts`): the rig generator (joint count, clip durations, weights that sum to 1), the cosmetics table, the controller over the heightfield and the enemy roaming rule, plus `character/character.test.ts`, which runs the character on the engine's fake GPU and a fixed clock (`createFakeDevice`, `fakeRendererGpu`, `createFixedClock` from `@thunderclap/engine/testing`): the pose updates, an attack locks, connects once and lunges by root motion, and the draws raise no device errors. The engine verifies the platform (WebGPU, skinning, IK, input, layout) itself.

## Shape

```
index.html                  the page: a positioned #app the engine mounts into
src/main.ts                 createGame({ sim: false }) → engine ctx; a Look and a Follow linked; one scene pushed
src/ctx.ts                  Action names and bindings, Player, GameCtx (= EngineCtx + game nouns)
src/character/rig.ts        pure: the joint table (J, JOINT_NAMES), rest lengths, clip names and durations, buildCharacterGlb()
src/character/controller.ts pure: the walk (camera-relative, acceleration, turn rate) over the ground, collision with the stones
src/character/graph.ts      pure: the AnimGraphDesc (idle / locomotion / attack / hit) over the five clips
src/character/cosmetics.ts  pure: the cosmetics table: three slots × two geom-built options
src/character/character.ts  the runtime character: parse → skinned Mesh + Skeleton + clips, mixer, graph, root motion, IK, lookAt, sockets, palette
src/enemies/enemies.ts      four capsules: a pure stepEnemy rule, meshes, name plates and health bars on ui.anchors
src/world/ground.ts         pure: the heightfield (geom), the stones, groundHeight and resolveXZ
src/world/stones.ts         the stones as geometry and as a static collider: stoneGeometry, stoneGeometryJson (the bake input), createStoneCollider, loadStoneCollider (baked file, else runtime)
assets/stones.json          the bake input `pnpm bake` reads (bake.config.json → public/baked/stones.coll)
src/scenes/arena.ts         the scene: lights, ground and stone meshes, the character, the enemies, the hit burst, the HUD
src/ui/hud.ts               health meter, kill count, cosmetic buttons and the prompt (ui.layout)
```

## Rules of the house

1. **Pure where it can be.** `rig.ts`, `controller.ts`, `graph.ts`, `cosmetics.ts`, `ground.ts` and `stepEnemy` import no DOM and no GPU; `geom` and `anim` types are arithmetic. Every rule there has a unit test; `character.ts`, `enemies.ts` and the scene are glue.
2. **The clip drives, the controller moves.** The attack's lunge is authored in the clip's hips track; `extractRootMotion` strips it from what the mixer plays and `applyRootMotionDelta` feeds the stripped travel into the controller each frame, so the feet and the capsule collision agree. Nothing else teleports the body.
3. **A client keeps nothing.** `sim: false` and no `save`: the loop runs at render rate (`update(dt)` gets the real frame delta) and the engine never touches storage.
4. **Zero allocations per frame.** `update` and `render` mutate pre-built `Transform`s, `Float32Array`s and emit params; the pose, world and palette buffers are allocated once in `createCharacter`.
5. **Devices never leak past `ctx.ts` and `Look`.** Scenes read `look.move`, `look.look`, `look.zoom` and actions (`input.pressed('attack')`), never keys, buttons, touches or `movementX`. The orbit drag is the `Look`'s (`mode: 'orbit'`), not the page's.
6. **Import only the public map.** `@thunderclap/engine` and `@thunderclap/engine/<module>` (`core`, `render`, `input`, `ui`, `fx`, `anim`, `assets`, `geom`, ...). Never a path into the engine's `src/`.

## The engine's nouns

- **`createGame(opts)`** (`@thunderclap/engine`): boots WebGPU on a letterboxed canvas and returns the **`EngineCtx`** (or `null` when WebGPU is missing). Used here: `root`, `title`, `design` (1920×1080), `sim: false`, `input: { bindings, buttonKeys }`. `main.ts` widens it with `look`, `follow`, `player`, `hud` (`GameCtx`).
- **`Look`** (`input`): `new Look({ mode: 'orbit', keys, touch: { moveZone: 'left' }, zoom: { wheel, pinch, pad: 'shoulders' } })`, linked with `ctx.input.setLook(look)`. `mode: 'orbit'`: a primary-button mouse or pen drag on the canvas turns the view at `sensitivity` with no pointer lock (the linked input feeds it and keeps the drag from the gestures). Each tick `look.move.x/y` is the walk vector, `look.look.dx/dy` the orbit deltas (the drag, a touch drag in the look zone, the right stick) and **`look.zoom`** the zoom axis (wheel notches, pinch, shoulders; positive is closer).
- **`Follow`** (`input`): `new Follow(ctx.camera, { distance, minDistance, maxDistance, shoulder: [right, up], eyeHeight, smoothing, pitch, pitchMin, pitchMax, zoomStep })`; `follow.target = { position, yaw? }` (the controller is one), `follow.setLook(look)`, `follow.update(dt)` each tick aims the camera: it orbits from `look.look`, steps `distance` from `look.zoom`, eases the pivot. `follow.yaw` is the orbit yaw the controller walks relative to; `follow.snap()` jumps to the target. `obstacle` takes a line-of-sight test when walls should swing it in.
- **The rig** (`anim`, `assets`): `parseGltf(buffer)` → a `GltfDocument`; `skeletonFromSkin(doc, 0)` → a **`Skeleton`** (`parents`, `rest`, `inverseBind`, `joints`; this game sets `names` from the node names so sockets can be made by name); `interleaveSkinned(prim)` → `VERTEX_LAYOUT_SKINNED` vertices (position, normal, uv, colour, 4 joint indices, 4 weights); `doc.animations[i]` is an **`AnimationClip`**.
- **`AnimationMixer`** and **`createAnimGraph`** (`anim`): the mixer owns the **`Pose`** (`mixer.pose`, 10 floats per node: translation, rotation quaternion, scale); the graph (`character/graph.ts`) is `{ params, states, transitions, initial }`: a state is one clip or a 1D `blend` over a param; a transition is `{ from, to, when(params), fade, exitTime? }` (`from: '*'` from anywhere). Each tick `graph.set(name, value)`, `graph.update(dt)`, read `graph.state`, `graph.phase(state)` (0..1 of the clip) and `graph.actions(state)[0].time`.
- **Root motion** (`anim`): `extractRootMotion(clip, rootJoint, { planar: true })` → `{ clip, motion }`: `clip` plays with the hips held, `motion` holds the travel. `applyRootMotionDelta(motion, t0, t1, out)` → `[dx, dy, dz, yaw]` in the root's heading frame (the rig faces -Z); the game rotates it by the body yaw and feeds `moveController`.
- **`skinPose` / `poseToWorld` / `SkinPalette`** (`anim`, `render`): `skinPose(skeleton, pose, palette, slot, undefined, world)` is the one call per frame from the finished pose to the palette: it composes the 3×4 world matrices into `world` (12 floats per node, skeleton space; the sockets read them), multiplies by the inverse binds and writes the joints straight into `palette.write(slot)`. Pass a mixer and a `dt` instead of a pose to advance the clips in the same call. `poseToWorld(skeleton, pose, world)` alone is for IK and `lookAt` between edits; `palette.flush()` before the draw uploads the slot. The skinned material takes the palette as `skin` and the draw passes the palette slot in `params.w`.
- **`twoBoneIk`** (`anim`): `createIkChain(skeleton, { root, mid, tip })` once; `twoBoneIk(pose, skeleton, world, chain, targetWorld, poleWorld, instanceWorld, { weight })` bends the chain so `tip` reaches the target; `instanceWorld` is the body `Transform.world` so targets are in world units. The game plants each foot at the ground height under its animated position (clamped to ±0.35) and drops the hips by the lowest foot's offset.
- **`lookAt`** (`anim`): `lookAt(pose, skeleton, world, joint, targetWorld, instanceWorld, { forward, up, maxAngle, weight })` turns one joint's `forward` at a world point; the head uses `forward [0, 0, -1]`, `up [0, 1, 0]` and `maxAngle 1.1`. Recompute `poseToWorld` before each solver that reads `world`.
- **Sockets** (`anim`): `createSocket(skeleton, jointIndexOrName, { position?, rotation?, scale? })` once; `attachTransform(socket, world, instanceWorld, transform)` writes a `Transform` each frame for a mesh that rides the joint. See *Cosmetics*.
- **`geom`**: `createHeightfield(w, d, { scale, origin })` + a fill, `heightAt`, `normalAt`, `heightfieldGeometry(hf, { color })`; `box`, `sphere`, `capsule`, `cylinder`, `torus`, `mergeGeometry`, `transformGeometry(g, 3×4)`. A `Geometry` is a `MeshDesc`: `renderer.createMesh(geometry)`.
- **`createStandardMaterial(renderer, { baseColorFactor, metallic, roughness, skin })`** (`render`): the PBR material for the ground, the stones, the enemies, the cosmetics and the character; it reads `frame.lights` (sun, shadow, fog). With `skin: palette` it draws `VERTEX_LAYOUT_SKINNED` meshes through the palette (the character: vertex colours as albedo, `metallic: 0`, `roughness: 0.7`), so no custom WGSL.
- **`Lights`** (`render`): `lights.ambient`, `lights.sun.direction/color`, **`lights.sun.shadow = { extent, size }`** (one shadow map around the camera), `lights.fog.color/near/far` (`density: 1` for linear). `frame.lights = lights` each frame.
- **`ParticleSystem`** (`fx`): `new ParticleSystem(renderer, { space: 'world', capacity, blend: 'additive', fade, stretch })`; `system.emit(params, count)` bursts; `system.update(dt)`; `frame.drawable(system, order)` draws it.
- **`ctx.ui`** (`ui`): `createMeter(ctx.ui, { label, max, region, tone, format })` is the health bar; `ui.layout.add(el, { place: { default: 'top' | 'bottom', 'phone-portrait': 'hidden' }, order })`; `button(label, onClick)` and `h(tag, props, ...children)` build DOM; **`ui.anchors(() => ctx.camera).add(el, [x, y, z], { align: [0.5, 1], scale: 'distance', distance, hideBehind })`** pins a name plate to a world point (`handle.set(world)` moves it, `handle.remove()`); `ui.toasts.show(text, { tone, duration })`.
- **`Input` bindings** (`input`): `bindings: Record<Action, Binding[]>` with `{ key }`, `{ padButton }`, `{ gesture: 'tap' }`; `input.pressed(a)`, `held(a)`, `input.lastDevice` for prompts.
- **`Scene`** (`core`): `{ name, enter(ctx), exit(), update(dt), render(frame, camera, alpha) }`; `ctx.stack.push(scene)`.

## Cosmetics

`src/character/cosmetics.ts` is a table: `COSMETICS: CosmeticSlot[]`, each slot `{ slot, joint, local, options: [a, b] }` and each option `{ name, build, color, metallic, roughness }`. The scene (`character.ts`) builds one mesh and one standard material per option once, makes one socket per slot (`createSocket(skeleton, JOINT_NAMES[joint], local)`) and each frame runs `attachTransform` on every slot and draws the option worn (`current`). The HUD shows one button per slot; `cycle(slot)` steps `current` with `nextOption`. Keys 1 / 2 / 3 and the pad's X / Y / B are the actions `cosmeticHead` / `cosmeticBack` / `cosmeticHand` in `ctx.ts`.

Socket space is the joint's: at rest the joint axes are the world axes, the character faces -Z, +Y is up. So "behind the back" is +Z, "down the hand" is -Y, "above the head" is +Y. `local.position` places the socket on the joint; an option's `build()` returns geometry around the socket origin (`place(geometry, position, axis, angle, scale)` composes `transformGeometry`).

**Adding a fourth slot** (say a shield on the left hand), without reading the engine:

1. In `cosmetics.ts`: add `'hand-left'` to `SlotName` and `SLOT_NAMES`, then push a `CosmeticSlot` onto `COSMETICS` with `joint: J.handL`, `local: { position: [0, -0.05, 0] }` and two options built from `geom` (a `cylinder({ radius: [0.22, 0.22], height: 0.03 })` turned to face -Z is a round shield). The joint table `J` in `rig.ts` lists every joint; `cosmetics.test.ts` checks the slot is on a real joint and both options build.
2. In `ctx.ts`: add an action (`cosmeticHandLeft`) with a key and pad button, and in `scenes/arena.ts` call `cycle(3)` on `input.pressed` of it. The HUD button appears by itself (it maps `COSMETICS`).
3. Nothing in `character.ts` changes: it maps `COSMETICS` to sockets, meshes and materials.

A slot with more than two options: widen `options` from a pair to `readonly CosmeticOption[]`; `nextOption` already wraps on `length`.

## Extending it

- **A new clip** (a dodge, a second attack): add its name and duration to `CLIP_NAMES` / `CLIP_DURATIONS` and a `keys` function in `rig.ts` (or ship it in a real glb), a state and transitions in `graph.ts`, a param set from an action in the scene. The `rig.test.ts` clip test checks the duration.
- **A real model**: fetch a glb into `createCharacter` instead of `buildCharacterGlb()`; keep the clip names, set `skeleton.names` from the file and map `J` to its joint indices by name (`doc.nodes[i].name`) rather than constants.
- **Weapons that hit**: the attack arc is `ATTACK_REACH` / `ATTACK_HALF_ANGLE` in `character.ts` and `swing()` in the scene; a per-option reach is one field on `CosmeticOption`.
- **Smarter enemies**: `stepEnemy` is the whole rule; `@thunderclap/engine/nav` gives a flow field or an A* path to replace the straight-line chase.
- **Walls that block the camera**: pass `obstacle` to the `Follow` (a `raycastReg` against the stone collider, as `swing()` does for line of sight) and the orbit pulls in instead of clipping.
- **A server**: apply its state in `ctx.hooks.frame(dt)` or the scene's `update`, send `controller.position` / `yaw` and the graph state from there.
