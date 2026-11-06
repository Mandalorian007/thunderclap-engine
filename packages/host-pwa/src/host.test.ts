// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPwaHost, inStandalone } from './host';
import { SKIP_WAITING } from './worker';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A `ServiceWorker` stand-in: a state and the `statechange` event. */
function fakeWorker(state: string) {
  const w = Object.assign(new EventTarget(), {
    state,
    posted: [] as unknown[],
    postMessage(m: unknown) {
      w.posted.push(m);
    },
    setState(s: string) {
      w.state = s;
      w.dispatchEvent(new Event('statechange'));
    },
  });
  return w;
}
type FakeWorker = ReturnType<typeof fakeWorker>;

/** A `navigator.serviceWorker` whose `register` resolves to one registration. */
function fakeContainer(opts: { controller?: boolean; waiting?: FakeWorker; fail?: boolean } = {}) {
  const reg = Object.assign(new EventTarget(), {
    scope: 'http://localhost/',
    installing: null as FakeWorker | null,
    waiting: opts.waiting ?? null,
    active: opts.controller ? fakeWorker('activated') : null,
    /** Plays a new worker arriving: `updatefound`, then its install. */
    update(w: FakeWorker) {
      reg.installing = w;
      reg.dispatchEvent(new Event('updatefound'));
    },
  });
  const container = Object.assign(new EventTarget(), {
    controller: opts.controller ? reg.active : null,
    registered: [] as string[],
    register: vi.fn(async (url: string) => {
      container.registered.push(url);
      if (opts.fail) throw new Error('insecure');
      return reg;
    }),
    getRegistration: vi.fn(async () => reg),
  });
  return { container, reg };
}

/** A happy-dom window with the fakes installed; every property is restored by `afterEach`. */
function setup(
  opts: {
    sw?: ReturnType<typeof fakeContainer>['container'] | null;
    page?: { sw: string; version: string } | null;
    onLine?: boolean;
    caches?: unknown;
  } = {},
) {
  const win = window as Window & { __tcPwa?: unknown; caches: CacheStorage };
  const nav = win.navigator as Navigator & { serviceWorker?: unknown; onLine: boolean };
  Object.defineProperty(nav, 'onLine', { value: opts.onLine ?? true, configurable: true });
  if (opts.sw) Object.defineProperty(nav, 'serviceWorker', { value: opts.sw, configurable: true });
  else Reflect.deleteProperty(nav, 'serviceWorker');
  if (opts.page) win.__tcPwa = opts.page;
  else delete win.__tcPwa;
  Object.defineProperty(win, 'caches', { value: opts.caches, configurable: true, writable: true });
  return win;
}

afterEach(() => {
  const nav = window.navigator as Navigator & { serviceWorker?: unknown };
  Reflect.deleteProperty(nav, 'serviceWorker');
  Reflect.deleteProperty(nav, 'onLine');
  delete (window as Window & { __tcPwa?: unknown }).__tcPwa;
  Reflect.deleteProperty(window, 'caches');
});

/** A `beforeinstallprompt` with a scripted answer. */
function installPrompt(outcome: 'accepted' | 'dismissed') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    prompted: boolean;
  };
  e.prompted = false;
  e.prompt = async () => {
    e.prompted = true;
  };
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

describe('createPwaHost', () => {
  it('is the web host with a pwa facet; kind stays web', () => {
    setup();
    const host = createPwaHost();
    expect(host.kind).toBe('web');
    expect(host.storage.kind).toBe('local');
    expect(typeof host.requestFrame).toBe('function');
    expect(host.pwa.standalone).toBe(false);
    expect(host.pwa.offline).toBe(false);
  });

  it('is unavailable everywhere without a worker, prompt or caches, and never throws', async () => {
    setup({ sw: null, caches: undefined });
    const host = createPwaHost();
    expect(host.pwa.installable).toBe(false);
    expect(await host.pwa.install()).toBe('unavailable');
    expect(host.pwa.updateReady).toBe(false);
    await expect(host.pwa.applyUpdate()).resolves.toBeUndefined();
    expect(await host.pwa.cacheStatus()).toEqual({ precached: 0, runtime: 0, bytes: 0 });
    await expect(host.pwa.clearCache()).resolves.toBeUndefined();
  });

  it('registers the worker the plugin named, or the swUrl given, or nothing', async () => {
    const a = fakeContainer();
    setup({ sw: a.container, page: { sw: '/sw.js', version: '1' } });
    createPwaHost();
    await tick();
    expect(a.container.registered).toEqual(['/sw.js']);

    const b = fakeContainer();
    setup({ sw: b.container, page: { sw: '/sw.js', version: '1' } });
    createPwaHost({ swUrl: '/custom.js' });
    await tick();
    expect(b.container.registered).toEqual(['/custom.js']);

    const c = fakeContainer();
    setup({ sw: c.container, page: null });
    createPwaHost();
    await tick();
    expect(c.container.registered).toEqual([]);

    const d = fakeContainer();
    setup({ sw: d.container, page: { sw: '/sw.js', version: '1' } });
    createPwaHost({ register: false });
    await tick();
    expect(d.container.registered).toEqual([]);
    expect(d.container.getRegistration).toHaveBeenCalledWith('/sw.js');
  });

  it('survives a registration that rejects', async () => {
    const a = fakeContainer({ fail: true });
    setup({ sw: a.container, page: { sw: '/sw.js', version: '1' } });
    const host = createPwaHost();
    await tick();
    expect(host.pwa.updateReady).toBe(false);
    await expect(host.pwa.applyUpdate()).resolves.toBeUndefined();
  });

  describe('install', () => {
    it('defers beforeinstallprompt and reports the outcome', async () => {
      const win = setup();
      const host = createPwaHost();
      const seen: boolean[] = [];
      host.pwa.onInstallable((v) => seen.push(v));
      const e = installPrompt('accepted');
      win.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(host.pwa.installable).toBe(true);
      expect(seen).toEqual([true]);

      expect(await host.pwa.install()).toBe('accepted');
      expect(e.prompted).toBe(true);
      expect(host.pwa.installable).toBe(false);
      expect(seen).toEqual([true, false]);
      // The prompt is spent.
      expect(await host.pwa.install()).toBe('unavailable');
    });
    it('reports a dismissal, and appinstalled clears the prompt', async () => {
      const win = setup();
      const host = createPwaHost();
      win.dispatchEvent(installPrompt('dismissed'));
      expect(await host.pwa.install()).toBe('dismissed');

      win.dispatchEvent(installPrompt('accepted'));
      expect(host.pwa.installable).toBe(true);
      win.dispatchEvent(new Event('appinstalled'));
      expect(host.pwa.installable).toBe(false);
      expect(await host.pwa.install()).toBe('unavailable');
    });
    it('unsubscribes', () => {
      const win = setup();
      const host = createPwaHost();
      const fn = vi.fn();
      host.pwa.onInstallable(fn)();
      win.dispatchEvent(installPrompt('accepted'));
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('is ready when a worker is already waiting behind the controller', async () => {
      const waiting = fakeWorker('installed');
      const { container } = fakeContainer({ controller: true, waiting });
      setup({ sw: container, page: { sw: '/sw.js', version: '2' } });
      const host = createPwaHost();
      const fn = vi.fn();
      host.pwa.onUpdateReady(fn);
      await tick();
      expect(host.pwa.updateReady).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });
    it('becomes ready when a new worker installs while one controls the page', async () => {
      const { container, reg } = fakeContainer({ controller: true });
      setup({ sw: container, page: { sw: '/sw.js', version: '2' } });
      const host = createPwaHost();
      const fn = vi.fn();
      host.pwa.onUpdateReady(fn);
      await tick();
      expect(host.pwa.updateReady).toBe(false);
      const w = fakeWorker('installing');
      reg.update(w);
      w.setState('installed');
      expect(host.pwa.updateReady).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
      // Fires once.
      w.setState('installed');
      expect(fn).toHaveBeenCalledTimes(1);
    });
    it('is not an update when the first worker installs (nothing controls the page yet)', async () => {
      const { container, reg } = fakeContainer({ controller: false });
      setup({ sw: container, page: { sw: '/sw.js', version: '1' } });
      const host = createPwaHost();
      await tick();
      const w = fakeWorker('installing');
      reg.update(w);
      w.setState('installed');
      expect(host.pwa.updateReady).toBe(false);
    });
    it('applyUpdate tells the waiting worker to skip waiting, then reloads on controllerchange', async () => {
      const waiting = fakeWorker('installed');
      const { container } = fakeContainer({ controller: true, waiting });
      const win = setup({ sw: container, page: { sw: '/sw.js', version: '2' } });
      const reload = vi.fn();
      Object.defineProperty(win.location, 'reload', { value: reload, configurable: true });
      const host = createPwaHost();
      await tick();
      let done = false;
      const p = host.pwa.applyUpdate().then(() => {
        done = true;
      });
      await tick();
      expect(waiting.posted).toEqual([{ type: SKIP_WAITING }]);
      expect(done).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      container.dispatchEvent(new Event('controllerchange'));
      await p;
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('offline', () => {
    it('starts from navigator.onLine and follows the online and offline events', () => {
      const win = setup({ onLine: false });
      const host = createPwaHost();
      expect(host.pwa.offline).toBe(true);
      const seen: boolean[] = [];
      const off = host.pwa.onOffline((v) => seen.push(v));
      win.dispatchEvent(new Event('online'));
      win.dispatchEvent(new Event('online'));
      win.dispatchEvent(new Event('offline'));
      expect(host.pwa.offline).toBe(true);
      expect(seen).toEqual([false, true]);
      off();
      win.dispatchEvent(new Event('online'));
      expect(host.pwa.offline).toBe(false);
      expect(seen).toEqual([false, true]);
    });
  });

  describe('caches', () => {
    /** A `CacheStorage` over plain maps of url → body. */
    function fakeCaches(stores: Record<string, Record<string, string>>) {
      const open = async (name: string) => {
        const entries = stores[name] ?? {};
        return {
          keys: async () => Object.keys(entries).map((url) => ({ url })),
          match: async (k: { url: string }) =>
            k.url in entries ? new Response(entries[k.url]) : undefined,
        };
      };
      return {
        keys: vi.fn(async () => Object.keys(stores)),
        open: vi.fn(open),
        delete: vi.fn(async (name: string) => delete stores[name]),
      };
    }
    it('counts this package’s caches and leaves others alone', async () => {
      const stores = {
        'tc-pwa-precache-abc': { '/a.js': 'aaaa', '/index.html': 'bb' },
        'tc-pwa-runtime': { '/data/1.json': 'c' },
        'someone-else': { '/x': 'xxxxxxxx' },
      };
      const caches = fakeCaches(stores);
      setup({ caches });
      const host = createPwaHost();
      expect(await host.pwa.cacheStatus()).toEqual({ precached: 2, runtime: 1, bytes: 7 });
      await host.pwa.clearCache();
      expect(Object.keys(stores)).toEqual(['someone-else']);
    });
    it('is zeros when caches throws', async () => {
      setup({
        caches: {
          keys: async () => {
            throw new Error('blocked');
          },
        },
      });
      const host = createPwaHost();
      expect(await host.pwa.cacheStatus()).toEqual({ precached: 0, runtime: 0, bytes: 0 });
    });
  });
});

describe('inStandalone', () => {
  const win = (matches: Record<string, boolean>, standalone?: boolean) =>
    ({
      matchMedia: (q: string) => ({ matches: matches[q] ?? false }),
      navigator: { standalone },
    }) as unknown as Window;
  it('reads display-mode standalone or fullscreen, or iOS navigator.standalone', () => {
    expect(inStandalone(win({}))).toBe(false);
    expect(inStandalone(win({ '(display-mode: standalone)': true }))).toBe(true);
    expect(inStandalone(win({ '(display-mode: fullscreen)': true }))).toBe(true);
    expect(inStandalone(win({}, true))).toBe(true);
    expect(inStandalone({ navigator: {} } as unknown as Window)).toBe(false);
  });
});
