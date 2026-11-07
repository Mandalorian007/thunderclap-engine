# Getting started

In this guide you clone the engine, run the example, scaffold a game from a template and run it. Then you learn the shape every ThunderClap game shares, and how to ship one to itch.io, the desktop or an installable web app.

## What you need

- Node 22 or newer and pnpm (the repo pins the version in `package.json`).
- A WebGPU browser: Chrome or Edge 113+, or Safari 26+. A browser without WebGPU shows a styled "unsupported" screen instead of the game.

## Run the example

```sh
git clone https://github.com/Mandalorian007/thunderclap-engine.git
cd thunderclap-engine
pnpm install
pnpm example
```

Open `http://127.0.0.1:5173`. You see a glowing square that spins. Click or press Space and it flares. The whole game is one file, `examples/hello/main.ts`, about 50 lines. You will read it piece by piece below.

## Scaffold a game

A template is a complete, small game you copy and then change. List them:

```sh
node scripts/create-game.mjs --list
```

There are four:

| Template | What it is |
| --- | --- |
| `puzzle` | A 2D card-pairs game: one scene, pure rules, a versioned save, a HUD layout. The smallest start. |
| `platformer` | A 2D side-scroller: a tile map from a string level format, a flipbook player, a pause menu, sounds, a save. |
| `first-person` | A first-person walk over chunked terrain: `Look` controls, Worker-built meshes, shadows, fog, weather. |
| `third-person` | A third-person action game: a skinned character, a `Follow` camera, enemies with health bars. |

Pick one and copy it out of the repo. Run this from the engine checkout:

```sh
pnpm create-game ../my-game --template platformer --engine .
cd ../my-game
pnpm install
pnpm dev
```

`--engine .` points the new game at your clone (it becomes a `link:` dependency). Without it, the game asks for `@thunderclap/engine` from the npm registry, which the engine is not published to yet. Other useful flags: `--name <pkg>` sets the package name, `--dry-run` prints the files it would write, and `--force` writes into a folder that is not empty.

`pnpm dev` starts Vite at `http://127.0.0.1:5173`. `pnpm check` runs the type checker, the linter and the game's tests.

Each template has a `CLAUDE.md` that lists its files, its house rules and every engine noun it uses. Read it before you change anything. It is written so that you (or an agent) never need to open the engine's source.

## The shape of a game

Every game starts with one call to `createGame`. It boots WebGPU on a letterboxed canvas and returns the engine ctx, or `null` when the browser has no WebGPU (the engine has already shown the unsupported screen, so you just stop).

```ts
import { createGame } from '@thunderclap/engine';
import type { Scene } from '@thunderclap/engine/core';
import { type DrawParams, type Frame, hex } from '@thunderclap/engine/render';

type Action = 'flare';

const ctx = await createGame<Action>({
  root: document.getElementById('app')!,
  title: 'My game',
  design: { width: 1920, height: 1080 },
  input: { bindings: { flare: [{ mouse: 0 }, { key: 'Space' }, { gesture: 'tap' }] } },
});

if (ctx) {
  const square: DrawParams = { x: 960, y: 540, w: 240, h: 240, rotation: 0, emissive: 1 };

  const play: Scene<typeof ctx, Frame> = {
    name: 'play',
    update(dt) {
      square.rotation = (square.rotation ?? 0) + dt;
      if (ctx.input.pressed('flare')) square.emissive = 4;
    },
    render(frame) {
      frame.clear(0.02, 0.02, 0.04);
      square.tint = hex('#3fe0ff', 1);
      frame.sprite(null, square);
    },
  };

  ctx.stack.push(play);
  ctx.loop.start();
}
```

The page needs one element for the engine to mount into. The templates use `<main id="app">` with `position: fixed; inset: 0`.

### The options

The options you will use first:

- `root`: the element the canvas and the DOM overlay mount into.
- `title`: the game's name, shown on the fatal screens (no WebGPU, device lost).
- `design`: the logical size in design pixels. Default 1920×1080. The camera, the renderer and the overlay all share it, and the surface letterboxes it to fit the window.
- `input.bindings`: one list of bindings per action. Your code reads actions (`ctx.input.pressed('flare')`), never keys.
- `save(host)`: builds the game's save from the host's storage. Leave it out and `ctx.save` is `null`.
- `layout`: the HUD regions per form factor (phone, tablet, desktop).
- `sim`: the fixed-step simulation (see below).
- `host`: where the game runs. The default is the web host. You swap it to ship to the desktop.

Others: `post` (bloom, fog, grade), `mixerKey` (persist audio volumes), `styles(doc)` (your stylesheets), `xr` (VR), `input.magnify` (a loupe for small touch targets).

### The ctx

`EngineCtx` is everything the engine built for you, in one object:

- `renderer`, `camera`, `post` and `particles` for drawing.
- `input`, `gestures`, `pointers` and `padNav` for input.
- `ui` (the DOM overlay and its layout), `audio`, `save` and `host`.
- `stack` (the scenes), `loop` (the frame loop), `clock` (game time in ms) and `hooks`.

### Scenes and `ctx.stack`

A scene is one screen: a title, a level, a pause menu. It is a plain object with optional `name`, `enter(ctx)`, `exit()`, `pause()`, `resume()`, `update(dt)` and `render(frame, camera, alpha)`.

`ctx.stack` holds them. `push(scene)` puts a scene on top, `pop()` removes it, `replace(scene)` swaps the top. Only the top scene updates. A scene with `transparent: true` draws over the one beneath it, so a pause menu shows the level behind it.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import type { Scene } from '@thunderclap/engine/core';
import type { Frame } from '@thunderclap/engine/render';

export function pauseMenu(ctx: EngineCtx<'back'>): Scene<EngineCtx<'back'>, Frame> {
  return {
    name: 'pause',
    transparent: true,
    update() {
      if (ctx.input.pressed('back')) ctx.stack.pop();
    },
    render(frame) {
      frame.sprite(null, { x: 960, y: 540, w: 1920, h: 1080, tint: [0, 0, 0, 0.5] });
    },
  };
}
```

A stack change made inside `update` or `render` waits until that call returns, so popping yourself is safe.

### `Frame`: what you draw with

`render` gets a `Frame`, the recorder for this frame's draws. `frame.clear(r, g, b)` sets the background. `frame.sprite(material, params)` draws a quad; pass `null` for a flat sprite. `frame.mesh(mesh, material, transform)` draws geometry. Draws with the same material and mesh batch into one GPU call. The engine draws the frame through `ctx.camera` after your scenes return.

The default camera is `Camera.ortho2d(1920, 1080)`: the origin is top left, y points down and one unit is one design pixel. The [2D guide](2d-game.md) and the [3D guide](3d-game.md) go further.

### The loop: `update` and `render`

`ctx.loop.start()` starts the frame loop. Nothing runs before that call.

The loop has two rates:

- `update(dt)` runs in fixed steps of 1/60 s. On a 120 Hz display it runs about every other frame; after a slow frame it runs several times to catch up. `dt` is always the step, so physics and timers behave the same on every machine. Put game logic here.
- `render(frame, camera, alpha)` runs once per displayed frame. `alpha` (0 to 1) says how far you are between the last two steps, if you want to interpolate. Put drawing here and keep game rules out of it.

`ctx.hooks.update` runs once per fixed step before the scenes, for systems that are not a scene (tweens, a scheduler). `ctx.hooks.afterRender` runs after each drawn frame. `ctx.loop.paused = true` stops `update` but keeps `render`, so menus still draw. A different step: `sim: { step: 1 / 120 }`.

The engine also stops the loop when the page is hidden and flushes the save, then starts it again when the page comes back. You do not write that code.

### `sim: false`: client mode

Some games do not own their simulation: a client that shows a server's state, or an explorer with nothing to keep in step. `sim: false` runs the loop at render rate. Each frame, `hooks.frame(dt)` and the top scene's `update(dt)` run once with the real frame delta. The `first-person` and `third-person` templates use it, and leave `save` out, so the engine never touches storage.

```ts
import { createGame } from '@thunderclap/engine';

const ctx = await createGame({
  root: document.getElementById('app')!,
  sim: false,
  input: { bindings: { forward: [{ key: 'KeyW' }] } },
});

if (ctx) {
  ctx.hooks.frame = (dt) => {
    // apply the latest server state here
  };
  ctx.loop.start();
}
```

### Add your game's nouns to the ctx

The engine ctx knows nothing about your game. You add your own fields to the same object with `Object.assign`. The stack hands scenes that same object, so a scene typed against your ctx sees your fields. The templates keep this in `src/ctx.ts`:

```ts
import { createGame, type EngineCtx } from '@thunderclap/engine';
import { createSaveStore, type SaveStore, s } from '@thunderclap/engine/save';

type Action = 'jump';
type Progress = { coins: number };
type ProgressStore = SaveStore<Progress>;

interface GameCtx extends EngineCtx<Action, ProgressStore, GameCtx> {
  readonly player: { x: number; y: number };
  respawn(): void;
}

const engine = await createGame<Action, ProgressStore, GameCtx>({
  root: document.getElementById('app')!,
  save: (host) =>
    createSaveStore<Progress>({
      game: 'my-game',
      version: 1,
      defaults: () => ({ coins: 0 }),
      schema: s.object({ coins: s.number({ min: 0, int: true }) }),
      host,
    }),
  input: { bindings: { jump: [{ key: 'Space' }] } },
});

if (engine) {
  const player = { x: 0, y: 0 };
  const ctx: GameCtx = Object.assign(engine, {
    player,
    respawn() {
      player.x = 0;
      player.y = 0;
    },
  });
  ctx.respawn();
  ctx.loop.start();
}
```

The three type arguments are your action names, your save type and your ctx type. Keep game state on `ctx` (here `ctx.player`), not inside a scene's closure, so the HUD and other scenes can read it.

## Ship it

A game is a static web build. `vite build` writes it to `dist/`. The templates do not ship a `build` script, so add one to `package.json` (`"build": "vite build"`), or run `pnpm exec vite build`.

### itch.io

itch.io serves an HTML5 game inside a cross-origin iframe, from a sub-path of its CDN. The web host detects the iframe (`ctx.host.embed` is `'cross-origin-frame'`), and adapts: copying falls back to a path the iframe allows, and the engine's link widget still opens a page when pop-ups are blocked. You have two things to do.

First, build with relative asset paths, because itch does not serve your game from the site root. In `vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
});
```

Then build and zip the contents of `dist/` (not the folder itself), so `index.html` is at the top of the zip:

```sh
pnpm exec vite build
cd dist && zip -r ../my-game.zip . && cd ..
```

On itch, create a project, set "Kind of project" to HTML, upload the zip and tick "This file will be played in the browser". Turn on the fullscreen button if you want one. Saves live in the iframe's `localStorage`; if the browser blocks it, `ctx.save.persistent` is `false` and the templates show a toast.

### Desktop with Electron

`packages/host-electron` is a desktop shell: your web build runs unchanged inside Electron. In the game, pick the host at boot. Electron gets `createElectronHost()`, the browser keeps the web host:

```ts
import { createGame } from '@thunderclap/engine';
import { createWebHost } from '@thunderclap/engine/host';

// The shell's preload puts its bridge on window.thunderclap; a browser has none.
const host =
  'thunderclap' in window
    ? (await import('@thunderclap/host-electron')).createElectronHost()
    : createWebHost();

const ctx = await createGame({ root: document.getElementById('app')!, host, input: { bindings: {} } });
ctx?.host.window?.close(); // a Quit button; host.window exists only on the desktop
```

`@thunderclap/host-electron` is a workspace package your game adds itself (`"@thunderclap/host-electron": "link:<engine>/packages/host-electron"`). The dynamic import behind the check keeps the package out of the browser's download. Inside the package, `inElectronShell()` makes the same check.

From the engine checkout, develop and package against your game:

```sh
pnpm dev                                              # in your game: Vite on :5173
pnpm desktop:dev --url http://localhost:5173          # in the engine: open it in Electron
pnpm desktop:build --renderer ../my-game/dist         # package your built game for this OS
```

The packages land in `dist/desktop/` in the engine repo. They are unsigned, so macOS Gatekeeper and Windows SmartScreen warn on first open. The shell blocks the network at runtime and keeps saves in `localStorage` under one fixed origin, so they survive updates.

### Installable web app (PWA)

`packages/host-pwa` turns the build into an app players can install, which loads offline after the first visit. It has two parts: a Vite plugin that writes the manifest, icons and service worker at build time, and a host that tells you when an install or an update is ready.

```ts
// vite.config.ts
import { pwaPlugin } from '@thunderclap/host-pwa/vite';
import { defineConfig } from 'vite';

// One square SVG; the plugin rasterises it to the 192 and 512 px icons.
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3fe0ff"/></svg>';

export default defineConfig({
  plugins: [pwaPlugin({ manifest: { name: 'My game', theme_color: '#0b0d14', background_color: '#0b0d14', svg: icon } })],
});
```

```ts
// main.ts
import { createGame } from '@thunderclap/engine';
import { createPwaHost } from '@thunderclap/host-pwa';

const host = createPwaHost();
const ctx = await createGame({ root: document.getElementById('app')!, host, input: { bindings: {} } });
host.pwa.onUpdateReady(() => ctx?.ui.toasts.show('Update ready: reload to play it'));

// An install button that shows itself once the browser offers an install.
const install = document.createElement('button');
install.textContent = 'Install';
install.hidden = true;
install.onclick = () => host.pwa.install();
document.body.append(install);
host.pwa.onInstallable(() => {
  install.hidden = false;
});
```

The puzzle template's `vite.config.ts` has the plugin line commented out, ready to turn on (see "Installable" in its `CLAUDE.md`). The plugin only runs on `vite build`; `pnpm dev` is unchanged. Saves are never cached by the worker.

### Phones and tablets: Capacitor

`packages/host-capacitor` wraps the same build in a Capacitor app for the iOS and Android stores. `createCapacitorHost({ plugins })` takes the Capacitor plugins your app installs and fills in haptics, the back button, the app lifecycle and storage. See its [README](../../packages/host-capacitor/README.md).

## Next

- [Core reference](../../src/core/README.md): the loop, scenes, random, scheduler, events
- [Host reference](../../src/host/README.md): the `Host` interface and the web host
- [Electron host](../../packages/host-electron/README.md), [PWA host](../../packages/host-pwa/README.md), [Capacitor host](../../packages/host-capacitor/README.md)
- [Save reference](../../src/save/README.md)
- [2D game](2d-game.md) and [3D game](3d-game.md)
- [Input](input.md)
- [UI and HUD](ui-and-hud.md)
- [Testing your game](testing-your-game.md)
