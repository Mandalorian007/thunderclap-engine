# demos/range

A first-person target range: a courtyard with twelve plates on posts. Run it with `pnpm demo range`
(or `pnpm exec vite demos/range --host 127.0.0.1`).

**What it shows.** Click to take the pointer lock, then the mouse looks; a touch drags the view
(no move stick); the pad's right stick looks. A click, tap or trigger fires a ray from the eye along
the view direction (the CSS reticle at the screen centre). A hit knocks the plate over on its hinge
(a hand-written tween), bursts sparks, draws a tracer along the shot, plays a synthesised chime
positioned at the plate and adds to the score in a world anchor over the far row. A plate rises
again 3 s after it fell. A shot into the sky or at a plate already down is a miss.

**Engine modules.** `input` (`Look`, `Gestures`, `Input`, one `meshTester` per plate over the cube
it draws, `createRay`), `render` (perspective `Camera`, `Transform` parent chains for the hinges,
`Lights`, a lit material), `fx` (`ParticleSystem` in world space, `Trail`), `audio` (`AudioEngine`,
`recipes`, spatial `at` voices, `listener.fromCamera`), `ui` (`createOverlay`, anchors, toasts),
`platform` (`boot`), `core` (`GameLoop`).

**What the spec checks** (`e2e/demos/range.spec.ts`, every matrix row, via the harness server's `/demos/range/` route): boot
with every target standing and no console errors; `__demo.aimAt(3)` then a click (a CDP tap on
touch rows) sets `lastHit` 3, `score` 1, `targetsUp` 11, and the target stands again after the
reset; a shot at the sky (`__demo.aim(0, 1.2)`) grows `shots` but not `score`; touch rows: a tap
fires; desktop rows: `fps` above 20. `window.__demo.state` also carries `frame`, `stats`
(`drawCalls`, `instances`, `culled`), `aimDir`, `yaw`, `pitch`, `locked` and `gpuErrors`.
