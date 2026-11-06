# Brief: ws/ui-widgets

Read `docs/briefs/common.md` first, then DECISIONS E-021 (demos as quality validation); `src/ui/widgets.ts` whole (`button`, `slider`, `toggle` and the `h` helper they use), `src/ui/dom.ts`, `src/ui/styles.ts` (how `BASE_CSS` names classes and theme variables; read only, do not edit), `src/ui/README.md` *Widgets and helpers* and *More widgets and helpers*, `src/ui/ui.test.ts` (how widgets are tested with the DOM), `demos/range/main.ts` and `demos/arena/main.ts` on your base if present (what they hand-roll today; read only).

## Goal

The widgets a demo or game builds itself today, made once in the engine with keyboard, pointer and pad behaviour, labels and theme classes: a reticle, a progress/health bar, a segmented choice, a select, a key-prompt chip, a numeric stepper, and a radial cooldown. DOM only; every widget is a plain element with a small handle; nothing in the panel stack or overlay changes.

STATUS row, *done when*: in `src/ui/widgets-2.ts` (exported from `ui/index.ts`): `reticle(opts?: { size?, thickness?, gap?, dot?, color? })` → `{ element, set(spread: 0..1), hit(), hide/show }` drawn with CSS only, centred by its parent; `bar(label, value, { min?, max?, segments?, tone?, format? })` → `{ element, set(value), tone(t) }` with `role=progressbar` and `aria-valuetext`; `segmented(label, options: { value, label }[], value, onChange)` → `{ element, set, value }` with roving tabindex, ArrowLeft/Right, `role=radiogroup`; `select(label, options, value, onChange)` → `{ element, select, set }` wrapping a native `<select>` with the theme class; `keyPrompt(action, { key?, pad? })` → `{ element, set(key, pad?) }` showing the bound key or pad glyph text (strings in, no icon font); `stepper(label, value, onChange, { min, max, step, format? })` → `{ element, set, value }` with −/+ buttons, ArrowUp/Down and Home/End, `role=spinbutton`; `cooldown(opts?: { size? })` → `{ element, set(fraction: 0..1), ready }` as a conic-gradient sweep with `aria-hidden`. Each returns `destroy()`-free plain elements, zero per-frame allocations in `set`; classes follow the `tc-ui-*` convention; CSS for the new widgets in a new `WIDGETS2_CSS` string in `widgets-2.ts` that `createOverlay` injects once (one appended line in `overlay.ts` after the existing style injection, nothing else there); unit tests; harness `widgets.html` on the matrix; documented.

## Scope

- `src/ui/widgets-2.ts` + `widgets-2.test.ts`: behaviour through `h`; ARIA per widget above; `segmented`/`stepper` consume only the arrow keys they use (so `PanelStack`'s arrow walk from ws/ergo-2d keeps working for ArrowUp/Down over a `segmented`). Theme variables only from the existing set in `styles.ts` (read it for names; add none).
- `src/ui/overlay.ts`: one line injecting `WIDGETS2_CSS` beside the existing `BASE_CSS` injection (same id convention, `tc-ui-widgets-2`). ws/ui-hud is landing with its own `HUD_CSS` second style: expect a one-line adjacent conflict the integrator keeps both of.
- Harness `harness/widgets.html` + `widgets.ts` + `widgets-state.ts`: every widget once, a reticle over a dark canvas, state exposes `bar`, `segment`, `stepper`, `cooldownReady`, `reticleSpread`; api `set` per widget. `e2e/widgets.spec.ts`: ArrowRight moves the segmented value, ArrowUp steps the stepper, `bar.set` updates `aria-valuenow`, cooldown `ready` flips at 1.
- Docs: ui README *Widgets and helpers* bullets for the seven widgets; CHANGELOG one line; ARCHITECTURE UI clause (one); root README harness list item.

## Files owned

`src/ui/widgets-2.ts`, `src/ui/widgets-2.test.ts`, `src/ui/index.ts` (append), `src/ui/overlay.ts` (one line), `src/ui/README.md` (*Widgets and helpers* bullets), `harness/widgets.*`, `e2e/widgets.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one clause), `CHANGELOG.md`.

Branch from `main` (5e6177a or later). Running alongside: ws/ui-hud (landing; `src/ui/hud.ts`, `styles.ts`), ws/ergo-2d (landing; `stack.ts`, `dom.ts`, `padnav.ts`), ws/perf-overlay (landing; `src/ui/perf.ts`): do not edit any of those. `src/ui/index.ts`: append only.
