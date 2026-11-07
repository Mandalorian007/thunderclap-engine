// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ThunderclapBridge } from './bridge';
import { createElectronHost, electronBridge, inElectronShell } from './renderer';

/** A bridge that records calls; `fullscreen.emit` plays the main process's change event. */
function fakeBridge(opts: { copy?: boolean | 'throw'; fsStart?: boolean; fsSet?: 'refuse' } = {}) {
  const calls: string[] = [];
  const fsListeners = new Set<(on: boolean) => void>();
  let fs = opts.fsStart ?? false;
  const bridge: ThunderclapBridge & { emit(on: boolean): void } = {
    version: 1,
    platform: 'darwin',
    openExternal: vi.fn(async (url: string) => {
      calls.push(`open ${url}`);
      return true;
    }),
    copyText: vi.fn(async (text: string) => {
      calls.push(`copy ${text}`);
      if (opts.copy === 'throw') throw new Error('ipc gone');
      return opts.copy ?? true;
    }),
    fullscreen: {
      get: async () => fs,
      set: async (on: boolean) => {
        if (opts.fsSet === 'refuse') throw new Error('refused');
        fs = on;
        for (const fn of fsListeners) fn(on);
        return fs;
      },
      onChange(fn) {
        fsListeners.add(fn);
        return () => fsListeners.delete(fn);
      },
    },
    window: {
      minimize: () => calls.push('minimize'),
      toggleMaximize: () => calls.push('toggleMaximize'),
      close: () => calls.push('close'),
      setTitle: (t: string) => calls.push(`title ${t}`),
    },
    emit(on: boolean) {
      fs = on;
      for (const fn of fsListeners) fn(on);
    },
  };
  return { bridge, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createElectronHost', () => {
  it('is the electron host at top level, with window controls', () => {
    const { bridge } = fakeBridge();
    const host = createElectronHost({ bridge });
    expect(host.kind).toBe('electron');
    expect(host.embed).toBe('top');
    expect(host.clipboardWriteAllowed()).toBe(true);
    expect(host.window).toBeDefined();
  });

  it('throws without a bridge; inElectronShell and electronBridge read window.thunderclap', () => {
    expect(inElectronShell()).toBe(false);
    expect(electronBridge()).toBeNull();
    expect(() => createElectronHost()).toThrow(/no window\.thunderclap/);
    const { bridge } = fakeBridge();
    const w = window as unknown as { thunderclap?: ThunderclapBridge };
    w.thunderclap = bridge;
    try {
      expect(inElectronShell()).toBe(true);
      expect(createElectronHost().kind).toBe('electron');
    } finally {
      delete w.thunderclap;
    }
  });

  it('opens plain https links through the bridge for every activation', async () => {
    const { bridge, calls } = fakeBridge();
    const host = createElectronHost({ bridge });
    for (const activation of ['pointer', 'keyboard', 'gamepad', 'script'] as const) {
      expect(host.openExternal(' https://example.com/a ', { activation })).toBe('opened');
    }
    await tick();
    expect(calls).toEqual(Array(4).fill('open https://example.com/a'));
  });

  it('refuses anything but plain https without calling the bridge', () => {
    const { bridge } = fakeBridge();
    const host = createElectronHost({ bridge });
    for (const bad of [
      '',
      'http://example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pw@example.com',
      'https://exa mple.com',
    ]) {
      expect(host.openExternal(bad, { activation: 'pointer' })).toBe('invalid');
    }
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it('a failing open in the main process does not throw in the page', async () => {
    const { bridge } = fakeBridge();
    bridge.openExternal = vi.fn(() => Promise.reject(new Error('no browser')));
    const host = createElectronHost({ bridge });
    expect(host.openExternal('https://example.com', { activation: 'pointer' })).toBe('opened');
    await tick();
  });

  it('copies through the bridge; a refusal or a lost bridge is manual', async () => {
    const ok = fakeBridge();
    expect(await createElectronHost({ bridge: ok.bridge }).copyText('hi')).toBe('copied');
    expect(ok.calls).toEqual(['copy hi']);
    const refused = fakeBridge({ copy: false });
    expect(await createElectronHost({ bridge: refused.bridge }).copyText('hi')).toBe('manual');
    const broken = fakeBridge({ copy: 'throw' });
    expect(await createElectronHost({ bridge: broken.bridge }).copyText('hi')).toBe('manual');
  });

  it('tracks fullscreen from the bridge and toggles it', async () => {
    const { bridge } = fakeBridge({ fsStart: true });
    const host = createElectronHost({ bridge });
    expect(host.fullscreen.available()).toBe(true);
    await tick();
    expect(host.fullscreen.active).toBe(true);

    const seen: boolean[] = [];
    const off = host.fullscreen.watch((on) => seen.push(on));
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(host.fullscreen.active).toBe(false);
    bridge.emit(true); // e.g. the macOS green button
    expect(host.fullscreen.active).toBe(true);
    bridge.emit(true); // no change, no report
    off();
    bridge.emit(false);
    expect(seen).toEqual([false, true]);
  });

  it('a refused fullscreen toggle leaves the state as it was', async () => {
    const { bridge } = fakeBridge({ fsSet: 'refuse' });
    const host = createElectronHost({ bridge });
    await tick();
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(host.fullscreen.active).toBe(false);
  });

  it('window controls call the bridge', () => {
    const { bridge, calls } = fakeBridge();
    const w = createElectronHost({ bridge }).window!;
    w.minimize?.();
    w.toggleMaximize?.();
    w.setTitle?.('Title');
    w.close();
    expect(calls).toEqual(['minimize', 'toggleMaximize', 'title Title', 'close']);
  });

  it('storage is the page localStorage, probed like the web host', () => {
    const { bridge } = fakeBridge();
    const host = createElectronHost({ bridge });
    expect(host.storage.kind).toBe('local');
    const st = host.storage.open();
    expect(st).not.toBeNull();
    st?.setItem('tc:test', '1');
    expect(window.localStorage.getItem('tc:test')).toBe('1');
    window.localStorage.removeItem('tc:test');
  });

  it('storage is null when localStorage throws', () => {
    const { bridge } = fakeBridge();
    const win = {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
      self: null as unknown,
      top: null as unknown,
    };
    win.self = win;
    win.top = win;
    const host = createElectronHost({ bridge, win: win as unknown as Window });
    expect(host.storage.open()).toBeNull();
  });
});
