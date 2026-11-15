# engine/ui

The DOM overlay over the WebGPU canvas: panels with focus and pad navigation, toasts, captions, HUD and inventory widgets, world anchors and panels, layout regions per form factor and theme tokens. `createGame` gives you one as `ctx.ui`; what goes in it, its words and its look are the game's. No dependencies and no game nouns.

## Quick use

<!-- snippet:check -->
```ts
import { createOverlay } from '@thunderclap-engine/engine/ui';

declare const stageEl: HTMLElement;

const ui = createOverlay({ parent: stageEl, theme: { colorAccent: '#7fd' } });
const hp = ui.meter({ label: 'HP', max: 100 }); // a HUD bar in the bottom region
hp.set(72);
ui.toasts.show('Saved');
const panel = ui.stack.push({ title: 'Paused', content: document.createElement('div') });
panel.close();
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createOverlay(opts)` | the overlay root over the canvas |
| `ui.stack.push(opts)` | open a panel; modal by default, with focus trapping |
| `ui.toasts.show(message)` | a short notice |
| `ui.caption` | a speech or caption card |
| `ui.meter / ui.reticle / ui.slots` | HUD widgets |
| `ui.layout` | regions per form factor |
| `ui.anchors(camera?)` | DOM elements pinned to world points |
| `createWorldPanel(...)` | a panel drawn in the world (VR) |
| `ui.floats / ui.minimap` | floating text and a minimap |
| `applyTheme / defaultTheme` | theme tokens |

## Contents

- [Overview](#overview)
- [Overlay](#overlay)
- [Panels: `ui.stack`](#panels-uistack)
- [Toasts: `ui.toasts`](#toasts-uitoasts)
- [Caption card: `ui.caption`](#caption-card-uicaption)
- [Widgets and helpers](#widgets-and-helpers)
- [HUD widgets: `ui.reticle`, `ui.meter`, `ui.slots`, `ui.heading`](#hud-widgets-uireticle-uimeter-uislots-uiheading)
- [Inventory: `ui.grid`, `ui.card`, `ui.radial`, `ui.contextList`](#inventory-uigrid-uicard-uiradial-uicontextlist)
- [External links: `externalLink`](#external-links-externallink)
- [Theme](#theme)
- [Layout API: `ui.layout`](#layout-api-uilayout)
- [Anchors: `ui.anchors(camera)`](#anchors-uianchorscamera)
- [World panels: `createWorldPanel`](#world-panels-createworldpanel)
- [Text scale and units](#text-scale-and-units)
- [Theme functions](#theme-functions)
- [More widgets and helpers](#more-widgets-and-helpers)
- [Tooltip: `ui.tooltip`](#tooltip-uitooltip)
- [World cursor: `ui.cursor`](#world-cursor-uicursor)
- [Pad owner: `ui.padOwner`](#pad-owner-uipadowner)
- [Floating text: `ui.floats`](#floating-text-uifloats)
- [Ring and compass: `ui.ring`, `ui.compass`](#ring-and-compass-uiring-uicompass)
- [Minimap: `ui.minimap`](#minimap-uiminimap)
- [Loading screen: `ui.loading`](#loading-screen-uiloading)
- [Notifications: `ui.notify`](#notifications-uinotify)
- [Perf: `createPerfMonitor`, `createPerfOverlay`](#perf-createperfmonitor-createperfoverlay)
- [Accessibility checklist](#accessibility-checklist)
- [Tests](#tests)

## Overview

The DOM overlay that sits on top of the WebGPU canvas: panels, toasts, a speech/caption card, small
widgets and theme tokens. It has no dependencies and no game nouns.

## Overlay

```ts
import { createOverlay } from '@thunderclap-engine/engine/ui';

const ui = createOverlay({ parent: stageEl, theme: { colorAccent: '#7fd' } });
surface.onResize(({ rect }) => ui.setFrame(rect)); // letterboxed canvas rect, CSS px relative to parent
input.blocked = () => ui.stack.hasModal;       // the game ignores input while a modal is open
```

- One root over the whole parent, laid out in **CSS px** with no transform. The canvas rect is the
  **frame** (`setFrame`, exposed as `--tc-frame-x/y/w/h`), and `--tc-dpx` is one design px of it
  (1920×1080 by default) in CSS px; `ui.scale` is the same number.
- `ui.layout` is the overlay's layout (`ui/layout.ts`): regions per form factor over the whole root.
  Each form's units (`ui.units`, `data-units`) size the base UI: `frame` (desktop, tablet) in design
  px of the frame, `css` (phones) in CSS px (`cssPxTheme`).
- **Form factor in CSS** (#1). The root carries `data-form-factor` = `phone-landscape`,
  `phone-portrait`, `tablet` or `desktop` (`ui.layout`'s classification: a phone is a coarse
  pointer with a short side of at most 600 CSS px, or any view under 480), updated on every
  re-layout. It replaces the removed `ctx.device`: a phone stylesheet keys off
  `.tc-overlay[data-form-factor^="phone"] .my-hud { … }`, and code reads
  `ctx.ui.root.dataset.formFactor` (or `ui.layout.onChange`). `data-units` sits beside it.
- **Native controls on the frame's layers.** Selects and range sliders in `hud`, `captions` and
  (in `frame` units) `panels` and `toasts` are zoomed by `--tc-zoom`, and a select divides the
  theme tokens it reads (font size, padding, border, radius) back out. Those rules sit in
  `:where()` (#3), so they have no specificity: a game's ordinary `.my-panel select { … }` wins
  over them. The engine's own `select()` widget keeps its look (its fix is `(0,2,1)`).
- Widgets inside a region flow in a flex box: `top` and `bottom` are **rows** (widgets side by
  side, in `order`), `left` and `right` (and `cardLane`) are **columns**; `captionLane` is a row,
  `fill` and `modal` centre their content. A game that wants another arrangement wraps its widgets
  in one element and lays that out itself.
- A design-px game sheet goes through `toFrameUnits` (and `scaleFontSizes`): each `Npx` becomes
  `N * var(--tc-unit)`, one design px on the frame's layers and one CSS px in the regions.
- The root and its layers are `pointer-events: none`. Only interactive elements (buttons, panels,
  toasts, the caption card) take the pointer, so clicks on empty space still reach the canvas.
- Layers, bottom to top: `hud`, `captions` (both on the frame, clipped to it), `layout` (the whole
  root), `panels`, `toasts` (on the frame in `frame` units, the whole root in `css` units). A modal
  panel always covers the caption card, and the overlay also suspends the card (hidden, timers
  frozen) while a modal is open. World-anchored HUD elements go in `ui.layers.hud`, at their design
  coordinates times `--tc-unit`.
- `ui.clientToDesign(clientX, clientY)` maps viewport coordinates to design space, or returns null
  outside the overlay. Platform owns the canonical transform, so prefer that one.
- The `parent` must be a positioned element (`position: relative`, `fixed` or `absolute`).
- **Control ids** (ws/input-12). Every overlay button has a stable id, `controlId(el, root?)`: the
  game's own `ButtonOptions.id` (the `CONTROL_ID_ATTR`, `data-tc-id`, on any `<button>`) when set,
  else `page/key`. The page is the nearest `CONTROL_PAGE_ATTR` (`data-tc-page`) or the panel's
  accessible name (a `ui.stack` panel's title), omitted outside both; the key is the button's
  `aria-label` or text. A derived id shared by earlier buttons gets `#2`, `#3`, … in document
  order; a button with no id and no label has none (null). `ui.onControl((id, el) => …)` hears
  every button click in the overlay (mouse, keyboard, pad, `activate`) before its handlers, and
  `ui.activate(id)` clicks the enabled button with that id (false when there is none).
  `createGame` wires both to the input, so recordings carry page-button presses by id and a replay
  presses them on the same frame (the `ui` lane, [input](../input/README.md#recording-and-replay)).

## Panels: `ui.stack`

```ts
const p = ui.stack.push({ title: 'Settings', content: el, onClose: (why) => {} });
p.close();
```

- **Modal** (the default): dims the background, traps Tab inside the panel, and makes lower panels
  plus the `hud`, `captions` and `layout` layers `inert`. `hasModal` stays true while it is open.
- **Esc** closes the top panel if it is dismissible (the default). The handler calls
  `preventDefault` and `stopPropagation` from a `document` listener, so a key listener on `window`,
  which is where `Input.attach` listens, does not see that Escape. Clicking the backdrop also
  closes the panel when `closeOnBackdrop` (default: the panel's `dismissible`) is true.
- **Arrows.** ArrowUp/ArrowDown move focus through the top panel's focusable elements and wrap;
  `arrowNav: 'both'` adds ArrowLeft/ArrowRight, `'none'` turns it off (`ArrowNav`, default
  `'vertical'`). A focused text field keeps left/right, and a select, textarea, range or
  `role=slider` keeps both axes, so the arrows never steal from a control that uses them. A
  non-modal panel moves focus only while focus is inside it; a modal panel also from itself.
- On open, focus moves to `initialFocus`, otherwise to the first focusable element, otherwise to the
  panel itself. On close, focus goes back to whatever had it before.
- **Focus home.** `createOverlay({ focusHome: () => canvas })` names where focus goes when a
  panel closes and its opener can't take it back: the opener is gone or inert, or nothing was
  focused (`<body>`). Mark openers that double as keyboard shortcuts, or their container (a HUD
  bar), with `NO_RESTORE_FOCUS_ATTR` (`data-tc-no-restore-focus`). Those never get focus back,
  because a focused button would swallow the game's keys. Focus goes to the next panel down,
  else home. A bare `PanelStack` takes `{ home }` as its third argument.
- **Gamepad in panels.** Game input is usually blocked while a modal is up, so a pad can't reach
  a panel through the input map. `new PadNav(overlay.stack)` with `update()` once a frame fixes
  that: the d-pad or left stick moves focus through the top modal's controls, A clicks the
  focused one, B closes the panel (`stack.dismissTop()`, the same as Esc), and left/right step a
  focused range slider or select. It does nothing while no modal is open.
- Use `modal: false` for side panels such as a journal that stays open during play. They don't
  block input or trap focus.
- `chrome: 'none'` drops the card styling, for full-bleed custom panels. Pass `label` when there is
  no visible title.
- Other methods: `pop()`, `replace(opts)`, `clear()`, `onChange(fn)`, `top`, `size`.

## Toasts: `ui.toasts`

`ui.toasts.show('Saved', { tone: 'success', duration: 2000 })`. The container is a polite live
region. Clicking a toast dismisses it. `duration: 0` keeps a toast up until it is dismissed. The
oldest toast is dropped once more than `maxToasts` are showing.

## Caption card: `ui.caption`

A corner speech card with a typewriter reveal and a queue.

```ts
await ui.caption.say('Something old is listening.', {
  speaker: 'Narrator',
  portrait: glyphCanvas,     // optional Node shown left of the text (speaker name goes under it)
  onChar: () => audio.play('blip', { gain: 0.3 }),
  hold: 0,                   // 0 = wait for a click / advance(); default readingTimeMs(text)
});
```

- The full line goes into a polite live region (`role=status`) immediately. Screen readers read the
  sentence once and never hear the typewriter, and the card's portrait, speaker and text are `aria-hidden`.
- Unrevealed characters are rendered `visibility: hidden`, so the card has its final size from the
  first frame and never reflows while typing.
- The first click (or `advance()`) skips the reveal. The next one dismisses the line. `clear()`
  empties the queue. Every `say()` promise resolves when its line goes away, however that happens.
- With reduced motion (`prefers-reduced-motion`, or `caption: { reducedMotion: true }`), or with
  `cps: 0`, the line appears at once and `onChar` is not called.
- Defaults: 45 cps, with longer pauses after `.,;:!?`. The pure helpers `readingTimeMs(text)` and
  `revealDelayMs(prev, cps)` are exported.
- Corners: `bottom-right` (the default), `bottom-left`, `top-right`, `top-left`. Set one per card
  with `caption: { corner }` or per line with `say(…, { corner })`. For a second, independent card,
  create one: `new CaptionCard(ui.layers.captions, opts)`.
- Size: the card is as wide as its text needs, up to `--tc-caption-max-width` (default 720px; 480px for a card
  docked in `css` units), and sits `--tc-caption-margin` from the edges. It has no max height and
  long words wrap, so text is never clipped. Set both vars on `.tc-caption` to tune them per game.
- `onPlace(fn)` runs whenever the card is laid out in its corner (a new line, back from
  suspension, undocked), after its corner is reset and its inline `max-width` cleared. A game that
  must keep the card off parts of its scene moves or narrows it there (`overlapArea` and
  `cornerOrder` help); `relayout()` lays it out again when the scene moved. Returns unsubscribe.
- `suspend(on)` hides the card and freezes its typing and hold. `suspend(false)` resumes where it
  was with a fresh hold. `say()` still queues while suspended. The overlay calls it for modals.

## Widgets and helpers

- `button(label, onClick, { variant: 'default' | 'primary' | 'ghost', disabled, ariaLabel, id })`;
  `id` is the stable control id a recording stores (`data-tc-id`, ws/input-12; see *Overlay*).
- `slider(label, value, onInput, { min, max, step, format })` returns `{ element, input, set }`.
  `format` fills in `aria-valuetext`.
- `toggle(label, checked, onChange)` returns `{ element, input, set }`.
- The second set (`ui/widgets-2.ts`, ws/ui-widgets): plain elements with a small handle, classes
  `tc-ui-*`, styled by `WIDGETS2_CSS` (design px through `toFrameUnits`, theme tokens only), which
  `createOverlay` injects once as `#tc-ui-widgets-2` (`ensureWidgets2Styles(doc)` does it by hand).
  Every `set` writes the DOM only when the value changed. `ChoiceOption` is `{ value, label }`.
  - `reticle({ size, thickness, gap, dot, color })` returns `{ element, set(spread), hit(), hide(),
    show() }`: four CSS lines and a dot, `aria-hidden`, centred in its positioned parent (put it on
    the `hud` layer); `set(0..1)` opens the lines, `hit()` plays the flash (`data-hit`).
  - `bar(label, value, { min, max, segments, tone, format })` returns `{ element, set(value),
    tone(t) }`: `role=progressbar` with `aria-valuemin/max/now` and `aria-valuetext` (`format`,
    else a percent; with `format` the text also shows); `segments` draws pips; `tone` is
    `WidgetTone` (`accent | info | success | warn | danger`).
  - `segmented(label, options, value, onChange)` returns `{ element, set(value), value }`:
    `role=radiogroup` of `role=radio` buttons with a roving tabindex, ArrowLeft/ArrowRight to move
    (wrapping) and a click to pick; it consumes only those two keys. `set` never calls `onChange`.
  - `select(label, options, value, onChange)` returns `{ element, select, set }`: a native
    `<select>` in a `.tc-field.tc-ui-select` label.
  - `keyPrompt(action, { key, pad })` returns `{ element, set(key, pad?) }`: a key chip (`<kbd>`),
    a pad chip when a glyph string is given, and the action's text; strings in, no icon font.
  - `stepper(label, value, onChange, { min, max, step, format })` returns `{ element, set, value }`:
    `−` and `+` buttons around a focusable `role=spinbutton`; ArrowUp/ArrowDown step, Home/End jump
    (only those four keys are consumed); values snap to `step` and clamp; buttons disable at the
    bounds.
  - `cooldown({ size })` returns `{ element, set(fraction), ready }`: a `conic-gradient` sweep on
    `--tc-ui-sweep`, `data-ready` at 1, `aria-hidden`.
  `reticle` is a plain element; use `createReticle` from the HUD (or `ui.reticle`) for one that hides under modals.
- `h(tag, props, ...children)` is hyperscript. It handles `class`, `style` (an object including
  `--custom` properties, or a `cssText` string: `h('div', { style: 'color: red' })`), `dataset`
  and `on: { click }`. Any other prop becomes an attribute: `true` sets an empty attribute and
  `false`/null omits it.
- `focusableWithin(el)` lists the focusable descendants of an element, skipping `inert` and `hidden`
  subtrees.

## HUD widgets: `ui.reticle`, `ui.meter`, `ui.slots`, `ui.heading`

What a first- or third-person game puts over its world, in the theme and the overlay's units
(`ui/hud.ts`). Noun-free: a meter is a meter, a strip is a strip.

```ts
const reticle = ui.reticle({ style: 'cross', size: 28, gap: 8 }); // hud layer, frame centre
const stamina = ui.meter({ label: 'Stamina', max: 100, region: 'left', tone: 'warn' });
const strip = ui.slots({ count: 6, hints: ['1', '2', '3', '4', '5', '6'] }); // bottom region
const compass = ui.heading({ region: 'top', width: 480 });
stamina.set(42);              // clamps to [0, max]; set(v, max) changes the max
strip.select(strip.selected + 1); // wraps
strip.setContent(0, iconCanvas);
compass.setYaw(camera.yaw);   // radians, clockwise from N
reticle.pulse();              // a short flash on a hit
```

- **Lengths are theme px.** `themePx(n)` is `calc(n * var(--tc-space-1) / 4)`: `n` design px of
  the frame on the `hud` layer, `n` CSS px in a region in `frame` units and `n / 2` CSS px in
  `css` units, so the widgets shrink on phones with the rest of the theme. Colours, radii, fonts
  and timings are the `--tc-*` tokens; `HUD_CSS` is the stylesheet, injected once per document by
  the first widget (`ensureHudStyles(doc)`, `#tc-ui-hud`).
- **Reticle** (`ReticleOptions`: `style: ReticleStyle` = `dot | cross | circle`, `size` 24,
  `gap` 6 for the cross, `color`). `Reticle`: `el`, `visible`, `style`, `show()`, `hide()`,
  `pulse()` (adds `tc-reticle-pulse`, removed on `animationend` or after 400 ms), `setStyle()`,
  `remove()`. It sits at the centre of the frame in `layers.hud`, is `aria-hidden`, and gets
  `data-modal` (display none) while `ui.stack.hasModal`; the layer is `inert` then too.
- **Meter** (`MeterOptions`: `label`, `max` 1, `value` = max, `region` `bottom`, `order`, `tone:
  MeterTone` = `accent | info | success | warn | danger`, `width` 240, `format(value, max)` for a
  readout and `aria-valuetext`). `Meter`: `el` (`role="meter"`, `aria-valuemin/now/max`,
  `aria-label` = label), `value`, `max`, `set(value, max?)`, `setTone()`, `remove()`. The fill is
  `scaleX(--tc-meter-value)`. ws/ui-5 adds, on both shapes: `shape: MeterShape` (`'bar' | 'orb'`,
  see below), `trail: boolean | MeterTrailOptions` (a damage trail: a lighter band in
  `--tc-color-meter-trail` holds where the value was for `delay` ms, 400, then drains to it over
  `duration` ms, 600; off under `prefers-reduced-motion` or `reducedMotion: true`), `readout:
  MeterReadout` (`'value' | 'percent' | 'none'`), `color` (a CSS colour over the tone), `size`
  (the orb's diameter, theme px, 128; a `FormSize` since ws/ui-10, below), `reducedMotion` and `now` (the trail's clock, ms). `Meter`
  gains `shape`, `trail` (where the band is now, in `value` units, never under the value) and
  `setColor(color | null)`. A bar with none of these is unchanged.
- **Orb** (`ui.meter({ shape: 'orb' })`, `createOrbMeter(host, opts)`): a round well whose fill
  rises from the bottom with a bright meniscus on its surface and a gloss over it; the readout
  (default `'value'`) sits in the middle. The fill and the trail are full-height layers moved by
  `translateY((1 - v) × 100%)` on CSS transitions, so a `set` writes custom properties and costs
  nothing per frame; the trail's `linear` transition with the delay is the same curve `trail`
  reports. `data-empty` drops the meniscus at 0. `ORB_CSS` is injected once (`ensureOrbStyles`,
  `#tc-ui-orb`).
- **Sized meters** (ws/ui-10). An orb's `size` is a `FormSize`: a number, or `FormSizes`, one
  per form factor, `{ phone?, 'phone-landscape'?, 'phone-portrait'?, tablet?, desktop?, default }`
  (theme px; `phone` covers both phone forms, a form's own name wins). `ui.meter({ shape: 'orb',
  size: { phone: 56, default: 96 } })` is 56 on a phone and 96 elsewhere: the orb writes
  `--tc-orb-size` from `WidgetOptions.onForm` on every re-layout, before the layout measures, so
  a content bar or rail sizes to the new diameter in the same pass. `meter.setSize(size)` changes
  it live and re-lays out once when the current form's diameter changes (a bar ignores it).
  `meter.size` reads the `FormSize` back (an orb's, 128 when unset; `undefined` on a bar).
- **Placed meters** (ws/ui-11). `MeterOptions.place` is a region or a per-form-factor map as
  `layout.add` takes it (`{ phone: 'right', default: 'bottom' }`), overriding `region`; the
  layout moves the live meter when the form factor changes, in the same re-layout, so a game
  needs no `onChange` handler and no rebuild. `meter.setPlace(place)` (same shape) moves it
  later; `meter.region` reads where it sits. A move keeps the element, so value, tone, colour,
  focus and the trail band carry over: the layout's `onMove` re-arms the band's transition from
  where it stands with the time left on its hold and drain (moving a node cancels CSS
  transitions), and the next `set` restores the configured timings. The map is the primary
  form because placement is per form factor everywhere else (`layout.add`, `ui.minimap`) and
  the engine re-lays out on the form change itself; `setPlace` is the escape hatch.
- **Slots** (`SlotsOptions`: `count`, `region` `bottom`, `order`, `hints` per slot, `label`
  `Slots`, `selected` 0, `size` 72). `Slots`: `el` (`role="listbox"`), `count`, `selected`,
  `select(i)` (**wraps**: `select(count)` is 0, `select(-1)` the last, so a wheel cycles),
  `setContent(i, text | HTMLElement)`, `setHint(i, text)`, `remove()`. Each slot is a
  `role="option"` with `aria-selected`, a `.tc-slot-hint` badge and `data-selected` on the one
  highlighted. Not focusable: a game's input map drives it.
- **Heading** (`HeadingOptions`: `region` `top`, `order`, `width` 480, `span` 90 degrees across
  the width, `tickEvery` 15, `labels` `['N', 'E', 'S', 'W']`). `Heading`: `el` (`role="img"`,
  `aria-label` "Heading 90°"), `strip`, `yaw`, `offset`, `setYaw(radians)`, `remove()`. The strip
  holds two turns (−180° to 540°) so it never jumps at north; `setYaw` writes one `translate3d`
  when the offset changed. Pure: `wrapDegrees(deg)`, `headingOffset(yaw, width, span)`.
- The factories also stand alone: `createReticle(host: HudHost, opts)`, `createMeter`,
  `createSlots`, `createHeading`, where `HudHost` is `{ layers: { hud }, layout, stack }` (an
  `Overlay` fits). `harness/hud.html` shows all four over the mesh scene.

## Inventory: `ui.grid`, `ui.card`, `ui.radial`, `ui.contextList`

Item grids with drag and drop, item cards, a radial menu and a context list (`ui/inventory*.ts`,
ws/ui-inventory). Noun-free: a cell holds a `CellItem`, a tone is a colour.

```ts
const card = ui.card({ title: '', rows: [] });                       // hud layer, role=tooltip
const bag = ui.grid({ cols: 6, rows: 4, label: 'Bag', card, describe: (item) => ({ title: item.label ?? item.id, rows: [] }),
  onMove: (from, to, item) => save(item, to), onContext: (cell, item, anchor) =>
    ui.contextList([{ id: 'use', label: 'Use' }, { id: 'drop', label: 'Drop', danger: true }], { at: anchor, onPick: (id) => act(id, item) }) });
const gear = ui.grid({ cols: 2, rows: 3, label: 'Gear', card, describe, canDrop: (from, to, item) => item.tone === 'accent' });
panel.append(bag.element, gear.element);                            // ui.grid registers both with ui.drag
bag.set({ col: 0, row: 0 }, { id: 'potion', icon: potionCanvas, label: 'Potion', count: 3, tone: 'info' });
ui.drag.register(slotsTarget(ui.slots({ count: 4 }), (index, item) => bind(index, item)));
const wheel = ui.radial({ items: eight, onPick });                  // sector 0 east, clockwise
wheel.open(); wheel.aim(stick.x, stick.y); if (pad.a) wheel.pick(); // or arrows, Enter, Escape
pad.on('select', () => bag.act('select'));                          // pad: select, back, secondary, left/right/up/down
```

- **Grid** (`GridOptions`: `cols`, `rows`, `cellSize` 56, `gap` 4 (theme px), `label`,
  `canDrop(from, to, item)`, `onMove(from, to, item)`, `onActivate(cell, item)`, `onFocus(cell)`,
  `onContext(cell, item, anchor)`, `card` + `describe(item, cell)`, `hoverMs` 250, `labels:
  InventoryLabels` (`defaultInventoryLabels`: live-region phrases). `grid(opts)` → `Grid`:
  `element` (`role="grid"` of `gridcell`s, `aria-rowcount/colcount`), `cols`, `rows`,
  `set(cell, item | null)`, `get(cell)`, `find(item)`, `move(from, to)`, `items: GridEntry[]`,
  `focus(cell)`, `focused`, `held`, `act(action: PadAction)`, `clear()`, `remove()`. A `CellItem`
  is `{ id, icon, label?, count?, span?, tone?, locked? }` (`GridCell` is `{ col, row }`; `CellRef`
  adds `grid`); a span covers its cells (`data-covered`), a count shows in `.tc-cell-count`.
  Keyboard: a roving tabindex, arrows clamp (no wrap), Home/End, Enter or Space activates on
  release, a **held** Enter or Space picks up (`aria-grabbed="true"`), the next Enter drops,
  Escape puts it back; Shift+F10, the ContextMenu key, the secondary button and the pad's
  `secondary` call `onContext`. The structural rule (in bounds, the span's cells free) is checked
  before the game's `canDrop`; a refused target shows `data-reject`. `ui.grid` registers the
  grid with `ui.drag`; `grid()` alone needs `drag.register(grid)` for cross-grid moves.
- **Drag** (`createDragContext(host: InventoryHost, opts?: DragContextOptions)` → `DragContext`:
  `register(target)`, `unregister(target)`, `dragging: DragPick | null`, `cancel()`, `targets`,
  `destroy()`; `ui.drag` is the overlay's, made on first use). A mouse or pen drags after 4 CSS px
  (`moveThreshold`), a touch after a 160 ms hold (`longPressMs`; a pan before it scrolls). The
  ghost (a clone of the item) rides the `hud` layer with `pointer-events: none`; the spot under
  it gets `data-over`, plus `data-reject` when refused. A drop calls `onMove` on **both** grids
  (`release` on the source, `drop` on the target); a refused drop snaps the ghost back over
  `--tc-duration-fast` (at once under reduced motion). Pad and keyboard: a pick-up at a grid's
  left or right edge walks to the next target in reading order (`cross`). Any `DropTarget`
  (`element`, `spotAt`, `spots`, `canDrop`, `drop`, `hover`, optional `release`, `pickAt`,
  `carryIn`, `carryEnd`) can register; the context wires `link: DragLink` (`pointerStart`,
  `carryStart`, `cross`, `commit`, `cancelCarry`, `pointerActive`). A `DropSpot` is
  `{ el, col, row }`, a `DragPick` is `{ item, from, source }`. `slotsTarget(slots, onAssign,
  opts?: SlotsTargetOptions)` → `SlotsTarget` makes a `ui.slots` strip a target: a drop calls
  `onAssign(index, item, from)` and the item stays in its grid (an assignment); `canAssign` is
  the rule. Slots are not focusable, so the pad walk skips the strip.
- **Card** (`card(host, opts: CardOptions)` → `Card`; `CardOptions`: `title`, `subtitle`,
  `tone`, `rows: CardRow[]` (`label`, `value`, `tone`, `compare: up | down | same`, an arrow in
  CSS), `footer`, `width` 280). `Card`: `element` (`role="tooltip"` on the `hud` layer), `set`,
  `show(anchor, placement?: CardPlacement)` (an element gets `aria-describedby`), `hide`,
  `visible`, `placement: CardSide | null`, `remove`. A grid shows it on focus and on hover after
  `hoverMs`. Pure: `placeCard(anchorRect, size, frame, placement = 'auto', gap = 0)` → `{ x, y,
  placement }` tries right, left, below, above (a named side flips to its opposite) and clamps.
- **Radial** (`radial(host, opts: RadialOptions)` → `Radial`; `RadialOptions`: `items:
  RadialItem[]` (`id`, `icon`, `label`, `disabled`; 4–8, more are cut), `radius` 110, `deadzone`
  0.35, `onPick(id)`, `onCancel`, `label`). `Radial`: `element` (`role="menu"` of `menuitem`s,
  `data-active` on the highlight), `open(at?)` (client px; the frame centre by default),
  `close`, `aim(x, y)` (sector 0 east, clockwise; inside the dead zone none), `highlighted`,
  `pick()`, `visible`, `remove`. Arrows rotate, Enter picks, Escape cancels; `data-modal` hides
  it while `stack.hasModal`.
- **Context list** (`contextList(host, items: ContextItem[], opts: ContextListOptions)` →
  `ContextList`; items `{ id, label, hint?, disabled?, danger? }`; opts `at` (a client point or
  an element), `onPick`, `onCancel`, `label`). On the `toasts` layer (never inert), placed below
  the anchor (flipping above), `role="menu"`; the first item is focused, ArrowUp/Down wrap over
  the enabled items, Enter or Space picks, Escape and a press outside cancel; `close()`, `open`.
  The focus returns to the opener.
- `INVENTORY_CSS` is the stylesheet (tokens only, lengths in theme px), injected once by
  `createOverlay` or the first widget (`ensureInventoryStyles(doc)`, `#tc-ui-inventory`);
  `iconNode(icon, doc)` wraps a string icon in a span. The hosts take an `InventoryHost`
  (`{ layers: { hud, toasts? }, stack? }`; an `Overlay` fits). The `hud` layer is inert under a
  modal: for grids inside a modal panel, build the card, radial and drag context with a host
  whose `layers.hud` is `ui.layers.toasts`. `harness/inventory.html` shows the set.

## External links: `externalLink`

A real new-tab link plus a **Copy link** button, with "Copied" feedback and a fallback popover
(the URL in a selected read-only field) for when the browser blocks the copy or the new tab. Logic
lives in the host (`host/web-links.ts` on the web); the widget only builds DOM and wires it. Labels come from the
caller; the look comes from theme tokens (override `.tc-link`, `.tc-link-row`, `.tc-link-copy`,
`.tc-link-fallback`, `.tc-link-message`, `.tc-link-field`, `.tc-link-close`).

```ts
import { activateLink, externalLink } from '@thunderclap-engine/engine/ui';

const link = externalLink({
  url: SHOP_URL, // not https, or blank → returns null: render nothing
  content: 'Visit the shop',
  labels: {
    copy: 'Copy link',
    copied: 'Copied!',
    copiedAnnounce: 'Link copied.', // aria-live, polite
    copyAriaLabel: 'Copy link to the shop',
    copyBlocked: 'Your browser blocked copying. Copy the link:',
    popupBlocked: 'Your browser blocked the new tab. Copy the link:',
    close: 'Close',
  },
  linkClass: 'my-link', // on the <a>
  className: 'my-links', // on the wrapper
  action: 'shop', // data-action: shop, shop-copy, shop-fallback, shop-close
  place: 'below', // fallback popover above or below the row
  align: 'center', // start | center | end
});
if (link) menu.append(link.element);

// A gamepad press is not a user gesture: route it through activateLink. On a widget anchor it
// uses window.open and shows the fallback if that was blocked; anything else is clicked.
activateLink(focusedElement, 'gamepad');
```

- Mouse and Enter use the `<a>` natively (`target=_blank`, `rel="noopener noreferrer"`).
- Copy order: `navigator.clipboard.writeText` (skipped when the frame's permissions policy forbids
  `clipboard-write`), then a hidden textarea + `execCommand('copy')`, then the fallback field.
  Never silent.
- Escape or Close hides the fallback and returns focus to Copy link. `PadNav` already routes A
  through `activateLink`.
- Nothing opens or copies until the player acts. No network calls.

Opening and copying go through the host (`@thunderclap-engine/engine/host`): pass `host` to
`externalLink`, or it uses `defaultHost()`. Usable without the widget:

- `host.openExternal(url, { activation })`: `'opened' | 'blocked' | 'invalid'`. On the web,
  `pointer` and `keyboard` click a temporary `<a>`; `gamepad` and `script` call `window.open` and
  report `null` as `blocked` (the opened tab's `opener` is cleared).
- `host.copyText(text)`: `Promise<'copied' | 'manual'>`; `host.clipboardWriteAllowed()`.
- `safeExternalUrl(url)` and `embedContext(win?)` stay in `@thunderclap-engine/engine/platform`.

## Theme

`defaultTheme` holds the tokens, which become CSS custom properties: `colorAccent` turns into
`--tc-color-accent` and `space3` into `--tc-space-3`. Use them in game CSS as
`var(--tc-color-accent)`, or in inline styles via `cssVar('colorAccent')`. `ui.setTheme({...})`
changes tokens at runtime. A game can add tokens of its own, and they map to properties the same
way. `themeToCss(tokens)` produces declarations for a stylesheet.

Fonts come from system stacks: the serif body uses Iowan / Palatino / Georgia, and `fontUi` is
`system-ui`. Nothing is fetched at runtime. To use a custom font, self-host an OFL font with its
licence and put it first in the stack.

The base stylesheet (`BASE_CSS`) is injected once per document; its rules match only the overlay's own
`.tc-*` classes (most under `.tc-overlay`, the layer and region classes at top level). Under `prefers-reduced-motion: reduce` it turns off all animations and transitions
inside the overlay.

## Layout API: `ui.layout`

`createOverlay` builds the one layout from `OverlayOptions.layout` (a `LayoutSpec`: `forms`,
`classify`, `safeArea`, `collapseEmpty`, `bars`); a game reads it as `ui.layout` (`Layout`). What follows
lists the exported names; ARCHITECTURE.md *Layout* describes the model.

- **Form factors.** `FormFactor` is one of `FORM_FACTORS` (`phone-landscape`, `phone-portrait`,
  `tablet`, `desktop`). `classifyFormFactor(i: ClassifyInput)` picks one from `{ width, height,
  coarsePointer, shortSide }`: a phone is a coarse pointer with a short side of at most
  `PHONE_MAX_SHORT_SIDE` (600) or any view under `PHONE_MAX_VIEW_SHORT` (480).
- **Forms.** `FormSpec` is `{ columns, rows, areas, tapMin, textMin, pad, modalMargin, units }`;
  a `Track` is CSS px, `'fill'` or `{ frac, min?, max? }`; `Units` is `'frame' | 'css'`; the
  optional `bars` sizes the bars (below).
  `defaultForms` holds the engine's forms; `formSpec(ff, spec?)` merges a spec's overrides over
  them.
- **Regions and widgets.** `RegionName` is one of `REGIONS` (`top`, `left`, `right`, `bottom`,
  `cardLane`, `captionLane`, `modal`, `fill`). `layout.add(el, opts: WidgetOptions)` (`place`
  per form factor plus `default`, `order`, `id`) returns a `WidgetHandle` (`element`, `region`,
  `setPlace`, `remove`). `WidgetOptions.onForm(ff)` (ws/ui-10) runs on every re-layout before the
  layout measures, for a widget sized per form factor. `WidgetOptions.onMove(region)`
  (ws/ui-11) runs after a re-layout that moved the element (another region, another position in
  its order, free, or into or out of hidden), after the measure and before `onChange`. A
  re-layout leaves every widget that is already in place where it is (no DOM move), so a
  resize, `refresh`, `add` or `setSize` keeps running CSS transitions and focus. `FormSize` is a number or `FormSizes`
  (`{ default } & Partial<Record<FormFactor | 'phone', number>>`); the pure `formSize(size, ff)`
  resolves one (the form's own entry, then `phone` on either phone form, then `default`). A `Placement` is a region, `'hidden'` or a `FreePlacement` (`{ region:
  'free', rect, reason }`); `placementFor(place, ff)` resolves one.
- **Content bars** (ws/ui-8). `bars` (on `LayoutSpec` for every form factor, or on a
  `FormSpec`, which wins bar by bar) maps a `BarName` (`top`, `bottom`) to a `BarSize`
  `{ size: 'fixed' | 'content', max? }`. `fixed`, the default, keeps the form's row track.
  `content` grows the bar's outer row track to its tallest widget plus the form's `pad` each
  side, never below the form's track and never above `max` (CSS px, default no limit), and the
  grid re-flows: `fill` (and so `freeRect`) gives up the space. The layout reads the bar
  widgets' heights once per re-layout, after placing them, and lays the grid out again only if
  a track moved. A widget taller than `max` allows is clamped and reported by `overflows()`.
  `{ bars: { bottom: { size: 'content', max: 160 } } }` holds a 128 px orb meter on a phone.
- **Content rails** (ws/ui-9). `BarName` also names the side rails, `left` and `right`, so
  `{ bars: { left: { size: 'content', max: 160 } } }` grows the rail's outer column track to its
  widest widget plus `pad` each side, between the form's track and `max`, with the same re-flow
  (`fill` and `freeRect` get narrower) and the same `overflows()` report past `max`. Since
  ws/ui-10 a rail widget's width is its `max-content` width: for the one measure per re-layout
  the rail is laid out `width: max-content` with `align-items: flex-start` (its own inline values
  come back after), so a stretch-width widget contributes what it wants rather than the rail's
  current width, and a rail widens when a label grows and narrows when it shrinks, at the next
  re-layout (`refresh`). Fixed rails stay the default. `{ bars: { left: …, right: … } }` holds an orb at each side of a phone.
- **Corner rule** (ws/ui-9). Where a content bar and a content rail meet (the cell on the bar's
  outer row and the rail's outer column, held by either in `areas`: `phone-landscape`'s rails
  hold their corners, the wide forms' bars hold theirs), the cell goes to the one whose content
  wants the larger track (widget plus `pad`, clamped by `max`): a 136 px top bar beside a 104 px
  left rail runs the full width and the rail starts under it. A tie keeps the form's `areas`, as
  does a swap that would leave a region not a rectangle (`phone-portrait`'s bottom-left cell
  stays the bottom bar's: the left rail does not reach it). The DOM grid draws the same areas.
- **Overflow** (ws/ui-7, E-040). After each re-layout (`add`, `setPlace`, a resize, `refresh`;
  never per frame) the layout measures every widget placed in a region against the region's
  content box: its rect less the region element's computed padding and border (#10), so a game
  that restyles `.tc-region` padding gets neither false reports nor misses. The check judges the
  finished layout, not each step (#9): it runs once in a microtask after the current run of
  `add` calls, so a widget added before its column's siblings is measured with them in place.
  Code that builds across several tasks wraps the build in `layout.batch(() => { … })`, which
  holds re-layout until it returns (nested batches lay out at the outermost; inside, `state` and
  a new handle's `region` still show the layout before it). `layout.overflows()` lists the
  current ones as `LayoutOverflow { id, region, w, h, rw, rh }` (CSS px); read before the
  microtask, it measures then. Each overflow warns once through `console.warn` (`[layout] <id>
  overflows its "<region>" region in <form factor>: WxH px in RWxRH px`): again only after it
  fitted, moved region or form factor, or `setPlace`. The warning is for development (#8):
  `LayoutSpec.warnOverflows` defaults to `import.meta.env?.DEV === true`, on under Vite's dev
  server and Vitest. A Vite production build replaces the condition with `false`, so the warning
  is off and the minifier drops the call; a bundler without `import.meta.env` is silent too, and
  `warnOverflows: true` or `false` (`createOverlay({ layout: { warnOverflows } })`) overrides
  either way. `overflows()` is callable and accurate in every build, so a game's e2e asserts
  layout health against a production preview (`vite build && vite preview`) by reading it, not
  the console: publish the ids on a test hook after each re-layout (`layout.onChange(() => {
  hook.overflows = layout.overflows().map((o) => o.id) })`, as `demos/arpg` does on `__demo`)
  and poll them to `[]` in the spec. Hidden and `free` widgets are not measured; content that
  grows later is caught at the next re-layout.
- **State.** `LayoutState` is the pure result for one size (`formFactor`, `units`, `width`,
  `height`, `safeArea`, `columns`, `rows`, `regions`, `freeRect`). `Layout` adds `element`,
  `freeUses`, `overflows()`, `batch(fn)`, `region(name)`, `dockCaption`, `setSafeArea`, `setForms`, `refresh`, `onChange` and
  `destroy`. `LayoutHost` is what the layout needs from its overlay.
- **Pure helpers** (tested in Node): `parseAreas(areas)`, `resolveTracks(tracks, length,
  collapsed?)`, `resolveLayout(ff, form, width, height, safeArea?, occupied?)`,
  `effectiveInsets(rect, viewport, insets)`; `Insets` is `{ top, right, bottom, left }`,
  `NO_INSETS` is all zero, and `readSafeArea(doc?)` reads `env(safe-area-inset-*)` (or the
  `--tc-safe-*` overrides).
- **Host safe area** (ws/host-mobile). `followSafeArea(layout, source: SafeAreaSource)` sets
  `layout.setSafeArea(source.insets())` now and on every `source.watch` report, so the regions
  keep clear of a notch and a home indicator; it returns an unsubscribe that also clears the
  override. A `SafeAreaSource` is `{ insets(): Insets; watch(fn): () => void }`, which a
  `Host.safeArea` satisfies; `createGame` calls it with `host.safeArea` when the host has one.
  The layout keeps only the part of each inset the overlay reaches into (`effectiveInsets`), so a
  letterboxed canvas is not padded twice.

## Anchors: `ui.anchors(camera)`

DOM that follows a world point: a name over a character, a damage number, a hint on a tile, a
marker that stays on screen for something off it.

```ts
const anchors = ctx.ui.anchors(); // built on the first call, on the hud layer, through ctx.camera
const tag = anchors.add(nameEl, [x, y + 2, z], { align: [0.5, 1], scale: 'distance' });
const goal = anchors.add(arrowEl, goalPos, { clamp: true, margin: 24 });
tag.set(npc.position); // each tick it moves; createGame calls update() after every frame
```

- `Anchors` (`new Anchors(opts: AnchorsOptions)`): `root` (the default layer, laid over the frame),
  `surface` (an `AnchorSurface`: `rect` in CSS px relative to the overlay's parent plus
  `logicalWidth` / `logicalHeight`; `Surface` fits), `camera: () => AnchorCamera` (anything with
  `viewProjection` and `screen`; `Camera` fits), optional `layers` by name and `onFrame(layer)`
  (false for a layer laid over the parent, so the frame's offset is added). Methods: `add(el,
  world, opts?)`, `update()`, `setCamera(fn)`, `clear()`, `size`.
- `update()` projects each point through `camera.viewProjection` (one reused `Float32Array(4)`),
  maps clip space onto `camera.screen` (logical px, or a fraction of the canvas when it lies inside
  the unit square: the renderer's viewport rule, so a split-screen camera works), and that onto the
  canvas rect in CSS px (`logicalToClient`). It writes `transform` only (the element is absolutely
  placed at the layer's top-left), and only when the point moved; with CSS Typed OM (Chromium,
  WebKit) it reuses one `CSSTransformValue` per element and allocates nothing, elsewhere a moved
  element gets one transform string.
- `AnchorOptions`: `offset` (CSS px), `align` (fraction of the element's box put on the point,
  default centred), `clamp` (keep inside the camera's viewport `margin` CSS px from the edges,
  default 16; a point behind the camera is pinned toward its side, never mirrored; while pinned
  the element has `data-anchor-clamped`), `scale` (`'none'` or `'distance'`: `distance / w`,
  `w` being the view depth, between `min` and `max`, defaults 10, 0.25 and 2), `hideBehind`
  (default true: a point behind the camera or outside clip space sets `hidden`; clamped anchors
  are never hidden), `layer` (an overlay layer name: `hud` by default, or `captions`, `layout`,
  `panels`, `toasts`).
- `AnchorHandle`: `el`, `visible`, `clamped`, `x`, `y` (the placed point in the layer, CSS px),
  `scale`, `set(world)`, `remove()`. `AnchorRect` is the rect shape both `screen` and `rect` use.
- `overlay.anchors(camera?)` returns the overlay's one `Anchors`, built on the first call (with
  `camera`, else `OverlayOptions.camera`, which `createGame` sets to the game's camera; it throws
  when neither is given, ws/api-core); a later call with one switches it. `overlay.updateAnchors()` updates it if it
  was built; `createGame` calls it after `hooks.afterRender` on every frame, so a game never
  calls `update()` itself. Outside `createGame`, call `ui.updateAnchors()` after rendering.
- `hidden` loses to a stylesheet that sets `display` on the element; add `[hidden] { display:
  none }` for such a class. One camera per `Anchors`: a stereo UI is not this step.

### Anchors frame

`anchors.frame` (an `AnchorFrame`: `width`, `height`, the logical size the camera's `screen` is
in, and `rect`, the CSS rect it fills relative to the overlay's parent) is the one place a
world-anchored widget learns where it projects into. It is read live from the surface (one reused
object), so a resize is seen by the next `place`. `anchors.project(x, y, z, out)` projects one
world point into frame CSS px (the hud layer's coordinates) the way `update()` places an anchor
before its offset and clamp, writes `out.x`/`out.y` and returns whether the point is in view; it
allocates nothing. The tooltip's world-point targets, the world cursor, the floating text and
`update()` itself all go through it, so they agree to the pixel.

## World panels: `createWorldPanel`

A panel that lives in the world rather than on the screen (ws/ui-world-panel, `src/ui/world-panel/`): one blended quad whose face is a canvas the engine paints with the same theme tokens as the overlay, holding a small widget set, hit by any pointer ray. Use the overlay for a screen (menus, HUD, anything that must be crisp DOM); use a world panel where there is no screen (a headset) or where the UI *is* a thing in the scene (a terminal, a sign, a wrist menu). No DOM is involved: it works without `document` (a Worker's `OffscreenCanvas` is out of scope for now: the panel makes its canvas with `makePanelCanvas`, `OffscreenCanvas` then `<canvas>`, and only the main thread uploads it).

```ts
const panel = createWorldPanel(ctx.renderer, { width: 2, height: 1.2 });   // world units, 256 px/unit
panel.transform.setPosition(0, 1.6, -3);                                    // a wall sign facing +z
panel.add(worldLabel({ text: 'Settings', size: 'l' }));
const sound = panel.add(worldToggle({ text: 'Sound', value: true, onChange: (v) => audio.mute(!v) }));
panel.add(worldSlider({ min: 0, max: 100, value: 80, step: 5, onChange: (v) => audio.volume(v / 100) }));
panel.add(worldButton({ text: 'Back', onPress: () => stack.pop() }));
panel.attach(ctx.input);                                                    // once: rays, hover, press, release
scene.render = (frame) => frame.drawable(panel.drawable, 10);               // after the opaque meshes
sound.set({ value: false });                                                // writes only on change
panel.focusNext(); panel.activate();                                        // a pad with no ray
panel.dispose();
```

- `createWorldPanel(renderer, opts)`: `WorldPanelOptions` `width`/`height` in world units, `resolution` px per unit (256), `theme` (partial `ThemeTokens` over `cssPxTheme`, so 16 px text on a 256 px/unit panel reads at arm's length), `background` `'panel'` (rounded surface and border) or `'transparent'`, `billboard` (turns to the camera each `update`), `headLocked: { distance, offset?: [x, y] }` (sits `distance` in front of the eye, offset along the view's right and up, each `update(camera)`), `depthTest` (default on; off for head-locked), `canvas` (inject a `PanelCanvas` in tests), `label`.
- `WorldPanel`: `transform` (a `Transform` the game places; head-locked and billboard panels rewrite it in `update(camera)`), `drawable` (a `Drawable`: push it with `frame.drawable(panel.drawable, order)` after the opaque pass; one quad, premultiplied alpha, depth-tested without writing depth; its pipeline is keyed on the pass's `frame.auxKey` through `renderer.sceneTargets(blend, aux)`, so one panel draws into a target with aux attachments such as velocity and into a plain target in the same frame, ws/core-8), `add(widget)`/`remove(widget)`, `widgets`, `hitTest(ray)` (`WorldPanelHit { x, y, widget, distance }` in panel px, reused), `pointerDown/Move/Up(x, y, id)`, `pointerLeave(id)`, `wheel(x, y, dy)`, `poll(pointers)`, `focus(widget)`, `focused`, `focusNext()`/`focusPrev()` (wrapping, skipping labels, progress and disabled widgets), `activate()`, `key(event)` (`PanelKeyEvent { key, shiftKey? }`: Tab, Shift+Tab, Enter, Space, then the focused widget's arrows), `hovered`, `pressing`, `dirty`, `repaint()`, `update(camera)`, `stats` (`WorldPanelStats { repaints, uploads, bytes }`), `fontLoaded` (resolves on `document.fonts.ready` and remeasures; already resolved without `document`), `theme` (`PanelTheme`), `painter`, `texture`, `dispose()`.
- **Widgets** (`WorldWidget` subclasses, built by `worldLabel`, `worldButton`, `worldToggle`, `worldSlider`, `worldList`, `worldProgress`): `WorldLabel` (`WorldLabelOptions` `text`, `size` `WorldWidgetSize` `'s' | 'm' | 'l'`, `align` `WorldWidgetAlign`, `tone` `WorldWidgetTone`), `WorldButton` (`WorldButtonOptions` `text`, `onPress`, `disabled`; fires on the release over it, not the press), `WorldToggle` (`WorldToggleOptions` `text`, `value`, `onChange`), `WorldSlider` (`WorldSliderOptions` `min`, `max`, `value`, `step`, `onChange`; drag anywhere on the track, arrows step), `WorldList` (`WorldListOptions` `items`, `selected`, `onSelect`, `visibleRows`; scrolls by drag and wheel, clamped, arrows move the selection and keep it visible), `WorldProgress` (`WorldProgressOptions` `value` 0..1, `tone`). Every option set takes `rect?: PanelRect` to place the widget by hand; otherwise `flowLayout` stacks them top to bottom with the theme's `space3` padding and `space2` gap (`FlowItem`, `FlowOptions`). `widget.set(patch)` writes only the fields that changed and marks the widget's rect dirty (a layout field relayouts); `options`, `layoutRect`, `hover`, `pressed`, `focused`, `disabled`, `focusable`. Hover tints, a pressed shade, a `colorFocus` ring and 45 % alpha when disabled; `WorldWidgetHost` is what a widget sees of its panel.
- **Painting**: Canvas2D through `Painter` (`fillRoundRect`, `strokeRoundRect`, `focusRing`, `text` with a per-font measure cache, `clearMeasures`) over a `PanelContext2D` (the subset a `CanvasRenderingContext2D` satisfies) from a `PanelCanvas`; `resolvePanelTheme(overrides)` reads the tokens once by value. Repaints cover the union of the dirty rects only; the frame's `prepare` then uploads that rect with one `copyExternalImageToTexture` (premultiplied), so `uploads` stays flat while nothing changes. `WORLD_PANEL_WGSL` (internal since 1.0.0: the panel builds its pipeline from it) is the quad's shader (six corners from `vertex_index`, `camera.view_proj`, the texture sampled with the linear-clamp sampler).
- **Pointers**: `worldPanelTarget(panel)` is a router `HitTester` whose hit carries the panel as `target`, the world point, a normal facing the ray and the distance, so `router.hit`, `{ pointer: 'select' }` bindings and the nearest-hit rule work as for meshes. `panel.poll(router.pointers)` once per tick (after `input.update()`, so in `hooks.beforeRender` or `hooks.update`) turns the routed pointers into hover, press and release: a press that leaves the quad keeps dragging on the panel's plane and releases where the ray meets it, a vanished pointer releases where it was. Without a ray, `focusNext`/`focusPrev`/`activate` and `key` drive it from a pad or keyboard.

### World panels on the input tick

Call `attach(ctx.input)` once. `panel.attach(input, opts?)` (a `WorldPanelInput`: `pointers`
and `onUpdated(fn)`, which
`Input` fits) adds the panel's tester to the input's pointer router and,
through `input.onUpdated`, calls `poll(router.pointers)` after every `input.update()` and then
`update(router.camera)` (the camera the rays go through: `ctx.camera` in `createGame`, the head
camera while `ctx.xr` is active; `opts.camera`, a getter, names another, ws/api-core), so
the page never calls `poll` or `update`. A head-locked or billboard panel is placed again from
that camera in `prepare`, as the frame draws, so in VR it follows the head as posed for the frame
(also on a frame with no input tick, ws/xr-fixes). It throws when the input has no router. `detach()`
undoes it (so does `dispose()`); the manual `addTester(worldPanelTarget(panel))` +
`poll`/`update` path stays for an input without a router.

- Harness `harness/world-panel.html` (`?pad` adds a pad cursor; the panels use `attach`); spec `e2e/world-panel.spec.ts`; tests `src/ui/world-panel/panel.test.ts` with a Canvas2D stub and the fake GPU.

## Text scale and units

- `applyTextScale(root, scale, setTheme?)` sets `--tc-text-scale` (`TEXT_SCALE_VAR`) and
  `data-text-scale`, and hands `setTheme` the engine's font tokens at that scale
  (`textScaleTokens(scale, base?)`, from `DESIGN_FONT_PX` or, in `css` units, `CSS_FONT_PX`).
- `scaleFontSizes(css)` rewrites every `font-size: Npx` to `scalePxCss(N)`, a length that follows
  the scale and floors at `--tc-text-min` (`TEXT_MIN_VAR`); `scaledPx(px, scale)` is the number
  it computes (small text scales fully, display text only as far as body text).
- `toFrameUnits(css)` rewrites every `Npx` to `calc(N * var(--tc-unit, 1px))` (`UNIT_VAR`).

## Theme functions

`ThemeTokens` is the shape of `defaultTheme`; `cssPxTheme` is its size tokens for `css` units;
`ThemeOverrides` adds a game's own tokens. `tokenVar(name)` gives the custom property
(`colorAccent` → `--tc-color-accent`), `cssVar(name)` its `var(...)`, `themeToCss(tokens)` the
declarations, and `applyTheme(el, tokens)` sets them on an element. `ensureStyles(doc?)` injects
`BASE_CSS` once; `prefersReducedMotionIn(win?)` reads the media query (ws/api-core).

The stylesheet constants (`BASE_CSS`, `HUD_CSS`, `TOOLTIP_CSS`, `CURSOR_CSS`, `NOTIFY_CSS`,
`ORB_CSS`, `INVENTORY_CSS`, `FLOATS_CSS`, `CANVAS_MINIMAP_CSS`, `LOADING_CSS`, `WIDGETS2_CSS`,
`WIDGETS3_CSS`) are internal since 1.0.0: their `ensure*Styles` inject them.

## More widgets and helpers

- **Overlay types.** `createOverlay(opts: OverlayOptions)` (`parent`, `designWidth`,
  `designHeight`, `logicalSize`, `layout`, `theme`, `caption`, `maxToasts`, `focusHome`) returns an `Overlay`;
  `logicalSize` (ws/kit-fit) is read live by the anchors when the logical size can leave the
  design size (a `fit: 'fill'` surface; pass the surface);
  `Rect` is `{ x, y, width, height }` in CSS px.
- **Panels.** `PanelOptions` (`content`, `title`, `label`, `modal`, `dismissible`,
  `closeOnBackdrop`, `chrome`, `className`, `initialFocus`, `role`, `onClose`) and
  `PanelHandle` (`element`, `open`, `close(reason?)`); `CloseReason` is `'escape' | 'backdrop' |
  'programmatic' | 'replaced'`. `PanelStackFocusOptions` is `{ home }`. `PadNav(stack, opts?:
  PadNavOptions)` takes `{ getGamepads?, axisThreshold? }`; `PadLike` is the slice of `Gamepad`
  it reads.
- **Toasts.** `Toaster` is `ui.toasts`; `show(text, opts?: ToastOptions)` (`duration`, `tone:
  ToastTone` = `info | success | warn | danger`) returns a `ToastHandle` (`element`, `dismiss()`).
- **Captions.** `CaptionCard(parent, opts?: CaptionOptions)` (`corner`, `reducedMotion`, `cps`,
  `clickToAdvance`); `say(text, opts?: SayOptions)`; `Corner`; `readingTimeMs(text, opts?:
  ReadingTimeOptions)` (`baseMs`, `perCharMs`, `minMs`, `maxMs`); `overlapArea(box, regions)` and
  `cornerOrder(preferred)` for `onPlace` handlers.
- **Widget options.** `ButtonOptions` (`variant`, `disabled`, `ariaLabel`, `className`) and
  `SliderOptions` (`min`, `max`, `step`, `format`); for the second set, `WidgetReticleOptions`,
  `BarOptions`, `KeyPromptOptions`, `StepperOptions`, `WidgetCooldownOptions` and the handles `WidgetReticle`,
  `Bar`, `Segmented`, `Select`, `KeyPrompt`, `Stepper`, `WidgetCooldown` (ws/api-core). `h`'s children are `Child` (`Node`, string,
  number or nothing); `append(el, ...children)` adds them to an existing element.
- **ws/ui-5 types.** `MeterShape`, `MeterReadout`, `MeterTrailOptions` (the meter, above);
  `Floats`, `FloatsHost`, `FloatsOptions`, `FloatTextOptions` (floating text); `CanvasMinimap`,
  `CanvasMinimapHost`, `CanvasMinimapOptions`, `MinimapWorld`, `MinimapRotate`, `MinimapShape`,
  `MinimapMarker`, `MinimapMarkerShape`, `MinimapKindStyle`, `MinimapBackground` and (ws/ui-6)
  `MinimapMarkerPlace` (the minimap). ws/ui-7: `LayoutOverflow` (`layout.overflows()`).
  ws/ui-8: `BarName`, `BarSize` (`LayoutSpec.bars`, `FormSpec.bars`); ws/ui-9 widens `BarName`
  to `'top' | 'bottom' | 'left' | 'right'`.
- **External links.** `externalLink(opts: ExternalLinkOptions)` returns an `ExternalLink`
  (`element`, `anchor`, `copyButton`, …) or null; `ExternalLinkLabels` are the strings shown
  above.
- **Menus.** `menuNav(input: MenuNavInput<A>, root, actions?: MenuNavActions<A>): MenuNavResult`
  is one tick of up/down/confirm over a non-modal menu's focusable controls (`'moved' |
  'clicked' | null`); confirm is taken only from a gamepad, since a focused control handles Enter
  and Space itself.
- **Loupe.** `new Loupe(source, opts?: LoupeOptions)` (`size` 120, `zoom` 2.5, `parent`,
  `className`) magnifies a patch of the `source` canvas; `show(view: LoupeView)` takes the
  `focus` point, where to draw it (`at`), an optional `ring` and `leader`; `loupeLeader(at, size, spot)` is the
  leader's segment, or null. The input module's `magnify` option drives it for touch.
- **Rotate card (interim).** `createRotateCard(opts: RotateCardOptions)` (`title`, `lines`,
  `note`, `ariaLabel`, `device`, `colors: RotateCardColors`, `doc`) returns a `RotateCard`
  (`element`, `visible`, `update()`, `destroy()`): the "turn it sideways" card for a landscape
  game on an upright phone. It reads `platform/device-mode.ts`; both stay until the layout's
  portrait forms replace them (E-010).

## Tooltip: `ui.tooltip`

`ui.tooltip(target, content, { delay, placement, arrow, interactive, gap })` attaches a tooltip to
an element or a world point and returns a `Tooltip` (`element`, `target`, `visible`, `placement`
(the side it landed on), `set(content)`, `show()`, `hide()`, `dispose()`). Every overlay has one
shared `role="tooltip"` element (`ui.tooltips.element`, on the `toasts` layer, so it reads over a
modal panel too); the latest `show` owns it and `ui.tooltips.active` is the tooltip showing now.

- An **element** target shows after `delay` ms (default 400) of hover and at once on focus; pointer
  leave, blur and Escape hide it. While shown the element carries `aria-describedby` pointing at
  the tooltip. `interactive: true` keeps it up while the pointer is over the tooltip itself.
- An **`AnchorHandle`** or a **world point** `[x, y, z]` target rides `ui.anchors(camera)` (build
  it first, or the call throws), shows at once and hides while the point is behind the camera;
  `ui.updateAnchors()` (which `createGame` calls each frame) re-places it.
- `placement` is `top`, `bottom`, `left`, `right` or `auto` (default; the first of top, bottom,
  right, left that fits). A side that would leave the layer flips to its opposite, then the box is
  clamped in; `data-placement` on the element and `--tc-tooltip-arrow` place the arrow. The pure
  `placeTooltip(anchor, size, frame, placement, gap)` does the sums and is exported for tests.
- `TOOLTIP_CSS` is injected once on first use (`ensureTooltipStyles`); the plain overlay page is
  unchanged until then. `createTooltips(host)` builds a set outside an overlay.
- Types: `TooltipOptions`, `TooltipTarget`, `TooltipSide`, `TooltipPlacement` (a side or `auto`),
  `TooltipPlace` (what `placeTooltip` returns), `TooltipHost` (the layers, `rect`, `units` and
  `anchors()` an overlay provides). The frame comes from `anchors().frame.rect` (ws/ui-4).

## World cursor: `ui.cursor`

`ui.cursor({ mode, step, at, targets, onSelect, onMove, repeat, weight, getGamepads, keys, enabled })`
is a pad- and keyboard-driven selection cursor over the world (tactics grids, tile pickers). Call
`cursor.update(now?)` once per frame; it reads the pads through `readPad` (the same latch as
`PadNav`: a control is fresh when it is held this frame and was not last frame) plus the arrow
keys and Enter (skipped when the focused control uses the arrows itself; `keys: false` turns them
off), and `cursor.press(dir)` feeds a press from the game's own input.

- `mode: 'grid'`: each fresh direction calls `step(dx, dy)` (y down); holding repeats after
  `repeat.delay` (400 ms) every `repeat.interval` (80 ms). `at()` returns the cursor's world point
  (or null) so the `.tc-cursor` element rides `ui.anchors()` on the `hud` layer.
- `mode: 'targets'`: `targets()` lists `WorldTarget`s (`{ id, x, y, world }`); a press snaps to the
  nearest in that direction by `pickTarget(from, targets, dir, weight)`: among targets with a
  positive component along the direction, the least `along + weight × perpendicular` (default
  weight 2) wins, so a neighbour in line beats a nearer one to the side. `cursor.target`,
  `cursor.position`, `cursor.setTarget(t)`; `onMove(target)` on every move.
- A or Enter calls `onSelect(target)`. While the stack owns the pad (`stack.padOwner`, followed
  through `onPadOwnerChange`, see *Pad owner*) the cursor reads nothing; its latch resets on each
  transition, and it resumes after the panel closes without taking a press that outlived it.
  `cursor.latched` is true while a control is held or repeating. `enable()` / `disable()` /
  `dispose()`.
- A `CursorHost` whose `stack` has no `onPadOwnerChange` (optional) is polled
  through `stack.hasModal` each frame.
- `CURSOR_CSS` is injected once on first use (`ensureCursorStyles`); `createCursor(host, opts)`
  builds one outside an overlay. `defaultPads()` is the guarded `navigator.getGamepads()`.
- Types: `CursorOptions`, `CursorRepeat`, `WorldCursor`, `CursorHost` (`layers.hud`, `stack.hasModal`
  and `stack.onPadOwnerChange`, `anchors()`), and from `padnav.ts` `PadDir` (`up | down | left | right`) and `PadControl`
  (a `PadDir`, `activate` or `back`), the set `readPad` fills.

## Pad owner: `ui.padOwner`

One latch for who has the gamepad, kept by the stack (ws/ui-4). `stack.padOwner` (a `PadOwner`,
`'stack' | 'game'`) is `'stack'` while any modal panel is open; `stack.onPadOwnerChange(fn)` calls
`fn(owner)` once per transition (a second modal over the first changes nothing) and returns the
remover. `PadNav` and `ui.cursor` subscribe to it instead of polling `hasModal` each frame: both
reset their latch on the transition, so the A that opened a menu never activates its first
control and a direction held through the panel is not a fresh press for the cursor afterwards.
`ui.padOwner` (the overlay's `stack.padOwner`, so `ctx.ui.padOwner` in `createGame`) is what a
game's own bindings gate on:

```ts
if (ctx.ui.padOwner === 'game' && ctx.input.pressed('jump')) jump();
```

`PadNav.dispose()` stops it following the stack.

## Floating text: `ui.floats`

```ts
const floats = ui.floats();                                  // the overlay's pool (ws/ui-6), through ctx.camera
floats.spawn('-12', hitPoint, { color: '#ff5a4a' });
floats.spawn('84!', hitPoint, { crit: true, size: 1.4 });
floats.update(dt);                                           // once per update
```

`ui.floats(camera?, opts?: FloatsOptions)` returns the overlay's `Floats`, made on the first call
(`camera` defaults to `OverlayOptions.camera`, the game's under `createGame`)
(later calls return the same pool and ignore their arguments; `ui.destroy()` disposes it). The
pool underneath is `createFloats(host: FloatsHost, camera?, opts?: FloatsOptions)`: floating text
from a world point through the overlay's anchors (`FloatsHost` is `layers.hud` and
`anchors(camera?)`; `camera` is handed to `ui.anchors` once). `FloatsOptions`: `max` (pool, 64),
`life` (s, 1), `rise` (design px, 56), `stackRadius` (world, 0.35), `stackStep` (design px, `[30,
18]`), `style` (an extra class), `reducedMotion`. `spawn(text, world, opts?: FloatTextOptions)`
takes `color`, `size` (a factor on `--tc-font-size-m`; a crit defaults to 1.3), `rise`, `life`,
`crit` (a scale pop, 0.6 → 1.5 → 1.15 over the first fifth of the life) and `stack` (default
true: spawns on a point with younger labels fan out right, left, each a step higher). `Floats`:
`live`, `pooled`, `max`, `spawn`, `update(dt)`, `clear()`, `dispose()`. Nodes are pooled (past
`max` the oldest is recycled) and hidden when the point is behind the camera or off screen;
`update` writes `transform` (Typed OM where it exists) and `opacity` from precomputed strings, so a
steady frame allocates nothing. Reduced motion keeps them still (fade only). `FLOATS_CSS`
(`ensureFloatsStyles`, `#tc-ui-floats`). ws/ui-6 retired ws/ui-4's `createFloatNumbers` (the
earlier `ui.floats` getter, `spawn(x, y, z, text, { kind })`): pass `color` and `crit` instead.

## Ring and compass: `ui.ring`, `ui.compass`

- `ui.ring(opts)` / `createRing(host, opts)` (`Widgets3Host`: `layers.hud`, `layout`):
  `RingOptions` `radius`, `thickness` (design px, 48 and 8), `value` (0..1), `label`, `color`,
  `region` (default `bottom`), `order`. A conic-gradient ring with the label in the middle,
  `role="progressbar"`; `Ring`: `el`, `value`, `set(value)` (clamped; `aria-valuenow` follows),
  `setLabel(label)`, `remove()`.
- `ui.compass(opts)` / `createCompass(host, opts)`: `CompassOptions` `width` (design px, 480),
  `fov` (degrees each side of the heading, default 180: the strip spans the whole circle),
  `headingDeg`, `markers` (`CompassMarker { name, bearingDeg, icon? }`), `labels`, `region`
  (default `top`), `order`. The strip scrolls under a centre mark with `setHeading(deg)`; each
  marker sits `bearingOffset(bearing, heading) × width / (2 × fov)` px from the centre, wrapping,
  and hides past the edge. `Compass`: `el`, `heading`, `setHeading`, `setMarkers`, `offsetOf(name)`,
  `remove()`. `bearingOffset(bearingDeg, headingDeg)` is the signed difference wrapped to
  −180..180.
- `WIDGETS3_CSS` is injected once (`ensureWidgets3Styles`).

## Minimap: `ui.minimap`

```ts
const map = ui.minimap({                                      // ws/ui-5, ws/ui-6
  size: 200, world: { minX: -64, minZ: -64, maxX: 64, maxZ: 64 }, rotate: 'player',
  background: painted, onPick: (x, z) => moveTo(x, z),
});
map.setPlayer(p.x, p.z, yaw);                                 // radians, clockwise from north
map.setMarkers([{ id: 'a', x: 4, z: -9, kind: 'enemy' }]);
// ws/ui-7: a kind with shape 'arrow' draws as the player's arrow, turned to the marker's heading.
// ui.minimap({ ..., kinds: { mover: { shape: 'arrow', size: 14 } } })
map.setMarkers([{ id: 'b', x: 2, z: 3, kind: 'mover', heading: Math.PI / 2 }]); // facing east
```

`ui.minimap(opts)` / `createCanvasMinimap(host: CanvasMinimapHost, opts: CanvasMinimapOptions)`
draws the map on its own canvas in a layout region. `CanvasMinimapOptions`: `size` (design px, 200), `world:
MinimapWorld` (`{ minX, minZ, maxX, maxZ }`, the rectangle the background covers), `rotate:
MinimapRotate` (`'north' | 'player'`), `shape: MinimapShape` (`'round' | 'square'`), `center`
(`'player'` or `'world'`), `zoom` (1: the world's longer side spans the map), `worldRadius`
(world units from the centre to the rim, inset 5 px; overrides `zoom`), `background`
(`MinimapBackground`: a canvas, `ImageBitmap` or image the game paints), `kinds` (per marker
kind, `MinimapKindStyle { shape: MinimapMarkerShape, color, size }`; the shapes are `dot`,
`square`, `diamond`, `triangle`, `ring`, `arrow`; defaults for `self`, `ally`, `enemy`, `objective`, `info`),
`onPick(worldX, worldZ)`, `region` (`right`), `place` (per form factor as `layout.add` takes it,
overriding `region`: a phone's 56 px rail is too narrow for a map, so put it in `cardLane` there),
`order`, `label`. The map is square and shrinks to fit a smaller fixed region; in a `content` bar or rail
(which carries `data-content`) it holds its `size` and the track grows to it, past the rail's
`max` too, where `layout.overflows()` reports it (ws/ui-11); picks read the drawn rect. `CanvasMinimap`: `el`, `canvas`,
`size`, `redraws`, `markers`, `rim` (markers held on the rim at the last draw), `zoom` (get and
set), `setMarkers(list: MinimapMarker[])` (`{ id, x, z, kind, color?, icon?, heading? }`; `icon` is a glyph
drawn in place of the shape), `markerAt(id, out?)` (a `MinimapMarkerPlace { x, y, outside, angle }` in
map px from the top-left after the rim clamp, or `null`), `setPlayer(x, z, yaw)`, `setBackground(bg | null)`, `toMap(x, z, out)`,
`toWorld(u, v, out)` (exact inverses, map px from the top-left), `flush()`, `remove()`. It
redraws only on change: each setter compares with what it holds and schedules one draw on the
next animation frame. Markers past the edge sit on the rim, dimmed; colours may be `var(--tc-…)`
tokens. A click or tap gives `onPick` through `toWorld` (ignored off a round map's disc).
**Heading** (ws/ui-7): `MinimapMarker.heading` is radians clockwise from north (−z), the
convention of `setPlayer`'s yaw, default 0. A kind with `shape: 'arrow'` draws the player's
arrow (`size` is its length; the player's is 16), turned by the heading on a north-up map and by
heading − yaw on a player-up one; `markerAt(id).angle` is that turn (radians clockwise from up).
Other shapes do not turn. A heading change redraws like any other marker change.
`CANVAS_MINIMAP_CSS` (`ensureCanvasMinimapStyles`, `#tc-ui-cminimap`). ws/ui-6 retired ws/ui-4's
DOM `createMinimap` (pooled marker nodes, `setCenter`/`setMarker`): `rotate: 'player'` with
`worldRadius` and `markerAt` cover what it did.

## Loading screen: `ui.loading`

`ui.loading({ title, tip, tipInterval, progress, label, reducedMotion })` pushes a full-frame,
non-dismissible modal panel (`.tc-loading`, `chrome: 'none'`) on the `panels` layer with a title,
a `bar` and a tip line (`role="status"`, polite; an array of tips rotates every `tipInterval` ms,
default 4000). While it shows the overlay root carries `aria-busy="true"`, the lower layers are
inert, the game's `Input` is blocked through `ui.stack.hasModal`, and every key but Tab is
swallowed at the document's capture phase. `set(progress, label?)` moves the bar (the label
replaces the percent text), `tip(text)` shows one tip and stops rotating, `progress` and
`visible` read back, and `done()` fades it out and resolves after the transition (at once under
reduced motion or `reducedMotion: true`; a 400 ms fallback when no `transitionend` arrives), then
closes the panel and clears `aria-busy`. `LOADING_CSS` is injected once (`ensureLoadingStyles`);
`createLoading(host, opts)` builds one outside an overlay. Types: `LoadingOptions`, `LoadingScreen`,
`LoadingHost` (`root` and `stack`).

## Notifications: `ui.notify`

`ui.notify({ title, body, icon, tone, actions, timeout })` stacks a card top-right on the `toasts`
layer, in `ui.notifications.element` (`role="status"`, `aria-live="polite"`; made on first use).
Toasts stay the one-line, top-centre notice; a notification has a title, a body, an icon, a tone
(`info`, `success`, `warn`, `danger`: the left edge), action buttons (`{ label, onClick, keep }`:
an action dismisses the card unless `keep`) and a close button. It disappears after `timeout` ms
(default 6000; `0` keeps it until dismissed), paused while hovered or focused; Escape inside it
dismisses it. The handle is `{ element, open, dismiss() }`. `ui.notifications.count`,
`dismissAll()` and `focus()` (the newest card's first button, for pad users) manage the stack; a
game drives the actions with its pad through `menuNav(input, ui.notifications.element)`. At most
4 are shown; the oldest goes first. `NOTIFY_CSS` is injected once (`ensureNotifyStyles`);
`createNotifier(container, max)` builds one outside an overlay. Types: `NotifyOptions`, `NotifyTone`,
`NotifyAction`, `Notification` (the handle), `Notifier` (the stack).

## Perf: `createPerfMonitor`, `createPerfOverlay`

A frame-cost readout for demos, the bench and quality checks: the same numbers as a plain object
and as a small DOM box with a sparkline. No key binding is included; a game binds one to
`toggle()`.

```ts
import { createPerfMonitor, createPerfOverlay } from '@thunderclap-engine/engine/ui';

const perf = createPerfMonitor({ window: 120 });                 // frames kept (default 120)
const hud = createPerfOverlay(perf, { parent: stageEl, corner: 'tr' });
// each frame, after renderer.endFrame():
state.perf = perf.sample(renderer);
hud.update();
```

- `createPerfMonitor(opts?: PerfMonitorOptions)` (`window`, `gpuEvery`, `now`) returns a
  `PerfMonitor`, which *is* its `PerfSample` plus `begin(nowMs?)`, `end(nowMs?)`,
  `sample(source: PerfSource)`, `history: Float32Array`, `head` and `reset()`. Pure: no DOM, no GPU.
- `sample(renderer)` once per frame reads `renderer.stats`, `renderer.timing` and
  `renderer.resolutionScale` (`PerfSource` is that slice, so a fake fits) and returns the reused
  sample: `frame: PerfFrameStats` (`last`, `avg`, `p95`, `max`, `fps`, over the ring), `gpu:
  PerfGpuStats | null` (`total` ms and `passes` by label; `null` until the renderer has resolved
  a GPU sample), `counts` (every numeric field of `stats`, read by key so a new counter such as
  `batches` shows up without a code change, plus `draws` as an alias of `drawCalls`),
  `resolutionScale`, `memory` (`performance.memory.usedJSHeapSize` bytes where Chromium exposes it,
  otherwise absent), `samples`, `filled` and `window`. It is JSON-safe, so a harness page can
  expose it as state.
- Frame time: bracket the CPU frame with `begin()`/`end()` for an exact span; without them
  `sample` measures the interval between its own calls (the frame interval). `history` is a ring
  of `window` ms values; `filled` says how many hold data and `head` where the next goes.
- GPU time comes from `renderer.timing`, which only fills while `renderer.timingEvery > 0`. When
  `sample` finds it at 0 it sets it to `gpuEvery` (default 1; `0` leaves the renderer alone), so
  the one-line setup works. Per-pass times need `timestamp-query`; otherwise `passes` is empty and
  `total` is the queue's submit-to-done time.
- Steady state allocates nothing: the ring, the sort scratch, the stats object and the records are
  reused; a new counter or pass label adds a key once.
- `createPerfOverlay(monitor, opts?: PerfOverlayOptions)` (`corner: PerfCorner` = `'tl' | 'tr' |
  'bl' | 'br'`, `graph` default true, `parent` default `<body>` where the box is `position: fixed`,
  `updateEvery` frames, default 10) returns a `PerfOverlay`: `el` (`.tc-perf`, `aria-hidden`,
  `pointer-events: none`), `update()` (call once a frame; it redraws the text and the `<canvas>`
  sparkline every `updateEvery` calls, nothing while hidden), `show()`, `hide()`, `toggle()`,
  `visible`, `destroy()`. It is styled from the theme tokens (`--tc-font-mono`, `--tc-color-text`,
  `--tc-color-surface`, `--tc-color-border`, `--tc-color-accent`, `--tc-radius-s`) with the
  default theme's values as fallbacks, so it reads the same on a page without an overlay root; its
  sizes are CSS px (a debug readout, not game UI). The sparkline draws `history` oldest to newest
  with a 16.7 ms guide line and a floor of 33 ms, so a steady 60 Hz sits at half height.
- The harness pages `mesh.html`, `lights.html` and `pbr.html` sample every frame and show the
  overlay with `?perf` (`e2e/perf.spec.ts`); without it they draw nothing extra.

## Accessibility checklist

- Panels have `role=dialog` (or `alertdialog`), `aria-modal`, and are labelled by their title.
- Focus is trapped in a modal and restored when it closes. Lower layers are `inert`.
- Every focusable element gets a visible `:focus-visible` ring (`--tc-focus-ring`, `--tc-color-focus`).
- Captions and toasts use polite live regions.
- Buttons are at least 64 design px tall, which is about 32 CSS px at a 960×540 embed.
- Grids are `role="grid"` with a roving tabindex, no wrap, and a polite live region that says what
  was picked up, dropped, refused or put back; `aria-grabbed` marks the source while carrying.
- Cards are `role="tooltip"` and name their anchor through `aria-describedby`; radials and context
  lists are `role="menu"` of `menuitem`s, close on Escape and give the focus back to the opener.
- Drag and drop always has a keyboard and pad path: hold Enter or Space (pad `select`) to pick up,
  arrows to the target (across grids at the edge), Enter (`select`) to drop, Escape (`back`) to cancel.
- Tooltips are one `role="tooltip"` element per overlay; an element target names it through
  `aria-describedby` while it shows, focus shows it without a delay and Escape hides it.
- The world cursor answers the arrow keys and Enter as well as the pad, never steals them from a
  focused text field, slider or select, and yields to a modal panel.
- The loading screen is a non-dismissible modal: the root is `aria-busy`, the lower layers inert,
  the tip line a polite live region, and Tab still moves focus while every other key is swallowed.
- Notifications are a polite live region of cards with real buttons: pad users reach the actions
  through `menuNav`, Escape dismisses the focused card and focus moves to the next card, not the body.

## UI specs: `panel`, `hud`, `presentDom` (ws/ui-spec)

UI written as data, from Forge Wilds' spec framework with its game nouns taken out. A
`PanelSpec` (`{ id, body, fade?, held? }`) is a tree of words (`SpecNode`): `col`/`row`
(`SpecStack`: gap, pad, align, scroll, a `tap` stack), `grid` (`SpecGrid`), `list` (`SpecList`:
rows of one `row` subtree by key, a `head` word for keys starting `#`, `tail` to follow the end),
`text` (`SpecText`, a `SpecTextStyle` from `SPEC_LINE` and `SPEC_TYPE`, `wrap` counted lines,
`marked` `{w}…{/}` runs), `slot` (`SpecSlot`), `meter` (`SpecMeter`, `SpecMark`s), `icon`
(`SpecIcon`, `SpecGlyphPart`s), `button` (`SpecButton`, `SpecButtonPress`: tap, toggle or held),
`field` (`SpecField`, `SpecFieldKind`), `tabs` (`SpecTabs`) and `range` (`SpecRange`); every word
takes `SpecCommon` (id, cls, w, h, grow, show, state, label, tint, again), `SpecAlign`, and a
`SpecStr` or `SpecNum` is fixed or a `Bind` made with `b(key)` (`b('row.name')` in a list's row).
`SpecFontFamily` names a `SPEC_FAMILY` stack (`SPEC_SANS`, `SPEC_SERIF`, `SPEC_MONO`).

```ts
const p = panel({ id: 'vitals', body: { k: 'col', gap: 6, children: [
  { k: 'meter', id: 'hp', value: b('hp'), w: 180, h: 14 },
  { k: 'button', id: 'rest', text: 'Rest', w: 100, h: 40 },
] } });
presentDom(p, host, { theme: theme({ accent: '#5fd3e6' }) });
p.frame(0, 0);                 // natural size
p.model.set('hp', 0.8);        // drawn at the next frame, nothing else written
p.onEvent = (e) => { if (e.id === 'rest') rest(); };
```

`panel(spec, opts?)` (`SpecPanelOptions`: a `SpecSchedule`, or null to apply it yourself) compiles
a spec once per object (`CompiledSpec`) and returns a `SpecPanel`: its `model` (`SpecModel`: `set`,
`setAll`, `get`, `setList`, `row` (a `SpecRow` of a `SpecListState`, moved `SpecListMove` keep,
top or end), `focus`; values are `SpecValue`s) marks only keys that changed, its `boxes`
(`SpecBoxes`) are a pure two-pass layout over typed arrays that allocates nothing once warm, and
`apply()` returns at once when nothing changed. `frame(w, h, text)` gives it a frame (0: natural).
Events come out as `PanelEvent`s (`SpecPressKind`: tap, hold, toggle, down, up, input, enter, pick,
change, focus, blur, held), `one` on a shift press. A `SpecPresenter` draws a panel:
`presentDom(panel, host, opts?)` (`DomOptions`: scale, theme, fit, slotArt, a `SpecTimer` for
holds) returns a `DomPresenter` that builds one real element per word (`<button>`s, inputs,
`role=meter`, `tablist`, a list's pooled rows), writes only what changed keys bind (`writes`
counts), keeps `data-tc-id` control ids (`<panel>/<word>[:<row>]`) so `PadNav`, arrow keys and
`onControl` work, and holds after `SPEC_HOLD_MS` within `SPEC_HOLD_SLOP` px.
A tabs' option's `label` row field is its button's words (`list.row(k).set('label', …)` or
`setAt(0, …)`). A `weigh` tabs shares its row by each label's measured need (`tabNeed`: the label
in the theme's sans at the tabs' `labelWeight`, default 400, plus the padding and border), so a
bold label fits where a letter count did not (B24); both presenters draw it at that weight. `tabShares(n, least, w, weight, out)` is that
sharing on its own (exported, ws/water-split): `n` widths in `w` units into `out`, by `weight(i)`
(or equal), none under `least`, each floored and the last taking the rest; a presenter of its own
places tabs with it as the engine's do. A text with a `term` places the term at its column's start and its words a block
beside it, both written inline (no float: WebKit ignores one in the line clamp's box), so it holds
with the engine's sheet held off. Under `fit: 'content'` the host's inline width and height are the
engine's: a game that places the host by its own sums gives its width another way (a custom
property its CSS reads), or a sizer observer handing that width back loops.

`hud(spec)` (`HudSpec` of `HudItem`s: a spec, a layout `place`, an order, a width) is a `SpecHud`
of panels; `presentHud(hud, ui)` adds each panel's host through `ui.layout.add` (regions, safe
areas and form factors as for any widget) at `specScale(ui)` CSS px per unit and follows resizes
(`HudView`). `presentModal(ui, panel, opts)` (`SpecModalOptions`) opens a panel on `ui.stack` as a
`SpecModal` (focus trap, Escape, focus return). Both take a `SpecOverlay` (the overlay's layout,
units, scale, `onResize` and stack; the page comes from `layout.root`, the overlay root the layout
is made over, ws/ui-world). The look is tokens, not parsed CSS: `theme(tokens)`
resolves `SpecTokens` over `defaultSpecTokens` into a `SpecTheme` of `--tcs-*` properties
(`specTokenVar`). Text lines are counted with `wrapCount`/`wrapText` (`WrapOptions`) and
`textWidth`, measuring with an `OffscreenCanvas` or an estimate; `measureWith` (a `SpecMeasurer`)
fixes it for tests. See `spec/README.md` and `harness/ui-spec.html`.

### The world presenter: `presentWorld`, `worldScreen` (ws/ui-world)

The same `SpecPanel` drawn on a `WorldPanel` in the scene, so one spec looks and behaves alike on a
flat screen, on touch and in a headset (Forge's one HUD layout everywhere):

```ts
const quad = createWorldPanel(ctx.renderer, { width: 1.2, height: 1.35, resolution: 400 });
const onQuad = presentWorld(kit, quad, { fit: 'none', scale: 480 / 360 }); // the DOM's words, in the world
quad.attach(ctx.input);                                                    // rays: mouse, touch, pad cursor, XR
const screen = worldScreen(ctx.renderer);                                  // head-following, lazy
const bar = presentWorldHud(myHud, screen);                                // regions on the screen
const dlg = presentWorldModal(screen, dialog, { onClose: (why) => {} });   // dim backdrop, Tab trap, Escape
```

- `presentWorld(panel, world, opts?)` (`WorldOptions`: `scale` px per unit, `fit` `'surface'` (fill
  the panel), `'natural'` (the spec's own size) or `'none'`, `w` (the frame width, units), `rect`
  (where on the canvas) or `place(w, h, out)`, `theme`, `slotArt`, `timer`, `onEscape`) returns a `WorldPresenter`: one `WorldWidget` (`widget`) that paints the
  panel's `SpecBoxes` with Canvas2D and repaints only the boxes of dirty keys and rows (`paints`;
  an idle frame paints nothing), routes ray presses, holds, drags on a range and the wheel on a
  list into the same events as `presentDom` (tap, toggle, pick, down/up, change, input, enter then
  the `submits` button's tap, focus and blur), takes keys while focused (`key`, `keyUp`: Tab order
  as the DOM's tab stops, arrows on a range and tabs, typing into a field), and reports
  `focusId`, `focusOrder()`, `rectOf(id, row?)` (a word's canvas-px box), `unitScale`,
  `setScale`, `setRect`, `focusFirst`, `apply` and `dispose`.
- `worldScreen(renderer, opts?)` (`WorldScreenOptions`: `width` 1.6, `height` 0.9, `resolution`
  800, `distance` 1.2, `lazy` 0.35 rad, `ease` 0.12 s, `canvas`) is a transparent head-locked
  `WorldPanel` that holds still while the view stays inside its `lazy` cone and eases back when it
  leaves; it is not depth tested and its empty pixels let rays through (`hitEmpty: false`).
- `presentWorldHud(hud, screen, opts?)` (`WorldHudOptions` `margin` 16 px) lays a `SpecHud`'s items
  on the screen by their `desktop` (else `default`) region: top, bottom and caption lanes as
  centred rows, left, right and card lanes as columns, the rest centred; `'hidden'` is skipped.
  It returns a `WorldHudView` (`presenters`, `dispose`).
- `presentWorldModal(screen, panel, opts?)` (`WorldModalOptions` `onClose(reason)`, `dismissable`
  true) opens a panel centred over a dim backdrop on the screen, focuses its first word, traps Tab,
  and closes by Escape, a backdrop press or `close()` (`WorldModal`).
- World panels gained what the presenter needs: `WorldPanelOptions.hitEmpty` (a press on no widget
  still hits the panel; false lets it through), `headLocked.lazy`/`ease`, `invalidateRect(r)` and
  `paintClip` (a widget repaints a part of itself), `following` (a lazy screen is catching up),
  `WorldWidget.keyFirst` (it sees keys before the panel's Tab and Enter) and
  `PanelKeyEvent.ctrlKey`/`metaKey`.
- Harness `harness/ui-world.html` (one panel on the page and on a quad, a HUD and a modal on the
  screen; `?stereo` draws two eyes side by side); spec `e2e/ui-world.spec.ts` (DOM vs ray parity,
  an idle quad, the screen's modal, stereo); tests `spec/present-world.dom.test.ts` (parity on the
  fake GPU, Tab order, an idle frame paints nothing, the lazy screen, the modal, the HUD).

### Game fit (ws/ui-fit)

Hooks a game's panels need, on both presenters unless said, so one spec stays one layout on a
flat screen, a touch screen and in a headset. All additive: a spec without them draws as before.

- **Aim.** `{ k: 'row' | 'col', aim: 'north' | b('aim') }` writes `data-aim` on the page (the
  game's CSS turns it); `panel.aimOf(id)` reads it for a world painter. Nothing is painted for it.
- **Ring.** `{ k: 'icon', ring: b('cool') }`: a bound fill 0..1, `--tcs-ring` on the page's
  `.tcs-ring`, a wedge on the world surface.
- **Windowed lists.** `{ k: 'list', window: 48 }`: the page binds only the rows within `window`
  units of its view (and more as it scrolls); the world paints only rows in view anyway. A scroll
  says a `scroll` event (`value`: units from the top).
- **Slide.** `model.setList(id, keys, 'slide')` moves rows from where they stood (220 ms ease-out,
  `SPEC_SLIDE_MS`) and keeps the top row in view where it was; `PanelSpec.slide: 'up' | 'down' |
  'left' | 'right'` slides the body in and out with its show. Both stand still under reduced
  motion (`specStill`). The world's motion runs on `WorldOptions.frame`/`now` (default rAF and
  `performance.now`).
- **Give way.** `PanelSpec.giveWay: 'small' | 'always'`; `hud.giveWay(sheet, small)` (or
  `panel.giveWay`) hides it and takes no presses while a sheet is open (on a small screen):
  `data-given`, `inert` and `tcs-given` on the page, nothing painted or hit on a surface.
- **Fields.** `typeAhead: true` (one per panel): a letter typed with nothing focused goes into the
  field (a search's lowercased), `/` focuses it. `closeKey: 'KeyE'`: that key in the empty field
  says `close` (not while a finger last touched: a soft keyboard types it).
- **Field text.** The model is the one truth: every presenter shows the model's value. Text typed
  on one surface goes into the model (`SpecModel.follow(i, v, from)`) and every other presenter on
  the panel shows it at its next apply; the game writes nothing back, and a `set` of `''` clears
  it everywhere. Presenters never talk to each other, only through the model.
- **Held slot.** `{ k: 'slot', press: 'held' }` says `down` and `up`, never `tap`.
- **Automation.** `dom.el(id, row?)`, `rows(listId)` (the rows bound, in order), `reveal(listId,
  key)`; the world presenter's `rows` (in view) and `reveal`. Every word with an id has `data-id`.
- **Class names.** `presentDom(p, host, { classes: { 'tcs-slot': 'my-slot' } })` swaps or adds
  the game's class for an engine one. `touching: () => boolean` overrides the touch guess.
- **Bare device.** `createWorldPanel({ device }, opts)` and `worldScreen({ device }, opts)` paint
  and upload the texture each `prepare`; `draw` does nothing: the game draws `panel.texture`.
- **Type.** `panel(spec, { families: { sans: 'MyFont, sans-serif' } })` counts wrap texts' lines
  in the game's stacks (`typeMeasureIn`); give its theme the same fonts.
- **Public pieces**, for a game's own presenter: `compileSpec`, `SpecPressable`, `viewOf`,
  `partsOf`, `maxRowsAt`, `typeMeasure` (a `SpecMeasure`), `SpecFamilies`, `specGivesWay` (the
  give-way rule), `specEaseOut` (the slide's curve), `SPEC_SLIDE_MAX` (units past which a row jumps
  instead of sliding), `PanelGpu` (a bare device's shape); the kinds `K_COL`, `K_ROW`, `K_TEXT`,
  `K_BUTTON`, `K_FIELD`, `K_METER`, `K_RANGE`, `K_ICON`, `K_SLOT`, `K_LIST`, `K_GRID`, `K_TABS`; and
  the roles a key binds to (`CompiledSpec.keyBinds`): `R_TEXT`, `R_LABEL`, `R_VALUE`,
  `R_VALUETEXT`, `R_ON`, `R_SELECTED`, `R_ENABLED`, `R_SHOW`, `R_TINT`, `R_STATE`, `R_ITEM`,
  `R_COUNT`, `R_KEY`, `R_BADGE`, `R_MARK`, `R_AGAIN`, `R_PLACEHOLDER`, `R_LINES`, `R_ROWS`,
  `R_RING`, `R_AIM`.

`harness/ui-fit.html` (e2e `ui-fit`) draws one such panel on the page and on a bare-device surface.

### Game fit, round two (ws/ui-input-fit)

- **Writes.** The page presenter keeps each part's last box and writes only what changed: a list
  laid out again with nothing moved writes nothing. A window list rebinds only when its view comes
  within half its `window` of the bound edge, and a pooled row goes to the end of the list, so
  nothing after it moves. Measured in `src/ui/spec/input-fit.dom.test.ts`: a 60 px scroll of a
  500-row window list went from 425 writes to 21.5, a chat line on a 40-row tail list from 767 to
  48. `dom.writes` counts them.
- **Lists.** A list's new count lays the panel out again (its content's height follows). A tail
  list goes to its end after its rows are placed (the new end, not the old), and back to it when
  a hidden log is shown again (WebKit resets a hidden scroller to 0); a player who scrolled up
  stays there until they scroll back to the end. A tail kept due while the embedder hid the host (`hidden`,
  `display: none`) goes to its end when the host gets a box again (the presenter's
  `ResizeObserver` on the host, before that paint), or at once with `presenter.tailsToEnd()`
  for an embedder that shows the host and reads its scroll in the same task (ws/actor-post-fit).
- **No forced layout.** `flash`, `ring` and `again` play again from their start through the
  element's own `getAnimations()` (`currentTime = 0`, `play()`), never a class toggle with a
  layout read in between. A flash's text set to `''` takes its class off. The first `again` value
  only puts `tcs-again` on (its animation plays as the class comes); each later change replays.
  `again` on the panel's root also replays the host's own CSS animations (the embedder's look of
  the whole panel: a shake, a flash), from the first change, with no class on the host
  (ws/actor-post-fit).
- **Keys.** Type-ahead calls `stopImmediatePropagation` on the keys it takes (a letter, `/`), so
  the game's key handler never also sees them, skips a key already default-prevented, and asks
  `DomOptions.holdTypeAhead(e)` first: true leaves the key to the game. A close key in the empty
  field stops propagation too.
- **Range.** A range says `input` while dragged and `change` once let go (a key is both at once),
  on both presenters, and writes `--fill` (its value's share of the track, a percent) for the
  game's CSS track.
- **Submit.** A submit button's `tap` (a click, or its field's Enter) carries the field's text.
- **Held.** `held` (and a held button's `up`) drops when the window loses focus or the browser
  cancels the touches.
- **Reduced motion.** `setSpecStill(true | false | null)` is the game's own setting (its options
  menu) over the system's; `specStill()` reads it. Under it the host has `data-still` and no
  transition or animation runs. `specEaseIn` is the curve a body slides out on.
- **Classes.** `classes` maps `tcs-tab` (a tab button), `tcs-inner` (a list's content) and
  `tcs-label` (a button's or tab's label: its own class now, styled as the label type, no longer
  `tcs-t-label`).

## Tests

`inventory.test.ts` covers the grid (shape, aria, clamping, hold to pick up, drop, cancel, `canDrop`, context hooks, the card on focus), the drag context (pad walk across grids, both-end `onMove`, pointer thresholds, the long press, `slotsTarget`), `placeCard`, the card, the radial and the context list. `hud.test.ts` covers the HUD widgets (DOM shape, aria, clamping, wrapping, heading offsets, the modal rule, pulse). `ui.test.ts` runs under happy-dom and covers theme var names, overlay mount and scaling,
client→design mapping, the modal focus trap, Esc, focus restore, inert stacking, non-modal panels,
backdrop clicks, toast caps and timers, caption typing / hold / skip / queue / reduced motion / suspend / onPlace, and
the slider's aria-valuetext. `overlay-controls.test.ts` covers control ids (derived, `#n`, the game's `id`), `onControl` and `activate` on a rebuilt page (ws/input-12). `perf.test.ts` covers the monitor's ring, p95, dynamic counter keys
and GPU records against a fake `RenderStats`, and the overlay's DOM under happy-dom.
`tooltip.test.ts` covers `placeTooltip` (sides, the flip, clamping, the arrow inset), the shared
element's delay, leave, focus, Escape and hand-over, and a world point riding the anchors;
`cursor.test.ts` covers `pickTarget`, the latch and repeat, the keys, the modal rule and the
anchored element in targets mode; `loading.test.ts` the bar, tips, `aria-busy`, key swallowing
and `done`; `notify.test.ts` the stack, timeouts, actions, `menuNav` and Escape; `dom.test.ts`
the `h` string style; `styles.test.ts` the select zoom rule and its `:where()` specificity (#3); `e2e/cover.spec.ts` checks a game's select rule wins in a real browser. `e2e/ui.spec.ts` runs the four
harness modes (`harness/ui.html?tooltip`, `?cursor&mode=`, `?loading&stall`, `?notify`) on the matrix.
ws/ui-4: `anchor.test.ts` covers `frame` and `project` against a placed anchor across a resize,
`tooltip.test.ts` a world-target tooltip landing on the anchored point, `pad-owner.test.ts` the
owner transitions, the cursor latch reset and two cursors on one transition, `widgets-3.test.ts`
the ring's aria and compass offsets, `world-panel/panel.test.ts` a press on the input tick.
`e2e/ui4.spec.ts` runs `harness/ui4.html` (`?floats`, `?ring`, `?compass`, `?minimap`, `?modal`,
`?still`) on the matrix; since ws/ui-6 its floats and minimap modes use `ui.floats` and
`ui.minimap`, and the rim clamp is read through `markerAt` and `rim` state fields.
ws/ui-5: `orb.test.ts` covers the orb's fill and aria, the readouts, the colour override, the trail
hold, drain and retarget on an injected clock, reduced motion and the bar's trail;
`floats.test.ts` pool reuse and the `max` recycle, a spawn behind the camera hidden, life end,
the stack fan, the rise and fade and the crit pop, and `ui.floats` memoised and disposed;
`minimap-canvas.test.ts` the mapping in both `rotate` modes, `toWorld` inverting `toMap`, no redraw
without a change, the pick, and `ui.minimap` with `worldRadius`, `markerAt` and `rim`.
ws/ui-7: `layout.test.ts` an oversized widget listed in `overflows()` and warned once (a fitting
one not, a hidden one not measured, `setPlace` warning again); E-040: `warnOverflows: false` and
`import.meta.env.DEV` false silent with `overflows()` still reporting (#8), a run of `add` calls
and a nested `batch` judged once on the finished layout, a later overflow of a widget that was
large while half-built still warning, and a new overflow after it fitted warning again (#9), a
region restyled to no padding, more padding or a border measured against its computed content
box (#10); `minimap-canvas.test.ts` the arrow
kind's drawn rotation (recorded `rotate` calls) in north and player modes and `markerAt.angle`.
`e2e/ui5.spec.ts` runs `harness/ui5.html` (`?orb`, `?floats`, `?minimap`, `?still`); since
ws/ui-7 `?minimap` holds an arrow marker whose `headingMarkers` angle tracks heading − yaw. Layout and
focus were also checked once in Chromium via Playwright (not part of CI).
ws/ui-spec: `spec/spec.test.ts` (layout, model, press, the zero-allocation budgets) and
`spec/present-dom.test.ts` (idle frames write nothing, pooled rows, fields, held buttons, today's
widgets as specs); `e2e/ui-spec.spec.ts` runs `harness/ui-spec.html` on the matrix.
