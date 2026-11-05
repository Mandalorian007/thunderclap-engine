/**
 * createGame harness page (D-041 addendum 2). Noun-free: it boots through `createGame` exactly
 * as a game does, with one empty scene, a probe save and one `tap` action, so the specs verify
 * the engine's wiring once for every game:
 *
 * - e2e/lifecycle.spec.ts: hidden, pagehide and freeze stop frames and audio and flush the save;
 *   show resumes them; audio unlocks on the first gesture; browser zoom is blocked.
 * - e2e/surface.spec.ts: resize and DPR changes mid-scene keep canvas, overlay and backbuffer in
 *   step; a lost device shows the reload screen and halts everything behind it.
 */
import { createGame } from '@thunderclap/engine';
import { createSaveStore, s } from '@thunderclap/engine/save';
import type { HarnessGameApi, HarnessGameState } from './game-state';

const root = document.getElementById('root') as HTMLElement;
const SaveData = s.object({ n: s.number() });

const state: HarnessGameState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  updates: 0,
  hides: 0,
  lost: 0,
  loopRunning: false,
  loopHalted: false,
  audio: 'locked',
  backbuffer: { width: 0, height: 0, pixelRatio: 1 },
  canvas: { width: 0, height: 0 },
  devicePixelRatio: window.devicePixelRatio,
  taps: [],
};

let api: Omit<HarnessGameApi, 'state'> = {
  write() {
    throw new Error('not booted');
  },
  stored: () => null,
};

window.__harnessGame = {
  state: () => state,
  write: (n) => api.write(n),
  stored: () => api.stored(),
};

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine harness',
    save: (host) =>
      createSaveStore({
        game: 'harness',
        slot: 'game',
        version: 1,
        defaults: () => ({ n: 0 }),
        schema: SaveData,
        host,
        // Only a flush stores it, and the store's own page-hide flush is off: the specs check
        // that createGame flushes.
        debounceMs: 60_000,
        autoFlush: false,
      }),
    mixerKey: 'harness',
    input: { bindings: { tap: [{ mouse: 0 }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  state.gpu = 'ok';
  const { hooks, loop, audio, surface, save, input, host } = ctx;
  const sync = () => {
    state.loopRunning = loop.isRunning;
    state.loopHalted = loop.halted;
    state.audio = audio.state;
    state.backbuffer = { ...surface.backbuffer };
    state.canvas = { width: surface.canvas.width, height: surface.canvas.height };
    state.devicePixelRatio = window.devicePixelRatio;
  };
  hooks.update = () => {
    state.updates++;
    if (input.pressed('tap')) state.taps.push({ x: input.pointer.x, y: input.pointer.y });
  };
  hooks.afterRender = () => {
    state.frames++;
    sync();
  };
  hooks.hide = () => {
    state.hides++;
  };
  hooks.deviceLost = () => {
    state.lost++;
  };
  window.__harnessGame = {
    state: () => {
      sync();
      return state;
    },
    write: (n) => {
      save.update((d) => {
        d.n = n;
        return d;
      });
    },
    stored: () => {
      const raw = host.storage.open()?.getItem(save.key);
      if (!raw) return null;
      const n = (JSON.parse(raw) as { d?: { n?: unknown } }).d?.n;
      return typeof n === 'number' ? n : null;
    },
  };
  api = window.__harnessGame;
  ctx.stack.push({});
  loop.start();
  surface.canvas.focus();
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
