// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaveStore, MemoryStorage, s } from '../save';
import { externalLink } from '../ui/link';
import { defaultHost, setDefaultHost } from './default';
import type { Host } from './types';
import { createWebHost } from './web';

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultHost(null);
  document.body.innerHTML = '';
});

/** A window-like object with just what the web host reads. */
function fakeWin(over: Record<string, unknown> = {}): Window {
  const w: Record<string, unknown> = { document, navigator: {}, open: () => null, ...over };
  if (!('self' in over)) w.self = w;
  if (!('top' in over)) w.top = w;
  return w as unknown as Window;
}

/** Storage whose writes throw a quota error while `full`. */
class FullStorage extends MemoryStorage {
  full = true;
  override setItem(key: string, value: string): void {
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    super.setItem(key, value);
  }
}

const Data = s.object({ n: s.number() });
const store = (host: Pick<Host, 'storage'>) =>
  createSaveStore({
    game: 'host-test',
    version: 1,
    defaults: () => ({ n: 0 }),
    schema: Data,
    host,
    debounceMs: 0,
    autoFlush: false,
  });

describe('createWebHost', () => {
  it('is the web kind and detects (does not assume) the embed', () => {
    expect(createWebHost({ win: fakeWin() }).kind).toBe('web');
    expect(createWebHost({ win: fakeWin() }).embed).toBe('top');
    const top = {
      get location(): never {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    expect(createWebHost({ win: fakeWin({ self: {}, top }) }).embed).toBe('cross-origin-frame');
    expect(createWebHost().embed).toBe('top');
    expect(createWebHost().window).toBeUndefined();
  });

  it("schedules frames through its window's requestAnimationFrame", () => {
    const calls: string[] = [];
    const host = createWebHost({
      win: fakeWin({
        requestAnimationFrame: (cb: (t: number) => void) => {
          calls.push('request');
          cb(16);
          return 42;
        },
        cancelAnimationFrame: (h: number) => calls.push(`cancel ${h}`),
      }),
    });
    const seen: number[] = [];
    expect(host.requestFrame((t) => seen.push(t))).toBe(42);
    host.cancelFrame(42);
    expect(seen).toEqual([16]);
    expect(calls).toEqual(['request', 'cancel 42']);
  });

  it('opens through its window: a pad press uses window.open, null means blocked', () => {
    const open = vi.fn(() => null);
    const host = createWebHost({ win: fakeWin({ open }) });
    expect(host.openExternal('https://x.test/', { activation: 'gamepad' })).toBe('blocked');
    expect(open).toHaveBeenCalledWith('https://x.test/', '_blank');
    expect(host.openExternal('javascript:alert(1)', { activation: 'gamepad' })).toBe('invalid');
    expect(open).toHaveBeenCalledOnce();
  });

  it("copies through its window's clipboard, else execCommand, else manual", async () => {
    const writeText = vi.fn(async () => {});
    const host = createWebHost({ win: fakeWin({ navigator: { clipboard: { writeText } } }) });
    expect(host.clipboardWriteAllowed()).toBe(true);
    expect(await host.copyText('hello')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('hello');
    document.execCommand = vi.fn(() => false);
    expect(await createWebHost({ win: fakeWin() }).copyText('hello')).toBe('manual');
  });

  it('fullscreen wraps the document: absent, toggle, watch', async () => {
    const doc = document as Document & { fullscreenEnabled: boolean };
    const host = createWebHost({ win: fakeWin() });
    Object.defineProperty(doc, 'fullscreenEnabled', { value: false, configurable: true });
    expect(host.fullscreen.available()).toBe(false);
    Object.defineProperty(doc, 'fullscreenEnabled', { value: true, configurable: true });
    const req = vi.fn(async () => {});
    document.documentElement.requestFullscreen = req;
    expect(host.fullscreen.available()).toBe(true);
    expect(host.fullscreen.active()).toBe(false);
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(req).toHaveBeenCalledOnce();
    const seen: boolean[] = [];
    const off = host.fullscreen.watch((on) => seen.push(on));
    document.dispatchEvent(new Event('fullscreenchange'));
    off();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(seen).toEqual([false]);
  });
});

describe('web host storage', () => {
  it('is localStorage when it round-trips', () => {
    const mem = new MemoryStorage();
    const host = createWebHost({ win: fakeWin({ localStorage: mem }) });
    expect(host.storage.kind).toBe('local');
    expect(host.storage.open()).toBe(mem);
    expect(mem.length).toBe(0);
    expect(createWebHost().storage.open()).toBe(globalThis.localStorage);
  });

  it('is null when reading localStorage throws, it is missing, or writes throw', () => {
    const blocked = fakeWin();
    Object.defineProperty(blocked, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(createWebHost({ win: blocked }).storage.open()).toBeNull();
    expect(createWebHost({ win: fakeWin({ localStorage: undefined }) }).storage.open()).toBeNull();
    expect(
      createWebHost({ win: fakeWin({ localStorage: new FullStorage() }) }).storage.open(),
    ).toBeNull();
  });

  it('a save on blocked storage keeps memory, and persists once storage comes back', () => {
    let backend: MemoryStorage | undefined;
    const win = fakeWin();
    Object.defineProperty(win, 'localStorage', {
      get() {
        if (!backend) throw new DOMException('denied', 'SecurityError');
        return backend;
      },
    });
    const st = store(createWebHost({ win }));
    expect(st.persistent).toBe(false);
    expect(st.status.error).toMatch(/memory/);
    st.set({ n: 1 });
    expect(st.get().n).toBe(1);
    expect(st.persistent).toBe(false);
    backend = new MemoryStorage();
    st.set({ n: 2 });
    expect(st.persistent).toBe(true);
    expect(JSON.parse(backend.getItem('thunderclap:host-test:main') ?? '{}').d).toEqual({ n: 2 });
  });

  it('a save on a full localStorage says so and keeps playing from memory', () => {
    const full = new FullStorage();
    // The probe itself writes, so let it through once and fill up afterwards.
    full.full = false;
    const st = store(createWebHost({ win: fakeWin({ localStorage: full }) }));
    expect(st.persistent).toBe(true);
    full.full = true;
    st.set({ n: 5 });
    expect(st.persistent).toBe(false);
    expect(st.status.error).toMatch(/full/);
    expect(st.get().n).toBe(5);
  });

  it('loads saves written before the host existed (same thunderclap:<game>:<slot> key)', () => {
    const mem = new MemoryStorage();
    mem.setItem('thunderclap:host-test:main', JSON.stringify({ v: 1, t: 7, d: { n: 42 } }));
    const st = store(createWebHost({ win: fakeWin({ localStorage: mem }) }));
    expect(st.status.loadResult).toBe('loaded');
    expect(st.get().n).toBe(42);
  });
});

describe('default host', () => {
  it('is one web host until replaced; save and externalLink use it when given none', async () => {
    const a = defaultHost();
    expect(a.kind).toBe('web');
    expect(defaultHost()).toBe(a);

    const mem = new MemoryStorage();
    const copyText = vi.fn(async () => 'copied' as const);
    const openExternal = vi.fn(() => 'blocked' as const);
    const fake: Host = {
      ...a,
      kind: 'electron',
      storage: { kind: 'fake', open: () => mem },
      copyText,
      openExternal,
    };
    setDefaultHost(fake);
    expect(defaultHost()).toBe(fake);

    const st = createSaveStore({
      game: 'host-test',
      version: 1,
      defaults: () => ({ n: 0 }),
      schema: Data,
      debounceMs: 0,
      autoFlush: false,
    });
    st.set({ n: 3 });
    expect(mem.getItem('thunderclap:host-test:main')).toContain('"n":3');

    const link = externalLink({
      url: 'https://x.test/',
      content: 'X',
      labels: {
        copy: 'Copy',
        copied: 'Copied',
        copiedAnnounce: 'Copied.',
        copyBlocked: 'Blocked',
        popupBlocked: 'Blocked',
        close: 'Close',
      },
    });
    expect(await link?.copy()).toBe('copied');
    expect(copyText).toHaveBeenCalledWith('https://x.test/');
    expect(link?.open('gamepad')).toBe('blocked');
    expect(openExternal).toHaveBeenCalledWith('https://x.test/', { activation: 'gamepad' });

    setDefaultHost(null);
    expect(defaultHost()).not.toBe(fake);
  });

  it('an explicit host wins over the default', async () => {
    setDefaultHost({ ...defaultHost(), copyText: async () => 'manual' });
    const copyText = vi.fn(async () => 'copied' as const);
    const link = externalLink({
      url: 'https://x.test/',
      content: 'X',
      host: { copyText, openExternal: () => 'opened' },
      labels: {
        copy: 'Copy',
        copied: 'Copied',
        copiedAnnounce: 'Copied.',
        copyBlocked: 'Blocked',
        popupBlocked: 'Blocked',
        close: 'Close',
      },
    });
    expect(await link?.copy()).toBe('copied');
  });
});

describe('web host lifecycle', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => setHidden(false));

  it('is active while visible, background when hidden or paged out, and reports each change once', () => {
    const win = fakeWin({ addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const host = createWebHost({ win });
    const seen: string[] = [];
    expect(host.lifecycle?.state()).toBe('active');
    const off = host.lifecycle!.watch((s) => seen.push(s));
    setHidden(true);
    setHidden(true);
    expect(host.lifecycle?.state()).toBe('background');
    setHidden(false);
    expect(seen).toEqual(['background', 'active']);
    // freeze (Android) counts as paged out until resume, whatever visibilityState says.
    document.dispatchEvent(new Event('freeze'));
    expect(host.lifecycle?.state()).toBe('background');
    document.dispatchEvent(new Event('resume'));
    expect(seen).toEqual(['background', 'active', 'background', 'active']);
    // pagehide / pageshow go through the window.
    const add = win.addEventListener as unknown as ReturnType<typeof vi.fn>;
    expect(add.mock.calls.map((c) => c[0])).toEqual(['pagehide', 'pageshow']);
    (add.mock.calls[0]![1] as () => void)();
    expect(host.lifecycle?.state()).toBe('background');
    (add.mock.calls[1]![1] as () => void)();
    expect(seen).toEqual(['background', 'active', 'background', 'active', 'background', 'active']);
    off();
    setHidden(true);
    expect(seen).toHaveLength(6);
    const remove = win.removeEventListener as unknown as ReturnType<typeof vi.fn>;
    expect(remove.mock.calls).toHaveLength(2);
  });
});

describe('web host haptics', () => {
  it('is unavailable without navigator.vibrate and every call is a no-op', () => {
    const host = createWebHost({ win: fakeWin() });
    expect(host.haptics?.available()).toBe(false);
    expect(() => {
      host.haptics?.impact('light');
      host.haptics?.notification('error');
      host.haptics?.vibrate(50);
    }).not.toThrow();
  });

  it('maps impact, notification and vibrate onto navigator.vibrate', () => {
    const vibrate = vi.fn((_pattern: number | number[]) => true);
    const host = createWebHost({ win: fakeWin({ navigator: { vibrate } }) });
    expect(host.haptics?.available()).toBe(true);
    host.haptics?.impact('light');
    host.haptics?.impact('heavy');
    host.haptics?.notification('success');
    host.haptics?.vibrate(50.4);
    host.haptics?.vibrate(0);
    expect(vibrate.mock.calls.map((c) => c[0])).toEqual([10, 35, [10, 40, 10], 50]);
    // A refusal is swallowed.
    vibrate.mockImplementation(() => {
      throw new Error('no gesture');
    });
    expect(() => host.haptics?.vibrate(5)).not.toThrow();
  });
});

describe('web host safe area', () => {
  it('reads the probe (env()/--tc-safe-* padding), caches until a resize, and reports changes', () => {
    // happy-dom does not resolve env(); the probe's computed padding is stubbed. The CSS itself
    // is the layout's `readSafeArea` rule, which e2e/layout.spec.ts exercises under CDP insets.
    const padding = { top: '0px', right: '0px', bottom: '0px', left: '0px' };
    const probes: Element[] = [];
    const listeners = new Map<string, () => void>();
    const win = fakeWin({
      getComputedStyle: (el: Element) => {
        probes.push(el);
        return {
          paddingTop: padding.top,
          paddingRight: padding.right,
          paddingBottom: padding.bottom,
          paddingLeft: padding.left,
        };
      },
      addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
      removeEventListener: vi.fn(),
    });
    const host = createWebHost({ win });
    const sa = host.safeArea!;
    expect(sa.insets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(probes).toHaveLength(1);
    expect(probes[0]!.isConnected).toBe(false);
    expect((probes[0] as HTMLElement).style.padding).toContain('env(safe-area-inset-top');
    padding.top = '44px';
    padding.bottom = '34px';
    // Cached: no re-read until the window resizes.
    expect(sa.insets().top).toBe(0);
    expect(probes).toHaveLength(1);
    const seen: number[] = [];
    const off = sa.watch((i) => seen.push(i.top));
    listeners.get('resize')!();
    expect(seen).toEqual([44]);
    expect(sa.insets()).toEqual({ top: 44, right: 0, bottom: 34, left: 0 });
    // The same values again: no report.
    listeners.get('resize')!();
    expect(seen).toEqual([44]);
    padding.top = '59px';
    listeners.get('orientationchange')!();
    expect(seen).toEqual([44, 59]);
    off();
    padding.top = '0px';
    listeners.get('resize')!();
    expect(seen).toEqual([44, 59]);
    expect(sa.insets().top).toBe(0);
    expect(document.querySelectorAll('div')).toHaveLength(0);
  });

  it('is all zero when there is no body to probe', () => {
    const doc = { body: null } as unknown as Document;
    const host = createWebHost({ win: fakeWin({ document: doc, getComputedStyle: () => ({}) }) });
    expect(host.safeArea?.insets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
