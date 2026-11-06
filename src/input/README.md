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
- `InputOptions`: `getGamepads`, `blocked`, `globalKeys`, `buttonKeys`, `queueTaps`, `tickMs`, `padLayout`, and the `gestures`, `pointers` and `look` to link.
- `Input.recorder` and `Input.playback`: the `InputRecorder` / `InputPlayback` installed on this input, or null (see *Recording and replay*).
- `AttachOptions`: `pointerTarget`, `keyTarget` (default the target's window), `disableTouchScroll` (default true), `hoverWhileClaimed` (default false; see *Pointer dispatcher*).
- `InputEvents`: `device`, `rumble`, and `attach`/`detach` with the `PointerDispatcher` `Input.attach` built. `ActionSource`: `{ update?(), value(action), fresh?(action) }` for `input.addActionSource` (touch zones feed actions through one).
- `input.onUpdated(fn)` runs `fn` at the end of every `update()` (after gestures, look, router and triggers; same tick, registration order; returns the remover): poll a world panel or read `pressed()` for the frame there. `input.axis(negative, positive)` is `value(positive) - value(negative)`.
- `ActionState`: one action's `pressed`, `held`, `released`, `value` (0..1), `heldTicks` and `holdProgress` (see *Triggers and chords*).
- `PointerState`: `input.pointer`: `x`, `y`, `dx`, `dy`, `inside`, `down`, `wheelX`, `wheelY` and `type` (`mouse | touch | pen`).
- `PointerTransform`: `(clientX, clientY) => { x, y } | null`, client CSS px to game space; `null` means outside the game rect.
- `InputDevice`: the `lastDevice` union, `keyboard | mouse | touch | pen | gamepad | xr`.
- `GamepadLike`: the slice of `Gamepad` the engine reads (`connected`, `buttons`, `axes`, and optionally `id` and `vibrationActuator`), for a fake `getGamepads` in tests.
- `PointerButton` (`select | secondary`), `XrButton` (`trigger | squeeze | pinch`) and `GestureKind` (`tap | doubleTap | longPress | pan | drag | pinch`): what `{ pointer }`, `{ xr }` and `{ gesture }` bindings can name.

## Pointer dispatcher

`Input.attach` builds one `PointerDispatcher` (`createPointerDispatcher(target, { transform, hoverWhileClaimed })`, `input/pointer-dispatch.ts`, ws/input-4): one set of `pointerdown`/`pointermove`/`pointerup`/`pointercancel`/`pointerleave` listeners on the target plus window `blur` and `visibilitychange`, one `pointerType` parse and one `setPointerCapture` per event, fanned out as a `PointerRecord` (`id`, `device`, `button`, `primary`, `x`, `y` in feed coordinates, `clientX`, `clientY`, `time`, `inside`; one reused object) to every `PointerConsumer` (`pointerDown`, `pointerMove`, `pointerUp`, `pointerCancel`, `pointerLeave`, `cancelAll`, all optional) in priority order (`add(consumer, priority, seesClaimed?)` returns the remover; `POINTER_PRIORITY` names the engine's: feed 0, zones 10, look 20, gestures 30, screen 40). The input's own feed, the linked `Gestures`, `Look` and the router's `ScreenPointers` are consumers, so a page has one listener set however many of them it links; `input.dispatcher` reads it, and `input.on('attach' | 'detach', fn)` sees it come and go. A `Gestures`, `Look` or `ScreenPointers` attached on its own builds a private dispatcher, so standalone use is unchanged. The feed methods stay the test and replay path.

`claim(id, owner)` / `release(id)`: a claimed pointer is delivered only to its owner (and to consumers added with `seesClaimed`: the feed, so recordings stay whole, and the screen source, which hides it from `poll`) until it is released, lifts or is cancelled; `owner(id)` and `claimed(id)` read the state, a second owner's claim returns false. An orbit drag claims its mouse or pen pointer and a touch zone claims its thumb, so neither pans, taps or hovers; `ScreenPointers.claim` is the predicate the source consults (installed from the dispatcher as "claimed and not `hoverWhileClaimed`"), and with `AttachOptions.hoverWhileClaimed` (or `dispatcher.hoverWhileClaimed`) a claimed pointer keeps hovering (`hit`/`hitEnd`, no select). `setTransform(fn)` follows `Input.setPointerTransform`; `destroy()` removes the listeners. Types: `PointerDispatcher`, `PointerDispatcherOptions`, `PointerConsumer`, `PointerRecord`, `PointerRecordDevice` (`mouse | touch | pen`).

## Touch zones

`createTouchZones(input, { zones, bindings?, devices? })` (`input/touch-zones.ts`, ws/input-4) turns screen regions into a stick, buttons or swipes that feed actions. Each zone has a `rect: (w, h) => ZoneRect` (`{ x, y, w, h }` in CSS px of the pointer target, evaluated when a pointer lands, so it follows resizes; `ZoneRectFn`) and a `kind: TouchZoneKind`: `'stick'` (`StickZoneOptions`: `deadZone` 0.12, `radius` 64 px, `anchor: 'down' | 'center'`), `'buttons'` (`ButtonsZoneOptions`: `buttons: Record<name, ZoneRectFn>` sub-rects) or `'swipe'` (`SwipeZoneOptions`: `threshold` 24 px). A pointer of one of `devices` (default `['touch']`) that goes down inside a free zone is claimed through the input's dispatcher, so gestures and the router never see it (two thumbs never pinch); each zone tracks at most one pointer, a pointer starting outside every zone is left alone. Readings (`zones.zones.<name>`, `TouchZoneReading`): `StickZone` (`active`, `vector` `[x, y]` -1..1 reused, `x`, `y`, `originX`, `originY`), `ButtonsZone` (`pressed(name)` on the landing tick, `held(name)`, `down`), `SwipeZone` (`swipe: SwipeDirection | null`, once per gesture). `bindings` map actions to `TouchZoneBinding`s (`{ zone, axis: 'x' | 'y', dir }`, `{ zone, button }`, `{ zone, swipe }`, one or a list) through an `ActionSource`, so `input.pressed('jump')`, `input.value('moveRight')` and `input.axis('moveLeft', 'moveRight')` read the thumbs; zone bindings live beside the binding map, not in it (`Bindings` and the glyphs are unchanged). The returned `TouchZones` has `enabled`, `update()` (called by `input.update()`), `attach()`/`detach()` (automatic on `input.attach`/`detach`) and `destroy()`. Recordings capture every zone thumb (the `ptr` lane, ws/input-5); `harness/input.html?zones` draws a stick and a jump button. Types: `TouchZonesOptions`, `TouchZoneOptions`, `ZoneRect`.

## Semantics
- `pressed` is true for exactly one `update()` when an action becomes active; `released` for one `update()` after it stops. `held` while active. `heldTicks` counts ticks.
- A tap that goes down and up between two ticks still produces `pressed` (and `held`) for one tick and `released` on the next.
- **Repeat taps are queued** (default on; `new Input(b, { queueTaps: false })` turns it off). If a key or mouse button goes down again before the tick that saw its first press, each extra tap fires `pressed` on one of the following ticks, up to 8 queued per key. The action stays `held` across them, and `released` fires once the queue drains. Quick double taps and automated `keydown`/`keyup` bursts therefore never lose a press. While `blocked()`, on `releaseAll()` and on `setBindings` the queue is dropped. A tap on a second binding of an action that is already held still does not re-press it.
- Several bindings on one action are OR'ed; switching from one to another while held doesn't re-press.
- `blocked()` true → every action reads inactive, nothing is `preventDefault`ed. Keys held across the block do not fire `pressed` when it ends.
- `lastDevice` (`keyboard | mouse | touch | pen | gamepad`) for showing the right prompts.
- Pointer position is game space via the transform. Without a transform it's CSS px relative to the pointer target. `inside` is false when the transform returns `null` (in the letterbox bars) or the mouse leaves.
- Call `update()` once per **simulation tick**. If you run several fixed steps in one frame, `pressed` fires on the first only, which is what you want.

## Triggers and chords

Every `Binding` is a `BindingSource` (the input it reads) plus `TriggerOptions`: `trigger?: Trigger` (`'press'`, the default, `'hold'` or `'doubleTap'`), `holdMs` and `doubleTapMs`. Timing is counted in ticks of `InputOptions.tickMs` (default 1000/60), so the result is the same on every machine and in a replay.

```ts
const input = new Input({
  jump:   [{ key: 'Space' }],
  charge: [{ key: 'Space', trigger: 'hold', holdMs: 600 }],        // the same key, fired late
  dash:   [{ key: 'KeyD', trigger: 'doubleTap', doubleTapMs: 250 }],
  combo:  [{ chord: [{ key: 'ShiftLeft' }, { key: 'KeyK' }] }],
}, { tickMs: 1000 / 60 });

const bar = input.state('charge').holdProgress;   // 0..1 while Space is down, 1 once it fired
```

- **`hold`**: the action goes `pressed` and `held` on the tick the source has been down for `holdMs` (`DEFAULT_HOLD_MS` 400; `ceil(holdMs / tickMs)` ticks), stays `held` until the source lifts, then `released`. Letting go early fires nothing. `ActionState.holdProgress` is the fraction of the hold elapsed (0 when idle, 1 from the fire on), the largest over the action's hold bindings; other triggers report 0.
- **`doubleTap`**: the second press of the source within `doubleTapMs` (`DEFAULT_DOUBLE_TAP_MS` 300) of the first fires `pressed` and `held` for one tick and `released` on the next; a third press right after starts a new count rather than chaining.
- **Chords** (`{ chord: Binding[] }` as a source): active while every member reads non-zero, `pressed` once when the last one lands, in any order, `released` when any lifts. Members can be any source (keys, pad buttons, a pointer button); a chord takes a trigger too (`{ chord: [...], trigger: 'hold' }`). A member that is also a plain binding of another action still drives that action.
- `blocked()` zeroes hold progress and the tap count; a source held through the block does not fire when it ends.

## Rebinding

A game rebinds one action at a time and keeps the rest; the action states of untouched actions survive.

```ts
import { findConflicts, parseBindings, serializeBindings } from '@thunderclap/engine/input';

const b = await input.listen('jump');            // the next key, mouse or pad button; null if cancelled
if (b) input.rebind('jump', [b]);
for (const c of findConflicts(input.bindings())) warn(c.binding, c.actions);   // [{ binding, actions }]

localStorage.setItem('bindings', serializeBindings(input.bindings()));
input.setBindings(parseBindings(localStorage.getItem('bindings'), DEFAULTS));
```

- `input.rebind(action, bindings)` replaces that action's list (`bindings()` returns the live map; it throws on an unknown action). A source that is down when it is rebound keeps reading 0 until it lifts, so the old action gets its `released` and the new one is not `pressed` by a key the player was already holding.
- `input.listen(action, opts?: ListenOptions)` resolves with the next key (`{ key }`), mouse or pen button (`{ mouse }`), pad button that was up when the listen began (`{ padButton }`) or XR button (`{ xr }`), swallowing it (no action sees it). Escape resolves `null`, as does `timeoutMs` (ticks of `tickMs`) or a newer `listen`. Keys typed into text fields never reach `Input`, so they are not captured. `listeningFor()` names the pending action.
- `serializeBindings(map)` is JSON; `parseBindings(text | object, defaults)` returns a map with the shape of `defaults`: actions it does not know are dropped and bindings that fail `isBinding` are dropped, each with one `console.warn`; unreadable text returns `defaults`. A rebind of a chord member or a trigger survives the round trip.
- `findConflicts(map)` returns one `BindingConflict { binding, actions }` per binding two or more actions share, comparing the whole binding: a `hold` and a `press` on one key are different bindings and do not conflict; chords conflict only with identical chords.

## Contexts

A menu, gameplay and a vehicle each own their bindings (ws/input-5); the game pushes and pops instead of toggling `blocked`.

```ts
const pop = input.pushContext('menu', {
  bindings: { confirm: [{ key: 'Enter' }, { padButton: 0 }], back: [{ key: 'Escape' }] },
  pass: 'none',                          // nothing below the menu fires
});
input.context;                           // 'menu'
pop();                                   // or input.popContext('menu')
```

- `pushContext(name, opts?: ContextOptions)` → a remover; `popContext(name): boolean` removes the topmost entry of that name. Pushing a name already on the stack moves it to the top. `ContextOptions.bindings` is a partial map over the same action names (an unknown action throws); `pass: ContextPass` says what the contexts below contribute: `'unbound'` (default) the bindings of every action this context leaves out, `'all'` theirs after its own (an overlay), `'none'` nothing.
- `context` (the top name or null), `contextStack()` (bottom first) and `onContextChange(fn)` (also the `'context'` event) read it.
- **Edges across a change.** Only actions whose effective bindings changed are rebuilt: their hold, double-tap and chord progress restarts and their buffered press is dropped. A rebuilt action whose input is down when the context changes is latched: it reads nothing until that input lifts, so the Space that opened a menu does not also press its `confirm`. An action that loses its bindings releases on the next `update()`.
- `bindings(context?)`, `rebind(action, list, context?)` and glyphs follow the stack: with no argument `bindings()` is the effective map and `rebind` writes the top context (the base map when none is pushed); `null` names the base map, a string a context on the stack. `glyphFor` reads the effective map, so a prompt shows the menu's key while the menu is up.
- Recordings note pushes and pops (`cx`, below); a replay pushes them again from the same inputs.

## Input buffer

`input.buffered(action, windowMs)` is true when `action` went `pressed` within the last `windowMs` and that press was not yet consumed; `input.consume(action)` marks the latest press used, clears `pressed` for the rest of the tick and returns whether there was one. The window counts ticks of the fixed step (`ceil(windowMs / tickMs)`, `InputOptions.tickMs`, default 1000 / 60: 100 ms is 6 ticks), so a replay gives the same answers. A press while `blocked()` does not buffer.

```ts
if (grounded && input.buffered('jump', 100)) {
  input.consume('jump');                 // a jump pressed up to 6 ticks before landing still lands
  jump();
}
```

## Sticks

`input.stick(negX, posX, negY, posY, out, opts?: StickOptions)` reads four actions as a 2D stick into `out` (`[x, y]`, reused, returned) and shapes it; `input.stickAngle(out)` is `atan2(y, x)` or null at rest. Keys give a diagonal of length 1, pad axes their analogue value (bind them with `threshold: 0` to keep the low end). `shapeStick(x, y, out, opts?)` is the same shaping on raw values. `StickOptions`: `deadzone` (default 0.15), `shape: StickShape` (`'scaledRadial'` default: zero inside the dead zone, the length rescaled from its edge so it is continuous; `'radial'`: the value unchanged past the dead zone; `'axial'`: each axis on its own, which snaps near-axis input to the axis), `curve` (the length to this power, default 1), `clamp` (length at most 1, default true). `Look`'s touch stick and pad sticks use the same function, scaled radial at their own dead zones.

## Rumble

```ts
input.rumble({ strong: 0.8, weak: 0.3, ms: 120 });   // true when a pad played it
if (input.rumbleSupported()) showRumbleToggle();
```

`input.rumble(opts?: RumbleOptions)` plays a `dual-rumble` effect (`strong`, `weak` 0..1, default 1; `ms`, default 100) on `pad`, or the first connected pad with a `vibrationActuator` (`GamepadLike.vibrationActuator`, a `GamepadActuatorLike`; `GamepadLike.id` is read for layouts too). It returns false, and nothing throws, without a pad, an actuator or when the browser refuses. `rumbleSupported(pad?)` says whether one could. Every call reaches the feed hooks (`InputFeedHook.rumble`) and `input.on('rumble', fn)` (`InputEvents`), so a recording lists the rumbles per tick and a test counts them with a fake actuator; playback feeds inputs, not rumbles, so the replayed game issues its own.

## Prompt glyphs

```ts
import { glyphForBinding, keyLabel, padButtonLabel } from '@thunderclap/engine/input';

input.on('device', (d) => redrawPrompts());          // lastDevice changed (InputEvents)
const g = input.glyphFor('jump');                    // for lastDevice: { kind: 'key', label: 'Space' } | null
prompt.textContent = g?.label ?? '';
```

- `input.lastDevice` (`InputDevice`: `keyboard | mouse | touch | pen | gamepad | xr`) follows the last source that produced input; `'xr'` when a linked `PointerSource` fires a trigger, squeeze or pinch. `input.on('device', fn)` fires on each change.
- `input.glyphFor(action, device = lastDevice)` picks the action's first binding for that device (`bindingMatchesDevice(binding, device)`; mouse and pen share, touch takes gestures and pointer buttons, a chord matches when a member does), falling back to the first binding, and labels it with `glyphForBinding(binding, layout)`: a `Glyph { kind: GlyphKind, label }` where `kind` is `key`, `mouse`, `wheel`, `pad`, `gesture`, `pointer`, `xr` or `chord` (members joined with ` + `), and `hold` or `doubleTap` triggers prefix `Hold ` / `Double-tap `.
- Keys: `keyLabel(code)` names a `KeyboardEvent.code` (`Space`, `Esc`, `Enter`, arrows as `←`, `KeyA` as `A`, `Digit1` as `1`, numpad and F keys, any other code split on its words). Pads: `padButtonLabel(index, layout)` and `padAxisLabel(axis, dir)` (`LS →`, `RS ↑`) name standard-mapping controls in a `PadLayout` (`'xbox'`, `'playstation'`, `'nintendo'` or `'generic'`); `guessPadLayout(gamepad.id)` reads the layout off the id string (vendor ids and names) and `InputOptions.padLayout` (or `input.padLayout`) overrides the guess. Gestures read `Tap`, `Double tap`, `Hold`, `Drag`, `Pinch`; pointer buttons `Select`, `Secondary`; XR `Trigger`, `Squeeze`, `Pinch`.
- The labels are plain strings; a game maps them to its own icon set (`src/ui` has no glyph widget).

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
- Feed methods for tests and replays: `pointerDown(id, x, y, device?, time?)`, `pointerMove`, `pointerUp`, `pointerCancel`, `cancelAll`. Pass `now` to drive long-press timing from a fake clock. Attached, the gestures consume from the pointer dispatcher (`GestureAttachOptions.dispatcher`, the input's when linked, else a private one).
- `onGesture(listener)` observes the stream: `listener(kind, phase, g)` is called synchronously each time the recogniser decides something (a tap on lift, a long-press when its time is up, each pan/drag/pinch `start`, `move`, `end` and `cancel`), not once per tick, and before any tick reports it. Discrete kinds come with phase `'end'`; `g` is the same report object the tick field will carry (narrow it by `kind`). It returns the unsubscribe function. It is an observer for tests, replays and logging, not a replacement for the per-tick fields or action bindings, which stay how a game reads gestures. `GestureListener` is its type.
- Gesture types: `GesturePoint` (`x`, `y`, `inside`, game space), `GesturePhase` (`start | move | end | cancel`), `GestureDevice` (`mouse | touch | pen`), `TapGesture` (tap, double tap, long press), `PanGesture` (`phase`, `dx`, `dy`, `pointers`), `DragGesture` (a pan with its `origin`) and `PinchGesture` (`phase`, `scale`, `delta`, centre in `x`/`y`). `GestureAttachOptions`: `pointerTarget`, `disableTouchScroll`, `dispatcher`.

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
- `PointerRouter<T>` (what `createPointerRouter(opts)` builds): `screen` (the built-in `ScreenPointers`), `pointers` (live `RoutedPointer`s, reused), `camera`, `hit` (the primary pointer's), `addTester`, `addSource` (each returns its remover), `held`/`fired` per `PointerButton`, `xrHeld`/`xrFired` per `XrButton`, `attach(target, dispatcher?)`, `detach`, `update()`; events `hit`, `hitEnd`, `select`, `secondary`, `moved` (a pointer's position or ray changed, once per pointer per tick, after its `hit`/`hitEnd`) and `released` (its select or secondary went up), all with the `PointerHitEvent` payload (`PointerRouterEvents`).
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

A world panel (`ui/world-panel`, ws/ui-world-panel) is routed like a mesh: `router.addTester(worldPanelTarget(panel))` registers a `HitTester` whose hit has the panel as `target`, the world point on the quad, a normal turned to face the ray and the distance, so the nearest-hit rule, `router.hit` and `{ pointer: 'select' }` bindings treat a mouse, a touch, the pad cursor and a headset controller alike. The router never calls into the panel: once per tick after `input.update()` the game calls `panel.poll(router.pointers)` (an `input.onUpdated` hook is the place), which reads each pointer's `hit` and `select` and turns them into hover, press and release in panel px (`hitTest(ray)` does the ray-to-px step for anything else).

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
- Feed methods for tests and replays: `mouseMove(dx, dy)`, `wheel(units)`, `touchDown(id, x, y, inMoveZone)`, `touchMove`, `touchUp`, `cancelAll`. `attach(el, dispatcher?)`/`detach()` are called by `Input.attach`/`detach`; attached, the pointer events come from the dispatcher (the wheel, the locked mouse and the lock events stay the look's own listeners).
- `gyro` (`LookOptions.gyro`, a `GyroSource`) adds gyro aim; `onTap` reports taps (see *Gyro aim* and *Look tap*).
- Types: `LookOptions`, `LookMode`, `LookTapOptions`, `LookTapListener`, `LookTouchOptions` (`moveZone`, `deadzone`, `radius`, `sensitivity`), `LookZoomOptions` (`wheel`, `pinch`, `pad`, `stepPx`), `LookZoomPad`, `MoveZone`, `LookKeys`, `LookStick`, `LookEvents`; constant `PAD_ZOOM_PER_S`. No allocation per tick.

## Orbit look

`LookOptions.mode: LookMode` (`'locked'`, the default, or `'orbit'`) picks how the mouse looks. In orbit mode a mouse or pen drag on the attached element turns the view at the same `sensitivity`, with no pointer lock: a level editor, a model viewer or a strategy camera. `look.setMode(mode)` switches at run time (to orbit releases the lock; to locked ends a drag in progress); `look.mode` reads it.

```ts
const look = new Look({ mode: 'orbit', sensitivity: 0.005 });
ctx.input.setLook(look);                        // a left-button drag now feeds look.look
```

- `request()` resolves false without asking and `lockOnFirstClick` is ignored (one `console.warn`). The touch zones, the wheel, the pinch and the pad are unchanged, so a touch drag turns the view in both modes.
- A drag claims its pointer through the dispatcher (`dispatcher.claim`, ws/input-4; `gestures.claim`, the hook `Input` installs from `look.claimsPointer(device)`, covers the feed path), so it never pans or taps, and the router's screen source stops producing hits for it until it lifts (`hit` again on the next hover) unless `hoverWhileClaimed`; touches are not claimed, and in locked mode nothing is.
- Through an `Input` the drag comes from its feed (`buttonDown(0)`, `pointerAt`, `buttonUp(0)` with a non-touch pointer), so a recording replays an orbit; a `Look` attached on its own consumes a private dispatcher's pointer events. Feed methods for tests: `orbitDown(x, y)`, `orbitMove(x, y)`, `orbitUp()`; `orbiting` is true while a drag is live. `blocked()` zeroes it like the locked mouse.

## Gyro aim

A phone aims by turning it (ws/input-5). `createGyroSource(opts?: GyroSourceOptions)` (`input/gyro.ts`) reads `devicemotion`'s rotation rate into a look delta; give it to `Look` (`new Look({ gyro })` or `look.gyro = src`) and it is added to the pointer and stick look each tick.

```ts
const gyro = createGyroSource({ sensitivity: 1.2, smoothing: 0.3 });
button.onclick = async () => {
  if ((await gyro.requestPermission()) === 'granted') look.gyro = gyro;   // iOS asks from a tap
};
```

- `GyroSource`: `enabled`, `sensitivity` (look radians per device radian, default 1), `invertY` (its own; `Look.invertY` does not apply), `smoothing` (0..1 low-pass per tick), `available` (the API exists), `receiving` (a rotation rate arrived: desktops have the API, no sensor), `permission` (`'prompt'` until asked), `requestPermission(): Promise<GyroPermission>` (`'granted' | 'denied' | 'unavailable'`, never rejects), `take(out)` (what `Look` calls), `feed(alpha, beta, gamma, ms)` and `dispose()`.
- Rotation about the screen's vertical axis yaws and about its horizontal axis pitches, following `screen.orientation.angle`. Each event integrates over its own interval, capped at 100 ms so a stalled sensor does not jump the view. While `Look` is blocked the turn is dropped, not saved up.
- `GyroSourceOptions.env: GyroEnv` (`target`, `requestPermission`, `screenAngle`) replaces the page's `window`: tests and `harness/input5.html?gyro` feed a fake (`GyroMotionEvent` is the slice of the event read). Headless there is no target and the source is `'unavailable'`.

## Look tap

`look.onTap((x, y, device) => ...)` (`LookTapListener`) reports a press that lifts within `maxMs` (450) having moved at most `maxMove` (10) px in all (`LookOptions.tap: LookTapOptions`), so a page with an orbit or touch look can pick on a tap without writing its own pointerup detection. Only a primary, main-button pointer taps; a second pointer cancels it, and so does the touch move stick, a drag past `maxMove` or `blocked()`. `(x, y)` are in the router's units: through `Input.setPointerTransform` when one is set (`null` from it drops the tap), else CSS px of the target. The tap is reported beside the gestures' `tap`, not instead of it. Returns a remover.

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
The low-level feed methods (`keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`, `pointerAt`, `releaseAll`) are public, so tests, replays and the automated playtest can drive input without a DOM. Pass `getGamepads` to inject pads. `input.onFeed(hook)` installs an `InputFeedHook` that sees every one of those calls (DOM or direct) plus the pads each `update()` reads, and may substitute the pads; it returns the uninstaller. The recorder and playback below are its two implementations; a hook never changes how bindings are evaluated.

## Recording and replay

A game records everything its `Input` was fed, tick by tick, and plays it back later with the same results: bug reports, automated playtests, and e2e specs that want a scripted session instead of synthetic DOM events.

```ts
import { createInputPlayback, createInputRecorder, parseRecording, serializeRecording } from '@thunderclap/engine/input';

const rec = createInputRecorder(input);            // input.recorder === rec; one tick per input.update()
// ... play ...
const recording = rec.stop();                      // { version: 2, ticks: [...] }
localStorage.setItem('bug-42', serializeRecording(recording));

// Later, on an identical game (same bindings, same layout, same fixed step):
const pb = createInputPlayback(input2, parseRecording(json));   // input2.playback === pb
// each tick, before input2.update():
if (!pb.step()) finished();
// createGame does this for you: createGame({ input: { bindings, replay: recording } }) attaches no DOM
// listener and calls ctx.input.playback.step() before each fixed step; { record: true } gives ctx.input.recorder.
```

- `createInputRecorder(input, opts?)` → `InputRecorder { tick(), stop(): InputRecording, recording, ticks }`. It closes a tick on every `input.update()` (the hook's pad read), so `tick()` is only for driving it by hand. `InputRecorderOptions.pads` (default true) captures the pads `update()` read. `stop()` uninstalls it and returns the same object `recording` points at.
- `createInputPlayback(input, recording, opts?)` → `InputPlayback { step(): boolean, done, tick, length, seek(tick), speed, detach() }`. `step()` feeds the next tick's events and returns false once the recording is finished (the input then holds its last state; call `releaseAll()` yourself if you want it cleared). While installed, `update()` reads the recorded pad snapshot instead of `getGamepads`. `speed` (`InputPlaybackOptions.speed`, ticks per `step()`, default 1) fast-forwards in tests: the extra ticks are fed and `update()`d inside the call, so only the last one is seen by the caller. `seek(tick)` calls `releaseAll()` first, restores the pad snapshot in force at that tick and feeds nothing that was skipped; `seek(0)` restarts. `detach()` uninstalls the hook.
- **Format** (`InputRecording`, plain JSON, deltas only): `{ version: 2, ticks: InputTick[] }`. A tick with events is an `InputTickEvents` `{ t, k?, b?, p?, w?, r?, d?, g?, ptr?, cx?, cs? }`: `k` keys in call order as `[code, 1 | 0]` (down, up), `b` mouse buttons the same way, `p` the last pointer position fed that tick as `[clientX, clientY]` plus `'touch' | 'pen'` when not a mouse, `w` the wheel delta summed over the tick, `r: 1` for `releaseAll`, `d: 1` when a key went down after the tick's last pointer position (so the keyboard, not the pointer, is `lastDevice`), `g` the pads when they changed: `PadSnapshot[]`, each `{ buttons: number[], axes: number[] }` (a `pressed` button records as 1) or `null` for an empty or disconnected slot (the implied starting state is no pads, so a page whose `navigator.getGamepads()` is four empty slots records nothing). `ptr` (version 2) every pointer event the dispatcher delivered, in order, as an `InputPointerEntry` `[phase, id, device, clientX, clientY, button, primary]` (phase 0 down, 1 move, 2 up, 3 cancel, 4 leave: `InputPointerPhase`; consecutive moves of one pointer keep the last; a blur records a cancel per pointer still down), so touch zones, gestures and a second thumb replay. `cx` context pushes `[name, 1]` and pops `[name, 0]`, `cs` the actions `consume`d: both observational, like `rumble` (the game makes the same calls from the same inputs). Ticks on which nothing was fed collapse into an `InputTickRun` `{ t, n }`. `recordingLength(rec)` is the tick count. **Size:** a tick with one key edge is about 20 bytes; a pointer move 25; idle stretches of any length are one run. A minute of busy play is tens of kilobytes.
- `serializeRecording(rec)` is `JSON.stringify`; `parseRecording(json | value)` validates the version, the tick order and every field and throws `InputRecordingError` otherwise. **Versions:** the recorder writes 2; version 1 recordings (no `ptr`, `cx`, `cs`) still parse and play.
- **Replay order** within a tick: `r`, then `k`, `b`, `p`, `w` (`p` before `k` when `d` is set), then `ptr`, dispatched as `PointerEvent`s on the attached pointer target (`input.replayPointer`) (headless, with no target, the lane is skipped; `seek` cancels replayed pointers still down). A `releaseAll` that arrived after other events on the same tick (a blur mid-burst) is replayed before them; keys are in call order among themselves, buttons likewise, and `Input` does not otherwise care about the order of the groups.
- **Not captured:** gesture timing (`Gestures` reads a clock; the `ptr` lane replays its pointers, so a gesture replays when its clock is the tick clock), `Look`'s pointer lock and raw `movementX/Y`, `PointerRouter` sources, `blocked()` (replay with the same UI state), the pointer transform (positions are client CSS px, so replay on the same layout), and the state before the recording started: `releaseAll()` clears keys and buttons but not the pointer position, so a session that reads `pointer` should begin by placing it. The recording holds what reached `Input`; the game's own randomness and timing are the game's to pin.
- Zero allocations per tick while nothing happens: the recorder bumps the current run's count. `harness/replay.html` records a scripted 3 s session, replays it and compares every tick (`e2e/replay.spec.ts`).
