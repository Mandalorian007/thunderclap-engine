/**
 * The Capacitor host: `Host` (engine/host, D-041) for a game packaged as an iOS or Android app
 * with Capacitor. The page is the game's web build in the platform WebView, so frames, the
 * safe area and the fallbacks for everything else come from a web host (`base`); each Capacitor
 * plugin the app hands in (`plugins`) replaces one facet: links open in the in-app browser,
 * the clipboard and haptics go native, saves live in Preferences (which survive the WebView's
 * storage being cleared), and the lifecycle follows the app's foreground state instead of the
 * document's visibility. Nothing here imports a Capacitor package: the plugins are peers,
 * typed by hand in plugins.ts.
 */
import {
  createWebHost,
  type HapticImpact,
  type HapticNotification,
  type Host,
  type HostHaptics,
  type HostLifecycle,
  type HostLifecycleState,
  type HostStorage,
} from '@thunderclap-engine/engine/host';
import { safeExternalUrl } from '@thunderclap-engine/engine/platform';
import type { StorageLike } from '@thunderclap-engine/engine/save';
import type {
  AppPlugin,
  BackButtonEvent,
  CapacitorPlugins,
  HapticsPlugin,
  ImpactStyle,
  ListenerResult,
  NotificationType,
  PreferencesPlugin,
} from './plugins';

export interface CapacitorHostOptions {
  /** The Capacitor plugins the app installed. Each missing one falls back to `base`. */
  plugins?: Partial<CapacitorPlugins>;
  /** The host answering for everything a plugin does not. Default: `createWebHost({ win })`. */
  base?: Host;
  /** The WebView's window, for the default `base`. Default: the global `window`. */
  win?: Window;
}

/** Android's hardware or gesture back. Present only when `plugins.App` was given. */
export interface HostBack {
  /**
   * Calls `fn` on each back press. Registering any listener takes over the platform default
   * (leaving the app), so a game that has nothing to close should call `App.exitApp()` itself.
   * Returns unsubscribe.
   */
  watch(fn: (event: BackButtonEvent) => void): () => void;
}

export interface CapacitorHost extends Host {
  readonly kind: 'capacitor';
  /**
   * Resolves once `storage.open()` can answer: the Preferences store has been read into the
   * mirror. Until then `open()` returns null and the save store tries again on its next write.
   * Resolves at once when there is no `Preferences` plugin (saves then use `base.storage`).
   */
  readonly ready: Promise<void>;
  readonly back?: HostBack;
}

/** Key under which every save key is kept in Preferences, so a `keys()` sweep finds only ours. */
const PREFIX = 'tc:';

export function createCapacitorHost(opts: CapacitorHostOptions = {}): CapacitorHost {
  const plugins = opts.plugins ?? {};
  const base = opts.base ?? createWebHost({ win: opts.win });
  const { App, Browser, Clipboard, Haptics, Preferences, ScreenOrientation } = plugins;

  const storage = Preferences ? createPreferencesStorage(Preferences) : null;

  const host: CapacitorHost = {
    kind: 'capacitor',
    // The WebView is a page: frames come from its requestAnimationFrame via the base host.
    requestFrame: (cb) => base.requestFrame(cb),
    cancelFrame: (handle) => base.cancelFrame(handle),
    get embed() {
      return base.embed;
    },
    openExternal(url, o) {
      if (!Browser) return base.openExternal(url, o);
      const href = safeExternalUrl(url);
      if (!href) return 'invalid';
      // An in-app browser sheet has no popup blocker: every activation opens.
      void Browser.open({ url: href }).catch(() => {});
      return 'opened';
    },
    async copyText(text) {
      if (!Clipboard) return base.copyText(text);
      try {
        await Clipboard.write({ string: String(text) });
        return 'copied';
      } catch {
        return 'manual';
      }
    },
    clipboardWriteAllowed: () => (Clipboard ? true : base.clipboardWriteAllowed()),
    fullscreen: {
      // A store app already fills the screen; there is nothing to enter or leave.
      available: () => false,
      active: false,
      async toggle(o) {
        if (o?.lockLandscape && ScreenOrientation) {
          try {
            await ScreenOrientation.lock({ orientation: 'landscape' });
          } catch {
            // Refused (a tablet policy, an unsupported platform): leave things as they were.
          }
        }
        return false;
      },
      watch: () => () => {},
    },
    storage: storage?.storage ?? base.storage,
    ready: storage?.ready ?? Promise.resolve(),
    lifecycle: App ? createAppLifecycle(App) : base.lifecycle,
    haptics: Haptics ? createCapacitorHaptics(Haptics) : base.haptics,
    safeArea: base.safeArea,
    // No `window`: a phone app has no title bar or close box.
  };
  if (App) {
    (host as { back?: HostBack }).back = {
      watch: (fn) => listen(App.addListener('backButton', fn)),
    };
  }
  return host;
}

/** Subscribes through a Capacitor listener handle (direct or promised). Returns unsubscribe. */
function listen(result: ListenerResult): () => void {
  let removed = false;
  const handle = Promise.resolve(result);
  handle.catch(() => {});
  return () => {
    if (removed) return;
    removed = true;
    void handle.then((h) => h.remove()).catch(() => {});
  };
}

/**
 * The app's foreground state as a `HostLifecycle`. `appStateChange` carries it; `pause` and
 * `resume` are honoured too, for platforms that send only those. Starts `active` (the page is
 * running) and corrects itself from `getState()`.
 */
export function createAppLifecycle(app: AppPlugin): HostLifecycle {
  let state: HostLifecycleState = 'active';
  const watchers = new Set<(state: HostLifecycleState) => void>();
  const set = (next: HostLifecycleState) => {
    if (next === state) return;
    state = next;
    for (const fn of [...watchers]) fn(state);
  };
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    app.addListener('appStateChange', (s) => set(s.isActive ? 'active' : 'background'));
    app.addListener('pause', () => set('background'));
    app.addListener('resume', () => set('active'));
    app
      .getState()
      .then((s) => set(s.isActive ? 'active' : 'background'))
      .catch(() => {});
  };
  return {
    get state() {
      return state;
    },
    watch(fn) {
      listen();
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
  };
}

const IMPACT: Record<HapticImpact, ImpactStyle> = {
  light: 'LIGHT',
  medium: 'MEDIUM',
  heavy: 'HEAVY',
};
const NOTIFICATION: Record<HapticNotification, NotificationType> = {
  success: 'SUCCESS',
  warning: 'WARNING',
  error: 'ERROR',
};

/** `@capacitor/haptics` as a `HostHaptics`. Every call is fire-and-forget; a rejection is dropped. */
export function createCapacitorHaptics(haptics: HapticsPlugin): HostHaptics {
  const fire = (p: Promise<void>) => {
    p.catch(() => {});
  };
  return {
    available: () => true,
    impact: (style) => fire(haptics.impact({ style: IMPACT[style] ?? 'MEDIUM' })),
    notification: (kind) => fire(haptics.notification({ type: NOTIFICATION[kind] ?? 'SUCCESS' })),
    vibrate: (ms) => {
      const duration = Math.max(0, Math.round(ms));
      if (duration > 0) fire(haptics.vibrate({ duration }));
    },
  };
}

/**
 * Preferences as a synchronous `StorageLike` (`kind: 'preferences'`): reads are served from an
 * in-memory mirror loaded once from the plugin, writes update the mirror at once and reach the
 * plugin in order behind a promise chain. `open()` returns null until the load finished (`ready`),
 * so an early save-store write misses nothing: it retries on the next write.
 */
export function createPreferencesStorage(prefs: PreferencesPlugin): {
  storage: HostStorage;
  ready: Promise<void>;
} {
  const map = new Map<string, string>();
  let loaded = false;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = (op: () => Promise<void>) => {
    tail = tail.then(op, op).catch(() => {});
  };
  const ready = (async () => {
    try {
      const { keys } = await prefs.keys();
      for (const key of keys) {
        if (!key.startsWith(PREFIX)) continue;
        const { value } = await prefs.get({ key });
        if (value !== null) map.set(key.slice(PREFIX.length), value);
      }
    } catch {
      // Unreadable: start empty rather than never becoming usable.
    }
    loaded = true;
  })();
  const mirror: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      const v = String(value);
      map.set(key, v);
      enqueue(() => prefs.set({ key: PREFIX + key, value: v }));
    },
    removeItem(key) {
      map.delete(key);
      enqueue(() => prefs.remove({ key: PREFIX + key }));
    },
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
  return {
    ready,
    storage: { kind: 'preferences', open: () => (loaded ? mirror : null) },
  };
}
