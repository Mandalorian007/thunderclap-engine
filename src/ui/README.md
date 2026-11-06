# engine/ui

The DOM overlay that sits on top of the WebGPU canvas: panels, toasts, a speech/caption card, small
widgets and theme tokens. It has no dependencies and no game nouns.

## Overlay

```ts
import { createOverlay } from '@thunderclap/engine/ui';

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

- `button(label, onClick, { variant: 'default' | 'primary' | 'ghost', disabled, ariaLabel })`
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
- `h(tag, props, ...children)` is hyperscript. It handles `class`, `style` (including `--custom`
  properties), `dataset` and `on: { click }`. Any other prop becomes an attribute: `true` sets an
  empty attribute and `false`/null omits it.
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
  `scaleX(--tc-meter-value)`.
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

## External links: `externalLink`

A real new-tab link plus a **Copy link** button, with "Copied" feedback and a fallback popover
(the URL in a selected read-only field) for when the browser blocks the copy or the new tab. Logic
lives in the host (`host/web-links.ts` on the web); the widget only builds DOM and wires it. Labels come from the
caller; the look comes from theme tokens (override `.tc-link`, `.tc-link-row`, `.tc-link-copy`,
`.tc-link-fallback`, `.tc-link-message`, `.tc-link-field`, `.tc-link-close`).

```ts
import { activateLink, externalLink } from '@thunderclap/engine/ui';

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

Opening and copying go through the host (`@thunderclap/engine/host`): pass `host` to
`externalLink`, or it uses `defaultHost()`. Usable without the widget:

- `host.openExternal(url, { activation })`: `'opened' | 'blocked' | 'invalid'`. On the web,
  `pointer` and `keyboard` click a temporary `<a>`; `gamepad` and `script` call `window.open` and
  report `null` as `blocked` (the opened tab's `opener` is cleared).
- `host.copyText(text)`: `Promise<'copied' | 'manual'>`; `host.clipboardWriteAllowed()`.
- `safeExternalUrl(url)` and `embedContext(win?)` stay in `@thunderclap/engine/platform`.

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
`classify`, `safeArea`, `collapseEmpty`); a game reads it as `ui.layout` (`Layout`). What follows
lists the exported names; ARCHITECTURE.md *Layout* describes the model.

- **Form factors.** `FormFactor` is one of `FORM_FACTORS` (`phone-landscape`, `phone-portrait`,
  `tablet`, `desktop`). `classifyFormFactor(i: ClassifyInput)` picks one from `{ width, height,
  coarsePointer, shortSide }`: a phone is a coarse pointer with a short side of at most
  `PHONE_MAX_SHORT_SIDE` (600) or any view under `PHONE_MAX_VIEW_SHORT` (480).
- **Forms.** `FormSpec` is `{ columns, rows, areas, tapMin, textMin, pad, modalMargin, units }`;
  a `Track` is CSS px, `'fill'` or `{ frac, min?, max? }`; `Units` is `'frame' | 'css'`.
  `defaultForms` holds the engine's forms; `formSpec(ff, spec?)` merges a spec's overrides over
  them.
- **Regions and widgets.** `RegionName` is one of `REGIONS` (`top`, `left`, `right`, `bottom`,
  `cardLane`, `captionLane`, `modal`, `fill`). `layout.add(el, opts: WidgetOptions)` (`place`
  per form factor plus `default`, `order`, `id`) returns a `WidgetHandle` (`element`, `region`,
  `setPlace`, `remove`). A `Placement` is a region, `'hidden'` or a `FreePlacement` (`{ region:
  'free', rect, reason }`); `placementFor(place, ff)` resolves one.
- **State.** `LayoutState` is the pure result for one size (`formFactor`, `units`, `width`,
  `height`, `safeArea`, `columns`, `rows`, `regions`, `freeRect`). `Layout` adds `element`,
  `freeUses`, `region(name)`, `dockCaption`, `setSafeArea`, `setForms`, `refresh`, `onChange` and
  `destroy`. `LayoutHost` is what the layout needs from its overlay.
- **Pure helpers** (tested in Node): `parseAreas(areas)`, `resolveTracks(tracks, length,
  collapsed?)`, `resolveLayout(ff, form, width, height, safeArea?, occupied?)`,
  `effectiveInsets(rect, viewport, insets)`; `Insets` is `{ top, right, bottom, left }`,
  `NO_INSETS` is all zero, and `readSafeArea(doc?)` reads `env(safe-area-inset-*)` (or the
  `--tc-safe-*` overrides).

## Anchors: `ui.anchors(camera)`

DOM that follows a world point: a name over a character, a damage number, a hint on a tile, a
marker that stays on screen for something off it.

```ts
const anchors = ctx.ui.anchors(() => ctx.camera); // built on the first call, on the hud layer
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
- `overlay.anchors(camera?)` returns the overlay's one `Anchors`, built on the first call (which
  needs the camera; a later call with one switches it). `overlay.updateAnchors()` updates it if it
  was built; `createGame` calls it after `hooks.afterRender` on every frame, so a game never
  calls `update()` itself. Outside `createGame`, call `ui.updateAnchors()` after rendering.
- `hidden` loses to a stylesheet that sets `display` on the element; add `[hidden] { display:
  none }` for such a class. One camera per `Anchors`: a stereo UI is not this step.

## World panels: `createWorldPanel`

A panel that lives in the world rather than on the screen (ws/ui-world-panel, `src/ui/world-panel/`): one blended quad whose face is a canvas the engine paints with the same theme tokens as the overlay, holding a small widget set, hit by any pointer ray. Use the overlay for a screen (menus, HUD, anything that must be crisp DOM); use a world panel where there is no screen (a headset) or where the UI *is* a thing in the scene (a terminal, a sign, a wrist menu). No DOM is involved: it works without `document` (a Worker's `OffscreenCanvas` is out of scope for now: the panel makes its canvas with `makePanelCanvas`, `OffscreenCanvas` then `<canvas>`, and only the main thread uploads it).

```ts
const panel = createWorldPanel(ctx.renderer, { width: 2, height: 1.2 });   // world units, 256 px/unit
panel.transform.setPosition(0, 1.6, -3);                                    // a wall sign facing +z
panel.add(worldLabel({ text: 'Settings', size: 'l' }));
const sound = panel.add(worldToggle({ text: 'Sound', value: true, onChange: (v) => audio.mute(!v) }));
panel.add(worldSlider({ min: 0, max: 100, value: 80, step: 5, onChange: (v) => audio.volume(v / 100) }));
panel.add(worldButton({ text: 'Back', onPress: () => stack.pop() }));
ctx.pointers.addTester(worldPanelTarget(panel));                            // mouse, touch, pad cursor, XR rays
ctx.hooks.beforeRender = () => panel.poll(ctx.pointers.pointers);           // hover, press, release
scene.render = (frame) => frame.drawable(panel.drawable, 10);               // after the opaque meshes
sound.set({ value: false });                                                // writes only on change
panel.focusNext(); panel.activate();                                        // a pad with no ray
panel.dispose();
```

- `createWorldPanel(renderer, opts)`: `WorldPanelOptions` `width`/`height` in world units, `resolution` px per unit (256), `theme` (partial `ThemeTokens` over `cssPxTheme`, so 16 px text on a 256 px/unit panel reads at arm's length), `background` `'panel'` (rounded surface and border) or `'transparent'`, `billboard` (turns to the camera each `update`), `headLocked: { distance, offset?: [x, y] }` (sits `distance` in front of the eye, offset along the view's right and up, each `update(camera)`), `depthTest` (default on; off for head-locked), `canvas` (inject a `PanelCanvas` in tests), `label`.
- `WorldPanel`: `transform` (a `Transform` the game places; head-locked and billboard panels rewrite it in `update(camera)`), `drawable` (a `Drawable`: push it with `frame.drawable(panel.drawable, order)` after the opaque pass; one quad, premultiplied alpha, depth-tested without writing depth), `add(widget)`/`remove(widget)`, `widgets`, `hitTest(ray)` (`WorldPanelHit { x, y, widget, distance }` in panel px, reused), `pointerDown/Move/Up(x, y, id)`, `pointerLeave(id)`, `wheel(x, y, dy)`, `poll(pointers)`, `focus(widget)`, `focused`, `focusNext()`/`focusPrev()` (wrapping, skipping labels, progress and disabled widgets), `activate()`, `key(event)` (`PanelKeyEvent { key, shiftKey? }`: Tab, Shift+Tab, Enter, Space, then the focused widget's arrows), `hovered`, `pressing`, `dirty`, `repaint()`, `update(camera)`, `stats` (`WorldPanelStats { repaints, uploads, bytes }`), `fontLoaded` (resolves on `document.fonts.ready` and remeasures; already resolved without `document`), `theme` (`PanelTheme`), `painter`, `texture`, `dispose()`.
- **Widgets** (`WorldWidget` subclasses, built by `worldLabel`, `worldButton`, `worldToggle`, `worldSlider`, `worldList`, `worldProgress`): `WorldLabel` (`WorldLabelOptions` `text`, `size` `WorldWidgetSize` `'s' | 'm' | 'l'`, `align` `WorldWidgetAlign`, `tone` `WorldWidgetTone`), `WorldButton` (`WorldButtonOptions` `text`, `onPress`, `disabled`; fires on the release over it, not the press), `WorldToggle` (`WorldToggleOptions` `text`, `value`, `onChange`), `WorldSlider` (`WorldSliderOptions` `min`, `max`, `value`, `step`, `onChange`; drag anywhere on the track, arrows step), `WorldList` (`WorldListOptions` `items`, `selected`, `onSelect`, `visibleRows`; scrolls by drag and wheel, clamped, arrows move the selection and keep it visible), `WorldProgress` (`WorldProgressOptions` `value` 0..1, `tone`). Every option set takes `rect?: PanelRect` to place the widget by hand; otherwise `flowLayout` stacks them top to bottom with the theme's `space3` padding and `space2` gap (`FlowItem`, `FlowOptions`). `widget.set(patch)` writes only the fields that changed and marks the widget's rect dirty (a layout field relayouts); `options`, `layoutRect`, `hover`, `pressed`, `focused`, `disabled`, `focusable`. Hover tints, a pressed shade, a `colorFocus` ring and 45 % alpha when disabled; `WorldWidgetHost` is what a widget sees of its panel.
- **Painting**: Canvas2D through `Painter` (`fillRoundRect`, `strokeRoundRect`, `focusRing`, `text` with a per-font measure cache, `clearMeasures`) over a `PanelContext2D` (the subset a `CanvasRenderingContext2D` satisfies) from a `PanelCanvas`; `resolvePanelTheme(overrides)` reads the tokens once by value. Repaints cover the union of the dirty rects only; the frame's `prepare` then uploads that rect with one `copyExternalImageToTexture` (premultiplied), so `uploads` stays flat while nothing changes. `WORLD_PANEL_WGSL` is the quad's shader (six corners from `vertex_index`, `camera.view_proj`, the texture sampled with the linear-clamp sampler).
- **Pointers**: `worldPanelTarget(panel)` is a router `HitTester` whose hit carries the panel as `target`, the world point, a normal facing the ray and the distance, so `router.hit`, `{ pointer: 'select' }` bindings and the nearest-hit rule work as for meshes. `panel.poll(router.pointers)` once per tick (after `input.update()`, so in `hooks.beforeRender` or `hooks.update`) turns the routed pointers into hover, press and release: a press that leaves the quad keeps dragging on the panel's plane and releases where the ray meets it, a vanished pointer releases where it was. Without a ray, `focusNext`/`focusPrev`/`activate` and `key` drive it from a pad or keyboard.
- Harness `harness/world-panel.html` (`?pad` adds a pad cursor); spec `e2e/world-panel.spec.ts`; tests `src/ui/world-panel/panel.test.ts` with a Canvas2D stub and the fake GPU.

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
`BASE_CSS` once; `prefersReducedMotion(win?)` reads the media query.

## More widgets and helpers

- **Overlay types.** `createOverlay(opts: OverlayOptions)` (`parent`, `designWidth`,
  `designHeight`, `layout`, `theme`, `caption`, `maxToasts`, `focusHome`) returns an `Overlay`;
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
  `BarOptions`, `KeyPromptOptions`, `StepperOptions`, `CooldownOptions` and the handles `WidgetReticle`,
  `Bar`, `Segmented`, `Select`, `KeyPrompt`, `Stepper`, `Cooldown`. `h`'s children are `Child` (`Node`, string,
  number or nothing); `append(el, ...children)` adds them to an existing element.
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

## Accessibility checklist

- Panels have `role=dialog` (or `alertdialog`), `aria-modal`, and are labelled by their title.
- Focus is trapped in a modal and restored when it closes. Lower layers are `inert`.
- Every focusable element gets a visible `:focus-visible` ring (`--tc-focus-ring`, `--tc-color-focus`).
- Captions and toasts use polite live regions.
- Buttons are at least 64 design px tall, which is about 32 CSS px at a 960×540 embed.

## Tests

`hud.test.ts` covers the HUD widgets (DOM shape, aria, clamping, wrapping, heading offsets, the modal rule, pulse). `ui.test.ts` runs under happy-dom and covers theme var names, overlay mount and scaling,
client→design mapping, the modal focus trap, Esc, focus restore, inert stacking, non-modal panels,
backdrop clicks, toast caps and timers, caption typing / hold / skip / queue / reduced motion / suspend / onPlace, and
the slider's aria-valuetext. Layout and focus were also checked once in Chromium via Playwright (not
part of CI).
