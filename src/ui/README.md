# engine/ui

The DOM overlay that sits on top of the WebGPU canvas: panels, toasts, a speech/caption card, small
widgets and theme tokens. It has no dependencies and no game nouns.

## Overlay

```ts
import { createOverlay } from '@thunderclap/engine/ui';

const ui = createOverlay({ parent: stageEl, theme: { colorAccent: '#7fd' } });
platform.onResize((rect) => ui.setRect(rect)); // letterboxed canvas rect, CSS px relative to parent
input.blocked = () => ui.stack.hasModal;       // the game ignores input while a modal is open
```

- The UI is laid out at **design resolution** (1920×1080 by default) and one CSS transform scales it
  into the rect. Sizes in CSS and theme tokens are therefore design pixels. When the rect's aspect
  ratio differs from the design's, the overlay is centred inside it.
- The root and its layers are `pointer-events: none`. Only interactive elements (buttons, panels,
  toasts, the caption card) take the pointer, so clicks on empty space still reach the canvas.
- Layers, bottom to top: `hud`, `captions`, `panels`, `toasts`. A modal panel always covers the
  caption card, and the overlay also suspends the card (hidden, timers frozen) while a modal is open. Game HUD elements go in
  `ui.layers.hud`.
- `ui.clientToDesign(clientX, clientY)` maps viewport coordinates to design space, or returns null
  outside the overlay. Platform owns the canonical transform, so prefer that one.
- The `parent` must be a positioned element (`position: relative`, `fixed` or `absolute`).

## Panels: `ui.stack`

```ts
const p = ui.stack.push({ title: 'Settings', content: el, onClose: (why) => {} });
p.close();
```

- **Modal** (the default): dims the background, traps Tab inside the panel, and makes lower panels
  plus the `hud` and `captions` layers `inert`. `hasModal` stays true while it is open.
- **Esc** closes the top panel if it is dismissible (the default). The handler calls
  `preventDefault` and `stopPropagation` from a `document` listener, so a key listener on `window`,
  which is where `Input.attach` listens, does not see that Escape. Clicking the backdrop also
  closes the panel unless `closeOnBackdrop: false`.
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
  sentence once and never hear the typewriter, and the visible card is `aria-hidden`.
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
- Size: the card is as wide as its text needs, up to `--tc-caption-max-width` (default 720px), and
  sits `--tc-caption-margin` from the edges. It has no max height and long words wrap, so text is
  never clipped. Set both vars on `.tc-overlay` to tune them per game.
- `avoid(rect | rect[] | null)` keeps the card off parts of the screen (container px, i.e. design px
  for `ui.caption`). The card stays in its corner if it fits, else narrows (down to
  `caption: { minWidth }`, default 480), else tries the mirrored corner, then the opposite edge, and
  takes the first spot that touches nothing (or the one that covers least). It applies to the line
  on screen and every later one until changed. It is not cleared on its own: a scene that sets it
  clears it (`avoid(null)`) when it leaves.
- `suspend(on)` hides the card and freezes its typing and hold. `suspend(false)` resumes where it
  was with a fresh hold. `say()` still queues while suspended. The overlay calls it for modals.

## Widgets and helpers

- `button(label, onClick, { variant: 'default' | 'primary' | 'ghost', disabled, ariaLabel })`
- `slider(label, value, onInput, { min, max, step, format })` returns `{ element, input, set }`.
  `format` fills in `aria-valuetext`.
- `toggle(label, checked, onChange)` returns `{ element, input, set }`.
- `h(tag, props, ...children)` is hyperscript. It handles `class`, `style` (including `--custom`
  properties), `dataset` and `on: { click }`. Any other prop becomes an attribute: `true` sets an
  empty attribute and `false`/null omits it.
- `focusableWithin(el)` lists the focusable descendants of an element, skipping `inert` and `hidden`
  subtrees.

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

The base stylesheet (`BASE_CSS`) is injected once per document, and every rule in it is scoped under
`.tc-overlay`. Under `prefers-reduced-motion: reduce` it turns off all animations and transitions
inside the overlay.

## Accessibility checklist

- Panels have `role=dialog` (or `alertdialog`), `aria-modal`, and are labelled by their title.
- Focus is trapped in a modal and restored when it closes. Lower layers are `inert`.
- Every focusable element gets a visible `:focus-visible` ring (`--tc-focus-ring`, `--tc-color-focus`).
- Captions and toasts use polite live regions.
- Buttons are at least 64 design px tall, which is about 32 CSS px at a 960×540 embed.

## Tests

`ui.test.ts` runs under happy-dom and covers theme var names, overlay mount and scaling,
client→design mapping, the modal focus trap, Esc, focus restore, inert stacking, non-modal panels,
backdrop clicks, toast caps and timers, caption typing / hold / skip / queue / reduced motion / suspend / avoid placement, and
the slider's aria-valuetext. Layout and focus were also checked once in Chromium via Playwright (not
part of CI).
