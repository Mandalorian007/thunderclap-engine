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

Types a game names when it wraps or configures `Input`:

- `Bindings<A>`: the map from each action name to its `Binding` list, passed to `new Input` and `setBindings`.
- `InputOptions`: `getGamepads`, `blocked`, `globalKeys`, `buttonKeys`, `queueTaps`, and the `gestures`, `pointers` and `look` to link.
- `AttachOptions`: `pointerTarget`, `keyTarget` (default the target's window), `disableTouchScroll` (default true).
- `ActionState`: one action's `pressed`, `held`, `released`, `value` (0..1) and `heldTicks`.
- `PointerState`: `input.pointer`: `x`, `y`, `dx`, `dy`, `inside`, `down`, `wheelX`, `wheelY` and `type` (`mouse | touch | pen`).
- `PointerTransform`: `(clientX, clientY) => { x, y } | null`, client CSS px to game space; `null` means outside the game rect.
- `InputDevice`: the `lastDevice` union, `keyboard | mouse | touch | pen | gamepad`.
- `GamepadLike`: the slice of `Gamepad` the engine reads (`connected`, `buttons`, `axes`), for a fake `getGamepads` in tests.
- `PointerButton` (`select | secondary`), `XrButton` (`trigger | squeeze | pinch`) and `GestureKind` (`tap | doubleTap | longPress | pan | drag | pinch`): what `{ pointer }`, `{ xr }` and `{ gesture }` bindings can name.

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
- `isInteractiveTarget(target)`: true for an element that owns its keyboard input (`input`, `textarea`, `select`, `button`, `a`, `summary`, contenteditable, `role=button|textbox|slider|menuitem`): the test `Input` applies before ignoring a key, for a game's own key handlers.
- Wheel is `preventDefault`ed only if a wheel binding exists; right-click menu only if mouse button 2 is bound.
- `touch-action: none` is set on the pointer target (restored on `detach`).
- Pointer down on the target calls `window.focus()` so the iframe receives keys after a click.
- All keys/buttons release on window `blur` and when the tab is hidden: no stuck keys.
- Gamepad access is wrapped in `try` (permissions policy can block it inside iframes).

## Gestures

`Gestures` recognises touch and pointer gestures and reports them in the same tick model.

```ts
import { Gestures, Input } from '@thunderclap/engine/input';

// In a game, `createGame` builds the Gestures (`CreateGameOptions.input.magnify` → `GestureOptions.magnify`)
// and links them: read them as `ctx.gestures`. By hand:
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
- **Threshold rule**: a pointer's travel is cumulative from the down point (every move's distance summed, CSS px), so a slow drag in small steps crosses `panThreshold` too. On every move the threshold is checked before the long-press timer: travel past it is a pan, however long the frame took to deliver the move, and a pending long-press is dropped. A long-press that already fired stays fired (moving after it does nothing). Mouse, touch and pen follow the same rule.
- **pan** and **drag**: one pointer past the threshold starts both (`phase: 'start'`, with the travel so far in `dx`/`dy`), then `move` every tick (merged; `dx: 0` when idle), then `end`. Every `dx` of one gesture sums to the total travel. `drag` carries the `origin`; `pan.pointers` is always 1.
- **pinch**: a second pointer cancels a running pan and drag (one `cancel` each) and starts a pinch; while two or more pointers are down, pan and drag report nothing (pinch wins; two fingers moving together are not a pan). `scale` is the distance now over the distance at the start, `delta` the change since the last report. Lifting either pointer ends it; nothing more is reported until all pointers are up.
- Thresholds are CSS px (client coordinates); positions are game space through the transform. A point the transform maps to `null` reports `inside: false` with the last inside position.
- One tap, double tap and long-press per tick; extras queue for the following ticks (up to 8). `start` and `end` each get their own tick.
- `blocked()` (shared with the linked `Input`): nothing is reported and the press in progress is dropped; a running pan, drag or pinch gets one `cancel` so the game can put things back. Browser `pointercancel`, window blur and a hidden tab cancel the same way.
- Mouse: primary button only. Each pointer is captured, so a drag off the target keeps reporting.
- Feed methods for tests and replays: `pointerDown(id, x, y, device?, time?)`, `pointerMove`, `pointerUp`, `pointerCancel`, `cancelAll`. Pass `now` to drive long-press timing from a fake clock.
- `onGesture(listener)` observes the stream: `listener(kind, phase, g)` is called synchronously each time the recogniser decides something (a tap on lift, a long-press when its time is up, each pan/drag/pinch `start`, `move`, `end` and `cancel`), not once per tick, and before any tick reports it. Discrete kinds come with phase `'end'`; `g` is the same report object the tick field will carry (narrow it by `kind`). It returns the unsubscribe function. It is an observer for tests, replays and logging, not a replacement for the per-tick fields or action bindings, which stay how a game reads gestures. `GestureListener` is its type.
- Gesture types: `GesturePoint` (`x`, `y`, `inside`, game space), `GesturePhase` (`start | move | end | cancel`), `GestureDevice` (`mouse | touch | pen`), `TapGesture` (tap, double tap, long press), `PanGesture` (`phase`, `dx`, `dy`, `pointers`), `DragGesture` (a pan with its `origin`) and `PinchGesture` (`phase`, `scale`, `delta`, centre in `x`/`y`). `GestureAttachOptions`: `pointerTarget`, `disableTouchScroll`.

### Magnify (small touch targets)

A finger covers about 44 CSS px. With `GestureOptions.magnify` (or `gestures.setMagnify(opts)`), while one touch pointer is down `gestures.aim` reports where it aims, and a loupe beside the finger magnifies the area under it while targets are small. Mouse and pen never aim.

- `MagnifyOptions`: `pitch()` (the current target pitch, CSS px) is required; `below` (loupe shows under this pitch, 44), `size` (loupe diameter, 128, or a function read each tick), `zoom` (2.5), `lift` (aim point raised this far above a dragging finger, 56), `when`, `snap(x, y)` (the game's target picker), `over`, `toClient`, `source` (the canvas to magnify; without one only `aim` is reported), `className`, `parent`, `clear` (areas the loupe must, should or would rather not cover) and `leader`. `MAGNIFY_DEFAULTS` holds the four defaults.
- `MagnifyTarget`: what `snap` returns: centre `x`, `y`, radius `r` and the game's `data`.
- `Aim`: one tick's aim: game-space `x`, `y`, `inside`, `client` and `finger` (CSS px), `lifted`, the snapped `target`, `loupe` (wanted this tick), `ended` (the tick after the finger lifted: where a dragged thing lands) and `at` (the loupe centre).
- `Grid` and `snapToGrid(grid, x, y, ok?)`: the accepted cell nearest a point within half a pitch, or `null`; the usual `snap` for a board or list.
- `Rect` (`l`, `t`, `r`, `b`, client CSS px): the type of the `clear` areas. A game drawing its own loupe (no `source`) places it at `aim.at`, which already follows the engine's placement rules.

## Rays and the pointer router

Every pointer (mouse, pen, touch, the pad cursor, XR controllers and hands through `XrPointerSource`) becomes a ray through the camera, tested against the game's hit testers. 2D and 3D pick the same way.

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
- `HitTester<T> = (ray) => Hit<T> | null`. Return the tester's own reused `Hit`; the router copies the nearest. `planeTester(z, target?)`, `aabbTester(boxes)` and the transformed testers below ship; write your own for grids or voxels.
- Hover: mouse and pen are pointers while over the target. A touch is a pointer only while down, plus one tail tick after it lifts, so a `{ gesture: 'tap' }` select still sees its hit. A single touch aims with the magnify `aim` (the snapped target, else the lifted aim point).
- Select: if the input binds the router's `selectAction` (default `'select'`), any press of that action selects the **primary** pointer's hit (the one with the latest activity), so a key, a tap gesture or a pad button all select what is hovered. Otherwise each pointer's button down-edge selects. The same goes for `secondary`. The event's `hit` may be `null`.
- `{ pointer: 'select' | 'secondary' }` binds any pointer's button; `{ xr: 'trigger' | 'squeeze' | 'pinch', hand? }` binds an XR source's button.
- `blocked()` is shared with the input: every hit ends (`hitEnd`), `pointers` is empty, nothing selects, and a button held through the block does not fire after it.
- `PadCursor` appears at the screen centre when the stick deflects or select is pressed, moves `speed` × the short screen side per tick and is clamped to `camera.screen`. Call `hide()` when the mouse moves.
- No allocation per tick in steady state: rays, samples, hits and events are pooled.
- `PointerRouter<T>` (what `createPointerRouter(opts)` builds): `screen` (the built-in `ScreenPointers`), `pointers` (live `RoutedPointer`s, reused), `camera`, `hit` (the primary pointer's), `addTester`, `addSource` (each returns its remover), `held`/`fired` per `PointerButton`, `xrHeld`/`xrFired` per `XrButton`, `attach`, `detach`, `update()`; events `hit`, `hitEnd`, `select`, `secondary` (`PointerRouterEvents`).
- `PointerRouterOptions`: `camera` (a camera or a getter), `testers`, `sources`, `selectAction`, `secondaryAction`, `blocked`.
- `PointerHitEvent`: every event's payload (`pointer`, `hit`), reused between emits: read it in the listener or copy it. `RoutedPointer`: one live pointer's sample (`source`, `key`, `device`, `hand`, `x`, `y`, `ray`, buttons, `xr`) plus its nearest `hit`.
- `PointerActions`: the slice of `Input` the router reads (`bound`, `pressed`); a game that drives the router without an `Input` calls `router.poll()` then `router.resolve(actions)` with its own (`update()` is `poll()` then `resolve(null)`).
- `PadCursorOptions`: `getGamepads`, `pad`, `axes` ([0, 1], the left stick), `deadzone` (0.2), `speed` (0.012 of the short side per tick), `selectButton` (0), `secondaryButton` (2).
- Ray helpers for writing a `HitTester`: `Vec3` (a mutable `[x, y, z]`), `Aabb` (`min`, `max`, `target`, for `aabbTester`), `createRay()`, `createHit(target)` (allocate once and reuse), `rayAt(ray, t, out)` (the point at distance `t`), `transformRayInto(ray, worldMatrix3x4, outRay)` (the ray in an object's space; returns world units per object unit, 0 when singular) and `rayTriangle(ray, a, b, c, cullBack, outNormal | null)` (Möller–Trumbore: distance or -1).

### Picking 3D things (ws/pick)

Three testers pick against a `Transform` (any `RayTransform`, `Pick<Transform, 'world'>`: the 3×4 world matrix). Each reads the transform on every call, so a moving or spinning object is picked as drawn without re-registering, and each inverts the 3×3 itself, so rotation and non-uniform scale are fine. Every hit carries the world-space `point`, a unit `normal` facing the ray and `distance` in world units; a ray that starts inside a sphere or box hits at distance 0 with `normal: null` (as `aabbTester`). Zero allocations per call: each tester keeps its own scratch.

```ts
const thing = { transform: new Transform({ x: 3 }), vertices, indices };   // what the game drew
router.addTester(meshTester(thing.transform, thing.vertices, thing.indices, thing));
router.addTester(sphereTester(other.transform, mesh.bounds, other));       // cheap proxy
router.addTester(obbTester(door.transform, [0.5, 1, 0.05], door));         // half extents
```

- `sphereTester(transform, bounds: RayBounds, target?)`: the object-space sphere (`render`'s `MeshBounds`: `center`, `radius`; read each call) placed by the transform. Under non-uniform scale it is an ellipsoid and the normal follows it.
- `obbTester(transform, halfExtents, target?)`: the object-space box `[-h, h]` placed by the transform; the normal is the entering face's.
- `meshTester(transform, positions, indices | null, target?, opts?)`: the triangles of a mesh whose positions the game keeps on the CPU. `positions` is the interleaved `Float32Array` it uploaded (`MeshDesc.vertices`); `MeshTesterOptions.stride` and `offset` (floats; default 12 and 0, `VERTEX_LAYOUT_3D`) say where x, y, z sit, so pass `layout.floats` for another layout. `indices` is the index buffer (`Uint16Array` or `Uint32Array`) or `null` for a plain triangle list. The ray is rejected on `opts.bounds` first (an object-space sphere, read each call; default computed once from the positions; `radius` Infinity skips it), then every triangle is tested with Möller–Trumbore and the nearest wins; `opts.cullBack` skips triangles whose back faces the ray (counter-clockwise front). Cost: one 3×3 inverse plus O(triangles) per call after the sphere, so for large meshes a chunk pipeline registers one tester per chunk (its bounds reject most rays) or a `sphereTester` proxy first.
- Normals: `sphereTester` and `obbTester` return outward normals of what was entered; `meshTester` returns the triangle's geometric normal turned to face the ray, so a back face (without `cullBack`) reports a normal towards the ray too.

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

An XR source fills `ray` from each input source's target-ray pose, sets `select = trigger || pinch` and `secondary = squeeze`, and owns its thresholds (pinch distances in metres). It is added with `router.addSource(src)`; nothing in the router changes. `createSample(key, device)` allocates a blank `PointerSample` for a source to keep and refill.

`XrPointerSource` (ws/xr) is that source: `new XrPointerSource(session, referenceSpace, frame, opts?)` where `frame` returns the current `XRFrame` (an `XrHost`'s `frame`) or `null` outside one. Each `XRInputSource` with a target-ray pose is one pointer (`device: 'xr'`, `hand` from `handedness`, `x`/`y` NaN, `ray` from `targetRaySpace`, origin and -z of the pose matrix); `trigger` is gamepad button 0 or the `selectstart`/`selectend` events, `squeeze` button 1 or `squeezestart`/`squeezeend`, `pinch` the distance between the `index-finger-tip` and `thumb-tip` joints of a tracked hand with hysteresis: `XrPointerSourceOptions` `pinchStart` (0.02 m) and `pinchEnd` (0.035 m). Sources that leave (`inputsourceschange`) drop their key. `attach()`/`detach()` add and remove the session listeners; `createGame` adds it to `ctx.pointers` on `ctx.xr.enter()` and removes it on exit, so `{ xr: 'trigger' }` bindings and `router.hit` work the same in a headset. The WebXR types live in `src/platform/xr-types.d.ts`.

## Look

`Look` turns pointer-locked mouse, a two-zone touch layout, the pad's sticks and the move keys into three per-tick numbers a first- or third-person game reads: `look` (yaw and pitch deltas, radians), `move` (x, y in -1..1) and `zoom` (wheel notches, pinch or stick units; positive is closer). The game never sees which device moved.

```ts
import { Input, Look } from '@thunderclap/engine/input';

// The two lines a 3D game adds (createGame builds no Look, so a 2D game pays nothing):
const look = new Look({ keys: { forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'] } });
ctx.input.setLook(look);                         // or new Input(bindings, { look })

canvas.addEventListener('pointerdown', () => void look.request());   // the lock needs a gesture
look.onLockChange((locked) => showClickToPlay(!locked));

// each tick, after input.update() (which advances the look; don't call look.update() yourself):
yaw += look.look.dx;                             // > 0 turns right
pitch = clamp(pitch + look.look.dy, -1.4, 1.4);  // > 0 looks up
walk(look.move.x, look.move.y);                  // y > 0 is forward, length ≤ 1
distance -= look.zoom * step;                    // > 0 is closer (Follow does this itself)
```

- **Mouse**: `movementX/Y` count only while `document.pointerLockElement` is the attached element, times `sensitivity` (radians per CSS px, 0.0025). `request()` asks for the lock and resolves with whether it is held (false when detached, blocked, refused or unsupported; it never rejects). Browsers grant it only inside a user gesture. `release()` calls `document.exitPointerLock()` only when this element holds the lock. `locked` follows `pointerlockchange`; `onLockChange(fn)` (or `on('lockChange', fn)`, core `Emitter`, `LookEvents`) reports each change.
- **Touch**: the first touch that lands in the move zone (`touch.moveZone`, the `'left'` half of the element by default; `'right'`, or `'none'` for look only) is a floating stick: its offset from where it landed, clamped to `touch.radius` (56 CSS px), through a radial `touch.deadzone` (0.12 of the radius), is `move`. Any other touch drags the view at `touch.sensitivity` (default `sensitivity`). `look.stick` (`LookStick`: `active`, `originX`/`originY`, `x`/`y`, client CSS px) is there to draw the stick.
- **Pad**: the left stick is `move`, the right stick `look` at `padSensitivity` (radians per second at full deflection, 3) × the tick's `dt` from `now`; both through `padDeadzone` (0.15, radial). `pad` picks one pad (default the first connected).
- **Keys**: `keys` (`LookKeys`: `forward`, `back`, `left`, `right`, `KeyboardEvent.code` lists, no defaults) are read from the linked `Input`'s raw key state. Every source sums and `move` is clamped to length 1.
- **Zoom** (`zoom: LookZoomOptions`; `Look.zoom` resets each tick like `look.dx`): the wheel (`wheel`, on) on the attached element, listened passively, counts one unit per notch (wheel up is closer): `deltaMode` pixels over `stepPx` (100 CSS px), lines over 3, pages as is. A pinch (`pinch`, on) starts when a second finger lands while a look drag is live and neither takes the move stick: the change in finger distance over `stepPx` is the zoom, the drag reports no look while pinching, and when either finger lifts the other carries on as the drag; the move stick is never stolen. `pad` (`LookZoomPad`, default `'none'`): `'rightStickY'` makes the right stick's vertical axis the zoom (`PAD_ZOOM_PER_S` = 4 units per second at full deflection) and the stick then never pitches `look.dy` (the trade a game makes when the wheel is its only other zoom); `'shoulders'` reads the standard-mapping shoulder buttons as -1 (left, 4) and +1 (right, 5) per tick while held and leaves the stick to look. `wheel(units)` feeds notches for tests.
- `invertY` flips vertical look for every device.
- `lockOnFirstClick` (ws/ergo-3d, default false): a mouse or pen `pointerdown` on the attached element while the lock is not held calls `request()`, so the first click into the game locks the pointer and, after Escape, the next click locks it again; touches never lock and a `blocked()` session requests nothing. Without it the game wires `request()` to its own click handler as above.
- `blocked()` (shared with the linked `Input`): `look` and `move` read zero, the lock is released, and fingers already down are ignored until they lift. Window blur and a hidden tab drop the touches too.
- Feed methods for tests and replays: `mouseMove(dx, dy)`, `wheel(units)`, `touchDown(id, x, y, inMoveZone)`, `touchMove`, `touchUp`, `cancelAll`. `attach(el)`/`detach()` are called by `Input.attach`/`detach`.
- Types: `LookOptions`, `LookTouchOptions` (`moveZone`, `deadzone`, `radius`, `sensitivity`), `LookZoomOptions` (`wheel`, `pinch`, `pad`, `stepPx`), `LookZoomPad`, `MoveZone`, `LookKeys`, `LookStick`, `LookEvents`; constant `PAD_ZOOM_PER_S`. No allocation per tick.

## Follow

`Follow` is a third-person camera that follows a target, orbits from the same `look` deltas `Look` reports, swings in on obstacles the game reports, and becomes a first-person camera with one assignment. It drives any `FollowCamera` (`Pick<Camera, 'lookAt'>`; the renderer's `Camera`) through `lookAt` each `update(dt)`, so the orientation maths stays here and nothing allocates per frame.

```ts
import { Follow, Input, Look } from '@thunderclap/engine/input';

const follow = new Follow(camera, { distance: 5, shoulder: [0.6, 0], obstacle: world.lineOfSight });
follow.target = player;                 // { position: [x, y, z] | Float32Array; yaw?: number }
follow.setLook(look);                   // the Look linked to the Input; Follow reads look.look and look.zoom

// each tick, after input.update():
follow.update(dt);                      // yaw/pitch and zoom from the look, clamp, follow, test, camera.lookAt
if (input.pressed('view')) follow.mode = follow.mode === 'third' ? 'first' : 'third';
if (input.pressed('zoomOut')) follow.zoom(1);   // extra keys or buttons step it too
```

- **Conventions** match `Look` and the look harness: `yaw` 0 looks down -z and positive turns right; positive `pitch` looks up, so in third person the camera sinks below the pivot and a negative pitch (the default, -0.35) raises it. The pivot is `target.position + (0, eyeHeight, 0)` (1.6) shifted by `shoulder` `[right, up]` along the camera's right and up; the eye sits `distance` behind it along the view direction and the camera looks at the pivot. `pitch` is clamped to `pitchMin..pitchMax` (-1.2..1.2) every update.
- **Smoothing**: `smoothing` (seconds, a time constant; 0.12; 0 follows exactly) eases the pivot towards the target, so a moving character is followed with a little lag while the orbit answers the look at once. `snap()` forgets the lag (teleports, scene changes).
- **Obstacles** (`FollowObstacle`, `(from, to, outHit) => boolean`): the engine has no world, so the game tests the line from the pivot to the wanted eye and writes the first hit into `outHit`. The camera moves to the hit minus `margin` (0.2); `currentDistance` is what it used (`distance` stays what was wanted). It snaps in and eases back out with `smoothing`.
- **Zoom**: `zoom(steps)` steps `distance` by `zoomStep` (0.5) within `minDistance..maxDistance` (1..12), positive farther. With a `Look` linked, each `update` calls `zoom(-look.zoom)` (the look's axis is positive closer), so the wheel, a pinch and the opted-in pad control zoom with no binding of the game's own; `zoom(steps)` stays for keys and buttons.
- **Modes** (`FollowMode`): `mode = 'first'` puts the eye at `target.position + eyeHeight` looking along the same yaw and pitch, with no lag, shoulder or obstacle test, so a game toggles views with one assignment and the look continues where it was.
- `realign` (seconds; 0 = off) eases `yaw` back to `target.yaw` while the look is still. `position`, `pivot` and `forward` (`Vec3`) are what the last update placed; read them for audio listeners, anchors or movement relative to the camera.
- Types: `FollowOptions` (`distance`, `minDistance`, `maxDistance`, `shoulder`, `pitchMin`, `pitchMax`, `smoothing`, `eyeHeight`, `zoomStep`, `obstacle`, `margin`, `realign`, `yaw`, `pitch`, `mode`), `FollowTarget`, `FollowCamera`, `FollowMode`, `FollowObstacle`. `harness/follow.html` shows it: a capsule between walls, `V` toggles the mode.

## Testing / automation
The low-level feed methods (`keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`, `pointerAt`, `releaseAll`) are public, so tests, replays and the automated playtest can drive input without a DOM. Pass `getGamepads` to inject pads.
