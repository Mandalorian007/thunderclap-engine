# engine/kit

`createGame` builds everything: post stack, particles, overlay, audio, input, XR. A small 2D game, a tool, or a client whose frames come from somewhere else pays for all of it. `@thunderclap-engine/engine/kit` is the same engine as parts: `composeGame` builds the core (surface, GPU, renderer, host, save, tick clock, scene stack, loop, page lifecycle, device loss, crash screen) and then only the services passed in, each as a `with*()` factory. A service that is not passed is never imported, so the bundler drops it. The root `createGame` is the default kit: every service on, with its signature and behaviour unchanged.

## Quick use

<!-- snippet:check -->
```ts
import { composeGame, withInput, withOverlay } from '@thunderclap-engine/engine/kit';

const ctx = await composeGame({
  root: document.getElementById('app')!,
  design: { width: 1920, height: 1080 },
  ui: withOverlay(),
  input: withInput<'go'>({ bindings: { go: [{ key: 'Space' }] } }),
});
if (ctx) {
  ctx.hooks.update = () => {
    if (ctx.input.pressed('go')) ctx.ui.toasts.show('go');
  };
  ctx.loop.start();
}
```

`ctx` has `ui`, `input`, `gestures`, `pointers`, `padNav` and `replay` because those services were passed, and no `post`, `particles`, `audio` or `xr` (they are type errors, not `undefined`). With no post stack the renderer draws through its built-in present pass (`renderer.post` is `null`).

## Entry points

| Name | What it is for |
| --- | --- |
| `composeGame(kit)` | build the core plus the services in `kit`; resolves `KitGame<K>` or `null` (no WebGPU: the unsupported screen is shown) |
| `withOverlay(opts?)` | `ctx.ui`, the overlay with its layout (`KitOverlayOptions`: `styles`, `layout`, `theme`, `textScale`); needs a DOM |
| `withInput(opts)` | `ctx.input`, `gestures`, `pointers`, `padNav`, `replay(rec)` (`KitInputOptions`: `bindings`, `globalKeys`, `buttonKeys`, `blocked`, `getGamepads`, `magnify`, `record`, `replay`, `testers`) |
| `withAudio(opts?)` | `ctx.audio`; `mixerKey` persists the mixer |
| `withPost(settings?)` | `ctx.post`, the post stack, set as `renderer.post` |
| `withParticles(opts?)` | `ctx.particles`, updated after the hooks and before the scenes |
| `withXr(opts?)` | `ctx.xr`: `enter()` / `exit()` an immersive session (`XrOptions`, `XrControl`) |
| `createExternalFrames()` | a `FrameSource` for a `GameLoop` the game drives itself (`ExternalFrames.frame(loop, now)`) |

Each service is also constructible alone from an explicit dependency list, for a game that wires its own loop: `createKitOverlay(deps: KitOverlayDeps)`, `createKitInput(deps: KitInputDeps)` (returns `KitInput`: the fields and its `step(dt)`), `createKitAudio(deps: KitAudioDeps)`, `createKitXr(deps: KitXrDeps)` (returns `KitXr`: the fields, the session's `surface` and `frame`). `bootKit(opts: KitBootOptions)` is the core's boot alone (zoom block, surface, WebGPU; resolves `KitBoot` or `null`), and `createKitRenderer(gpu, design, aux?)` the renderer on it with GPU error logging.

## Options

`KitOptions` is `createGame`'s core options: `root`, `gpu`, `dom`, `host`, `clock`, `title`, `design`, `surface`, `aux`, `onGpuReady`, `blockBrowserZoom`, `forceUnsupported`, `save` (`(host) => FlushableSave`), `crash` (`boolean | CrashOptions`), plus `loop` (`KitLoopOptions`) and one field per service: `ui`, `audio`, `input`, `post`, `particles`, `xr`.

- `loop.sim` (`SimOption`): `{ step }` for fixed steps (default 1/60) calling `hooks.update`, or `false` for one update per rendered frame calling `hooks.frame(dt)`.
- `loop.frames`: `'host'` (default) runs on `host.requestFrame`. `'external'` is client mode: the engine schedules nothing and reads no clock; the game calls `ctx.frame(now)` (`KitExternalFrame`) once per frame with its own timestamp in ms, from its own `requestAnimationFrame`, a worker tick or a server-paced client. The first call after `loop.start()` runs with a delta of 0; calls while the loop is stopped (page hidden) or halted (device lost) are ignored; `maxFps` does not apply. `xr` needs the host's frames and is refused with `'external'`.
- `dom: false` runs with no DOM at all (needs `gpu` and `host`; `withOverlay` refuses it), as `createGame({ overlay: false })` does.

## Types

`KitGame<K>` is `KitCtx<S>` (the core fields: `design`, `surface`, `gpu`, `renderer`, `camera`, `setCamera`, `host`, `save`, `clock`, `stack`, `loop`, `hooks`, `onDeviceLost`) plus each passed service's fields (`KitOverlayFields`, `KitInputFields`, `KitAudioFields`, `KitPostFields`, `KitParticleFields`, `KitXrFields`) plus `frame(now)` in client mode. `S` is inferred from `save`, `null` without it.

A service is a `KitService<F, Part>`: `setup(core: KitCore)` returns a `KitPart<F>` (`{ fields }`) or a `KitStepPart<F>` (`{ fields, update(dt) }`). `KitCore` is what the core hands a service: `design`, `surface`, `gpu`, `renderer`, `host`, `clock`, `loop`, `hooks`, `dom`, `aux`, the overlay (`ui`) and pointer router (`pointers`) when those services are on, and `rayCamera()`. Services are built in a fixed order (post, particles, overlay, audio, input, XR) so an input can block under the overlay's modal panels and XR can add its controllers to the input's pointer router.

The 1.x types `createGame` re-exports live here too: `FlushableSave`, `GameHooks`, `HideReason`, `ShowReason`, `SimOption`, `CrashOptions`, `ReplayOptions`, `GameReplay`, `XrOptions`, `XrControl`.

## The loop

Per update: input (a replay's feed, the clock's advance, `input.update`, pad navigation) or, without input, the clock's advance; audio; `hooks.update` (fixed) or `hooks.frame` (`sim: false`); particles; scenes. Per render: `hooks.beforeRender`, `renderer.beginFrame`, the scenes (each XR eye while a session runs), `renderer.endFrame`, `hooks.afterRender`, `ui.updateAnchors`. A missing service drops its step and nothing else moves, so the default kit runs in exactly `createGame`'s 1.x order.

## Bundle size

The puzzle template (`templates/puzzle`, `vite build`, one chunk, gzip -9), measured on this branch:

| Build | Raw | Gzip |
| --- | --- | --- |
| `createGame` (the default kit) | 526.4 KB | 165.1 KB |
| `composeGame` with `withOverlay` and `withInput` (the services the template uses) | 356.9 KB | 112.3 KB (-32%) |

The lean build drops the post stack, particles, audio and XR. Its frames go through the built-in present instead of the post stack's finishing pass, so its pixels differ slightly; the templates stay on `createGame` and pixel-identical.

## Tests and demo

`src/kit/compose.test.ts` (plain Node, fake GPU and host): the core alone, each service's fields, the update order, the fake-GPU pass count with and without the post stack, device loss, client mode (no clock read, no frame scheduled, ignored while stopped). `harness/kit.html` is a 2D toy on the core alone (`?client` drives it with `ctx.frame(now)` from the page's own `requestAnimationFrame`); `e2e/kit.spec.ts` runs it.
