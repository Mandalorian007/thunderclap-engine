# VR with WebXR

## What you'll build

This guide takes a 3D ThunderClap game into a VR headset. You will add an Enter VR button, see what changes while a session runs, pick things with controllers and hands, and put a menu in the world and in front of the player's eyes.

A game that never enters VR runs the same code as before. The same build works on a page and in a headset.

## What you need

- A browser with WebXR **and** the WebXR/WebGPU binding (`XRGPUBinding`), and an `immersive-vr` device. Headless Chromium and most desktop browsers have neither, so `ctx.xr.supported()` is false there.
- A 3D scene: a perspective camera and meshes. VR works in metres, with y up. See the [3D game guide](3d-game.md) first.

## Turn VR on in createGame

Pass an `xr` option. It names the reference space and gives you two callbacks.

```ts
import { createGame } from '@thunderclap/engine';
import { Camera } from '@thunderclap/engine/render';

const ctx = await createGame<'select', null>({
  root: document.getElementById('app')!,
  title: 'My VR game',
  input: { bindings: { select: [{ mouse: 0 }, { xr: 'trigger' }] } },
  xr: {
    referenceSpace: 'local-floor',
    onEnter: (session) => console.log('in VR', session.visibilityState),
    onExit: () => console.log('back on the page'),
  },
});

if (ctx) {
  // On the page: a standing viewer 1.6 m up, looking down -z. A headset gives the same frame.
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 100);
  camera.lookAt([0, 1.6, 0], [0, 1, -2], [0, 1, 0]);
  ctx.renderer.camera = camera;
  ctx.loop.start();
}
```

`referenceSpace` sets where the origin is:

| Value | Origin |
| --- | --- |
| `'local-floor'` (default) | On the floor under the player. Use it for standing play. |
| `'local'` | At the headset's position when the session started. Use it for seated play. |
| `'viewer'` | The headset itself. Rarely what you want. |

With `'local-floor'`, a head at y = 1.6 is a person standing. Build your page camera the same way so the scene looks right in both places.

## Add the Enter VR button

The browser only starts a session from a user gesture, such as a click. So `enter()` must run inside a click handler, not at load time. Check `supported()` first and disable the button when it is false.

```ts
import type { EngineCtx } from '@thunderclap/engine';

export async function vrButton(ctx: EngineCtx<'select', null>, button: HTMLButtonElement) {
  button.disabled = !(await ctx.xr.supported());
  button.addEventListener('click', () => {
    const toggle = ctx.xr.active ? ctx.xr.exit() : ctx.xr.enter();
    toggle.catch((err: unknown) => console.warn('VR failed', err));
  });
}
```

- `supported()` resolves true only when WebXR, the WebGPU binding and `immersive-vr` are all there.
- `enter()` resolves once the first VR frame can run. It rejects when the browser refuses (no device, the player said no, no gesture). A second call while a session runs resolves at once.
- `exit()` ends the session and resolves when the page is back. The player can also leave from the headset's own menu; `onExit` runs in both cases.
- `ctx.xr.active`, `ctx.xr.session` and `ctx.xr.surface` tell you the current state.

Use the `onEnter` and `onExit` callbacks to change the button's label, as the session can end without your button being clicked.

## What changes while a session runs

You write no per-eye code. While VR is active, `createGame` does this for you:

1. **The loop runs on the session's frames.** Frames come from `XRSession.requestAnimationFrame` (the headset's refresh rate, often 72 or 90 Hz) instead of the page's. Your fixed step is still 1/60 s, so game logic runs at the same speed.
2. **Scenes record once, through the head.** Your scene's `render(frame, camera, alpha)` gets the **head camera**: a camera between the eyes, posed from the headset. On the page it gets `ctx.camera`.
3. **The renderer draws each eye.** It draws your one record once per eye, from that eye's camera, into an HDR target. The post stack (bloom, fog, grade) then resolves each eye into the headset's layer, so the headset sees what the screen would.
4. **Controllers and hands become pointers.** They join `ctx.pointers` as rays (see below).

When the session ends, everything goes back: the page's frames, `ctx.camera` and the page's pointers.

### Use the camera you are given

Because of step 2, always place head-relative things from the `camera` argument of `render`, never from `ctx.camera`. This marker sits 0.6 m in front of whatever head is drawing, on the page or in VR:

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { type Camera, type Frame, type Material, type Mesh, Transform } from '@thunderclap/engine/render';

export function addMarker(ctx: EngineCtx<'select', null>, cube: Mesh, lit: Material) {
  const marker = new Transform({ scaleX: 0.1, scaleY: 0.1, scaleZ: 0.1 });
  ctx.stack.push({
    render(frame: Frame, camera: Camera) {
      frame.clear(0.05, 0.06, 0.1);
      const p = camera.position;
      marker.setPosition(p[0]!, p[1]!, p[2]! - 0.6);
      frame.mesh(cube, lit, marker);
    },
  });
}
```

Do not move the head camera yourself: the headset owns it. To move the player through the world (teleport, walk with a stick), move the world or a parent `Transform`, not the camera.

### Things that do not apply in VR

- The DOM overlay (`ctx.ui`) is not visible inside the headset. Put in-VR menus on world panels (below).
- Pointer lock and `Look` do nothing useful: the head turns the view.
- The screen-space pointer (`input.pointer`, `{ mouse }` bindings) has no meaning for a controller. Use `{ xr }` or `{ pointer }` bindings.

## Controllers and hands as pointer rays

On `enter()`, `createGame` adds an `XrPointerSource` to `ctx.pointers`, and removes it on exit. Each controller, and each tracked hand, is one pointer whose ray comes from its target-ray pose. The hit testers you registered for the mouse work for controllers unchanged: the nearest hit wins, and `ctx.pointers.hit` is the primary pointer's hit.

The source reads three buttons:

| `XrButton` | From |
| --- | --- |
| `'trigger'` | The controller's trigger (gamepad button 0), or the session's `select` events. |
| `'squeeze'` | The grip (button 1), or the session's `squeeze` events. |
| `'pinch'` | A tracked hand's thumb and index finger tips coming together. |

`trigger` and `pinch` both count as the pointer's `select`; `squeeze` is its `secondary`.

Bind them like any other source. Add `hand` to listen to one side only:

```ts
import type { Bindings } from '@thunderclap/engine/input';

type Action = 'select' | 'grab' | 'menu';

export const bindings: Bindings<Action> = {
  // A click, a tap, a trigger or a pinch all select what is pointed at.
  select: [{ pointer: 'select' }, { key: 'Enter' }],
  grab: [{ xr: 'squeeze' }, { mouse: 2 }],
  menu: [{ xr: 'trigger', hand: 'left' }, { key: 'Escape' }],
};
```

`{ pointer: 'select' }` is usually what you want: one binding covers the mouse, touch, the pad cursor and both controllers, and the action selects the hovered hit. Use `{ xr }` for buttons that only exist in VR.

Pick a thing with a controller exactly as with a mouse:

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { obbTester } from '@thunderclap/engine/input';
import { Transform } from '@thunderclap/engine/render';

export function addDoor(ctx: EngineCtx<'select', null>) {
  const door = { name: 'door', transform: new Transform({ y: 1, z: -3 }) };
  ctx.pointers.addTester(obbTester(door.transform, [0.5, 1, 0.05], door));
  ctx.pointers.on('select', (e) => {
    if (e.hit?.target === door) console.log('open', e.pointer.hand, e.hit.distance);
  });
  ctx.hooks.update = () => {
    if (ctx.pointers.xrFired('squeeze', 'right')) console.log('right grip');
  };
}
```

`e.pointer.device` is `'xr'` for a controller or hand, and `e.pointer.hand` is `'left'`, `'right'` or `null`. `ctx.input.lastDevice` becomes `'xr'` when a controller button fires, so prompts can show `Trigger` instead of a key.

Hand tracking is requested as an optional feature. When the headset offers it, hands appear as pointers; when it does not, the session still starts.

## Post effects in VR

You do not need to do anything: `createGame` makes the surface with an HDR scene target, renders each eye into it and resolves it through `ctx.post` into the eye's part of the headset layer. Your bloom, fog and grade settings apply in both eyes.

If you write your own frame loop instead of using `createGame`, these are the pieces. This is a fragment of the render step, so it does not compile on its own:

```ts no-check
const eyes = xrFrame ? xrSurface.views(xrFrame) : [];
stack.render(frame, xrSurface.head, alpha);            // record once, through the head
for (const eye of eyes) {
  renderer.render(frame, eye.camera, xrSurface.scene!); // draw this eye into the HDR target
  renderer.resolve(xrSurface.scene!, eye.target.color.view, eye.viewport); // post, into the layer
}
renderer.endFrame({ present: false });                  // the session presents, not the canvas
```

The parts are `XrSurface` (from `@thunderclap/engine/platform`, built with `scene: true` and `colorFormat: renderer.format`), and `createXrHost(session, pageHost)` (from `@thunderclap/engine/host`), whose `frame` is the current `XRFrame` while a frame callback runs. Post effects cost twice in VR, once per eye, so keep them light on standalone headsets.

## Menus in the world

The overlay is DOM, and the headset cannot show DOM. A **world panel** is a flat quad in the scene with a canvas face, holding buttons, toggles, sliders and lists. Any pointer ray can hit it: the mouse on the page, a controller in VR.

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { type Camera, type Frame } from '@thunderclap/engine/render';
import { createWorldPanel, worldButton, worldLabel, worldSlider } from '@thunderclap/engine/ui';

export function addSettings(ctx: EngineCtx<'select', null>) {
  const panel = createWorldPanel(ctx.renderer, { width: 1.2, height: 0.8 });  // metres
  panel.transform.setPosition(0, 1.4, -1.5);                                 // a sign ahead of the player
  panel.add(worldLabel({ text: 'Settings', size: 'l' }));
  panel.add(worldSlider({ min: 0, max: 100, value: 80, step: 5, onChange: (v) => console.log(v) }));
  panel.add(worldButton({ text: 'Leave VR', onPress: () => void ctx.xr.exit() }));
  panel.attach(ctx.input);   // rays, hover, press and release on every input update

  ctx.stack.push({
    render(frame: Frame, camera: Camera) {
      // ... your opaque meshes first ...
      frame.drawable(panel.drawable, 10);  // then the panel, which is blended
    },
  });
  return panel;
}
```

- `width` and `height` are world units. The face is 256 px per unit by default, so 16 px text reads at arm's length.
- `attach(ctx.input)` registers the panel's hit tester on `ctx.pointers` and polls it after each input update. Call it once; `panel.dispose()` undoes it.
- A button fires on release over it, not on the press.
- Without a ray (a pad, a keyboard), drive it with `panel.focusNext()`, `panel.focusPrev()` and `panel.activate()`.
- Add `billboard: true` to make the panel turn to face the viewer.

### A head-locked panel

A head-locked panel stays in front of the eyes, like a HUD: pass `headLocked: { distance, offset }` (offset is right and up, in world units). It draws without a depth test, so the scene never cuts it.

Move it from the head camera each frame. `attach` moves it from `renderer.camera`, which in VR is the page's camera, not the head. So call `update` with the camera `render` hands you, before you draw:

```ts
import type { EngineCtx } from '@thunderclap/engine';
import { type Camera, type Frame } from '@thunderclap/engine/render';
import { createWorldPanel, worldProgress } from '@thunderclap/engine/ui';

export function addHud(ctx: EngineCtx<'select', null>) {
  const hud = createWorldPanel(ctx.renderer, {
    width: 0.4,
    height: 0.1,
    background: 'transparent',
    headLocked: { distance: 1, offset: [0.25, -0.2] },  // 1 m ahead, low and to the right
  });
  const health = hud.add(worldProgress({ value: 1, tone: 'success' }));
  hud.attach(ctx.input);

  ctx.stack.push({
    render(frame: Frame, camera: Camera) {
      hud.update(camera);                  // the head in VR, ctx.camera on the page
      frame.drawable(hud.drawable, 20);
    },
  });
  return health;
}
```

Keep head-locked panels small and low. Text glued to the eyes is tiring to read; a panel on the wrist or in the world is often kinder.

## Testing without a headset

On a desktop without a headset, `supported()` is false and your game runs its page path. Test that path as usual, and check that the button is disabled. The repo's `harness/xr.html` is a working example: a lit ground, a turning block, a marker in front of the head and an Enter VR button. On a headset browser, open it and press the button to see the same scene in both eyes.

## Next

- [Input reference](../../src/input/README.md): `XrPointerSource`, the pointer router and `{ xr }` bindings.
- [UI reference](../../src/ui/README.md): world panels and their widgets.
- [Platform reference](../../src/platform/README.md): `XrSurface`, eye views and the per-eye post path.
- [Host reference](../../src/host/README.md): `createXrHost`.
- [3D game](3d-game.md), [Input](input.md), [UI and HUD](ui-and-hud.md), [Style and post](style-and-post.md), [Testing your game](testing-your-game.md).
