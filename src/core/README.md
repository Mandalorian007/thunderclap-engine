# engine/core

The game loop, the scene stack, a typed event emitter and 4×4 matrix helpers. `createGame`
(root `@thunderclap/engine`) wires these together; a game reaches for this subpath when it needs
one of them on its own (a tool, a test, a second loop).

`createGame({ input: { getGamepads } })` names the gamepad source for both the action map
(`InputOptions.getGamepads`) and the pad navigation of modal panels (`PadNav`); the default is
`navigator.getGamepads()`, guarded. A test passes a fake `GamepadLike` here and drives
`ctx.padNav` by ticking the loop.

## Loop

```ts
import { GameLoop } from '@thunderclap/engine/core';

const loop = new GameLoop({ update: (dt, time) => sim(dt), render: (alpha) => draw(alpha) }, { step: 1 / 60 });
loop.start();
loop.paused = true;  // update stops, render keeps running (menus still draw)
loop.maxFps = 30;    // steady 30 fps on a 60 Hz display; null = every display frame
```

- `GameLoop(cb: LoopCallbacks, opts?: GameLoopOptions)`: fixed-step update plus variable-rate
  render, driven by the host's frames (`Host.requestFrame`). `start()`, `stop()` (tab hidden),
  `halt()` (device lost: later `start()` calls are ignored), `tickOnce(dt)` (tests, frame
  stepping), `setFrames(src)` (swap the `FrameSource` while running: the pending frame on the
  old source is cancelled and the next comes from the new one; called from inside a frame, the
  running frame finishes and reschedules through the new source; `createGame` uses it to move
  onto an XR session's host and back), `isRunning`, `halted`, `paused`, `maxFps`, `time`.
  In VR `createGame`'s render step draws each eye into the XR surface's HDR `scene` target and
  resolves it through the post stack into the eye's part of the layer (`renderer.resolve`,
  ws/xr-post), then `endFrame({ present: false })`.
- `LoopCallbacks`: `update(dt, time)` runs in fixed steps of `time.step`; `render(alpha, time)`
  once per rendered frame, `alpha` interpolating between sim states (0 while paused).
- `GameLoopOptions` extends `FixedStepperOptions` with `fixed` (default true; false runs update
  once per rendered frame with the real delta, for a client that applies another's state), `now`
  (clock in ms, default `performance.now`) and `frames` (the `FrameSource`; `createGame` passes its
  host, a test passes a stub).
- `Time`: read-only, mutated in place by the loop: `step`, `simTime`, `realTime`, `frameDt`,
  `frame`, `tick`. Systems read it instead of keeping their own clocks.
- `FixedStepper(opts?: FixedStepperOptions)`: the pure accumulator behind `GameLoop`. `advance(frameDt)`
  returns how many fixed steps to run, `alpha` is the interpolation factor, `reset()` clears it.
  Options `step` (1/60 s), `maxFrameDt` (0.25 s clamp for tab switches and breakpoints),
  `maxSteps` (8 per frame, the spiral-of-death guard). Use it directly to step a simulation
  outside the render loop (a server, a replay).

## createGame: input recording and replay

`createGame({ input: { ..., record: true } })` records everything `ctx.input` is fed from the first
tick: `ctx.input.recorder` is the `InputRecorder`, `stop()` it for the `InputRecording` (plain
JSON; `serializeRecording` in `@thunderclap/engine/input`). `createGame({ input: { ..., replay } })`
runs from a recording instead: the input is not attached to the canvas or the window, and before
each fixed step `ctx.input.playback.step()` feeds that tick's keys, buttons, pointer, wheel and
pads, so an identical game sees identical `pressed`/`held`/`value` per tick. Once the recording is
done the input holds its last state. Both options keep the rest of the pipeline untouched.

## Scenes

- `Scene<Ctx, Frame, Cam>`: an interface with optional `name`, `transparent`, `enter(ctx)`,
  `exit()`, `pause()`, `resume()`, `update(dt)` and `render(frame, camera, alpha)`. A game
  implements one per screen (title, level, pause menu).
- `SceneStack(ctx)`: `push`, `pop`, `replace`, `clear`, `top`, `size`, `list()`. Only the top
  scene updates; rendering starts at the highest scene that is not `transparent` and goes up, so a
  pause menu draws over the level beneath it. Stack changes made inside `update` or `render` are
  deferred until that call returns. `createGame` exposes one as `ctx.stack` and renders it with
  `ctx.camera` (or with `ctx.xr.surface.head` while an XR session runs).

## Events

- `Emitter<M extends EventMap>`: a typed event emitter. `on(type, fn)` returns an unsubscribe
  function; `once`, `off`, `emit(type, payload)`, `listenerCount`, `clear`. Listener arrays are
  copy-on-write, so `emit` never allocates and listeners may unsubscribe during dispatch.
- `EventMap`: the constraint for an emitter's event map, a record of event name to payload type.

## Math

- `Mat4`: a column-major `Float32Array(16)`, the layout WGSL's `mat4x4f` expects.
- `mat4`: `create`, `identity`, `copy`, `multiply`, `ortho`, `perspective`, `lookAt`, `view2d`,
  `invert`, `transformPoint`. Every function writes into `out` and returns it (`out` may alias an
  input), so a caller that keeps its matrices allocates nothing per frame. Right-handed view space
  looking down -z; clip depth 0..1.

Tests: `loop.test.ts`, `scene.test.ts`, `math.test.ts`, `game.test.ts`.
