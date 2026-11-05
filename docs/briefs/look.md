# Brief: ws/look

Read `docs/briefs/common.md` first, then `docs/VISION.md` (pillar 2; Forgewilds: pointer lock, Bedrock-style touch, pad), DECISIONS E-009, E-013; `ARCHITECTURE.md` *Input*; `src/input/README.md`; `src/input/input.ts` (how `Gestures` and the pointer router are linked: `setGestures`/`setPointers`, `blocked()`, attach, `update()`), `src/input/gestures.ts`, `src/input/types.ts`.

## Goal

A first-person or third-person game reads `look` (yaw, pitch delta) and `move` (x, y in -1..1) each tick and never sees a mouse, a touch or a stick. The same `Look` works with pointer lock on desktop, a two-zone touch layout on phones, and the pad's sticks.

STATUS row, *done when*: `Look` linked through `input.setLook` reports `look`/`move` from pointer lock, touch zones and sticks; pointer lock requested and released through it; harness `look.html` on the matrix.

## Scope

1. **`input/look.ts`.** `class Look { constructor(opts: LookOptions); look: { dx, dy } (radians, per tick); move: { x, y }; locked: boolean; request(): Promise<boolean>; release(); update(); attach(el); detach() }`. Options: `sensitivity` (radians per CSS px, default 0.0025), `padSensitivity` (radians per second at full deflection), `invertY`, `touch: { moveZone: 'left' | 'right' | 'none', deadzone }`, `now`. Mouse: deltas only while `document.pointerLockElement` is the attached element (`movementX/Y`); the game calls `request()` on a tap or click because browsers require a gesture. Touch: the pointer that lands in the move zone (left half by default) is a virtual stick (deadzone, clamped to a radius in CSS px, reported as `move`); any other touch drags look. Pad: left stick → `move`, right stick → `look` scaled by `padSensitivity · dt`. Report per tick like `Gestures`; while `blocked()` report zeros and release the lock. No allocation per tick.
2. **Wiring.** `input.setLook(look)` (or a `look` constructor option) links it like gestures: shared `blocked()` and transform, attached by `Input.attach`, advanced in `Input.update()`. Bindings: `{ look: 'move' }` is not needed; games read `input.look` directly. `createGame` does **not** build one (a 2D game pays nothing); document the two lines a game adds.
3. **Lock lifecycle.** `pointerlockchange`/`pointerlockerror` listeners; `locked` tracks the element; `release()` calls `document.exitPointerLock` only when we hold it. Expose `onLockChange` through the core `Emitter`.
4. **Harness.** `harness/look.html` + `look.ts`: a perspective camera over the mesh-page cube field, yaw/pitch from `look`, walk with `move`; state object exposes yaw, pitch, position, locked. `e2e/look.spec.ts`: on touch rows, a drag on the right half changes yaw and a drag on the left half moves; on desktop rows, keyboard WASD moves and a synthesized `mousemove` with pointer lock is not testable, so assert `request()` resolves false or true without throwing and that `locked` is false after `release()`.

## Files owned

`src/input/look.ts` (new), `src/input/look.test.ts`, `src/input/look.dom.test.ts`, `src/input/input.ts` (`setLook` + the `look` option + its calls in `attach`/`detach`/`update`; nothing else), `src/input/index.ts` (append), `src/input/README.md` (a *Look* section), `harness/look.html`, `harness/look.ts`, `harness/look-state.ts`, `harness/index.html` or wherever the page list lives (one line), `e2e/look.spec.ts`, `ARCHITECTURE.md` *Input* (one sentence), `CHANGELOG.md`.

Running alongside: ws/xr adds `input/xr-source.ts` and appends to `input/index.ts`; ws/prune removes a few `input/index.ts` lines (merged first). ws/anchors owns `src/ui/`. Nothing else touches `input.ts`.
