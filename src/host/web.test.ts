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
