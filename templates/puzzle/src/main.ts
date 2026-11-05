/**
 * Pairs: the whole game is this file plus `rules/`, `scenes/`, `save/`, `layout/` and `ui/`.
 * `createGame` boots WebGPU on a letterboxed surface and hands back the engine ctx (renderer,
 * input, overlay with its layout, save, scene stack, loop). The game widens that object with its
 * own nouns and pushes one scene.
 */
import { createGame } from '@thunderclap/engine';
import { Gestures } from '@thunderclap/engine/input';
import { type Action, bindings, type Game, type GameCtx } from './ctx';
import { layoutSpec } from './layout/spec';
import { createBoard } from './rules/board';
import { createProgressStore, type ProgressStore } from './save/schema';
import { createBoardScene } from './scenes/board';
import { createHud } from './ui/hud';

const COLS = 4;
const ROWS = 4;

const engine = await createGame<Action, ProgressStore, GameCtx>({
  root: document.getElementById('app')!,
  title: 'Pairs',
  design: { width: 1920, height: 1080 },
  // The save is built from the host so storage comes from the page (localStorage on the web, a
  // file in Electron). Leave `save` out for a client whose state lives on a server.
  save: (host) => createProgressStore({ host }),
  input: { bindings, buttonKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] },
  layout: layoutSpec,
});

if (engine) {
  // Taps (touch, pen, mouse) become the `select` action; the scene reads the tap's position.
  const gestures = new Gestures();
  engine.input.setGestures(gestures);

  const game: Game = { board: createBoard(COLS, ROWS, engine.save.get().seed), cursor: 0 };
  const ctx: GameCtx = Object.assign(engine, {
    gestures,
    game,
    newGame() {
      const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0;
      game.board = createBoard(COLS, ROWS, seed);
      game.cursor = 0;
      ctx.save.update((d) => ({ ...d, seed }));
      hud.refresh();
    },
    refreshHud() {
      hud.refresh();
    },
  });
  const hud = createHud(ctx);

  if (!ctx.save.persistent) {
    ctx.ui.toasts.show('Progress will not be saved in this browser.', {
      tone: 'warn',
      duration: 4000,
    });
  }

  ctx.stack.push(createBoardScene(ctx));
  ctx.loop.start();
}
