/**
 * The preload: runs sandboxed (`sandbox: true`, `contextIsolation: true`, no Node in the page)
 * and exposes `window.thunderclap` (src/bridge.ts) with `contextBridge`. Each member is a thin
 * IPC call; the main process checks every argument and the caller (src/main/main.ts).
 * Built to a single CommonJS file (out/preload.cjs), as sandboxed preloads require.
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import { BRIDGE_GLOBAL, BRIDGE_VERSION, CH, type ThunderclapBridge } from '../bridge';

const bridge: ThunderclapBridge = {
  version: BRIDGE_VERSION,
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke(CH.openExternal, String(url)),
  copyText: (text) => ipcRenderer.invoke(CH.copyText, String(text)),
  fullscreen: {
    get: () => ipcRenderer.invoke(CH.fullscreenGet),
    set: (on) => ipcRenderer.invoke(CH.fullscreenSet, on === true),
    onChange(fn) {
      const listener = (_e: IpcRendererEvent, on: unknown) => fn(on === true);
      ipcRenderer.on(CH.fullscreenChanged, listener);
      return () => {
        ipcRenderer.removeListener(CH.fullscreenChanged, listener);
      };
    },
  },
  window: {
    minimize: () => ipcRenderer.send(CH.minimize),
    toggleMaximize: () => ipcRenderer.send(CH.toggleMaximize),
    close: () => ipcRenderer.send(CH.close),
    setTitle: (title) => ipcRenderer.send(CH.setTitle, String(title)),
  },
};

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge);
