// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipboardWriteAllowed, copyText, openExternal } from './web-links';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** A window-like object with just what links.ts reads. */
function fakeWin(over: Record<string, unknown> = {}): Window {
  return { document, navigator: {}, open: () => null, ...over } as unknown as Window;
}

describe('openExternal', () => {
  it('invalid URLs do nothing', () => {
    const open = vi.fn();
    expect(openExternal('http://x.test', { activation: 'gamepad' }, fakeWin({ open }))).toBe(
      'invalid',
    );
    expect(open).not.toHaveBeenCalled();
  });
  it('pointer/keyboard click a temporary noopener anchor and remove it', () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const open = vi.fn();
    expect(openExternal('https://x.test/', { activation: 'pointer' }, fakeWin({ open }))).toBe(
      'opened',
    );
    expect(open).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.target).toBe('_blank');
    expect(clicked[0]?.rel).toBe('noopener noreferrer');
    expect(clicked[0]?.isConnected).toBe(false);
  });
  it('gamepad uses window.open; null means blocked', () => {
    const open = vi.fn(() => null);
    expect(openExternal('https://x.test/', { activation: 'gamepad' }, fakeWin({ open }))).toBe(
      'blocked',
    );
    expect(open).toHaveBeenCalledWith('https://x.test/', '_blank');
  });
  it('gamepad: an opened tab loses its opener', () => {
    const tab = { opener: {} as unknown };
    const open = vi.fn(() => tab);
    expect(openExternal('https://x.test/', { activation: 'script' }, fakeWin({ open }))).toBe(
      'opened',
    );
    expect(tab.opener).toBeNull();
  });
  it('a throwing window.open counts as blocked', () => {
    const open = vi.fn(() => {
      throw new Error('nope');
    });
    expect(openExternal('https://x.test/', { activation: 'gamepad' }, fakeWin({ open }))).toBe(
      'blocked',
    );
  });
});

describe('copyText', () => {
  it('uses the Clipboard API when it works', async () => {
    const writeText = vi.fn(async () => {});
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const r = await copyText(
      'https://x.test/',
      fakeWin({ navigator: { clipboard: { writeText } } }),
    );
    expect(r).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://x.test/');
    expect(exec).not.toHaveBeenCalled();
  });
  it('falls back to execCommand when writeText is refused, and cleans up', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    let selected = '';
    document.execCommand = vi.fn(() => {
      const ta = document.querySelector('textarea');
      selected = ta?.value ?? '';
      return true;
    });
    const r = await copyText(
      'https://x.test/',
      fakeWin({ navigator: { clipboard: { writeText } } }),
    );
    expect(r).toBe('copied');
    expect(selected).toBe('https://x.test/');
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('restores focus after the execCommand textarea', async () => {
    const btn = document.createElement('button');
    document.body.append(btn);
    btn.focus();
    document.execCommand = vi.fn(() => true);
    await copyText('https://x.test/', fakeWin({ navigator: {} }));
    expect(document.activeElement).toBe(btn);
  });
  it('skips writeText when the frame policy forbids clipboard-write (itch), uses execCommand', async () => {
    const writeText = vi.fn(async () => {});
    const doc = document as Document & { featurePolicy?: unknown };
    doc.featurePolicy = { allowsFeature: (f: string) => f !== 'clipboard-write' };
    document.execCommand = vi.fn(() => true);
    try {
      const r = await copyText(
        'https://x.test/',
        fakeWin({ navigator: { clipboard: { writeText } } }),
      );
      expect(r).toBe('copied');
      expect(writeText).not.toHaveBeenCalled();
      expect(clipboardWriteAllowed(document)).toBe(false);
    } finally {
      delete doc.featurePolicy;
    }
    expect(clipboardWriteAllowed(document)).toBe(true);
  });
  it('manual when there is no clipboard and execCommand fails', async () => {
    document.execCommand = vi.fn(() => false);
    expect(await copyText('https://x.test/', fakeWin({ navigator: {} }))).toBe('manual');
    document.execCommand = vi.fn(() => {
      throw new Error('unsupported');
    });
    expect(await copyText('https://x.test/', fakeWin({ navigator: {} }))).toBe('manual');
  });
});
