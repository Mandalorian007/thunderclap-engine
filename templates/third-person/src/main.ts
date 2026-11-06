/**
 * Ember Reach: a third-person action game on a `geom` heightfield. The whole game is this file
 * plus `character/` (the generated rig, the controller, the graph and the cosmetics table: pure
 * where it can be), `enemies/`, `world/` (pure), `scenes/` and `ui/`.
 *
 * `createGame` boots WebGPU on a letterboxed surface and hands back the engine ctx. This game is
 * a client: `sim: false` runs the loop at render rate and there is no `save`, so the engine never
 * touches storage. The game widens the ctx with its own nouns, links one `Look` (move keys, touch
 * zones, sticks, wheel and pinch for the zoom) and one `Follow` (the orbit camera) and pushes one
 * scene.
 */
import { createGame } from '@thunderclap/engine';
import { Follow, Look } from '@thunderclap/engine/input';
import { type Action, bindings, type GameCtx, type Player } from './ctx';
import { createArenaScene } from './scenes/arena';

const engine = await createGame<Action, null, GameCtx>({
  root: document.getElementById('app')!,
  title: 'Ember Reach',
  design: { width: 1920, height: 1080 },
  sim: false,
  input: { bindings, buttonKeys: ['Space', 'ShiftLeft'] },
});

if (engine) {
  // The Look: the move keys, the left touch zone as a stick, the pad's left stick for `move`;
  // a mouse drag, the right touch zone and the right stick for `look`; the wheel, a pinch and
  // the shoulder buttons for `zoom`.
  const look = new Look({
    keys: {
      forward: ['KeyW', 'ArrowUp'],
      back: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
    },
    touch: { moveZone: 'left' },
    zoom: { wheel: true, pinch: true, pad: 'shoulders' },
  });
  engine.input.setLook(look);

  // A third-person camera orbits on a plain drag, no pointer lock: `Look.attach` only feeds the
  // mouse while locked, so the page forwards an unlocked drag itself.
  const canvas = engine.surface.canvas;
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') dragging = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging && e.pointerType === 'mouse' && !look.locked)
      look.mouseMove(e.movementX, e.movementY);
  });
  const stop = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  // The Follow: an over-the-shoulder orbit around the controller (feet + eyeHeight), zoomed by
  // `Look.zoom`, eased so a sprint does not jerk the frame.
  const follow = new Follow(engine.camera, {
    distance: 4.5,
    minDistance: 1.6,
    maxDistance: 9,
    shoulder: [0.45, 0],
    eyeHeight: 1.45,
    smoothing: 0.1,
    pitch: -0.28,
    pitchMin: -1.1,
    pitchMax: 0.6,
    zoomStep: 0.5,
  });

  const player: Player = { health: 5, maxHealth: 5, kills: 0 };
  const ctx: GameCtx = Object.assign(engine, {
    look,
    follow,
    player,
    hud: null as unknown as GameCtx['hud'],
  });

  ctx.stack.push(createArenaScene(ctx));
  ctx.loop.start();
}
