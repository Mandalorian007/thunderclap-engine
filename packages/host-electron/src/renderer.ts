/**
 * The Electron host for the renderer: `Host` (engine/host, D-041) over the preload bridge
 * `window.thunderclap` (src/bridge.ts). Links and the clipboard go through the main process;
 * fullscreen and the window controls act on the shell's `BrowserWindow`.
 *
 * Storage is the renderer's `localStorage`, the same backend and probe as the web host (PM call,
 * 2026-11-03: browser storage only for now). The shell serves the page from one fixed origin
 * (`app://bundle`), so saves stay put across launches and updates. A file backend in `userData`
 * is an open question; see README.md.
 */
import type { Host, HostFullscreen } from '@thunderclap-engine/engine/host';
import { embedContext, safeExternalUrl } from '@thunderclap-engine/engine/platform';
import { probeStorage } from '@thunderclap-engine/engine/save';
import { BRIDGE_GLOBAL, type ThunderclapBridge } from './bridge';

export interface ElectronHostOptions {
  /** The bridge. Default: `window.thunderclap`. Tests pass a fake. */
  bridge?: ThunderclapBridge;
  /** The window whose `localStorage` holds saves. Default: the global `window`. */
  win?: Window;
}

/** The preload bridge when this page runs inside the ThunderClap shell, else null. */
export function electronBridge(win: Window = window): ThunderclapBridge | null {
  const b = (win as unknown as Record<string, unknown>)[BRIDGE_GLOBAL] as
    | ThunderclapBridge
    | undefined;
  return b && typeof b.openExternal === 'function' ? b : null;
}

/** True when the page runs inside the ThunderClap Electron shell. */
export function inElectronShell(win: Window = window): boolean {
  return electronBridge(win) !== null;
}

/**
 * Builds the Electron host. Throws when there is no bridge (the page is not in the shell);
 * check `inElectronShell()` first and fall back to `createWebHost()`.
 */
export function createElectronHost(opts: ElectronHostOptions = {}): Host {
  const win = opts.win ?? window;
  const bridge = opts.bridge ?? electronBridge(win);
  if (!bridge) {
    throw new Error('createElectronHost: no window.thunderclap bridge (not in the Electron shell)');
  }

  const fullscreen = createFullscreen(bridge);

  return {
    kind: 'electron',
    // The shell's window is a Chromium page: frames come from its requestAnimationFrame.
    requestFrame: (cb) => win.requestAnimationFrame(cb),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
    embed: embedContext(win),
    openExternal(url) {
      // Checked here so a bad link is `invalid` at once, and again in the main process.
      const href = safeExternalUrl(url);
      if (!href) return 'invalid';
      // A desktop window has no popup blocker, so every activation (pad and script too) opens.
      // The OS answer comes later; a failure there is logged by the main process.
      void bridge.openExternal(href).catch(() => false);
      return 'opened';
    },
    async copyText(text) {
      try {
        return (await bridge.copyText(String(text))) ? 'copied' : 'manual';
      } catch {
        return 'manual';
      }
    },
    clipboardWriteAllowed: () => true,
    fullscreen,
    storage: {
      kind: 'local',
      // The same guarded probe as the web host: null when missing or failing a round trip.
      open: () => probeStorage(() => win.localStorage),
    },
    window: {
      close: () => bridge.window.close(),
      minimize: () => bridge.window.minimize(),
      toggleMaximize: () => bridge.window.toggleMaximize(),
      setTitle: (title) => bridge.window.setTitle(String(title)),
    },
  };
}

/**
 * Fullscreen of the shell's window. `active` is a synchronous getter in `Host`, so the state is kept
 * here: read once at start, then updated by the main process's change events and by `toggle`.
 */
function createFullscreen(bridge: ThunderclapBridge): HostFullscreen {
  let on = false;
  const listeners = new Set<(on: boolean) => void>();
  const update = (next: boolean): void => {
    if (next === on) return;
    on = next;
    for (const fn of [...listeners]) fn(on);
  };
  bridge.fullscreen.onChange((next) => update(!!next));
  bridge.fullscreen
    .get()
    .then((v) => update(!!v))
    .catch(() => {});

  return {
    available: () => true,
    get active() {
      return on;
    },
    async toggle() {
      // `lockLandscape` has no meaning for a desktop window.
      try {
        update(!!(await bridge.fullscreen.set(!on)));
      } catch {
        // Refused: leave things as they were.
      }
      return on;
    },
    watch(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
