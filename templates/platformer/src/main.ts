/**
 * Skyline: the whole game is this file plus `levels/`, `physics/`, `world/`, `scenes/`, `ui/`,
 * and `save/`. `createGame` boots WebGPU on a letterboxed 1920×1080 design surface with a
 * fixed-step sim and hands back the engine ctx; the game paints its atlas, defines its sounds,
 * widens the ctx with its own nouns and pushes the title.
 */
import { createGame } from '@thunderclap-engine/engine';
import { recipes } from '@thunderclap-engine/engine/audio';
import { createTouchZones } from '@thunderclap-engine/engine/input';
import { createTweens } from '@thunderclap-engine/engine/tween';
import { type Action, bindings, buttonKeys, type GameCtx, type Run, touchZones } from './ctx';
import { createProgressStore, type ProgressStore, START_LIVES } from './save/schema';
import { createLevelScene } from './scenes/level';
import { createTitleScene } from './scenes/title';
import { buildAtlas } from './world/atlas';
import { buildFrames } from './world/world';

declare global {
  interface Window {
    __template?: { scene: string; frames: number };
  }
}

const engine = await createGame<Action, ProgressStore, GameCtx>({
  root: document.getElementById('app')!,
  title: 'Skyline',
  design: { width: 1920, height: 1080 },
  save: (host) => createProgressStore({ host }),
  input: { bindings, buttonKeys },
  particles: { capacity: 2048 },
});

if (engine) {
  const atlasTex = engine.renderer.textureFromSource(buildAtlas(), 'atlas');
  const atlas = engine.renderer.createSpriteMaterial({
    texture: atlasTex,
    label: 'atlas',
    sampler: 'nearest-clamp',
  });
  const tweens = createTweens();
  const run: Run = { lives: engine.save.get().lives || START_LIVES, levelIndex: 0 };

  const ctx: GameCtx = Object.assign(engine, {
    atlas,
    frames: buildFrames(),
    tweens,
    run,
    startLevel(level) {
      ctx.stack.replace(createLevelScene(ctx, level));
    },
    toTitle() {
      ctx.stack.replace(createTitleScene(ctx));
    },
  } satisfies Omit<GameCtx, keyof typeof engine>);

  // The thumb zones feed `left`/`right`/`jump`/`dash` through the same actions the keys do.
  createTouchZones(engine.input, touchZones);

  engine.hooks.update = (dt) => tweens.update(dt);

  // Synthesised sounds: no files. `prepare` renders them once; the first user gesture unlocks
  // the context.
  ctx.audio.define('jump', recipes.whoosh({ direction: 'up', length: 0.5, brightness: 0.6 }));
  ctx.audio.define('coin', recipes.chime({ pitch: 1320, length: 0.5, brightness: 0.7 }));
  ctx.audio.define('hurt', recipes.thud({ pitch: 90, length: 0.8, brightness: 0.3 }));
  await ctx.audio.prepare();

  if (!ctx.save.persistent) {
    ctx.ui.toasts.show('Progress will not be saved in this browser.', {
      tone: 'warn',
      duration: 4000,
    });
  }

  // Dev only: lets a browser console (or a smoke script) read `renderer.stats` and drive scenes.
  if (import.meta.env.DEV) (window as unknown as { __game: GameCtx }).__game = ctx;
  // `window.__template`: the top scene's name and the frame count, for the repo's smoke e2e
  // (`e2e/templates.spec.ts`). Updated after every rendered frame.
  const probe = { scene: '', frames: 0 };
  window.__template = probe;
  engine.hooks.afterRender = () => {
    probe.scene = ctx.stack.top?.name ?? '';
    probe.frames++;
  };

  ctx.stack.push(createTitleScene(ctx));
  ctx.loop.start();
}
