# `@thunderclap-engine/engine/xr`

Headset comfort and controllers, beside the session and the stereo views. The session itself is `createGame({ xr })` and `ctx.xr` (`./kit`); the eyes are `XrSurface` (`./platform`), each eye a render-core view and both eyes one `union` cull group (`ctx.xr.setCore(core, { immediate: false })` draws a headset frame with one cull dispatch). This module is what a game does on top: ease the view, fade a vignette, turn about the head, fit the player's height, read the sticks and pose controller models. It is pure: no WebXR global, no DOM, no action names, and nothing allocates per frame. Ported from Forge Wilds' XR layer (ws/xr-merge).

## Quick use

<!-- snippet:check -->
```ts
import { createPads, headRelative, headYawOf, readPads, Vignette, XrSticks } from '@thunderclap-engine/engine/xr';

declare const session: { inputSources: ArrayLike<{ handedness: string; gamepad?: { buttons: ArrayLike<{ pressed: boolean }>; axes: ArrayLike<number> } | null }> };
declare const headOrientation: Float32Array; // the viewer pose's quaternion (x, y, z, w)

const pads = createPads();
const sticks = new XrSticks({ turn: 'snap', snapDeg: 30 });
const vignette = new Vignette();
const walk: [number, number] = [0, 0];
let bodyYaw = 0;

function frame(dt: number): void {
  readPads(session.inputSources, pads);
  sticks.frame(pads.left, pads.right, dt);
  bodyYaw += sticks.turn;
  if (sticks.snapped) vignette.snapped();
  headRelative(sticks.move, headYawOf(headOrientation) + bodyYaw, walk); // world x, z
  vignette.frame(walk[0] !== 0 || walk[1] !== 0 ? 1 : 0, 0, dt);
  // the game moves its body by walk × speed, draws a vignette of vignette.strength
}
```

## Entry points

**Comfort** (`comfort.ts`).
- `ViewEase` (`ViewEaseOptions`: `tau`, `maxJump`; defaults `EASE_TAU_S`, `EASE_MAX_JUMP`) smooths what the game's body does to the eye: each frame `frame(eye, body: EaseBody, nowMs)` with the body's `corrections` (snaps a collision made, given back over `tau`) and `resets` (teleports); a far move or a reset snaps and counts in `jumps`; `free` eases nothing. `out` is the drawn eye.
- `Vignette` fades in while moving and out at rest (`strength`, default `VIGNETTE_DEFAULT`), blinks on a snap turn (`snapped()`: `SNAP_BLINK` for `SNAP_BLINK_MS`) and fades over a jump (`jumped()`, `JUMP_FADE_MS`); `edge` and `fade` are what the game draws.
- `SpeedLimit` (`SpeedLimitOptions`: `maxSpeed`, `maxAccel`, `maxTurnDegS`) clamps a move (`move(vx, vz, dt)` into `out`) and a turn (`turn(angle, dt)`).

**Height** (`height.ts`). `HeightCalibration(eyeHeight, mode: HeightMode)` maps the real head onto the body: `'avatar'` measures the standing head over `WAIT_MS` (clamped to `HEAD_MIN`..`HEAD_MAX`) and scales it to the body's eye, `'real'` keeps the room's height. `ask(why: CalibrateWhy)` re-measures, `frame(headY, now)` is true when a measure lands, `eyeOverFeet(headY)` is the drawn eye height, `report()` a `HeightReport`.

**Turning about the head** (`pivot.ts`). `HeadPivot` carries the drawn place on each turn so a head standing away from the body's place (a step in the room) stays put and only the view turns: `turn(eye, before, after, hx, hz, blocked?)`, capped at `PIVOT_MAX` (`maxCarry`) and refused where the game's `PivotBlocked` test says the carried body would stand in a wall (`fallbacks`); `check(eye, blocked)` drops a carry that became blocked (`drops`). `cellBoxBlocked(x, y, z, box: BodyBox, solid: SolidAt)` is a ready test for unit grids.

**Sticks** (`sticks.ts`). `XrSticks` (`XrSticksOptions`: `moveHand`, `turn` `'snap' | 'smooth'`, `snapDeg`, `smoothDegS`) reads two xr-standard pads (`XrPad`) each frame into `move` (x right, y forward, `STICK_DEAD` dead zone), `turn` (radians, `snapped` on a snap past `SNAP_AT`, re-armed under `REARM`), `flick` (±1) and `any`, with `held`, `pressed` and `released(hand, button: XrButtonName)` over `XR_BUTTON` (trigger 0, grip 1, stick 3, primary 4, secondary 5). `headYawOf(q, keep)` is the head's yaw on the ground (0 faces -z, positive right); `headRelative(move, yaw, out)` turns a stick move into world x, z.

**Pads** (`pads.ts`). `readPads(session.inputSources, out: XrPads)` sorts the session's gamepads by hand (a tracked hand, with no gamepad, is null), with each side's profiles; `createPads()` makes the reused object. `PadSource` is the part of an `XRInputSource` it reads.

**Controller models** (`controller.ts`). The WebXR input profiles' layouts read against a model: `profileFor(profiles, have, fallback)` picks a profile (default `FALLBACK_PROFILE`), `layoutOf(profile: ProfileJson, hand: ControllerHand, nodeNames)` gives a `ControllerLayout` (its `ComponentLayout`s and `ResponseLayout`s as node indices, and `parts`: the node each `ControllerPart` label hangs on), and `ControllerPose.frame(pad)` writes each response's 0 to 1 value into `values` and `hidden` (visibility responses). `componentState` (a `STATE_DEFAULT`, `STATE_TOUCHED` or `STATE_PRESSED` bit) and `responseValue` are the pieces; `Prop` names what a response reads. The game loads the profile JSON and the model (`./models`) and poses the nodes.

## Testing

`@thunderclap-engine/engine/testing` carries the fake WebXR stack: `installFakeXr` (a `FakeXr` with `FakeXrSession`, `FakeXrInputSource` with `press` and `stick` on an xr-standard pad) for unit tests over the fake GPU, and `emulateXr` (an `XrEmulator`, `EmulateXrOptions`) for a page: the fake on the real GPU, stepped by animation frames, the layer mirrored onto a canvas (`harness/stereo.html`, `e2e/stereo.spec.ts`). Controllers reach `createIntents` as XR pointer rays (`src/kit/xr-intents.test.ts`).
