/**
 * createGame harness page (D-041 addendum 2). Noun-free: it boots through `createGame` exactly
 * as a game does, with one empty scene, a probe save and one `tap` action, so the specs verify
 * the engine's wiring once for every game:
 *
 * - e2e/lifecycle.spec.ts: hidden, pagehide and freeze stop frames and audio and flush the save;
 *   show resumes them; audio unlocks on the first gesture; browser zoom is blocked.
 * - e2e/surface.spec.ts: resize and DPR changes mid-scene keep canvas, overlay and backbuffer in
 *   step; a lost device shows the reload screen and halts everything behind it.
 * - e2e/client.spec.ts (`?mode=client`): a pure client, no save and `sim: false`, renders,
 *   updates once per frame and never reads `host.storage`.
 */
import {
  createGame,
  type EngineCtx,
  type FlushableSave,
  type GameHooks,
} from '@thunderclap-engine/engine';
import { createWebHost, type Host } from '@thunderclap-engine/engine/host';
import { createSaveStore, s } from '@thunderclap-engine/engine/save';
import type { HarnessGameApi, HarnessGameState } from './game-state';

const root = document.getElementById('root') as HTMLElement;
const SaveData = s.object({ n: s.number() });

const client = new URLSearchParams(location.search).get('mode') === 'client';

const state: HarnessGameState = {
  mode: client ? 'client' : 'full',
  ready: false,
  gpu: 'pending',
  frames: 0,
  updates: 0,
  clientFrames: 0,
  storageReads: 0,
  saveNull: false,
  hides: 0,
  lastHide: null,
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

/** The web host, with every `storage` read counted (the client-mode spec expects none). */
function countingHost(): Host {
  const web = createWebHost();
  const host = { ...web };
  Object.defineProperty(host, 'storage', {
    get: () => {
      state.storageReads++;
      return web.storage;
    },
  });
  return host;
}

type Action = 'tap';
const input = { bindings: { tap: [{ mouse: 0 }] } };

/** A pure client: no save, the mixer in memory, the loop at render rate. */
function bootClient(host: Host): Promise<EngineCtx<Action, null> | null> {
  return createGame({ root, title: 'Engine harness', host, sim: false, input });
}

async function main(): Promise<void> {
  const host = countingHost();
  if (client) {
    const ctx = await bootClient(host);
    if (!ctx) {
      state.gpu = 'unsupported';
      state.ready = true;
      return;
    }
    state.saveNull = ctx.save === null;
    ctx.hooks.frame = () => {
      state.clientFrames++;
    };
    const sync = wire(ctx);
    window.__harnessGame = {
      state: () => {
        sync();
        return state;
      },
      write: () => {
        throw new Error('client mode has no save');
      },
      stored: () => null,
    };
    api = window.__harnessGame;
    start(ctx);
    return;
  }
  const ctx = await createGame({
    root,
    title: 'Engine harness',
    host,
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
    input,
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { save } = ctx;
  const sync = wire(ctx);
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
  start(ctx);
}

/** The probes both modes share. Returns the sync that copies live values into `state`. */
function wire(ctx: EngineCtx<Action, FlushableSave | null>): () => void {
  const { loop, audio, surface, input } = ctx;
  const hooks: GameHooks = ctx.hooks;
  state.gpu = 'ok';
  const sync = () => {
    state.loopRunning = loop.isRunning;
    state.loopHalted = loop.halted;
    state.audio = audio.state;
    state.backbuffer = { ...surface.backbuffer };
    state.canvas = { width: surface.canvas.width, height: surface.canvas.height };
    state.devicePixelRatio = window.devicePixelRatio;
  };
  const tap = () => {
    if (input.pressed('tap')) state.taps.push({ x: input.pointer.x, y: input.pointer.y });
  };
  hooks.update = () => {
    state.updates++;
    tap();
  };
  const frame = hooks.frame;
  hooks.frame = (dt) => {
    frame?.(dt);
    tap();
  };
  hooks.afterRender = () => {
    state.frames++;
    sync();
  };
  hooks.hide = (reason) => {
    state.hides++;
    state.lastHide = reason;
  };
  hooks.deviceLost = () => {
    state.lost++;
  };
  return sync;
}

function start(ctx: EngineCtx<Action, FlushableSave | null>): void {
  ctx.stack.push({});
  ctx.loop.start();
  ctx.surface.canvas.focus();
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
