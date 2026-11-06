# ThunderClap Engine

A WebGPU game engine for the browser, written in TypeScript. It renders with raw WebGPU, runs on desktop, tablet and phone, and has no runtime dependencies.

`@thunderclap/engine` knows nothing about any game. A game supplies its scenes, rules and art; the engine supplies the canvas, the frame loop, rendering, post-processing, input, UI, audio, saves and the page lifecycle.

<p align="center">
  <img src="docs/media/last-rune.gif" alt="The Last Rune running on ThunderClap: title screen, the machine hall, then gems placed in a stone altar carry a lightning bolt to the gauge at exactly full charge." width="640" />
  <br />
  <sub><a href="https://mandalorian007.github.io/last-rune/">The Last Rune</a>, the first game built on ThunderClap</sub>
</p>

**Vision:** [docs/VISION.md](docs/VISION.md) says what ThunderClap is for and where it is going.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Modules](#modules)
- [How a frame runs](#how-a-frame-runs)
- [Testing](#testing)
- [Design rules](#design-rules)
- [Status and roadmap](#status-and-roadmap)
- [Built with ThunderClap](#built-with-thunderclap)
- [License](#license)

## Features

- **Raw WebGPU 2D renderer.** HDR colour and emissive targets, instanced quads and meshes merged by material, and materials with your own WGSL. In steady state it allocates nothing per frame.
- **Post stack.** Bloom fed by the emissive target, god rays, fog, vignette and colour grade, plus quality tiers for weaker devices.
- **GPU particles and flicker FX.**
- **One `createGame()` call.** It boots WebGPU, sets up a letterboxed (or width-filling) surface, and wires the renderer, post stack, particles, input, UI overlay, audio, save and a fixed-step 60 Hz loop into one ctx. Browsers without WebGPU get a styled "unsupported" screen instead.
- **Input.** An action map over keyboard, mouse, touch, pen and gamepad. Gestures cover tap, double tap, long-press, pan, drag and pinch. A magnifying loupe with snap-to-grid helps with small touch targets.
- **Layout regions for every form factor.** Phone landscape and portrait, tablet and desktop. Widgets are placed in CSS px, with safe areas (notch, home bar), 44 px touch targets and text scaling.
- **DOM UI overlay.** Panels, buttons, toggles, sliders, toasts, captions, a modal stack with gamepad navigation, and external links that still work when pop-ups are blocked.
- **Procedural audio.** WebAudio buses, a synth and sound recipes. The mixer settings persist.
- **Saves.** Versioned, schema-checked save slots with migrations. They survive a full or blocked `localStorage`.
- **Page lifecycle.** Hiding, `pagehide` and freeze stop the loop and flush the save. GPU device loss shows a reload screen instead of a frozen frame. Browser zoom gestures are blocked by default.
- **Hosts.** The page the game runs in is an interface (`Host`), so the same game runs in a top-level tab, a cross-origin iframe (as on itch.io), or an Electron desktop shell.

## Requirements

- A WebGPU browser: Chrome or Edge 113+, or Safari 26+ (including iOS and iPadOS).
- To develop: Node 22 or newer and pnpm (the version is pinned in `package.json`).

## Quick start

```sh
git clone https://github.com/Mandalorian007/thunderclap-engine.git
cd thunderclap-engine
pnpm install
pnpm example     # http://127.0.0.1:5173: a glowing square; click or press Space to flare it
```

This is the whole example (`examples/hello/main.ts`):

```ts
import { createGame } from '@thunderclap/engine';
import type { Scene } from '@thunderclap/engine/core';
import { type DrawParams, type Frame, hex } from '@thunderclap/engine/render';
import { createSaveStore, s } from '@thunderclap/engine/save';

const ctx = await createGame({
  root: document.getElementById('app')!,
  title: 'Hello ThunderClap',
  save: (host) =>
    createSaveStore({
      game: 'hello',
      slot: 'main',
      version: 1,
      defaults: () => ({ flares: 0 }),
      schema: s.object({ flares: s.number() }),
      host,
    }),
  input: { bindings: { flare: [{ mouse: 0 }, { key: 'Space' }] } },
});

if (ctx) {
  // null means no WebGPU: the unsupported screen is already showing.
  const square: DrawParams = { x: 960, y: 540, w: 240, h: 240, rotation: 0, emissive: 1 };
  let glow = 1;

  const hello: Scene<typeof ctx, Frame> = {
    update(dt) {
      square.rotation = (square.rotation ?? 0) + dt;
      if (ctx.input.pressed('flare')) {
        glow = 4;
        ctx.save.update((d) => ({ flares: d.flares + 1 }));
      }
      glow += (1 - glow) * Math.min(1, dt * 3);
    },
    render(frame) {
      frame.clear(0.02, 0.02, 0.04);
      square.tint = hex('#3fe0ff', glow); // HDR tint above 1 blooms
      frame.sprite(null, square);
    },
  };

  ctx.stack.push(hello);
  ctx.loop.start();
}
```

A pure client of a server-authoritative game leaves out `save` (then `ctx.save` is `null` and the engine never touches storage) and passes `sim: false`, so the loop runs once per rendered frame and calls `ctx.hooks.frame(dt)`, where it applies the latest server state.

VR: `createGame({ xr: XrOptions })` (`{ referenceSpace?, onEnter?, onExit? }`) gives `ctx.xr: XrControl` (`supported()`, `enter()`, `exit()`, `active`, `session`, `surface`). `enter()` requests an `immersive-vr` session with the WebGPU binding, moves the loop onto the session's frames, renders the scenes once per eye into its layer and adds the controllers and hands to `ctx.pointers` as rays; `exit()` (or the headset ending the session) restores the page. Nothing changes for a game that never calls it.

The world is a 1920×1080 logical space by default (origin top-left, y down). The surface scales it to fit any screen. A game typically widens `ctx` with its own nouns (`Object.assign(ctx, { ... })`), so every scene gets one typed ctx.

### Using it in a game

The package isn't on npm yet. It ships TypeScript source, which your bundler compiles (Vite is what it's built and tested with). Until it's published, add it as a workspace package or a git dependency:

```jsonc
// package.json
"dependencies": {
  "@thunderclap/engine": "github:Mandalorian007/thunderclap-engine"
}
```

Import only from the public entry points listed under [Modules](#modules). Anything not re-exported from a module's `index.ts` is internal.

## Modules

| Import | What it holds |
| --- | --- |
| `@thunderclap/engine` | `createGame(opts: CreateGameOptions)`, `EngineCtx`, `GameHooks` (with `HideReason`, `ShowReason`), `SimOption`, `FlushableSave`: the top layer a game touches |
| `@thunderclap/engine/core` | `GameLoop` (fixed step, fps cap, pause), `Scene` and `SceneStack`, `Emitter`, `mat4`, timing |
| `@thunderclap/engine/platform` | WebGPU boot, `Surface` (canvas, DPR, letterbox fit), page lifecycle, device detection, the unsupported and reload screens ([README](src/platform/README.md)) |
| `@thunderclap/engine/render` | `Renderer`, `Frame`, `Camera` (`ortho2d`, `perspective`), `render(frame, camera, target)`, materials and custom WGSL, meshes, transforms, textures, colour helpers ([README](src/render/README.md)) |
| `@thunderclap/engine/post` | `PostStack`: bloom, god rays, fog, vignette, grade, quality tiers ([README](src/post/README.md)) |
| `@thunderclap/engine/fx` | GPU particles, flicker and pulse ([README](src/fx/README.md)) |
| `@thunderclap/engine/input` | `Input` action map, `Gestures`, pointer router and rays, magnify/loupe, `snapToGrid` ([README](src/input/README.md)) |
| `@thunderclap/engine/ui` | Overlay, panels and widgets, toasts, captions, pad navigation, layout regions (`ui.layout`) ([README](src/ui/README.md)) |
| `@thunderclap/engine/audio` | WebAudio buses, synth, sound recipes, mixer persistence ([README](src/audio/README.md)) |
| `@thunderclap/engine/save` | `createSaveStore`, schemas (`s`), slots and migrations ([README](src/save/README.md)) |
| `@thunderclap/engine/assets` | `parseGltf` and `loadGltf`: glTF 2.0 static geometry to meshes, transforms, textures and a lit material ([README](src/assets/README.md)) |
| `@thunderclap/engine/analytics` | `createAnalytics`: typed, batched events to a game-supplied sink; no network code ([README](src/analytics/README.md)) |
| `@thunderclap/engine/host` | `Host` interface, `createWebHost()` (top-level page or iframe): links, clipboard, fullscreen, storage ([README](src/host/README.md)) |
| `@thunderclap/engine/testing` | A recording fake `GPUDevice` for unit tests (`src/render/fake-gpu.ts`) |

**Templates.** `templates/puzzle` (`@thunderclap/template-puzzle`) is a copyable 2D puzzle game: `createGame`, one scene, pure `rules/` with tests, a versioned save with a migration, a layout spec placing a HUD on every form factor, and a `CLAUDE.md` that names the engine concepts for an agent extending it. Run `pnpm template:puzzle`; `pnpm check` runs its typecheck and tests (`check:template-puzzle`).

**Packages.** `packages/host-electron` (`@thunderclap/host-electron`) is the Electron desktop host: a sandboxed shell, a preload bridge and `createElectronHost()`. It lives in this repo as a pnpm workspace package and the engine never imports it. Run `pnpm desktop:dev`, `pnpm desktop:build` or `pnpm test:e2e:desktop` ([README](packages/host-electron/README.md)).

[ARCHITECTURE.md](ARCHITECTURE.md) has the contracts for each one: what exists today and what is planned.

## How a frame runs

```
createGame()
  └─ GameLoop  (fixed 60 Hz update, variable-rate render, requestAnimationFrame)
       update(dt):  input → pad nav → hooks.update → particles → scene stack
       render:      hooks.beforeRender → renderer.beginFrame → scene stack → endFrame → hooks.afterRender

renderer.endFrame()
  1. upload globals and all instance data (one writeBuffer each)
  2. pre-passes and drawable.prepare() (compute, uploads), on the first render() of the frame
  3. scene pass per render(frame, camera, target) → HDR colour + emissive targets (+ depth)
  4. post stack (bloom, god rays, fog, vignette, grade) → swapchain
  5. submit
```

`renderer.render(frame, camera, target)` runs the recorded draw lists through a camera into a target, any number of times per frame; `endFrame` calls it with `renderer.camera` when nothing did. With the default `ortho2d` camera draw order is submission order (then `order`) and there is no depth attachment; a camera with depth sorts by view-space depth and tests depth. Consecutive draws with the same material and mesh batch into one instanced call.

## Testing

```sh
pnpm check       # typecheck + Biome lint + import boundaries + README coverage (check:docs) + Vitest unit tests (480 tests in 39 files)
pnpm test:e2e    # Playwright e2e against the harness pages, on a device matrix
pnpm harness     # serve the harness pages yourself
```

The e2e specs run against small harness pages that don't contain any game (`harness/`). Every spec runs on the same matrix:

- desktop at 1280×720 and 1920×1080;
- an iPad;
- four landscape phones with touch and safe-area insets;
- the harness inside a cross-origin iframe.

The layout spec also runs on upright phone and tablet rows. The pages: `index.html` (2D renderer), `game.html` (`createGame`), `ui.html` (the overlay, text scale, menus and panels, no WebGPU), `layout.html` (layout regions and safe areas on every form factor, no WebGPU), `gestures.html` (gestures and the magnify loupe, no WebGPU), `rays.html` (pointer router and rays), `mesh.html` (perspective camera, depth and a lit mesh orbiting under pointer and pad input), `weather.html` (world-space rain, snow and lit dust over the mesh scene), `look.html` (a first-person walk on `Look`: pointer lock, touch zones, sticks, WASD), `follow.html` (a third-person `Follow` camera over `Look`: orbit, shoulder, walls swinging it in, `V` for first person), `stream.html` (chunk meshes rebuilt in a Worker and uploaded without a copy), `anchors.html` (DOM labels and a clamped marker following cubes through `ctx.ui.anchors`), `gltf.html` (a GLB built in the page parsed and drawn through `@thunderclap/engine/assets`), `xr.html` (`createGame({ xr })` with an "Enter VR" button; on the matrix it proves the page path with `supported() === false`, on a headset it enters an immersive session) and `pick.html` (six spinning meshes picked through `meshTester`: click or tap tints the hit one). The engine tests what the platform can do; a game built on it tests only its own product.

Headless Chromium gets a WebGPU adapter with `--enable-unsafe-webgpu`. On macOS that's Metal; on Linux it's SwiftShader. `playwright.config.ts` sets the flags.

## Design rules

1. **No game nouns.** Code joins the engine only if a shipped game uses it, the next game plausibly would, and its API names nothing from that game.
2. **One direction.** Games import the engine; the engine never imports a game.
3. **No runtime dependencies.** WebGPU is the only renderer.
4. **Browser-only storage.** Saves go through `Host.storage`, which is `localStorage` on the web. The engine makes no network calls.
5. **Seams, not speculation.** 3D and XR are out of scope for now. The engine keeps the three seams they would plug into (`Surface`, `Camera`, the frame loop) and doesn't build ahead of a real game's need.

## Status and roadmap

Version **0.2.0-alpha.1**. The API is still settling: see [CHANGELOG.md](CHANGELOG.md). Current work is in [docs/STATUS.md](docs/STATUS.md), and the decisions behind the engine are in [docs/DECISIONS.md](docs/DECISIONS.md).

The engine was built inside The Last Rune and extracted into this repo with its git history. That's why commit messages, decision numbers (`D-0xx`) and `docs/` paths in comments point at [that repo](https://github.com/Mandalorian007/last-rune), where the design notes live.

Next up:

- **A lighting block** (ambient, directional and point lights) that game WGSL reads.
- **Dynamic meshes** streamed from a Worker without a main-thread copy.
- **Two views per frame**, the stereo seam XR will plug into.
- **`createGame` plumbing**: gestures and pointers wired, a design-px helper for fitting a camera to `layout.freeRect`.
- **Publishing** `engine-v1.0.0`.

## Built with ThunderClap

### The Last Rune

[**Play free in your browser →**](https://mandalorian007.github.io/last-rune/) · [Source](https://github.com/Mandalorian007/last-rune)

The Last Rune is the game that started ThunderClap, and the first one built on it.

Runes are gemstones that carry lightning. In a forgotten facility you set them into carved stone altars so a captured bolt flows from the storm cell to a dead machine and arrives at exactly full charge: not a spark short, not a spark over. There are sixteen machines and six kinds of gem, each with its own rule. Your guide is FUSE, a forty-year-old foreman robot who has been waiting a long time for someone to show up. It takes about an hour.

Everything on screen and every sound is procedural, generated in code with no asset files. The engine came out of building it. The renderer, bloom and god rays, the gem glow, the phone layout, the touch loupe for small sockets and the save system all began as Last Rune code, and moved into the engine once they no longer named anything from the game.

*Made a game with ThunderClap? Open a pull request and add it here.*

## License

MIT. See [LICENSE](LICENSE).
