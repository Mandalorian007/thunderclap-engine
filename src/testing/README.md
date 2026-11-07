# testing

`@thunderclap/engine/testing` holds what a game's unit tests need to run in Vitest or plain Node, with no browser and no GPU: a fake host, a fixed-step clock and the recording fake GPU device. The engine itself never imports it.

The entry is `src/testing/index.ts`. It re-exports the fake GPU from `src/render/fake-gpu.ts` and adds `fake-host.ts` and `fixed-clock.ts`.

How a game uses these is in [Testing your game](../../docs/guide/testing-your-game.md).

## Fake host

`createFakeHost(opts?: FakeHostOptions): FakeHost` returns a full `Host` (`@thunderclap/engine/host`). Every optional facet (`lifecycle`, `haptics`, `safeArea`) is present, and nothing touches the DOM.

- **Storage.** `storage.open()` returns the same `MemoryStorage` on every call, and `memory` is that object. A game's save store can open it and round-trip through it. `{ storage: null }` makes a host with no working storage, where `open()` returns null. `{ storage }` hands in a backend the test built.
- **Lifecycle.** `setState('background' | 'active')` moves `lifecycle.state()`. The `lifecycle.watch` listeners run only when the state changes. `{ state }` sets the starting state.
- **Haptics.** `impact`, `notification` and `vibrate` are pushed to `hapticCalls` as `FakeHapticCall`s (`{ op: 'impact', style }`, `{ op: 'notification', kind }`, `{ op: 'vibrate', ms }`). `{ haptics: false }` makes `available()` false, and the calls are still recorded.
- **Safe area.** `setSafeArea(partial)` sets some or all of the insets. The `safeArea.watch` listeners run only when a value changes. `{ safeArea }` sets the starting insets; missing sides are 0. The object `insets()` returns is reused.
- **Fullscreen.** Each `fullscreen.toggle(opts)` is pushed to `fullscreenCalls`. It flips `active()`, calls the watchers and resolves the new state. With `{ fullscreen: false }`, `available()` is false and `toggle` resolves false without changing anything.
- **Wake lock.** `wakeLock` is a `FakeWakeLock` (`request()`, `release()`, `held`, `calls`). `Host` has no wake-lock facet yet. This stub records what a game asks for through its own code.
- **Links and clipboard.** Each `openExternal(url, { activation })` is pushed to `opened` and answers `openResult` (default `'opened'`). Each `copyText(text)` is pushed to `copied` and resolves `copyResult` (default `'copied'`). `clipboardWriteAllowed()` answers `clipboardWriteAllowed` (default true). `kind` defaults to `'web'` and `embed` to `'top'`.
- **Frames.** `requestFrame` queues a callback and `cancelFrame` drops one. Nothing runs until `runFrame(timeMs?)`, which runs every callback queued before the call. It passes `timeMs`, or the last frame time plus `frameMs` (default 1000 / 60, starting at `startTime`, default 0). It returns how many callbacks ran. A callback that requests another frame is queued for the next call, so one `runFrame` is one display frame, and a `GameLoop` given the host as `frames` runs one frame per call. `pendingFrames` and `frameTime` read the queue and the last timestamp.

## Fixed clock

`createFixedClock(stepMs = 1000 / 60, start = 0): FixedClock` returns a `TickClock` (`@thunderclap/engine/input`), so it goes wherever `ctx.clock` goes: `createGestures({ clock })`, `createLook({ clock })`, `createInputPlayback(input, rec, { clock })`, or `GameLoop`'s `now` as `() => clock.now()`.

- `step(n = 1)` moves it by `n` whole steps. A negative, fractional or non-finite `n` is ignored. `ticks` counts the steps taken.
- `advance(ms)` moves it by a loose amount, the same as `createTickClock`. A negative or non-finite value is ignored. Loose time is not counted in `ticks`.
- `now()` is `start + advanced + ticks × stepMs`. N steps read exactly N × `stepMs`, with no float drift from repeated adds.
- `stepMs` reads the step back. A step that is not a positive finite number throws a `RangeError`.

A test drives a game tick by tick in the order `createGame`'s loop uses: `clock.step()`, then `input.update()`, then the game's update.

## Headless `createGame`

This kit has no `createTestGame` yet. `createGame` mounts a canvas into `root` and boots WebGPU itself. It has no option to take a GPU device or a clock, so it cannot run in Node (ws/testing-kit wish). Until it can, a test drives the parts it needs on their own: `Input`, gestures on the fixed clock, a `GameLoop` on the fake host, a `Renderer` on the fake GPU.

## Fake GPU

`createFakeDevice(opts?)` returns a recording fake `GPUDevice` as a `FakeDevice`, and `fakeRendererGpu(fake)` wraps it for `new Renderer(...)`, so the renderer and its props run in Node. It checks buffer and texture usage flags such as COPY_DST, catches writes past the end of a buffer, and records pass commands such as `setBindGroup` offsets and draws. `installGpuGlobals()` defines `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage` and `GPUMapMode` in Node. `fakeCanvasContext(fake)` is the context `fakeRendererGpu` uses.

A test can inspect these fields on a `FakeDevice`:

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
