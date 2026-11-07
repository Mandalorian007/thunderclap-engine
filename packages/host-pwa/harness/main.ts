/**
 * The PWA harness page: noun-free, built by Vite with `pwaPlugin` (harness/vite.config.ts). It
 * boots the PWA host, keeps `#status` current, and publishes `window.__pwa` so the smoke
 * (e2e/pwa.spec.ts) can read the host the way a game would. No WebGPU: the shell is what is
 * under test, and the engine's own matrix covers rendering.
 */
import { setDefaultHost } from '@thunderclap-engine/engine/host';
import { createPwaHost } from '../src';
import type { PwaProbe } from './state';

const host = createPwaHost();
setDefaultHost(host);

const status = document.getElementById('status') as HTMLElement;
const offlineEvents: boolean[] = [];
const render = () => {
  status.textContent = [
    `kind ${host.kind}`,
    `standalone ${host.pwa.standalone}`,
    `installable ${host.pwa.installable}`,
    `updateReady ${host.pwa.updateReady}`,
    `offline ${host.pwa.offline}`,
  ].join(' | ');
};
host.pwa.onOffline((off) => {
  offlineEvents.push(off);
  render();
});
host.pwa.onInstallable(render);
host.pwa.onUpdateReady(render);
render();

const probe: PwaProbe = {
  get kind() {
    return host.kind;
  },
  get standalone() {
    return host.pwa.standalone;
  },
  get installable() {
    return host.pwa.installable;
  },
  get updateReady() {
    return host.pwa.updateReady;
  },
  get offline() {
    return host.pwa.offline;
  },
  offlineEvents,
  cache: () => host.pwa.cacheStatus(),
  fetchData: async (name) => (await fetch(`data/${name}`)).status,
  install: () => host.pwa.install(),
  clearCache: () => host.pwa.clearCache(),
  workerState: async () => {
    if (!('serviceWorker' in navigator)) return 'none';
    const reg = await navigator.serviceWorker.getRegistration();
    const w = reg?.active ?? reg?.waiting ?? reg?.installing;
    return w?.state ?? 'none';
  },
  version: window.__tcPwa?.version ?? null,
};
window.__pwa = probe;
