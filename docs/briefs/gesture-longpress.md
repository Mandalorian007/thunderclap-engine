# Brief: ws/gesture-longpress

Read `docs/briefs/common.md` first, then DECISIONS E-017, E-019; `src/input/gestures.ts` whole (`Gestures`, `pointerMove`, `checkLongPress`, `panThreshold`, `longPressMs`, `Session.longPressed`, how pans and drags are reported per tick), `src/input/gestures.test.ts`, `src/input/README.md` *Gestures*, `e2e/gestures.spec.ts`, `e2e/mesh.spec.ts` `drag()` helper on main (ws/flake-input's ≥12 px steps), `e2e/golden/gestures.png` and `scripts/snap.mjs` (the 2D gestures page is in the snapshot gate: it must stay pixel-identical).

## Goal

A finger that moves is a pan, however slow the frame. Today `pointerMove` evaluates the long-press timer before the pan threshold, so a drag whose first steps are under 10 px during a long frame commits as a long-press and every later move is ignored. The fix is order and a cancel; the rest is making the gesture stream observable so a test or a game can see what the recogniser decided without reading engine code.

STATUS row, *done when*: in `pointerMove`, the pan threshold is checked before the long-press timer, and a session whose cumulative travel crosses `panThreshold` can never long-press (a pending long-press is cancelled, a committed one stays committed as today, since it already fired); a session's travel is measured from the down point (cumulative distance, not last-step distance), so slow drags cross the threshold; `Gestures.onGesture(listener: (kind: 'tap' | 'doubleTap' | 'longPress' | 'pan' | 'drag' | 'pinch', phase: GesturePhase, g: GesturePoint) => void): () => void` fires synchronously at recognition time (not per tick) and is documented as an observer, not a replacement for the per-tick fields; the mesh `drag()` helper's 12 px workaround is no longer needed but stays; tests; `pnpm snap:check` passes untouched; documented.

## Scope

- `gestures.ts`: reorder the move path; add `travel` (cumulative) to the session; cancel a pending long-press on threshold crossing; `onGesture` with a small listener array (no allocation per event beyond the call). Mouse and pen follow the same rule.
- Tests `gestures.test.ts`: slow drag with 6 px steps and a simulated 500 ms gap between frames reports a pan and no long-press; a still finger for 500 ms reports long-press; a finger that moves 4 px then 4 px then 4 px (12 cumulative) pans; listener receives start/move/end for a pan and one call for a tap; unsubscribe works.
- `e2e/gestures.spec.ts`: one new test only if a tap/long-press/pan interaction is not already asserted; do not change existing assertions. `pnpm snap:check` must pass: no visible change on the 2D page.
- Docs: `src/input/README.md` *Gestures* (threshold rule, `onGesture`), CHANGELOG under *Fixed* (ws/flake-input started that section: append), ARCHITECTURE *Input* one clause if gestures are described there.

## Files owned

`src/input/gestures.ts`, `src/input/gestures.test.ts`, `src/input/index.ts` (append a type if new), `src/input/README.md` (*Gestures*), `e2e/gestures.spec.ts` (additive only), `CHANGELOG.md`, `ARCHITECTURE.md` (one clause).

Branch from `main` (995a58f or later). Running alongside: integrators landing look-zoom and pick in `src/input` (other files; `index.ts`/README/CHANGELOG appends conflict trivially), ws/ui-hud, ws/geom, ws/ik, ws/anim-graph. Use `E2E_PORT_OFFSET=80`.
