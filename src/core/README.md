# engine/core

The game loop, the scene stack (with async preload), a typed event emitter, 4×4 matrix helpers and
the deterministic game utilities: seeded random, positional hashing, noise, a scheduler and pools. `createGame`
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
done the input holds its last state. A replay attaches the input to an element outside the page
(keys are read from it too), so the recorded pointers (the recording's `ptr` lane) reach
`ctx.gestures` and `ctx.pointers` while no real pointer or key can (ws/core-4). Both options keep the rest of the pipeline untouched.

## createGame: the tick clock

`ctx.clock` (an `InputClock` from `@thunderclap/engine/input`, ms, starting at 0) is the game's
tick clock (ws/core-4). The loop advances it by the fixed step in each fixed update (after the
replay feed, before `input.update()`; with `sim: false`, by the frame delta once per frame), so
N fixed steps move `ctx.clock.now()` by exactly N × step, and a paused (`loop.paused`), stopped
or halted loop does not move it. `ctx.gestures` runs on it, so long-press and double-tap
windows are game time, and a recording made under `createGame` replays its long-presses on the
same tick whatever the wall time between ticks.

Gestures or a `Look` the game builds itself take the same clock, so both share one time base:

```ts
const look = createLook({ clock: ctx.clock });       // or new Look({ clock: ctx.clock })
const extra = createGestures({ clock: ctx.clock });  // a second recogniser, if any
```

With `input: { replay }` the playback drives the clock instead (`createInputPlayback(input,
recording, { clock: ctx.clock })`, ws/input-9): each tick it feeds advances it by the
recording's `tickMs`, so `ctx.input.playback.speed = 2` replays two recorded ticks per loop tick
with a long-press on the same recorded tick and game time, and the loop does not advance the
clock a second time (`playback.clock === ctx.clock`). Once the recording is done the loop's step
moves the clock again. `seek` never moves it.

A replay started mid-session (from a menu, after the game has run live) is the same call made by
the game: `createInputPlayback(ctx.input, recording, { clock: ctx.clock, speed })`. The loop reads
`ctx.input.playback` each fixed step (ws/core-5), so from the next step it runs `playback.step()`,
skips its own advance while that playback drives `ctx.clock`, and resumes it once the recording
ends; the long-press lands on its recorded tick (counted from the install) at any speed. Before
ws/core-5 only a playback built from `input.replay` was stepped. Unlike `input.replay`, the input
stays attached to the canvas, so real pointers and keys still reach it during such a replay.

## Scenes

- `Scene<Ctx, Frame, Cam>`: an interface with optional `name`, `transparent`, `enter(ctx)`,
  `exit()`, `pause()`, `resume()`, `update(dt)` and `render(frame, camera, alpha)`. A game
  implements one per screen (title, level, pause menu).
- `SceneStack(ctx)`: `push`, `pop`, `replace`, `clear`, `top`, `size`, `list()`. Only the top
  scene updates; rendering starts at the highest scene that is not `transparent` and goes up, so a
  pause menu draws over the level beneath it. Stack changes made inside `update` or `render` are
  deferred until that call returns. `createGame` exposes one as `ctx.stack` and renders it with
  `ctx.camera` (or with `ctx.xr.surface.head` while an XR session runs).

## Scenes: preload and transitions

- `Scene.preload?(ctx)`: an optional async hook. `push(scene)` and `replace(scene)` call it before
  touching the stack and return a `Promise<void>` that resolves once the scene has entered (at
  once for a scene without `preload`). While it is pending, `stack.transitioning` is true, the old
  top keeps updating and rendering, and later `push`/`pop`/`replace`/`clear` calls queue behind it
  in order. A rejected (or throwing) preload rejects the promise and leaves the stack unchanged; the
  queue carries on. Ops issued inside `update` are still deferred to the end of that call.
- `stack.onTransition(fn)` returns an unsubscribe. `TransitionListener(from, to, phase)` gets
  `TransitionPhase` `'preload'` (a preload started), `'enter'` (a push or replace entered `to`)
  or `'exit'` (a pop, replace or clear removed `from`; `to` is the new top). Hang a loading screen
  on it: open `ctx.ui.loading()` on `'preload'`, `done()` on `'enter'` (harness/core2.html
  `?preload`). Existing callers that ignore the returned promise behave as before.

## Random

- `createRandom(seed)`: a `Random` on xoshiro128** (state expanded from the seed by splitmix32).
  `Seed` is a number or a string (hashed with FNV-1a over UTF-8), so `createRandom('level-3')` is
  the same sequence in every browser and on the server. `next()` in [0, 1), `int(min, max)`
  inclusive and unbiased, `float(min, max)`, `bool(p)`, `pick(list)`, `weighted(weights)` (the
  index, -1 when the sum is not positive), `shuffle(list)` in place, `gaussian(mean, sd)`,
  `unitVec2(out)` / `unitVec3(out)` (`NumberSink`: any writable numeric array, `Float32Array`
  included). None of them allocate.
- `fork(name)`: an independent child stream keyed by the parent's seed and `name` (not by how far
  the parent has been drawn), so `world.fork('loot')` stays the same when another system draws
  more. `key` is the stream's 32-bit seed key; `state` reads and writes the four state words (a
  copy) for saves and replays.
- `seedKey(seed: Seed): number`: the 32-bit key a seed turns into (an integer number seed `>>> 0`,
  anything else FNV-1a over its UTF-8 bytes), the same key `createRandom(seed).key` holds and
  `hash2` / `hash3` start from. A game derives its own stable hashes from the engine's seed with
  it (`seedKey('level-3') ^ id`) instead of re-implementing FNV-1a. Allocation-free; its values
  are pinned by the FNV-1a reference tests and do not change.

## Hash

- `hash2(seed, x, z)` and `hash3(seed, x, y, z)`: a uint32 per lattice cell; `hash2f` and
  `hash3f` are the same value as a float in [0, 1) (`hash * 2^-32`). For a roll per point (a tree
  in this column, a speckle on this texel), where `Noise` would give a field between points and
  `Random` a sequence. `seed` is a `Seed` hashed exactly as `createRandom` hashes it, so `hash2('level-3', x, z)` is stable across engines; a string seed is rehashed per call, so a
  hot loop passes a number. Each coordinate is truncated toward zero to an
  int32 (`x | 0`): floor first when the cell is `Math.floor(x)`. The key (tagged per dimension)
  and then each coordinate are folded in with the lowbias32 finaliser, so neighbouring cells do
  not correlate (tested: mean and lag-1 correlation over a 256×256 grid) and `hash3(s, x, 0, z)`
  is unrelated to `hash2(s, x, z)`. Pure 32-bit integer arithmetic; nothing allocates.
- `Noise` keeps its own lattice hash, the seeded 256-entry permutation table: it is a lookup with
  period 256 that the noise goldens pin, so it is not re-expressed on `hash2` / `hash3`.

## Noise

- `createNoise(seed)`: a `Noise` with `perlin2`, `perlin3` (improved Perlin), `simplex2`,
  `simplex3` and `value2`, `value3`, each a `NoiseFn` `(x, y, z) => number` in [-1, 1] (2D ones
  ignore `z`) from one seeded permutation table. Same seed, same field.
- `fbm(fn, x, y, z?, opts?)`: fractal sum of `fn` over `FbmOptions` `{ octaves = 4,
  lacunarity = 2, gain = 0.5 }`, divided by the summed amplitude so the result stays in [-1, 1]
  and one octave equals `fn` exactly. A voxel heightmap is `fbm(noise.perlin2, x / 64, z / 64)`.

## Scheduler

- `createScheduler()`: a `Scheduler` the game drives with `update(dt)` (from `hooks.update` or a
  scene). `after(seconds, fn)` and `every(seconds, fn, { count })` (`EveryOptions`) return a
  `TimerHandle` (a number; stale handles are ignored after the slot is reused). `cancel(h)`,
  `remaining(h)` (-1 when not live), `active`, `time`, `pause()` / `resume()` / `paused`,
  `clear()`. Timers fire in due order, ties in scheduling order; an `every` behind by several
  periods catches up within one `update`; a timer scheduled from a callback fires on a later
  `update`. Entries live in a binary heap over reused slots, so steady-state scheduling does not
  allocate.
- `cooldown(name, seconds)`: a named `Cooldown` on the scheduler's clock (the same object for the
  same name): `use()` returns true and starts it when ready, else false; `ready`, `remaining`,
  `progress` (0..1, for a bar), `reset()`. Pausing the scheduler holds cooldowns too.

## Pool

- `createPool<T>(PoolOptions)`: `{ create, reset?, initial?, max? }`. A `Pool<T>` hands out
  `acquire()` (the most recently released item first, a new one from `create` while under `max`,
  else `undefined`), takes back `release(item)` (calls `reset`; false for an item not live),
  `forEach(fn)` over live items (releasing the current item inside it is safe), `drain()`, `size`
  and `live`. For particles, projectiles and damage numbers without per-frame allocation.

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

Tests: `loop.test.ts`, `scene.test.ts`, `math.test.ts`, `game.test.ts`, `random.test.ts`,
`hash.test.ts`, `noise.test.ts`, `timer.test.ts`, `pool.test.ts`; e2e/core2.spec.ts drives harness/core2.html.
