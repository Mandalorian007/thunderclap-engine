# testing

`@thunderclap/engine/testing` holds what a game's unit tests need to run in Vitest or plain Node, with no browser and no GPU: a fake host, a fixed-step clock, the recording fake GPU device and `createTestGame`, a whole headless game on them. The engine itself never imports it.

The entry is `src/testing/index.ts`. It re-exports the fake GPU from `src/render/fake-gpu.ts` and adds `fake-host.ts`, `fixed-clock.ts` and `test-game.ts`. `createTestGame({ overlay: false })` runs on `createGame`'s no-DOM mode (ws/core-9).

How a game uses these is in [Testing your game](../../docs/guide/testing-your-game.md).

## Fake host

`createFakeHost(opts?: FakeHostOptions): FakeHost` returns a full `Host` (`@thunderclap/engine/host`). Every optional facet (`lifecycle`, `haptics`, `safeArea`) is present, and nothing touches the DOM.

- **Storage.** `storage.open()` returns the same `MemoryStorage` on every call, and `memory` is that object. A game's save store can open it and round-trip through it. `{ storage: null }` makes a host with no working storage, where `open()` returns null. `{ storage }` hands in a backend the test built.
- **Lifecycle.** `setState('background' | 'active')` moves `lifecycle.state` (a getter). The `lifecycle.watch` listeners run only when the state changes. `{ state }` sets the starting state.
- **Haptics.** `impact`, `notification` and `vibrate` are pushed to `hapticCalls` as `FakeHapticCall`s (`{ op: 'impact', style }`, `{ op: 'notification', kind }`, `{ op: 'vibrate', ms }`). `{ haptics: false }` makes `available()` false, and the calls are still recorded.
- **Safe area.** `setSafeArea(partial)` sets some or all of the insets. The `safeArea.watch` listeners run only when a value changes. `{ safeArea }` sets the starting insets; missing sides are 0. The object `insets()` returns is reused.
- **Fullscreen.** Each `fullscreen.toggle(opts)` is pushed to `fullscreenCalls`. It flips `active()`, calls the watchers and resolves the new state. With `{ fullscreen: false }`, `available()` is false and `toggle` resolves false without changing anything.
- **Wake lock.** `wakeLock` is a `FakeWakeLock` (`request()`, `release()`, `held`, `calls`). `Host` has no wake-lock facet yet. This stub records what a game asks for through its own code.
- **Links and clipboard.** Each `openExternal(url, { activation })` is pushed to `opened` and answers `openResult` (default `'opened'`). Each `copyText(text)` is pushed to `copied` and resolves `copyResult` (default `'copied'`). `clipboardWriteAllowed()` answers `clipboardWriteAllowed` (default true). `kind` defaults to `'web'` and `embed` to `'top'`.
- **Frames.** `requestFrame` queues a callback and `cancelFrame` drops one. Nothing runs until `runFrame(timeMs?)`, which runs every callback queued before the call. It passes `timeMs`, or the last frame time plus `frameMs` (default 1000 / 60, starting at `startTime`, default 0). It returns how many callbacks ran. A callback that requests another frame is queued for the next call, so one `runFrame` is one display frame, and a `GameLoop` given the host as `frames` runs one frame per call. `pendingFrames` and `frameTime` read the queue and the last timestamp.

## Fixed clock

`createFixedClock(stepMs = 1000 / 60, start = 0): FixedClock` returns a `TickClock` (`@thunderclap/engine/input`), so it goes wherever `ctx.clock` goes: `createGestures({ clock })`, `createLook({ clock })`, `createInputPlayback(input, rec, { clock })`, or `GameLoop`'s `now` as `() => clock.now()`.

- `step(n = 1)` moves it by `n` whole steps. A negative, fractional or non-finite `n` is ignored. `ticks` counts the steps taken.
- `advance(ms)` moves it by a loose amount, the same as `createTickClock`. A negative or non-finite value is ignored. An advance of exactly `stepMs` counts as a step (ws/core-8), so a game loop that advances its clock by the fixed step reads exactly N × `stepMs` after N updates; other loose time is not counted in `ticks`.
- `now()` is `start + advanced + ticks × stepMs`. N steps read exactly N × `stepMs`, with no float drift from repeated adds.
- `stepMs` reads the step back. A step that is not a positive finite number throws a `RangeError`.

A test drives a game tick by tick in the order `createGame`'s loop uses: `clock.step()`, then `input.update()`, then the game's update.

## Headless `createGame`: `createTestGame`

`createGame` runs headless (ws/core-8): given `gpu` (a `GpuContext`) it skips WebGPU and the canvas context, `root` becomes optional, and `clock` and `host` take fakes. `createTestGame(opts): Promise<TestGame>` is that call with this kit's fakes: a `FakeDevice` as the GPU, a `FakeHost` (save storage in memory) and a `FixedClock` on the step of `opts.sim` (default 1/60 s) as `ctx.clock`. By default it needs a DOM for the overlay (`// @vitest-environment happy-dom`), and throws without one; `overlay: false` runs it with none (below).

```ts
const g = await createTestGame({ input: { bindings } });
g.input.keyDown('Space');
g.step(10);                      // ten frames: one fixed update and one render each
expect(g.clock.now()).toBe(10 * (1000 / 60));
```

- `TestGameOptions` are `createGame`'s, without `gpu`, `host` and `clock`, plus `root?` (default a new `<div>` in `document.body`), `host?: FakeHost`, `device?: FakeDevice` and `viewport?: { width, height }` (the CSS px size the root reports, since happy-dom lays nothing out; default the design size, so client px are design px). The canvas reports the box the surface gave it, so touch zones and the pointer router measure as on a page.
- `TestGame`: `ctx` (exactly what `createGame` built), `input`, `host`, `clock`, `device`, and `step(n = 1)`, which runs `ctx.loop.tickOnce(step)` `n` times: the replay feed, clock, input, `hooks.update`, scenes and one render, in the engine's order. The loop is not started; `ctx.loop.start()` with the fake host runs on `host.runFrame()` instead.
- Same input, same steps, same state: two games fed the same keys or the same recording read the same values frame for frame (`src/testing/test-game.test.ts`).
- `loseDevice(reason = 'unknown', message?): Promise<void>` loses the GPU device (`device.loseDevice`) and resolves once the engine has handled it, so a test asserts what follows; see *Device loss*.

### The DOM requirement, and `overlay: false`

`createGame` always builds the DOM overlay, mounts the canvas in `root`, attaches input listeners to the canvas and audio's page-lifecycle listeners to `document` and `window`, and the surface reads `getComputedStyle` and a `ResizeObserver`. So by default `createTestGame` needs a DOM: happy-dom (`// @vitest-environment happy-dom` at the top of the file), which lays nothing out, so the kit sizes the root to `viewport` itself.

`overlay: false` drops that need: the test runs in Vitest's default `node` environment with no DOM library (ws/testing-2). It is `createGame({ overlay: false })`, core's no-DOM mode (ws/core-9): nothing touches `document` or `window`, and no DOM global is installed, so the file stays plain Node. There is no overlay (reading `ctx.ui` throws), no canvas (`ctx.surface.canvas` and `root` throw) and no DOM listener. `ctx.surface` letterboxes a virtual container of `viewport` (default the design size), so `input.pointerAt(x, y)` maps as on a page of that size. Drive the game through `input` (`keyDown`, `pointerAt` and the rest) or a recording, and assert on game state, the clock and the `FakeDevice`. `root` is not used. The same holds under happy-dom. Tests that click overlay buttons or read the overlay's DOM keep happy-dom and the default `overlay`.

```ts
// game.test.ts: no `@vitest-environment` line
const g = await createTestGame({ overlay: false, input: { bindings } });
g.input.keyDown('Space');
g.step(10);
```

### Device loss

`FakeDevice.lost` is the device's `lost` promise (`fake.device.lost` is the same one). It stays pending until `loseDevice(reason = 'unknown', message = 'fake device lost')` resolves it with a `GPUDeviceLostInfo`, or `device.destroy()` resolves it with reason `'destroyed'`. Only the first loss counts. `createGame` reads it as on a page: on any reason but `'destroyed'` it halts the loop for good (`ctx.loop.halted`; `step` and `loop.start()` then do nothing), calls `hooks.deviceLost(info)`, halts audio, suspends captions, flushes the save, then runs each `ctx.onDeviceLost` listener. `TestGame.loseDevice` awaits all of that:

```ts
const g = await createTestGame({ overlay: false, input: { bindings }, save });
g.ctx.hooks.deviceLost = (info) => log.push(info.reason);
await g.loseDevice('unknown', 'gpu reset');
expect(g.ctx.loop.halted).toBe(true);    // and g.step() now runs nothing
```

The headless game shows no reload screen (there is none without WebGPU); a game that draws its own does so in `hooks.deviceLost`. Tests: `src/testing/test-game-node.test.ts`.

## Fake GPU

`createFakeDevice(opts?)` returns a recording fake `GPUDevice` as a `FakeDevice`, and `fakeRendererGpu(fake)` wraps it for `new Renderer(...)`, so the renderer and its props run in Node. It checks buffer and texture usage flags such as COPY_DST, catches writes past the end of a buffer, and records pass commands such as `setBindGroup` offsets and draws. `installGpuGlobals()` defines `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage` and `GPUMapMode` in Node. `fakeCanvasContext(fake)` is the context `fakeRendererGpu` uses.

A test can inspect these fields on a `FakeDevice` (and lose it with `loseDevice`, see *Device loss*):

- `buffers`: each is a `FakeBuffer`, with `size`, `usage`, `destroyed` and `data`.
- `textures`: each is a `FakeTexture`, and its views are `FakeView`s.
- `bindGroups`: each is a `FakeBindGroup`, with its layout and entries.
- `writes` and `textureWrites`.
- `passes`: each is a `FakePass`, with `kind`, `label` and `commands`. A `PassCommand` is one recorded `setPipeline`, `setBindGroup`, `draw`, `drawIndexed`, `dispatch` or other call.
- `bufferCopies` (each a `FakeBufferCopy`), `querySets` (each a `FakeQuerySet`), `submits` and `errors`.

Buffers hold bytes:

- `writeBuffer` stores into `data`. `copyBufferToBuffer`, `clearBuffer` and `resolveQuerySet` apply when their command buffer is submitted.
- A `MAP_READ` buffer maps for real. `mapAsync` resolves a microtask later, and `getMappedRange` returns a copy of the bytes.
- A missing usage flag throws `FakeGpuValidationError` (named `GPUValidationError`, also pushed to `errors`).
- Nothing runs shaders. `fake.runPass` is called with each pass at submit, so a test can write into `data` what a dispatch would have written.

The full rules are in the [render README](../render/README.md) under *Tests*.
