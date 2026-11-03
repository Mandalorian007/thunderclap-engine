// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateLink, type ExternalLinkLabels, externalLink } from './link';

const labels: ExternalLinkLabels = {
  copy: 'Copy link',
  copied: 'Copied!',
  copiedAnnounce: 'Link copied.',
  copyAriaLabel: 'Copy link to the shop',
  copyBlocked: 'Copy blocked. Copy the link:',
  popupBlocked: 'New tab blocked. Copy the link:',
  close: 'Close',
};
const URL_ = 'https://shop.example/page';

function setClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function make() {
  const w = externalLink({ url: URL_, content: 'Shop', labels, action: 'shop' });
  if (!w) throw new Error('expected a widget');
  document.body.append(w.element);
  return w;
}

describe('externalLink', () => {
  it('returns null for a blank or unsafe URL (hide the control)', () => {
    expect(externalLink({ url: '', content: 'x', labels })).toBeNull();
    expect(externalLink({ url: 'http://x.test', content: 'x', labels })).toBeNull();
  });

  it('renders a real new-tab anchor and a labelled Copy button; fallback hidden', () => {
    const w = make();
    expect(w.anchor.getAttribute('href')).toBe(URL_);
    expect(w.anchor.target).toBe('_blank');
    expect(w.anchor.rel).toBe('noopener noreferrer');
    expect(w.anchor.dataset.action).toBe('shop');
    expect(w.copyButton.textContent).toBe('Copy link');
    expect(w.copyButton.getAttribute('aria-label')).toBe('Copy link to the shop');
    expect(w.copyButton.dataset.action).toBe('shop-copy');
    const fb = w.element.querySelector<HTMLElement>('[data-action="shop-fallback"]');
    expect(fb?.hidden).toBe(true);
  });

  it('does nothing on its own: no copy, no open', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    const open = vi.spyOn(window, 'open');
    make();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('Copy writes the URL, shows Copied, announces it, then resets', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    const w = make();
    w.copyButton.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(w.copyButton.textContent).toBe('Copied!');
    expect(w.copyButton.hasAttribute('data-copied')).toBe(true);
    expect(w.element.querySelector('[aria-live="polite"]')?.textContent).toBe('Link copied.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(w.copyButton.textContent).toBe('Copy link');
  });

  it('a failed copy shows the selected read-only field; Close and Escape hide it', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    const w = make();
    const r = await w.copy();
    expect(r).toBe('manual');
    const fb = w.element.querySelector<HTMLElement>('.tc-link-fallback')!;
    const field = fb.querySelector<HTMLInputElement>('input')!;
    expect(fb.hidden).toBe(false);
    expect(fb.textContent).toContain('Copy blocked. Copy the link:');
    expect(field.value).toBe(URL_);
    expect(field.hasAttribute('readonly')).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.labels?.[0]?.textContent).toBe('Copy blocked. Copy the link:');
    fb.querySelector<HTMLButtonElement>('[data-action="shop-close"]')!.click();
    expect(fb.hidden).toBe(true);
    expect(document.activeElement).toBe(w.copyButton);
    w.showFallback('copy');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fb.hidden).toBe(true);
  });

  it('activateLink on the anchor (gamepad) opens via window.open; blocked shows the field', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const w = make();
    expect(activateLink(w.anchor, 'gamepad')).toBe('blocked');
    expect(open).toHaveBeenCalledWith(URL_, '_blank');
    const fb = w.element.querySelector<HTMLElement>('.tc-link-fallback')!;
    expect(fb.hidden).toBe(false);
    expect(fb.textContent).toContain('New tab blocked. Copy the link:');
  });

  it('activateLink on anything else just clicks it', () => {
    const b = document.createElement('button');
    const click = vi.fn();
    b.addEventListener('click', click);
    expect(activateLink(b, 'gamepad')).toBeNull();
    expect(click).toHaveBeenCalledOnce();
  });
});
