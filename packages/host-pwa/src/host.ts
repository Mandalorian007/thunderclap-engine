/**
 * `createPwaHost()`: the web host (`createWebHost`, `@thunderclap-engine/engine/host`) with a `pwa`
 * facet: install prompt, update prompt, offline state, standalone detection and the caches the
 * plugin's worker fills. `Host` itself gains nothing: `kind` stays `'web'` (the engine's type is
 * not this package's), and `pwa.standalone` says the rest.
 *
 * Everything is guarded. In a tab without service workers, without `caches`, or on a build that
 * never ran the plugin (no `window.__tcPwa`, no `swUrl`), the host boots and every method
 * resolves `'unavailable'` or does nothing.
 */
import { createWebHost, type Host, type WebHostOptions } from '@thunderclap-engine/engine/host';
import { PAGE_GLOBAL } from './manifest';
import { CACHE_PREFIX, PRECACHE_PREFIX, RUNTIME_CACHE } from './sw-logic';
import { SKIP_WAITING } from './worker';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface CacheStatus {
  /** Entries in the build's precache (hashed assets and `index.html`). */
  precached: number;
  /** Entries in the runtime cache (the `runtimeCache` prefixes). */
  runtime: number;
  /** Bytes across both, summed from each cached body. */
  bytes: number;
}

export interface PwaHost {
  /** True once the browser offered an install prompt (`beforeinstallprompt`) that is still open. */
  readonly installable: boolean;
  /** Shows the deferred prompt. `unavailable` when there is none (already installed, or unsupported). */
  install(): Promise<InstallOutcome>;
  /** Calls `fn(installable)` on every change. Returns unsubscribe. */
  onInstallable(fn: (installable: boolean) => void): () => void;
  /** True when a new worker is installed and waiting behind the one that controls the page. */
  readonly updateReady: boolean;
  /**
   * Tells the waiting worker to take over and reloads the page once it controls it. Resolves
   * without reloading when no update is waiting.
   */
  applyUpdate(): Promise<void>;
  /** Calls `fn()` when an update becomes ready. Returns unsubscribe. */
  onUpdateReady(fn: () => void): () => void;
  /** `!navigator.onLine`: kept current from the `online` and `offline` events. */
  readonly offline: boolean;
  /** Calls `fn(offline)` on every change. Returns unsubscribe. */
  onOffline(fn: (offline: boolean) => void): () => void;
  /** True when the page runs as an installed app (display-mode standalone, or iOS `navigator.standalone`). */
  readonly standalone: boolean;
  /** Counts and bytes of this package's caches. Zeros without `caches`. */
  cacheStatus(): Promise<CacheStatus>;
  /** Deletes this package's caches (never saves: those are `localStorage` / IndexedDB). */
  clearCache(): Promise<void>;
}

export interface PwaHostOptions extends WebHostOptions {
  /**
   * The worker to register. Default: `window.__tcPwa.sw`, which the plugin's snippet sets in the
   * built page. Without either the host registers nothing.
   */
  swUrl?: string;
  /** Set false to leave registration to the page (the plugin's snippet already did it). Default true. */
  register?: boolean;
}

/** The event Chromium fires when the page meets the install criteria. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** True when the page runs as an installed app. */
export function inStandalone(win: Window = window): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (win.matchMedia?.('(display-mode: fullscreen)').matches) return true;
    return (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function listeners<T>() {
  const set = new Set<(v: T) => void>();
  return {
    add(fn: (v: T) => void) {
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit(v: T) {
      for (const fn of set) fn(v);
    },
  };
}

export function createPwaHost(opts: PwaHostOptions = {}): Host & { pwa: PwaHost } {
  const win = opts.win ?? window;
  const base = createWebHost({ win });
  const nav = win.navigator;

  // Install prompt.
  let deferred: BeforeInstallPromptEvent | null = null;
  const installable = listeners<boolean>();
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    installable.emit(true);
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    installable.emit(false);
  });

  // Online state.
  let offline = nav.onLine === false;
  const offlineL = listeners<boolean>();
  const setOffline = (v: boolean) => {
    if (v === offline) return;
    offline = v;
    offlineL.emit(v);
  };
  win.addEventListener('online', () => setOffline(false));
  win.addEventListener('offline', () => setOffline(true));

  // Service worker: registration and the waiting worker.
  const sw = 'serviceWorker' in nav ? nav.serviceWorker : null;
  const page = (win as unknown as Record<string, { sw?: string } | undefined>)[PAGE_GLOBAL];
  const swUrl = opts.swUrl ?? page?.sw;
  let registration: ServiceWorkerRegistration | null = null;
  let updateReady = false;
  const updateL = listeners<void>();
  const markReady = () => {
    if (updateReady) return;
    updateReady = true;
    updateL.emit();
  };
  const watchInstalling = (reg: ServiceWorkerRegistration) => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      // A worker that installed while another controls the page is an update waiting.
      if (w.state === 'installed' && sw?.controller) markReady();
    });
  };
  const adopt = (reg: ServiceWorkerRegistration) => {
    registration = reg;
    if (reg.waiting && sw?.controller) markReady();
    watchInstalling(reg);
    reg.addEventListener('updatefound', () => watchInstalling(reg));
  };
  if (sw && swUrl) {
    const ready =
      opts.register === false
        ? sw.getRegistration(swUrl)
        : sw.register(swUrl).then(
            (r) => r,
            () => undefined,
          );
    ready.then((reg) => reg && adopt(reg)).catch(() => {});
  }

  const openCaches = async (): Promise<{ name: string; cache: Cache }[]> => {
    const store = win.caches;
    if (!store) return [];
    try {
      const names = (await store.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
      return Promise.all(names.map(async (name) => ({ name, cache: await store.open(name) })));
    } catch {
      return [];
    }
  };

  const pwa: PwaHost = {
    get installable() {
      return deferred !== null;
    },
    async install() {
      const e = deferred;
      if (!e) return 'unavailable';
      deferred = null;
      installable.emit(false);
      try {
        await e.prompt();
        const { outcome } = await e.userChoice;
        return outcome;
      } catch {
        return 'unavailable';
      }
    },
    onInstallable: (fn) => installable.add(fn),
    get updateReady() {
      return updateReady;
    },
    async applyUpdate() {
      const waiting = registration?.waiting;
      if (!waiting || !sw) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          sw.removeEventListener('controllerchange', done);
          resolve();
        };
        sw.addEventListener('controllerchange', done);
        waiting.postMessage({ type: SKIP_WAITING });
      });
      win.location.reload();
    },
    onUpdateReady: (fn) => updateL.add(() => fn()),
    get offline() {
      return offline;
    },
    onOffline: (fn) => offlineL.add(fn),
    get standalone() {
      return inStandalone(win);
    },
    async cacheStatus() {
      const status: CacheStatus = { precached: 0, runtime: 0, bytes: 0 };
      for (const { name, cache } of await openCaches()) {
        const keys = await cache.keys();
        if (name.startsWith(PRECACHE_PREFIX)) status.precached += keys.length;
        else if (name === RUNTIME_CACHE) status.runtime += keys.length;
        for (const k of keys) {
          const res = await cache.match(k);
          if (res) status.bytes += (await res.arrayBuffer()).byteLength;
        }
      }
      return status;
    },
    async clearCache() {
      const store = win.caches;
      if (!store) return;
      for (const { name } of await openCaches()) await store.delete(name);
    },
  };

  return Object.assign(base, { pwa });
}
