/**
 * Highland: a first-person walk over a chunked height field. The whole game is this file plus
 * `world/` (the generator and the mesher, pure), `scenes/` and `ui/`.
 *
 * `createGame` boots WebGPU on a letterboxed surface and hands back the engine ctx. This game is
 * a client: `sim: false` runs the loop at render rate (the scene's `update(dt)` gets the real
 * frame delta) and there is no `save`, so the engine never touches storage. The game widens the
 * ctx with its own nouns, links one `Look` for the camera controls and pushes one scene.
 */
import { createGame } from '@thunderclap/engine';
import { Look } from '@thunderclap/engine/input';
import { type Action, bindings, type GameCtx, type Player, type World } from './ctx';
import { createWorldScene } from './scenes/world';
import { createHud } from './ui/hud';
import { createTerrain, findLandmarks } from './world/terrain';

/** The world's seed: the page and the mesher Worker both generate from it. */
const SEED = 2026;

const engine = await createGame<Action, null, GameCtx>({
  root: document.getElementById('app')!,
  title: 'Highland',
  design: { width: 1920, height: 1080 },
  sim: false,
  input: { bindings, buttonKeys: ['Space', 'ShiftLeft'] },
});

if (engine) {
  // The two lines a first-person game adds: a Look, linked to the input so it shares its block,
  // its attach and its pointer transform. Mouse (pointer lock), two touch zones, pad sticks and
  // the move keys all land in `look.look` and `look.move`.
  const look = new Look({
    keys: {
      forward: ['KeyW', 'ArrowUp'],
      back: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
    },
    touch: { moveZone: 'left' },
  });
  engine.input.setLook(look);
  // Browsers grant the pointer lock only inside a gesture: ask on a mouse click.
  engine.surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });

  const terrain = createTerrain(SEED);
  const world: World = { seed: SEED, terrain, landmarks: findLandmarks(terrain) };
  const player: Player = { position: new Float32Array(3), yaw: 0, pitch: 0 };

  const ctx: GameCtx = Object.assign(engine, {
    look,
    world,
    player,
    hud: null as unknown as GameCtx['hud'],
    respawn() {
      // The middle of the field, facing the summit.
      const x = terrain.size / 2 + 0.5;
      const z = terrain.size / 2 + 0.5;
      const summit = world.landmarks[0]!;
      player.position[0] = x;
      player.position[1] = terrain.heights[Math.floor(z) * terrain.size + Math.floor(x)]!;
      player.position[2] = z;
      player.yaw = Math.atan2(summit.x + 0.5 - x, -(summit.z + 0.5 - z));
      player.pitch = -0.1;
    },
  });
  Object.assign(ctx, { hud: createHud(ctx, look) });

  ctx.respawn();
  ctx.stack.push(createWorldScene(ctx));
  ctx.loop.start();
}
