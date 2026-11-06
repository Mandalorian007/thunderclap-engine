# Brief: ws/look-zoom

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/input/look.ts` (`Look`, `LookOptions`, the per-tick `look`/`move` reporting, pad sticks, DOM listener), `src/input/look.dom.test.ts`, `src/input/follow.ts` (`Follow.zoom(steps)`, `setLook`), `src/input/follow.test.ts`, `src/input/input.ts` (`setLook`, wheel handling if any), `src/input/README.md` *Look* and *Follow*, `harness/follow.ts`.

## Goal

`Look` reports a zoom axis the way it reports `look` and `move`, from the mouse wheel, pinch on touch, and the pad's right-stick vertical or shoulder buttons when the game opts in; `Follow` reads it directly so a third-person game needs no wheel binding of its own.

STATUS row, *done when*: `Look.zoom: number` (this tick, wheel notches or stick units, positive = closer), `LookOptions.zoom?: { wheel?: boolean; pinch?: boolean; pad?: 'rightStickY' | 'shoulders' | 'none'; stepPx?: number }` (default wheel + pinch on, pad `'none'`), `Follow` consumes `look.zoom` when linked (its `zoom(steps)` stays); harness `follow.html` drops its own wheel binding and still zooms; wheel and pinch covered by DOM tests; documented.

## Scope

- `look.ts`: the DOM listener gains `wheel` (passive, `deltaMode` normalised to notches: 100 px or `stepPx` per notch) and a two-finger pinch when `pinch` is on (distance delta divided by `stepPx`; the pinch must not steal the move stick or a look drag already in progress: a second touch while one drag is active starts a pinch, and release ends it). `zoom` resets each tick like `look.dx`. Pad: `rightStickY` reads the same stick `look` uses only when `pad: 'rightStickY'` (then look.dy from the stick is zero: document the trade), `shoulders` reads the two shoulder buttons as ±1 per tick.
- `follow.ts`: in `update`, when a `Look` is linked and `look.zoom !== 0`, call `this.zoom(look.zoom)`. Nothing else changes.
- Harness `follow.ts`: remove the `{ wheel: ±1 }` Input binding, keep `Look`; state unchanged.
- Tests: `look.dom.test.ts` wheel notches, `deltaMode` lines/pages, pinch start/move/end with a live move stick; `follow.test.ts` zoom through a linked fake look.
- Docs: `src/input/README.md` *Look* (zoom axis) and *Follow* (reads it), CHANGELOG one line, ARCHITECTURE *Input* one clause if the sentence lists axes.

## Files owned

`src/input/look.ts`, `src/input/look.dom.test.ts`, `src/input/look.test.ts`, `src/input/follow.ts`, `src/input/follow.test.ts`, `harness/follow.ts`, `src/input/README.md` (*Look*, *Follow*), `CHANGELOG.md`, `ARCHITECTURE.md` (one clause).

Branch from `main` (3813f8c or later). Running alongside: ws/pick (`rays.ts`, `input/index.ts` append, README *Rays*), ws/template-first-person (uses `Look`, no edits to it), ws/doc-sweep-3 (README tables).
