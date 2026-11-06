# demos/range

A first-person target range: a courtyard with twelve plates on posts. Run it with `pnpm demo range`
(or `pnpm exec vite demos/range --host 127.0.0.1`). To start a first-person game of your own from
this shape, `pnpm create-game --template first-person` scaffolds a project on the same public API.

**What it shows.** Click to take the pointer lock, then the mouse looks; a touch drags the view
(no move stick); the pad's right stick looks. A click, tap or trigger fires a ray from the eye along
the view direction (the `ui.reticle` dot at the screen centre). A hit knocks the plate over on its
hinge (a `tween` sequence), bursts sparks, draws a tracer along the shot, plays a synthesised
chime positioned at the plate, pulses the reticle and adds to the score on a billboard name plate
over the far row. A plate rises again 3 s after it fell. A shot into the sky or at a plate already
down is a miss; a miss into the backstop leaves a `Decals` bullet hole where the tracer ends.

## What to look at

- The reticle is `ui.reticle({ style: 'dot' })` on the overlay's hud layer: it follows the frame on
  every resize and pulses (`reticle.pulse()`) on a hit.
- One `geom` cube (`box()`) draws every post, plate, wall and the ground under a `Transform`; the
  same vertex and index arrays feed one `meshTester` per plate, so a plate is picked exactly as drawn,
  mid-fall included.
- The hinge: each plate is a child `Transform` of a hinge on top of its post; a hit runs one
  `tweens.sequence` (fall 0.35 s `cubicOut` in parallel with the `params.y` flash, a delay, rise
  0.45 s `quadInOut`) whose `.then` marks the plate shootable again.
- The score is a `createBillboards` name plate over the far row: `plates.text()` draws it into
  the atlas, `size: { px }` keeps it the same size at any distance and `depth: 'always'` keeps
  it over the wall.
- Bullet holes: a shot that reaches the far wall's face stamps a box `Decals` mark there (normal
  +z, 20 s life); `__demo.state.decals` counts the live ones.
- The tracer is a `Trail` of 24 points pushed in one go from under the eye to where the shot ended;
  the sparks are a world-space `ParticleSystem` with a floor and bounce.
- The chime is a spatial voice (`at` the plate, linear rolloff) with `audio.listener.fromCamera`,
  so a far-row hit sounds farther and off to the side.

## Known limits

The backstop is the only decal surface (the ground and side walls take none); the muzzle itself
leaves no mark, the hole is where the shot lands. Nothing moves without input, so the range has
no `?still`.

**Engine modules.** `input` (`Look`, `Gestures`, `Input`, one `meshTester` per plate over the cube
it draws, `createRay`), `geom` (`box`), `render` (perspective `Camera`, `Transform` parent chains
for the hinges, `Lights`, a lit material), `fx` (`ParticleSystem` in world space, `Trail`,
`Decals`, `createBillboards` with `text`), `tween` (`createTweens`, `ease`), `audio`
(`AudioEngine`, `recipes`, spatial `at` voices, `listener.fromCamera`), `ui` (`createOverlay`,
`reticle`, toasts), `platform` (`boot`), `core` (`GameLoop`).

**What the spec checks** (`e2e/demos/range.spec.ts`, every matrix row, via the harness server's `/demos/range/` route): boot
with every target standing and no console errors; `__demo.aimAt(3)` then a click (a CDP tap on
touch rows) sets `lastHit` 3, `score` 1, `targetsUp` 11, and the target stands again after the
reset; a shot at the sky (`__demo.aim(0, 1.2)`) grows `shots` but not `score`; a shot between
the posts into the backstop (`__demo.aim(0, -0.05)`) leaves one decal (`decals` 1) and no score;
touch rows: a tap fires; desktop rows: `fps` above 20. `window.__demo.state` also carries `frame`,
`stats` (`drawCalls`, `instances`, `culled`), `aimDir`, `yaw`, `pitch`, `locked` and `gpuErrors`.
