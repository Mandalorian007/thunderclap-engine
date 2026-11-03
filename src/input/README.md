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

## Testing / automation
The low-level feed methods (`keyDown`, `keyUp`, `buttonDown`, `buttonUp`, `wheel`, `pointerAt`, `releaseAll`) are public, so tests, replays and the automated playtest can drive input without a DOM. Pass `getGamepads` to inject pads.
