# engine/input

Pointer (mouse/touch/pen), keyboard and gamepad mapped to named **actions**. The engine has no default bindings; the game supplies them. No dependencies.

## Usage

```ts
import { Input } from '@thunderclap/engine/input';

const input = new Input({
  confirm: [{ key: 'Enter' }, { key: 'Space' }, { padButton: 0 }],
  cancel:  [{ key: 'Escape' }, { padButton: 1 }],
  select:  [{ mouse: 0 }],
  left:    [{ key: 'ArrowLeft' }, { key: 'KeyA' }, { padAxis: 0, dir: -1 }],
  zoomIn:  [{ wheel: -1 }],
});

input.attach({ pointerTarget: canvas });        // keys are read from the window by default
input.setPointerTransform(clientToLogical);     // from engine/platform: (clientX, clientY) => {x,y} | null
input.blocked = () => overlay.stack.hasModal;   // engine/ui: stop game actions while a modal panel is open

// once per fixed-step tick, before game logic:
input.update();
if (input.pressed('confirm')) …
if (input.held('left')) x -= speed * input.value('left');
const { x, y, inside, down, dx, dy, wheelY } = input.pointer;   // game space
```

`Binding` kinds: `{ key: code }` (`KeyboardEvent.code`, layout independent), `{ mouse: button }` (0 is also touch/pen contact), `{ wheel: 1 | -1 }`, `{ padButton, pad?, threshold? }` (standard mapping), `{ padAxis, dir, pad?, threshold? }` (analog `value()`).

## Semantics
- `pressed` is true for exactly one `update()` when an action becomes active; `released` for one `update()` after it stops. `held` while active. `heldTicks` counts ticks.
- A tap that goes down and up between two ticks still produces `pressed` (and `held`) for one tick and `released` on the next.
- **Repeat taps are queued** (default on; `new Input(b, { queueTaps: false })` turns it off). If a key or mouse button goes down again before the tick that saw its first press, each extra tap fires `pressed` on one of the following ticks, up to 8 queued per key. The action stays `held` across them, and `released` fires once the queue drains. Quick double taps and automated `keydown`/`keyup` bursts therefore never lose a press. While `blocked()`, on `releaseAll()` and on `setBindings` the queue is dropped. A tap on a second binding of an action that is already held still does not re-press it.
- Several bindings on one action are OR'ed; switching from one to another while held doesn't re-press.
- `blocked()` true → every action reads inactive, nothing is `preventDefault`ed. Keys held across the block do not fire `pressed` when it ends.
- `lastDevice` (`keyboard | mouse | touch | pen | gamepad`) for showing the right prompts.
- Pointer position is game space via the transform. Without a transform it's CSS px relative to the pointer target. `inside` is false when the transform returns `null` (in the letterbox bars) or the mouse leaves.
- Call `update()` once per **simulation tick**. If you run several fixed steps in one frame, `pressed` fires on the first only, which is what you want.

## Embedding (itch.io iframe)
- Only **bound** keys are `preventDefault`ed, and only when no Ctrl/Meta/Alt is held, the event target isn't a text field/button/link, input isn't blocked, and the document has focus. Browser shortcuts and the parent page keep working.
- Keys typed on a focused button, link or other control are ignored, so Space and Enter activate the control rather than the game. The exception is **global keys**: `new Input(b, { globalKeys: ['KeyC', 'KeyO'] })` or `input.setGlobalKeys([...])`. These still register on buttons, links and checkboxes, so HUD shortcuts keep working after a HUD button is clicked. The control keeps its default action, since global keys are never `preventDefault`ed there. They never register in text entry (`isTextEntryTarget`: text inputs, textarea, select, contenteditable, `role=textbox|searchbox|combobox`).
- **Button keys** (`buttonKeys: ['Escape', 'ArrowLeft', ...]` or `input.setButtonKeys`) are a narrower version of global keys. They register only while a plain button or link has focus (`isButtonTarget`: `button`, `a`, `summary`, button-type inputs, `role=button|link|menuitem`), so a clicked button doesn't swallow Back or arrow navigation. They never register on controls that use those keys themselves (sliders, checkboxes, radios, selects, text). They are not `preventDefault`ed there either.
- Wheel is `preventDefault`ed only if a wheel binding exists; right-click menu only if mouse button 2 is bound.
- `touch-action: none` is set on the pointer target (restored on `detach`).
- Pointer down on the target calls `window.focus()` so the iframe receives keys after a click.
- All keys/buttons release on window `blur` and when the tab is hidden: no stuck keys.
- Gamepad access is wrapped in `try` (permissions policy can block it inside iframes).

## Gestures

`Gestures` recognises touch and pointer gestures and reports them in the same tick model.

```ts
import { Gestures, Input } from '@thunderclap/engine/input';

const gestures = new Gestures();                 // { panThreshold: 10, longPressMs: 450, doubleTapMs: 300, doubleTapDistance: 24 }
const input = new Input({
  select: [{ mouse: 0 }, { gesture: 'tap' }],
  info:   [{ gesture: 'longPress' }],
}, { gestures });                                // or input.setGestures(gestures)
input.attach({ pointerTarget: canvas });         // attaches the gestures too
input.setPointerTransform(clientToLogical);      // shared with the gestures

// each tick: input.update() advances the gestures first (don't call gestures.update() yourself)
input.update();
if (input.pressed('info')) showInfo();
const d = gestures.drag;                         // null, or { phase, x, y, inside, dx, dy, origin, device }
if (d?.phase === 'move') moveBy(d.dx, d.dy);
if (gestures.pinch) zoom *= gestures.pinch.delta;
```

- **tap**: down and up within `panThreshold` CSS px, before `longPressMs`. **doubleTap**: a second tap that starts within `doubleTapMs` of the first ending and within `doubleTapDistance`; each of the two taps also reports `tap`.
- **longPress**: fires once after `longPressMs` without passing the threshold; no tap follows, and moving afterwards does not drag. As a binding it is held until the pointer lifts.
- **pan** and **drag**: one pointer past the threshold starts both (`phase: 'start'`, with the travel so far in `dx`/`dy`), then `move` every tick (merged; `dx: 0` when idle), then `end`. Every `dx` of one gesture sums to the total travel. `drag` carries the `origin`; `pan` also covers two fingers moving together (`pointers: 2`).
- **pinch**: a second pointer cancels the drag and starts a pinch; `scale` is the distance now over the distance at the start, `delta` the change since the last report. Lifting either pointer ends it; nothing more is reported until all pointers are up.
- Thresholds are CSS px (client coordinates); positions are game space through the transform. A point the transform maps to `null` reports `inside: false` with the last inside position.
- One tap, double tap and long-press per tick; extras queue for the following ticks (up to 8). `start` and `end` each get their own tick.
- `blocked()` (shared with the linked `Input`): nothing is reported and the press in progress is dropped; a running pan, drag or pinch gets one `cancel` so the game can put things back. Browser `pointercancel`, window blur and a hidden tab cancel the same way.
- Mouse: primary button only. Each pointer is captured, so a drag off the target keeps reporting.
- Feed methods for tests and replays: `pointerDown(id, x, y, device?, time?)`, `pointerMove`, `pointerUp`, `pointerCancel`, `cancelAll`. Pass `now` to drive long-press timing from a fake clock.

## Rays and the pointer router

Every pointer (mouse, pen, touch, the pad cursor, later XR controllers and hands) becomes a ray through the camera, tested against the game's hit testers. 2D and 3D pick the same way.

```ts
import { aabbTester, createPointerRouter, Input, PadCursor, planeTester } from '@thunderclap/engine/input';

const boxes = [{ min: [100, 100, 0], max: [250, 250, 0], target: card }];   // live array: edit freely
const router = createPointerRouter({
  camera: () => renderer.camera,          // or a Camera; anything with screen + screenToWorld
  testers: [aabbTester(boxes), planeTester(0)],
  sources: [new PadCursor()],             // ScreenPointers (mouse/pen/touch) is built in
});
const input = new Input({ select: [{ pointer: 'select' }, { key: 'Enter' }, { gesture: 'tap' }] }, { pointers: router });

router.on('hit', (e) => highlight(e.hit?.target));      // a pointer's nearest target changed to this
router.on('hitEnd', (e) => unhighlight(e.hit?.target));  // ... and left this
router.on('select', (e) => e.hit && toggle(e.hit.target));
```

- `screenRay(camera, sx, sy, out)` unprojects screen units at depth 0 and 1 (0.5 with an infinite far plane). For `Camera.ortho2d` the ray starts on the near plane (z = -`ORTHO2D_HALF_DEPTH`) and points along +z, into the screen, so flat quads at z = 0 are hit one half-depth away.
- `HitTester<T> = (ray) => Hit<T> | null`. Return the tester's own reused `Hit`; the router copies the nearest. `planeTester(z, target?)` and `aabbTester(boxes)` ship; write your own for grids, meshes or spheres.
- Hover: mouse and pen are pointers while over the target. A touch is a pointer only while down, plus one tail tick after it lifts, so a `{ gesture: 'tap' }` select still sees its hit. A single touch aims with the magnify `aim` (the snapped target, else the lifted aim point).
- Select: if the input binds the router's `selectAction` (default `'select'`), any press of that action selects the **primary** pointer's hit (the one with the latest activity), so a key, a tap gesture or a pad button all select what is hovered. Otherwise each pointer's button down-edge selects. The same goes for `secondary`. The event's `hit` may be `null`.
- `{ pointer: 'select' | 'secondary' }` binds any pointer's button; `{ xr: 'trigger' | 'squeeze' | 'pinch', hand? }` binds an XR source's button.
- `blocked()` is shared with the input: every hit ends (`hitEnd`), `pointers` is empty, nothing selects, and a button held through the block does not fire after it.
- `PadCursor` appears at the screen centre when the stick deflects or select is pressed, moves `speed` × the short screen side per tick and is clamped to `camera.screen`. Call `hide()` when the mouse moves.
- No allocation per tick in steady state: rays, samples, hits and events are pooled.

### The `PointerSource` seam (XR)

```ts
interface PointerSource {
  poll(camera: RayCamera | null): readonly PointerSample[];   // once per Input.update(); the source owns and reuses the array and samples
  attach?(target: HTMLElement): void;
  detach?(): void;
}
interface PointerSample {
  key: number;                 // stable per pointer within the source; a key missing from poll() ends that pointer
  device: PointerDevice;       // 'mouse' | 'touch' | 'pen' | 'gamepad' | 'xr'
  hand: Hand | null;
  readonly ray: Ray;           // world space, dir normalised
  x: number; y: number;        // screen units, NaN for XR
  select: boolean; secondary: boolean;
  xr: XrButtons | null;        // { trigger, squeeze, pinch }
}
```

An XR source fills `ray` from each input source's target-ray pose, sets `select = trigger || pinch` and `secondary = squeeze`, and owns its thresholds (pinch distances in metres). It is added with `router.addSource(src)`; nothing in the router changes. The engine ships no WebXR calls yet.

## Testing / automation
The low-level feed methods (`keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`, `pointerAt`, `releaseAll`) are public, so tests, replays and the automated playtest can drive input without a DOM. Pass `getGamepads` to inject pads.
