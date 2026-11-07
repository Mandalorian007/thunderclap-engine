/**
 * The desktop harness page: noun-free, like the engine's harness (packages/engine/harness),
 * but built only from the engine's public exports plus this package. It boots WebGPU, clears
 * the swapchain every frame and publishes `window.__desktop` so the Electron smoke
 * (e2e/shell.spec.ts) can drive the host the way a game does.
 *
 * It is also what `pnpm desktop:dev` and `pnpm desktop:build` show until a game supplies its
 * own renderer (ws/last-rune-desktop).
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { createWebHost, type Host, setDefaultHost } from '@thunderclap-engine/engine/host';
import { boot } from '@thunderclap-engine/engine/platform';
import { createSaveStore, s } from '@thunderclap-engine/engine/save';
import { createElectronHost, electronBridge } from '../src';
import type { DesktopProbe, DesktopSaveResult, DesktopState } from './state';

const root = document.getElementById('root') as HTMLElement;

const bridge = electronBridge();
const host: Host = bridge ? createElectronHost({ bridge }) : createWebHost();
setDefaultHost(host);

const state: DesktopState = { ready: false, gpu: 'pending', format: null, frames: 0 };

const SaveData = s.object({ n: s.number() });
const store = () =>
  createSaveStore({
    game: 'desktop-harness',
    slot: 'host',
    version: 1,
    defaults: () => ({ n: 0 }),
    schema: SaveData,
    host,
    debounceMs: 0,
    autoFlush: false,
  });
const saveResult = (st: ReturnType<typeof store>): DesktopSaveResult => ({
  persistent: st.persistent,
  loadResult: st.status.loadResult,
  error: st.status.error,
  n: st.get().n,
});

const probe: DesktopProbe = {
  state,
  info: () => ({
    kind: host.kind,
    embed: host.embed,
    bridgeVersion: bridge?.version ?? null,
    storageKind: host.storage.kind,
    storage: host.storage.open() !== null,
    clipboardWriteAllowed: host.clipboardWriteAllowed(),
    fullscreenAvailable: host.fullscreen.available(),
    fullscreenActive: host.fullscreen.active,
    hasWindow: !!host.window,
  }),
  open: (url, activation) => host.openExternal(url, { activation }),
  copy: (text) => host.copyText(text),
  setTitle: (title) => host.window?.setTitle?.(title),
  save(n) {
    const st = store();
    st.set({ n });
    st.flush();
    return saveResult(st);
  },
  load: () => saveResult(store()),
};
window.__desktop = probe;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'ThunderClap' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  state.gpu = 'ok';
  state.format = gpu.format;
  const loop = new GameLoop({
    update() {},
    render() {
      const encoder = gpu.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: gpu.context.getCurrentTexture().createView(),
            clearValue: { r: 0.08, g: 0.1, b: 0.16, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
      state.frames++;
    },
  });
  loop.start();
  state.ready = true;
}

main().catch((err) => {
  console.error('[desktop harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
