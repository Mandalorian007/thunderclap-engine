/**
 * The web host: the game in a browser tab, or in a frame such as itch.io's. It wraps the D-036
 * link service (host/web-links.ts), the fullscreen helpers (platform/device.ts) and
 * `localStorage` behind a guarded probe (save/storage.ts). Web storage is `localStorage` only.
 */
import {
  fullscreenAvailable,
  isFullscreen,
  toggleFullscreen,
  watchFullscreen,
} from '../platform/device';
import { type EmbedContext, embedContext } from '../platform/links';
import { probeStorage } from '../save/storage';
import type { Host } from './types';
import { clipboardWriteAllowed, copyText, openExternal } from './web-links';

export interface WebHostOptions {
  /** The window to act on. Default: the global `window`. Tests pass a stub. */
  win?: Window;
}

export function createWebHost(opts: WebHostOptions = {}): Host {
  const win = opts.win ?? window;
  let embed: EmbedContext | null = null;
  return {
    kind: 'web',
    requestFrame: (cb) => win.requestAnimationFrame(cb),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
    get embed() {
      embed ??= embedContext(win);
      return embed;
    },
    openExternal: (url, o) => openExternal(url, o, win),
    copyText: (text) => copyText(text, win),
    clipboardWriteAllowed: () => clipboardWriteAllowed(win.document),
    fullscreen: {
      available: () => fullscreenAvailable(win.document),
      active: () => isFullscreen(win.document),
      toggle: (o) => toggleFullscreen(win.document.documentElement, o),
      watch: (fn) => watchFullscreen(fn, win.document),
    },
    storage: {
      kind: 'local',
      // Merely reading `localStorage` throws in some sandboxed or third-party frames, so it is
      // read inside the probe's guard.
      open: () => probeStorage(() => win.localStorage),
    },
  };
}
