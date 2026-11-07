# UI and HUD

## What you'll build

This guide shows how to put menus, a HUD and labels over your game. You will place widgets in layout regions that adapt to phones, tablets and desktops, open a pause panel that works with a mouse, keyboard, touch and gamepad, add the ready-made HUD widgets, pin labels to points in the world and restyle it all with theme tokens.

## The overlay

The UI is plain DOM laid over the canvas. `createGame` builds it as `ctx.ui`. You write HTML elements and the engine positions them; nothing draws on the canvas.

A few rules to know up front:

- The overlay is measured in CSS pixels, not design pixels.
- Empty space lets clicks through to the canvas. Only buttons, panels and other interactive elements take the pointer.
- While a modal panel is open, game input is blocked for you. Your scene's `input.pressed(...)` calls return false until it closes.

`h(tag, props, ...children)` builds elements. `button`, `toggle` and `slider` build the common controls. All of them come from `@thunderclap-engine/engine/ui`.

## Place a widget in a region

The screen is split into named regions: `top`, `bottom`, `left`, `right`, `cardLane`, `captionLane`, `modal` and `fill`. `fill` is where your world shows. `ui.layout.add(element, { place, order })` puts an element in a region.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { button, h } from '@thunderclap-engine/engine/ui';

export function createScoreHud(ctx: EngineCtx, onRestart: () => void) {
  const score = h('div', {
    id: 'hud-score',
    style: {
      fontFamily: 'var(--tc-font-display)',
      fontSize: 'var(--tc-font-size-l)',
      color: 'var(--tc-color-text)',
    },
  });
  const restart = button('Restart', onRestart, { variant: 'primary' });

  const { layout } = ctx.ui;
  const handles = [
    // Top bar everywhere, but the right column on a landscape phone.
    layout.add(score, { place: { default: 'top', 'phone-landscape': 'right' }, order: 0 }),
    layout.add(restart, { place: { default: 'bottom', 'phone-portrait': 'hidden' } }),
  ];
  let last = -1;
  return {
    setScore(n: number) {
      if (n === last) return; // write the DOM only on change
      last = n;
      score.textContent = `${n} points`;
    },
    remove() {
      for (const hnd of handles) hnd.remove();
    },
  };
}
```

- `place` names a region per form factor, with `default` for the rest. `'hidden'` hides the widget on that form factor.
- `order` sorts widgets inside a region.
- `top`, `bottom` and `captionLane` lay their widgets out in a row. `left`, `right` and `cardLane` stack them in a column.
- Regions with no widgets collapse, so the world gets the space back.
- The handle has `setPlace(place)` to move the widget later and `remove()` to take it out.

Only write `textContent` when the value changed. The HUD then costs nothing on frames where nothing happened.

## Form factors

The layout picks one of four form factors from the screen size and pointer type: `desktop`, `tablet`, `phone-landscape` and `phone-portrait`. A phone is a touch screen whose short side is at most 600 CSS px. Read the current one as `ctx.ui.layout.formFactor`.

On desktop and tablet the UI is sized in design pixels of the canvas, so it scales with the game. On phones it is sized in CSS pixels, so text stays readable and buttons stay at least 44 px tall.

`ctx.ui.layout.onChange(fn)` fires after every re-layout: a resize, a rotation, a widget added. Use it to refit your camera to `ctx.ui.layout.freeRect`, the part of the screen the HUD leaves for the world. The [2D game guide](2d-game.md) shows that with `camera.fitFreeRect`.

## Shape the regions with a LayoutSpec

The default grid has a top bar, side rails, a card lane, a caption lane and a bottom bar. To change it, pass a `LayoutSpec` to `createGame({ layout })`. You only list what you change; the rest keeps the defaults.

```ts
import type { LayoutSpec } from '@thunderclap-engine/engine/ui';

export const layoutSpec: LayoutSpec = {
  forms: {
    desktop: {
      columns: ['fill'],
      rows: [64, 'fill', 72],
      areas: ['top', 'fill', 'bottom'],
    },
    'phone-landscape': {
      // A side column for the counters; no bars eating the short height.
      columns: ['fill', { frac: 0.3, min: 150, max: 220 }],
      rows: ['fill', 'fill'],
      areas: ['fill right', 'fill bottom'],
      pad: 8,
    },
  },
  // Let the bottom bar grow to fit its tallest widget, up to 160 CSS px.
  bars: { bottom: { size: 'content', max: 160 } },
};
```

- A track (one entry of `columns` or `rows`) is CSS px, `'fill'`, or `{ frac, min, max }`: a fraction of the screen clamped between two sizes.
- `areas` works like CSS `grid-template-areas`. Each region must be one rectangle.
- `bars` makes `top`, `bottom`, `left` or `right` size to their content instead of a fixed track. Use it for a big orb meter on a phone.
- If no region fits, a widget can take `{ region: 'free', rect, reason }` as its placement. The layout logs the reason once, so these escapes stay visible.

`ctx.ui.layout.overflows()` lists widgets that are bigger than their region. The layout also warns about them in the console once.

## Panels: menus and the modal stack

`ui.stack.push({ title, content, onClose })` opens a panel. Panels are modal by default: they dim the game, trap Tab focus and block game input. Esc, the gamepad's B button or a click on the backdrop closes the top one.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { button, h, slider, toggle } from '@thunderclap-engine/engine/ui';

export function openPause(ctx: EngineCtx, onQuit: () => void) {
  let panel: { close(): void } | null = null;
  const music = slider('Music', 0.8, (v) => console.log('music', v), {
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  });
  const shake = toggle('Screen shake', true, (on) => console.log('shake', on));
  const content = h(
    'div',
    { style: { display: 'grid', gap: '8px', minWidth: '260px' } },
    button('Resume', () => panel?.close(), { variant: 'primary' }),
    music.element,
    shake.element,
    button('Quit to title', () => {
      panel?.close();
      onQuit();
    }),
  );
  panel = ctx.ui.stack.push({
    title: 'Paused',
    content,
    onClose: (why) => {
      panel = null;
      console.log('closed by', why); // 'escape' | 'backdrop' | 'programmatic' | 'replaced'
    },
  });
}
```

- **Keyboard.** Tab and the up and down arrows move focus through the panel; Enter and Space press the focused control. `arrowNav: 'both'` adds left and right.
- **Gamepad.** `createGame` runs `ctx.padNav` for you: the d-pad or stick moves focus, A presses, B closes. You write nothing.
- **Touch and mouse.** The controls are normal buttons and inputs.
- `dismissible: false` makes a panel that Esc and the backdrop cannot close.
- `modal: false` gives a side panel that stays open during play and blocks nothing.
- `slider` and `toggle` return `{ element, input, set }`. Put `element` in the panel and call `set` to update the value from code.

The platformer opens its pause panel from a transparent scene (`templates/platformer/src/scenes/pause.ts`). The scene pushes the panel in `enter`, and the panel's `onClose` pops the scene. That keeps the scene stack and the panel stack in step.

For a menu that is not a modal (a title screen in a region), `menuNav(ctx.input, rootElement)` runs one tick of up, down and confirm over its buttons. Call it from your scene's `update`.

## Toasts and captions

A toast is a short message in a corner. It goes into a live region, so screen readers read it.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export async function tellPlayer(ctx: EngineCtx) {
  ctx.ui.toasts.show('Saved', { tone: 'success', duration: 2000 }); // duration 0 stays up
  // A speech card with a typewriter reveal. The promise resolves when the line goes away.
  await ctx.ui.caption.say('Something old is listening.', { speaker: 'Narrator' });
}
```

Tones are `info`, `success`, `warn` and `danger`. Captions queue: each `say` waits for the one before. The first click skips the typing, the next one dismisses the line. With reduced motion turned on, lines appear at once.

## HUD widgets

The overlay has ready-made widgets for common HUD needs. Each one places itself in a region and has a `set` method that writes the DOM only when the value changes.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';

export function createActionHud(ctx: EngineCtx) {
  const { ui } = ctx;
  // A bar meter with a damage trail that drains after a hit.
  const health = ui.meter({ label: 'Health', max: 100, region: 'left', tone: 'danger', trail: true });
  // The same meter as a round orb, smaller on phones.
  const mana = ui.meter({
    label: 'Mana',
    max: 50,
    shape: 'orb',
    size: { phone: 56, default: 96 },
    region: 'right',
    tone: 'info',
  });
  const cooldown = ui.ring({ label: 'Dash', value: 1, region: 'bottom' }); // 0..1
  const hotbar = ui.slots({ count: 6, hints: ['1', '2', '3', '4', '5', '6'] }); // bottom
  const compass = ui.compass({
    width: 480,
    markers: [{ name: 'Camp', bearingDeg: 120 }],
  }); // top
  const reticle = ui.reticle({ style: 'cross', size: 28, gap: 8 }); // centre of the frame

  return {
    update(hp: number, mp: number, dashReady: number, headingDeg: number) {
      health.set(hp); // clamps to [0, max]
      mana.set(mp);
      cooldown.set(dashReady);
      compass.setHeading(headingDeg);
    },
    nextSlot: () => hotbar.select(hotbar.selected + 1), // wraps
    onHit: () => reticle.pulse(),
  };
}
```

- **Meter** (`ui.meter`): a bar or, with `shape: 'orb'`, a round well. `tone` is `accent`, `info`, `success`, `warn` or `danger`. `format(value, max)` adds a readout.
- **Ring** (`ui.ring`): a round progress ring with a label in the middle.
- **Slots** (`ui.slots`): a hotbar. `setContent(i, text | element)` fills a slot.
- **Compass** (`ui.compass`): a strip that scrolls with `setHeading(degrees)` and shows markers. `ui.heading` is a simpler strip without markers that takes radians (`setYaw`).
- **Reticle** (`ui.reticle`): a crosshair in the centre of the frame. It hides itself while a modal panel is open.
- **Minimap** (`ui.minimap`): a canvas map with a player arrow, markers and a pick callback. Give it the world's extent and a background you paint: `ui.minimap({ size: 200, world: { minX, minZ, maxX, maxZ }, background })`, then `setPlayer(x, z, yaw)` and `setMarkers([...])`.

Every widget has `remove()`. Call it when the scene exits.

## Pin DOM to the world

`ui.anchors()` makes DOM elements follow points in the world: a name over a character, a hint over a tile, an arrow at the screen edge pointing to a goal. Under `createGame` it projects through `ctx.camera`; pass a function that returns another camera to override it. The engine updates every anchor after each frame, so you only move the points.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { h } from '@thunderclap-engine/engine/ui';

export function labelNpc(ctx: EngineCtx, name: string) {
  const anchors = ctx.ui.anchors();
  const tag = h('div', { class: 'npc-tag' }, name);
  // align [0.5, 1]: the bottom centre of the label sits on the point.
  const handle = anchors.add(tag, [400, 300, 0], { align: [0.5, 1], offset: [0, -8] });
  const goal = anchors.add(h('div', {}, '>'), [3000, 600, 0], { clamp: true, margin: 24 });
  return {
    follow(x: number, y: number) {
      handle.set([x, y - 40, 0]); // world units; z is 0 in 2D
    },
    remove() {
      handle.remove();
      goal.remove();
    },
  };
}
```

- `clamp: true` keeps the element on screen when its point is off screen. It gets `data-anchor-clamped` while pinned to the edge, so you can restyle it as an arrow.
- `scale: 'distance'` shrinks labels with distance under a 3D camera.
- Points behind the camera are hidden unless clamped.

**Floating text.** `ui.floats()` (through `ctx.camera`; pass another camera getter to override) returns a pool of rising, fading labels for damage numbers and pickups. Call `floats.spawn('-12', [x, y, 0], { color: '#ff5a4a' })`, and `floats.update(dt)` once per update.

## World panels

In VR there is no screen to put DOM on, and sometimes the UI is a thing in the scene, like a terminal or a sign. `createWorldPanel` draws a small widget set onto a quad in the world, styled with the same theme, and any pointer ray can press it.

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import type { Frame } from '@thunderclap-engine/engine/render';
import { createWorldPanel, worldButton, worldLabel, worldToggle } from '@thunderclap-engine/engine/ui';

export function createSign(ctx: EngineCtx, onBack: () => void) {
  const panel = createWorldPanel(ctx.renderer, { width: 2, height: 1.2 }); // world units
  panel.transform.setPosition(0, 1.6, -3);
  panel.add(worldLabel({ text: 'Settings', size: 'l' }));
  panel.add(worldToggle({ text: 'Sound', value: true, onChange: (on) => console.log(on) }));
  panel.add(worldButton({ text: 'Back', onPress: onBack }));
  panel.attach(ctx.input); // once: rays, hover and press come from the input tick
  return {
    draw: (frame: Frame) => frame.drawable(panel.drawable, 10), // after the opaque meshes
    dispose: () => panel.dispose(),
  };
}
```

In VR the input's rays go through the headset, so a `billboard` or `headLocked` panel faces the player; `panel.attach(ctx.input, { camera })` names another camera to face. A pad without a ray drives it with `panel.focusNext()` and `panel.activate()`. Use the DOM overlay for everything on a flat screen; it is sharper and accessible. The [XR guide](xr.md) covers headsets.

## Theme tokens

Every colour, font, size and timing is a theme token, exposed as a CSS custom property. `colorAccent` becomes `--tc-color-accent`, `fontSizeL` becomes `--tc-font-size-l`, `space3` becomes `--tc-space-3`. Use them in your own styles with `var(...)`, as the HUD example above does. Change them at runtime with `ui.setTheme`:

```ts
import type { EngineCtx } from '@thunderclap-engine/engine';
import { applyTextScale, cssVar } from '@thunderclap-engine/engine/ui';

export function restyle(ctx: EngineCtx) {
  ctx.ui.setTheme({
    colorAccent: '#7fd8ff',
    colorAccentText: '#04121a',
    fontDisplay: "'Trebuchet MS', system-ui, sans-serif",
  });
  // In an inline style: cssVar('colorAccent') is 'var(--tc-color-accent)'.
  ctx.ui.root.style.borderColor = cssVar('colorAccent');
}

/** The player's text size setting, 1 = default. */
export function setTextScale(ctx: EngineCtx, scale: number) {
  applyTextScale(ctx.ui.root, scale, (tokens) => ctx.ui.setTheme(tokens));
}
```

To start with a theme or a text scale, pass them to `createGame`: `createGame({ ..., theme: { colorAccent: '#7fd8ff' }, textScale: 1.25 })`.

Fonts come from system stacks; nothing is fetched. To use your own font, self-host it and put it first in the stack.

`applyTextScale` scales the engine's font tokens and sets `--tc-text-scale`. Small text scales fully, display text less, and nothing drops below the form's minimum (`textMin` in the `LayoutSpec`). Offer it in your settings panel as a slider and store the value in your save.

To add your own stylesheet, pass `styles(doc)` to `createGame`. It runs before the engine's styles, so the cascade stays predictable.

## Next

- [ui reference](../../src/ui/README.md): every widget, the layout model, anchors, world panels, tooltips, the loading screen and the accessibility checklist
- [input reference](../../src/input/README.md): actions, gestures and the pointer router
- [2D game](2d-game.md): fitting the camera to the free rect
- [Input](input.md)
- [Characters](characters.md)
- [XR](xr.md)
- [Testing your game](testing-your-game.md)
