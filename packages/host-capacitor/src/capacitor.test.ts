// @vitest-environment happy-dom
import type { Host } from '@thunderclap-engine/engine/host';
import { describe, expect, it, vi } from 'vitest';
import { createCapacitorHost, createPreferencesStorage } from './capacitor';
import type { AppState, BackButtonEvent, CapacitorPlugins, PreferencesPlugin } from './plugins';

type Listener = (arg: never) => void;

/** Fake plugins that record calls; `emit` plays an App event. */
function fakePlugins(opts: { stored?: Record<string, string>; promisedHandles?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const removed: string[] = [];
  const handle = (event: string, fn: Listener) => {
    const h = {
      remove: async () => {
        listeners.get(event)?.delete(fn);
        removed.push(event);
      },
    };
    return opts.promisedHandles ? Promise.resolve(h) : h;
  };
  const prefs = new Map<string, string>(Object.entries(opts.stored ?? {}));
  let active = true;
  const plugins: CapacitorPlugins = {
    App: {
      getState: async () => ({ isActive: active }),
      addListener(event: string, fn: Listener) {
        const set = listeners.get(event) ?? new Set<Listener>();
        listeners.set(event, set);
        set.add(fn);
        return handle(event, fn);
      },
      exitApp: async () => {
        calls.push('exitApp');
      },
    },
    Browser: {
      open: async ({ url }) => {
        calls.push(`browser ${url}`);
      },
    },
    Clipboard: {
      write: async ({ string }) => {
        calls.push(`clipboard ${string}`);
      },
    },
    Haptics: {
      impact: async (o) => {
        calls.push(`impact ${o?.style}`);
      },
      notification: async (o) => {
        calls.push(`notification ${o?.type}`);
      },
      vibrate: async (o) => {
        calls.push(`vibrate ${o?.duration}`);
      },
    },
    Preferences: {
      get: async ({ key }) => ({ value: prefs.get(key) ?? null }),
      set: async ({ key, value }) => {
        calls.push(`set ${key}=${value}`);
        prefs.set(key, value);
      },
      remove: async ({ key }) => {
        calls.push(`remove ${key}`);
        prefs.delete(key);
      },
      keys: async () => ({ keys: [...prefs.keys()] }),
    },
    ScreenOrientation: {
      lock: async ({ orientation }) => {
        calls.push(`lock ${orientation}`);
      },
      unlock: async () => {
        calls.push('unlock');
      },
    },
  };
  const emit = (event: string, arg?: AppState | BackButtonEvent) => {
    if (event === 'appStateChange') active = (arg as AppState).isActive;
    for (const fn of listeners.get(event) ?? []) (fn as (a: unknown) => void)(arg);
  };
  return { plugins, calls, emit, removed, prefs, setActive: (v: boolean) => (active = v) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createCapacitorHost', () => {
  it('is a capacitor host over the web base: frames and the safe area come from the page', () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(16);
      return 7;
    });
    const caf = vi.fn();
    const win = Object.assign(Object.create(window), {
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    }) as Window;
    const host = createCapacitorHost({ plugins: fakePlugins().plugins, win });
    expect(host.kind).toBe('capacitor');
    const cb = vi.fn();
    expect(host.requestFrame(cb)).toBe(7);
    expect(cb).toHaveBeenCalledWith(16);
    host.cancelFrame(7);
    expect(caf).toHaveBeenCalledWith(7);
    expect(host.embed).toBe('top');
    expect(host.safeArea?.insets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(host.window).toBeUndefined();
  });

  it('opens links in the in-app browser, copies through the clipboard plugin', async () => {
    const f = fakePlugins();
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    expect(host.openExternal('https://example.com/x', { activation: 'gamepad' })).toBe('opened');
    expect(host.openExternal('javascript:alert(1)', { activation: 'pointer' })).toBe('invalid');
    expect(host.clipboardWriteAllowed()).toBe(true);
    expect(await host.copyText('hello')).toBe('copied');
    await tick();
    expect(f.calls).toEqual(['browser https://example.com/x', 'clipboard hello']);
    f.plugins.Clipboard.write = async () => {
      throw new Error('denied');
    };
    expect(await host.copyText('again')).toBe('manual');
  });

  it('has no fullscreen, but toggle({ lockLandscape }) locks the orientation', async () => {
    const f = fakePlugins();
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    expect(host.fullscreen.available()).toBe(false);
    expect(host.fullscreen.active).toBe(false);
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(await host.fullscreen.toggle({ lockLandscape: true })).toBe(false);
    expect(f.calls).toEqual(['lock landscape']);
    f.plugins.ScreenOrientation.lock = async () => {
      throw new Error('tablet');
    };
    expect(await host.fullscreen.toggle({ lockLandscape: true })).toBe(false);
    expect(host.fullscreen.watch(() => {})).toBeTypeOf('function');
  });

  it('follows the app state for its lifecycle and exposes the back button', async () => {
    const f = fakePlugins({ promisedHandles: true });
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    const seen: string[] = [];
    expect(host.lifecycle?.state).toBe('active');
    const off = host.lifecycle!.watch((s) => seen.push(s));
    f.emit('appStateChange', { isActive: false });
    f.emit('appStateChange', { isActive: false });
    expect(host.lifecycle?.state).toBe('background');
    f.emit('resume');
    f.emit('pause');
    f.emit('appStateChange', { isActive: true });
    expect(seen).toEqual(['background', 'active', 'background', 'active']);
    off();
    f.emit('pause');
    expect(seen).toHaveLength(4);

    const backs: BackButtonEvent[] = [];
    const offBack = host.back!.watch((e) => backs.push(e));
    f.emit('backButton', { canGoBack: false });
    expect(backs).toEqual([{ canGoBack: false }]);
    offBack();
    offBack();
    await tick();
    expect(f.removed).toEqual(['backButton']);
    f.emit('backButton', { canGoBack: true });
    expect(backs).toHaveLength(1);
  });

  it('corrects an initial background state from getState()', async () => {
    const f = fakePlugins();
    f.setActive(false);
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    const seen: string[] = [];
    host.lifecycle!.watch((s) => seen.push(s));
    await tick();
    expect(seen).toEqual(['background']);
    expect(host.lifecycle?.state).toBe('background');
  });

  it('maps haptics onto the plugin and drops rejections', async () => {
    const f = fakePlugins();
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    expect(host.haptics?.available()).toBe(true);
    host.haptics?.impact('light');
    host.haptics?.impact('heavy');
    host.haptics?.notification('warning');
    host.haptics?.vibrate(12.4);
    host.haptics?.vibrate(0);
    await tick();
    expect(f.calls).toEqual(['impact LIGHT', 'impact HEAVY', 'notification WARNING', 'vibrate 12']);
    f.plugins.Haptics.impact = async () => {
      throw new Error('no engine');
    };
    expect(() => host.haptics?.impact('medium')).not.toThrow();
    await tick();
  });

  it('serves saves from a Preferences mirror once ready, writing through in order', async () => {
    const f = fakePlugins({ stored: { 'tc:save': '{"v":1}', other: 'x' } });
    const host = createCapacitorHost({ plugins: f.plugins, win: window });
    expect(host.storage.kind).toBe('preferences');
    expect(host.storage.open()).toBeNull();
    await host.ready;
    const s = host.storage.open()!;
    expect(s.getItem('save')).toBe('{"v":1}');
    expect(s.getItem('other')).toBeNull();
    expect(s.length).toBe(1);
    expect(s.key(0)).toBe('save');
    expect(s.key(1)).toBeNull();
    s.setItem('save', '{"v":2}');
    s.setItem('b', '1');
    s.removeItem('b');
    // Reads are synchronous from the mirror, before the plugin heard anything.
    expect(s.getItem('save')).toBe('{"v":2}');
    expect(s.getItem('b')).toBeNull();
    expect(f.calls).toEqual([]);
    await tick();
    expect(f.calls).toEqual(['set tc:save={"v":2}', 'set tc:b=1', 'remove tc:b']);
    expect(f.prefs.get('tc:save')).toBe('{"v":2}');
    expect(f.prefs.has('tc:b')).toBe(false);
  });

  it('keeps writing after a failed write and starts empty when the store is unreadable', async () => {
    const prefs: PreferencesPlugin = {
      keys: async () => {
        throw new Error('gone');
      },
      get: async () => ({ value: null }),
      set: vi.fn(async ({ key }) => {
        if (key === 'tc:bad') throw new Error('quota');
      }),
      remove: async () => {},
    };
    const { storage, ready } = createPreferencesStorage(prefs);
    await ready;
    const s = storage.open()!;
    s.setItem('bad', '1');
    s.setItem('good', '2');
    await tick();
    expect((prefs.set as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(s.getItem('bad')).toBe('1');
  });

  it('falls back to the base host for every plugin not given', async () => {
    const calls: string[] = [];
    const base = {
      kind: 'web',
      requestFrame: () => 1,
      cancelFrame: () => {},
      embed: 'top',
      openExternal: (url: string) => {
        calls.push(`open ${url}`);
        return 'blocked';
      },
      copyText: async () => 'manual',
      clipboardWriteAllowed: () => false,
      fullscreen: {
        available: () => true,
        active: false,
        toggle: async () => true,
        watch: () => () => {},
      },
      storage: { kind: 'local', open: () => null },
      lifecycle: { state: 'active', watch: () => () => {} },
      haptics: { available: () => false, impact() {}, notification() {}, vibrate() {} },
      safeArea: { insets: () => ({ top: 1, right: 2, bottom: 3, left: 4 }), watch: () => () => {} },
    } as unknown as Host;
    const host = createCapacitorHost({ base });
    expect(host.openExternal('https://a.b', { activation: 'pointer' })).toBe('blocked');
    expect(calls).toEqual(['open https://a.b']);
    expect(await host.copyText('x')).toBe('manual');
    expect(host.clipboardWriteAllowed()).toBe(false);
    expect(host.storage).toBe(base.storage);
    expect(host.lifecycle).toBe(base.lifecycle);
    expect(host.haptics).toBe(base.haptics);
    expect(host.safeArea?.insets().top).toBe(1);
    expect(host.back).toBeUndefined();
    await expect(host.ready).resolves.toBeUndefined();
    // Fullscreen is the app's own answer regardless of the base.
    expect(host.fullscreen.available()).toBe(false);
  });
});
