/**
 * Pairs: the whole game is this file plus `rules/`, `scenes/`, `save/`, `layout/` and `ui/`.
 * `createGame` boots WebGPU on a letterboxed surface and hands back the engine ctx (renderer,
 * camera, input with its gestures, overlay with its layout, save, scene stack, loop). The game
 * widens that object with its own nouns and pushes one scene.
 */
import { createGame } from '@thunderclap/engine';
import { createAnalytics } from '@thunderclap/engine/analytics';
import { COLLECT_URL, createBeaconSink, type Events } from './analytics';
import { type Action, bindings, type Game, type GameCtx } from './ctx';
import { layoutSpec } from './layout/spec';
import { createBoard } from './rules/board';
import { createProgressStore, type ProgressStore } from './save/schema';
import { createBoardScene } from './scenes/board';
import { createHud } from './ui/hud';

const COLS = 4;
const ROWS = 4;
/** The `level` prop of the analytics events: this template has one board size. */
const LEVEL = `${COLS}x${ROWS}`;

declare global {
  interface Window {
    __template?: { scene: string; frames: number; cursor: number };
  }
}

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
  // Analytics only when there is somewhere to send them; the engine never posts on its own.
  const analytics = COLLECT_URL
    ? createAnalytics<Events>({
        sink: createBeaconSink(COLLECT_URL),
        onError: (e) => console.warn('analytics', e),
      })
    : null;
  analytics?.attach(engine);

  const game: Game = {
    board: createBoard(COLS, ROWS, engine.save.get().seed),
    cursor: 0,
    dealtAt: Date.now(),
  };
  const ctx: GameCtx = Object.assign(engine, {
    game,
    analytics,
    newGame() {
      const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0;
      game.board = createBoard(COLS, ROWS, seed);
      game.cursor = 0;
      game.dealtAt = Date.now();
      ctx.save.update((d) => ({ ...d, seed }));
      analytics?.emit('level_start', { level: LEVEL });
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

  // `window.__template`: the top scene's name, the frame count and the cursor, for the repo's
  // smoke e2e (`e2e/templates.spec.ts`). Updated after every rendered frame.
  const probe = { scene: '', frames: 0, cursor: 0 };
  window.__template = probe;
  engine.hooks.afterRender = () => {
    probe.scene = ctx.stack.top?.name ?? '';
    probe.frames++;
    probe.cursor = game.cursor;
  };

  analytics?.emit('level_start', { level: LEVEL });
  ctx.stack.push(createBoardScene(ctx));
  ctx.loop.start();
}
