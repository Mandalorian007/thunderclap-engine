/**
 * The web host: the game in a browser tab, or in a frame such as itch.io's. It wraps the D-036
 * link service (host/web-links.ts), the fullscreen helpers (platform/device.ts) and
 * `localStorage` behind a guarded probe (save/storage.ts). Web storage is `localStorage` only.
 *
 * The mobile facets (ws/host-mobile) come from the page too: `lifecycle` from
 * `visibilitychange` and `pagehide`/`pageshow`, `haptics` from `navigator.vibrate` when the
 * browser has it, `safeArea` from `env(safe-area-inset-*)` read through a probe element and
 * re-read on resize. The factories are exported so another host (a store app's) can reuse them
 * for what its shell does not answer itself.
 */
import {
  fullscreenAvailable,
  isFullscreen,
  toggleFullscreen,
  watchFullscreen,
} from '../platform/device';
import { type EmbedContext, embedContext } from '../platform/links';
import { probeStorage } from '../save/storage';
import type {
  HapticImpact,
  HapticNotification,
  Host,
  HostHaptics,
  HostInsets,
  HostLifecycle,
  HostLifecycleState,
  HostSafeArea,
} from './types';
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
      get active() {
        return isFullscreen(win.document);
      },
      toggle: (o) => toggleFullscreen(win.document.documentElement, o),
      watch: (fn) => watchFullscreen(fn, win.document),
    },
    storage: {
      kind: 'local',
      // Merely reading `localStorage` throws in some sandboxed or third-party frames, so it is
      // read inside the probe's guard.
      open: () => probeStorage(() => win.localStorage),
    },
    lifecycle: createWebLifecycle(win),
    haptics: createWebHaptics(win),
    safeArea: createWebSafeArea(win),
  };
}

/**
 * The page's lifecycle as a `HostLifecycle`: `background` once the document is hidden or paged
 * out (`pagehide`, `freeze`), `active` when it is visible again (`visibilitychange`, `pageshow`,
 * `resume`). Each watcher sees a change only when the state differs from what it last saw.
 */
export function createWebLifecycle(win: Window): HostLifecycle {
  const doc = win.document;
  let pagedOut = false;
  const state = (): HostLifecycleState =>
    pagedOut || doc.visibilityState === 'hidden' ? 'background' : 'active';
  return {
    get state() {
      return state();
    },
    watch(fn) {
      let last = state();
      const emit = () => {
        const s = state();
        if (s === last) return;
        last = s;
        fn(s);
      };
      const onVis = () => {
        if (doc.visibilityState !== 'hidden') pagedOut = false;
        emit();
      };
      const onPageHide = () => {
        pagedOut = true;
        emit();
      };
      const onPageShow = () => {
        pagedOut = false;
        emit();
      };
      doc.addEventListener('visibilitychange', onVis);
      doc.addEventListener('freeze', onPageHide);
      doc.addEventListener('resume', onPageShow);
      win.addEventListener('pagehide', onPageHide);
      win.addEventListener('pageshow', onPageShow);
      return () => {
        doc.removeEventListener('visibilitychange', onVis);
        doc.removeEventListener('freeze', onPageHide);
        doc.removeEventListener('resume', onPageShow);
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('pageshow', onPageShow);
      };
    },
  };
}

/** `navigator.vibrate` durations, ms. */
const IMPACT_MS: Readonly<Record<HapticImpact, number>> = { light: 10, medium: 20, heavy: 35 };
const NOTIFICATION_PATTERN: Readonly<Record<HapticNotification, readonly number[]>> = {
  success: [10, 40, 10],
  warning: [25, 50, 25],
  error: [40, 50, 40, 50, 40],
};

/**
 * Haptics over `navigator.vibrate`, when the browser has it (Android Chrome does; iOS Safari
 * does not, so `available()` is false there and every call is a no-op). A vibrate call outside a
 * user gesture may be refused; that is ignored.
 */
export function createWebHaptics(win: Window): HostHaptics {
  const nav = win.navigator as Navigator | undefined;
  const vibrate = (pattern: number | readonly number[]): void => {
    try {
      nav?.vibrate?.(pattern as number | number[]);
    } catch {
      // Not allowed here (no gesture yet, or a frame policy): silence is the fallback.
    }
  };
  const available = () => typeof nav?.vibrate === 'function';
  return {
    available,
    impact: (style) => {
      if (available()) vibrate(IMPACT_MS[style] ?? IMPACT_MS.medium);
    },
    notification: (kind) => {
      if (available()) vibrate(NOTIFICATION_PATTERN[kind] ?? NOTIFICATION_PATTERN.warning);
    },
    vibrate: (ms) => {
      if (available() && ms > 0) vibrate(Math.round(ms));
    },
  };
}

/**
 * CSS px safe-area insets of `win`'s viewport, read through a probe element padded with
 * `env(safe-area-inset-*)` (the `--tc-safe-*` custom properties override them, for emulation).
 * Zero when the document has no body yet or the window cannot compute styles.
 */
export function readSafeAreaInsets(win: Window, out: HostInsets): HostInsets {
  const doc = win.document;
  out.top = out.right = out.bottom = out.left = 0;
  if (!doc?.body || typeof win.getComputedStyle !== 'function') return out;
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:var(--tc-safe-top,env(safe-area-inset-top,0px)) var(--tc-safe-right,env(safe-area-inset-right,0px)) ' +
    'var(--tc-safe-bottom,env(safe-area-inset-bottom,0px)) var(--tc-safe-left,env(safe-area-inset-left,0px));';
  doc.body.append(probe);
  const cs = win.getComputedStyle(probe);
  const px = (v: string | undefined) => Number.parseFloat(v ?? '') || 0;
  out.top = px(cs.paddingTop);
  out.right = px(cs.paddingRight);
  out.bottom = px(cs.paddingBottom);
  out.left = px(cs.paddingLeft);
  probe.remove();
  return out;
}

/**
 * The viewport's safe area as a `HostSafeArea`. `insets()` reads the page once and then serves
 * the cached values until a `resize` (or `orientationchange`) invalidates them; watchers are
 * called after a resize only when a value changed.
 */
export function createWebSafeArea(win: Window): HostSafeArea {
  const current: HostInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  let fresh = false;
  const watchers = new Set<(insets: Readonly<HostInsets>) => void>();
  const insets = (): Readonly<HostInsets> => {
    if (!fresh) {
      readSafeAreaInsets(win, current);
      fresh = true;
    }
    return current;
  };
  const same = (a: HostInsets, b: HostInsets) =>
    a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
  const previous: HostInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const onResize = () => {
    if (watchers.size === 0) {
      fresh = false;
      return;
    }
    Object.assign(previous, current);
    fresh = false;
    insets();
    if (same(previous, current)) return;
    for (const fn of [...watchers]) fn(current);
  };
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    win.addEventListener?.('resize', onResize);
    win.addEventListener?.('orientationchange', onResize);
  };
  return {
    insets: () => {
      listen();
      return insets();
    },
    watch(fn) {
      listen();
      insets();
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
  };
}
