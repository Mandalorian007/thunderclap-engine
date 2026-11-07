# Input

## What you'll build

This guide shows you how a ThunderClap game reads the player. You will name your actions, bind keys, buttons, pads, touch and gestures to them, pick things in the world with pointer rays, add mouse look and touch sticks, and record a session so you can replay it.

The rule of the house: your scenes read **actions** (`jump`, `select`), never keys or touches. Devices stay in one bindings map.

## Name your actions and bind them

`createGame` takes the bindings map and builds `ctx.input` from it. The engine has no default bindings: an action fires only from what you list.

```ts
import { createGame } from '@thunderclap-engine/engine';
import type { Bindings } from '@thunderclap-engine/engine/input';

type Action = 'jump' | 'left' | 'right' | 'select' | 'zoomIn';

const bindings: Bindings<Action> = {
  jump: [{ key: 'Space' }, { key: 'KeyW' }, { padButton: 0 }],
  left: [{ key: 'ArrowLeft' }, { key: 'KeyA' }, { padAxis: 0, dir: -1 }],
  right: [{ key: 'ArrowRight' }, { key: 'KeyD' }, { padAxis: 0, dir: 1 }],
  select: [{ mouse: 0 }, { gesture: 'tap' }],
  zoomIn: [{ wheel: -1 }],
};

const ctx = await createGame<Action>({
  root: document.getElementById('app')!,
  input: { bindings, buttonKeys: ['Space'] },
});
```

Every entry in a list is one way to fire the action. The lists are OR'ed. These are the binding kinds:

| Binding | What it reads |
| --- | --- |
| `{ key: 'KeyA' }` | A key, by `KeyboardEvent.code`, so it works on any keyboard layout. |
| `{ mouse: 0 }` | A mouse button. Button 0 is also a touch or pen contact. |
| `{ wheel: 1 }` or `{ wheel: -1 }` | One wheel direction. |
| `{ padButton: 0 }` | A gamepad button in the standard mapping (0 is A / Cross). |
| `{ padAxis: 0, dir: -1 }` | One direction of a stick axis. Its `value()` is analog. |
| `{ gesture: 'tap' }` | `tap`, `doubleTap`, `longPress`, `pan`, `drag` or `pinch`. |
| `{ pointer: 'select' }` | Any pointer's button, routed to what it points at (see below). |
| `{ xr: 'trigger' }` | A VR controller's `trigger`, `squeeze` or `pinch` (see the [XR guide](xr.md)). |
| `{ chord: [...] }` | Every member held at once, for example Shift + K. |

Any binding can also take a trigger: `trigger: 'hold'` (with `holdMs`) fires only after the source is held that long, and `trigger: 'doubleTap'` (with `doubleTapMs`) fires on the second press.

`buttonKeys` keeps Space and the arrows working after the player clicks a HUD button. Without it, a focused button would take the key.

## Read actions each tick

The engine calls `ctx.input.update()` once per fixed step, before your `hooks.update` and your scenes. You only read.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

type Action = 'jump' | 'left' | 'right' | 'select';

export function setup(ctx: EngineCtx<Action, null>) {
  let x = 0;
  ctx.hooks.update = (dt) => {
    const { input } = ctx;
    if (input.pressed('jump')) console.log('jump');        // true for one tick
    if (input.held('right')) x += 300 * dt * input.value('right');
    if (input.released('jump')) console.log('let go');     // the tick after it stops
    x += 300 * dt * input.axis('left', 'right');           // value(right) - value(left)
    const { x: px, y: py, inside } = input.pointer;        // design px
  };
}
```

- `pressed` is true for exactly one tick. A tap that goes down and up between two ticks still gives one `pressed`.
- `value` is 0..1. Keys read 0 or 1; a pad axis reads how far the stick is pushed.
- While a modal panel is open, every action reads inactive. You do not need to check for menus.

The type parameter matters. `EngineCtx<Action, null>` is a ctx whose actions are `Action` and which has no save. With it, `input.pressed('jupm')` is a type error.

### Show the right prompt

`input.lastDevice` is the device that last produced input: `keyboard`, `mouse`, `touch`, `pen`, `gamepad` or `xr`. `input.glyphFor(action)` gives a label for that device's binding, such as `Space` or `A`.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export function prompts(ctx: EngineCtx<'jump', null>, label: HTMLElement) {
  const redraw = () => {
    label.textContent = `${ctx.input.glyphFor('jump')?.label ?? ''} to jump`;
  };
  ctx.input.on('device', redraw);     // fires when lastDevice changes
  redraw();
}
```

## Buffer a press

A platformer wants a jump pressed just before landing to count. `buffered(action, ms)` is true when the action was pressed within the last `ms` and nobody used it yet. `consume(action)` marks it used.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export function setup(ctx: EngineCtx<'jump', null>, grounded: () => boolean, jump: () => void) {
  ctx.hooks.update = () => {
    if (grounded() && ctx.input.buffered('jump', 100)) {
      ctx.input.consume('jump');
      jump();
    }
  };
}
```

The window is counted in ticks, so a replay gives the same answer.

## Swap bindings with contexts

A menu, the gameplay and a vehicle can each own their bindings. Push a context when the menu opens and pop it when it closes.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

type Action = 'jump' | 'confirm' | 'back';

export function openMenu(ctx: EngineCtx<Action, null>) {
  const pop = ctx.input.pushContext('menu', {
    bindings: { confirm: [{ key: 'Enter' }, { padButton: 0 }], back: [{ key: 'Escape' }] },
    pass: 'none',    // nothing below the menu fires
  });
  return pop;        // call it to close the menu
}
```

`pass` says what the contexts below still do: `'unbound'` (the default) keeps their bindings for actions this context leaves out, `'all'` keeps all of theirs, `'none'` keeps nothing. A key held while the context changes does not fire in the new one, so the Space that opened the menu does not also confirm it.

Every action name in a context must be in your `Action` type. With a typed `Action`, declare menu actions in the base map too, even with an empty list. An `Input<string>` can bind an action in the context alone: it reads as unbound everywhere else.

## Gestures

`createGame` builds a gesture recogniser and links it to the input. You read it as `ctx.gestures`. A `{ gesture }` binding fires the action; the gesture object tells you where.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export function setup(ctx: EngineCtx<'select' | 'info', null>) {
  ctx.hooks.update = () => {
    const g = ctx.gestures;
    if (ctx.input.pressed('select') && g.tap) console.log('tap at', g.tap.x, g.tap.y);
    if (g.drag?.phase === 'move') console.log('drag by', g.drag.dx, g.drag.dy);
    if (g.pinch) console.log('zoom by', g.pinch.delta);
  };
}
```

Bind `select: [{ gesture: 'tap' }]` and `info: [{ gesture: 'longPress' }]` to use it. A tap is a press that moves less than 10 CSS px and lifts within 450 ms. Two fingers make a pinch, never a pan. Gestures run on the game's tick clock (`ctx.clock`), so they replay on the same ticks.

### Magnify small targets

A finger covers about 44 CSS px. When your cells are smaller, turn on the magnify loupe. While one finger is down, a circle beside it shows the area under it, and `ctx.gestures.aim` reports where it aims.

`snapToGrid` finds the nearest cell of a square grid. It returns the cell's column and row, so you turn that into a `MagnifyTarget` (a centre and a radius) yourself.

```ts
import { createGame } from '@thunderclap-engine/engine';
import { type MagnifyTarget, type SnapGrid, snapToGrid } from '@thunderclap-engine/engine/input';

const grid: SnapGrid = { left: 360, top: 140, pitch: 40, cols: 20, rows: 20 };

const ctx = await createGame<'select'>({
  root: document.getElementById('app')!,
  input: {
    bindings: { select: [{ gesture: 'tap' }] },
    magnify: {
      pitch: () => grid.pitch,       // the target size now, CSS px
      snap: (x, y): MagnifyTarget | null => {
        const cell = snapToGrid(grid, x, y);
        if (!cell) return null;
        const half = grid.pitch / 2;
        return {
          x: grid.left + cell.x * grid.pitch + half,
          y: grid.top + cell.y * grid.pitch + half,
          r: half,
          data: cell,
        };
      },
    },
  },
});
```

Pass `source: ctx.surface.canvas` (with `gestures.setMagnify`) to draw the loupe itself. Without a `source` the engine only reports `aim`, and you can draw your own loupe at `aim.at`.

## Pick things with pointer rays

Every pointer becomes a ray through the camera: the mouse, a pen, a touch, the pad cursor and VR controllers. `ctx.pointers` tests each ray against **hit testers** you register and keeps the nearest hit. 2D and 3D pick the same way.

| Tester | Hits |
| --- | --- |
| `planeTester(z, target?)` | The plane at depth `z`. Through a 2D camera this is the world point under the pointer. Pass `{ normal, offset }` instead of `z` for any other plane, such as a floor. |
| `aabbTester(boxes)` | A live array of `{ min, max, target }` boxes. Edit the array freely. |
| `sphereTester(transform, bounds, target?)` | A sphere placed by a `Transform`. |
| `obbTester(transform, halfExtents, target?)` | A box placed by a `Transform`. |
| `meshTester(transform, vertices, indices, target?)` | The triangles of a mesh you keep on the CPU. |

Each tester returns a remover. Bind `{ pointer: 'select' }` and any press of that action selects what the primary pointer is over, whether it came from a click, a tap or a pad button.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { aabbTester, meshTester, type RayBox } from '@thunderclap-engine/engine/input';
import { Transform } from '@thunderclap-engine/engine/render';

interface Card { name: string }

export function setup(
  ctx: EngineCtx<'select', null>,
  rock: { transform: Transform; vertices: Float32Array; indices: Uint16Array },
) {
  const boxes: RayBox<Card>[] = [{ min: [100, 100, 0], max: [250, 250, 0], target: { name: 'ace' } }];
  const removeBoxes = ctx.pointers.addTester(aabbTester(boxes));
  ctx.pointers.addTester(meshTester(rock.transform, rock.vertices, rock.indices, rock));

  ctx.pointers.on('hit', (e) => console.log('hover', e.hit?.target));
  ctx.pointers.on('hitEnd', (e) => console.log('leave', e.hit?.target));
  ctx.pointers.on('select', (e) => {
    if (e.hit) console.log('picked', e.hit.target, 'at', e.hit.point);
  });
  return removeBoxes;
}
```

The event object is reused. Read it inside the listener, or copy what you keep. `ctx.pointers.hit` is the primary pointer's hit right now, and its `target` is typed `unknown`, so cast it to your own type.

Under a pointer lock the mouse does not move, so a first-person crosshair casts its own ray with `screenRay(camera, design.width / 2, design.height / 2, ray)` and calls the same tester function.

## First-person look

`Look` turns the pointer-locked mouse, two touch zones, the pad sticks and the move keys into three numbers per tick: `look` (yaw and pitch deltas in radians), `move` (x and y in -1..1) and `zoom`. Your camera code never sees which device moved. `createGame` builds no `Look`, so you add one.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { Look } from '@thunderclap-engine/engine/input';

export function addLook(ctx: EngineCtx<string, null>) {
  const look = new Look({
    lockOnFirstClick: true,          // the first click takes the pointer lock
    keys: { forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
    touch: { moveZone: 'left' },     // left half is a move stick, the rest drags the view
    clock: ctx.clock,
  });
  ctx.input.setLook(look);           // input.update() now advances it

  let yaw = 0;
  let pitch = 0;
  ctx.hooks.update = (dt) => {
    yaw += look.look.dx;                                          // > 0 turns right
    pitch = Math.max(-1.4, Math.min(1.4, pitch + look.look.dy));  // > 0 looks up
    const forward = look.move.y;                                  // > 0 walks forward
    const strafe = look.move.x;
  };
  look.onLockChange((locked) => console.log(locked ? 'playing' : 'click to play'));
  return look;
}
```

- Browsers grant the pointer lock only inside a user gesture. `lockOnFirstClick` does that for you; otherwise call `look.request()` from your own click handler.
- `mode: 'orbit'` turns the view with a mouse drag and no lock, for an editor or a model viewer.
- `look.stick` tells you where the touch stick is, so you can draw it.
- For a third-person camera, give the same `Look` to a `Follow` (`follow.setLook(look)`).

## Read a stick from four actions

`input.stick` reads four actions as one 2D stick, with a dead zone and a diagonal of length 1 from keys.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

type Action = 'left' | 'right' | 'up' | 'down';

export function setup(ctx: EngineCtx<Action, null>) {
  const out: [number, number] = [0, 0];
  ctx.hooks.update = () => {
    const [x, y] = ctx.input.stick('left', 'right', 'up', 'down', out, { deadzone: 0.15 });
  };
}
```

Bind the pad axes with `threshold: 0` (for example `{ padAxis: 0, dir: 1, threshold: 0 }`) to keep the low end of the stick.

## Touch zones for thumbs

On a phone, `createTouchZones` turns screen regions into a stick, buttons or swipes that feed your actions. Your scenes keep reading `input.pressed('jump')` and `input.axis('left', 'right')`.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createTouchZones } from '@thunderclap-engine/engine/input';

type Action = 'left' | 'right' | 'jump';

export function addThumbs(ctx: EngineCtx<Action, null>) {
  return createTouchZones(ctx.input, {
    zones: {
      move: { kind: 'stick', rect: (w, h) => ({ x: 0, y: 0, w: w / 2, h }), radius: 64 },
      jump: {
        kind: 'buttons',
        rect: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h }),
        buttons: { jump: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h }) },
      },
    },
    bindings: {
      left: { zone: 'move', axis: 'x', dir: -1 },
      right: { zone: 'move', axis: 'x', dir: 1 },
      jump: { zone: 'jump', button: 'jump' },
    },
  });
}
```

- A `rect` is a function of the canvas size in CSS px, so it follows resizes.
- Each zone holds one pointer and claims it, so two thumbs never pinch and a thumb on the stick never taps.
- Use one zone per thumb. Two buttons a thumb might press at once go in separate zones.
- Read a zone directly with `zones.zones.move.vector` when you want to draw it.
- The `bindings` are typed: each key must be one of your actions and each `zone` one of your zones, so a typo is a compile error.

## Record and replay a session

A recording holds everything the input was fed, tick by tick: keys, buttons, pointers, pads and context changes. Replayed on the same game, it gives the same ticks. Use it for bug reports and scripted tests.

Ask `createGame` to record, then stop the recorder when you want the data:

```ts
import { createGame } from '@thunderclap-engine/engine';
import { serializeRecording } from '@thunderclap-engine/engine/input';

const ctx = await createGame<'jump'>({
  root: document.getElementById('app')!,
  input: { bindings: { jump: [{ key: 'Space' }] }, record: true },
});

export function saveBugReport() {
  const rec = ctx?.input.recorder?.stop();
  if (rec) localStorage.setItem('bug-42', serializeRecording(rec));
}
```

To play it back, pass the recording as `replay`. The input then attaches no DOM listeners, so a real key never leaks in, and the loop steps the playback before each fixed step.

```ts
import { createGame } from '@thunderclap-engine/engine';
import { parseRecording } from '@thunderclap-engine/engine/input';

const recording = parseRecording(localStorage.getItem('bug-42') ?? '');

const ctx = await createGame<'jump'>({
  root: document.getElementById('app')!,
  input: { bindings: { jump: [{ key: 'Space' }] }, replay: recording },
});
```

`parseRecording` throws an `InputRecordingError` on bad data.

To start a replay from a menu in a running game, call `ctx.replay(rec)`. It detaches the input from the canvas and the window while the recording runs, and mutes `ctx.pointers` (VR controllers too), so the player cannot disturb it. A mute you set yourself (`ctx.pointers.mute(...)`) is still on after the replay. The loop steps it from the next fixed step. When the recording ends, or you call `stop()`, the player gets the input back:

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { InputRecording } from '@thunderclap-engine/engine/input';

export function watchReplay(ctx: EngineCtx<'jump', null>, rec: InputRecording) {
  const run = ctx.replay(rec, { speed: 2 }); // two recorded ticks per step
  return () => run.stop();                    // call this from a "Skip" button
}
```

A second `ctx.replay` call stops the first. The returned object is the playback itself, so `run.done` and `run.tick` work too.

The manual form installs a playback on `ctx.input` yourself. The loop finds it on `ctx.input.playback` and steps it, but you do the detaching and cleanup:

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { createInputPlayback, type InputRecording } from '@thunderclap-engine/engine/input';

export function replayByHand(ctx: EngineCtx<'jump', null>, rec: InputRecording) {
  ctx.input.releaseAll();
  const pb = createInputPlayback(ctx.input, rec, { clock: ctx.clock });
  ctx.hooks.update = () => {
    if (pb.done) pb.detach();
  };
}
```

Passing `ctx.clock` lets the playback drive the game clock, which matters for `speed` above 1.

For a replay to match, the game must be the same: same bindings, same layout, same fixed step, and your own randomness seeded. A recording does not capture the pointer lock's raw mouse motion or extra pointer sources such as VR controllers.

## Next

- [Input reference](../../src/input/README.md): every option, rebinding, rumble, gyro aim, `Follow` and the recording format.
- [UI reference](../../src/ui/README.md): modal panels block input; world panels take pointer rays.
- [Core reference](../../src/core/README.md): the loop and `ctx.clock`.
- [Getting started](getting-started.md), [2D game](2d-game.md), [3D game](3d-game.md), [Characters](characters.md).
- [UI and HUD](ui-and-hud.md), [XR](xr.md), [Testing your game](testing-your-game.md).
