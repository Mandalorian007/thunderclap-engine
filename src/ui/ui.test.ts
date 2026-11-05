// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionCard, cornerOrder, overlapArea, readingTimeMs, revealDelayMs } from './caption';
import { h } from './dom';
import { createOverlay, type Overlay } from './overlay';
import { type PadLike, PadNav } from './padnav';
import { NO_RESTORE_FOCUS_ATTR } from './stack';
import { themeToCss, tokenVar } from './theme';
import { Toaster } from './toast';
import { button, slider } from './widgets';

const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};

describe('theme', () => {
  it('maps token names to custom properties', () => {
    expect(tokenVar('colorAccent')).toBe('--tc-color-accent');
    expect(tokenVar('fontSizeXl')).toBe('--tc-font-size-xl');
    expect(tokenVar('space1')).toBe('--tc-space-1');
    expect(themeToCss({ colorText: '#fff' })).toBe('--tc-color-text: #fff;');
  });
});

describe('overlay', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ov.destroy());

  it('mounts layers, injects styles once, applies theme vars', () => {
    expect(parent.querySelector('.tc-overlay')).toBe(ov.root);
    expect(Object.keys(ov.layers)).toEqual(['hud', 'captions', 'layout', 'panels', 'toasts']);
    createOverlay({ parent }).destroy();
    expect(document.querySelectorAll('#tc-ui-base').length).toBe(1);
    expect(ov.root.style.getPropertyValue('--tc-color-accent')).toBeTruthy();
  });

  it('a modal panel suspends the caption, which sits below the panels layer', () => {
    ov.caption.say('Over the hall', { hold: 0 });
    const p = ov.stack.push({ title: 'Settings', content: button('OK', () => {}) });
    expect(ov.caption.suspended).toBe(true);
    p.close();
    expect(ov.caption.suspended).toBe(false);
    expect(ov.caption.currentText).toBe('Over the hall');
  });

  it('puts the frame in CSS custom properties, never a transform; maps client coords', () => {
    const v = (k: string) => ov.root.style.getPropertyValue(k);
    ov.setFrame({ x: 10, y: 20, width: 960, height: 540 });
    expect(ov.scale).toBe(0.5);
    expect(ov.root.style.transform).toBe('');
    expect([v('--tc-frame-x'), v('--tc-frame-y'), v('--tc-frame-w'), v('--tc-frame-h')]).toEqual([
      '10px',
      '20px',
      '960px',
      '540px',
    ]);
    expect(v('--tc-dpx')).toBe('0.5px');
    expect(v('--tc-zoom')).toBe('0.5');
    expect(ov.frame).toEqual({ x: 10, y: 20, width: 960, height: 540 });
    expect(ov.clientToDesign(10 + 480, 20 + 270)).toEqual({ x: 960, y: 540 });
    expect(ov.clientToDesign(0, 0)).toBeNull();
  });

  it('desktop is in frame units: the theme is design px times --tc-dpx', () => {
    expect(ov.units).toBe('frame');
    expect(ov.root.dataset.units).toBe('frame');
    expect(ov.root.style.getPropertyValue('--tc-space-3')).toBe('calc(16 * var(--tc-unit, 1px))');
  });

  it('modal panels: focus first control, trap Tab, Esc closes and restores focus', () => {
    const opener = button('open', () => {});
    ov.layers.hud.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const a = button('A', () => {});
    const b = button('B', () => {});
    const p = ov.stack.push({ title: 'Settings', content: h('div', null, a, b), onClose });
    expect(p.element.getAttribute('role')).toBe('dialog');
    expect(p.element.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement).toBe(a);
    expect(ov.stack.hasModal).toBe(true);
    expect(ov.layers.hud.inert).toBe(true);

    b.focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(b);

    const esc = key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(ov.stack.size).toBe(0);
    expect(ov.stack.hasModal).toBe(false);
    expect(ov.layers.hud.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('focus home: openers marked no-restore send focus home instead', () => {
    ov.destroy();
    document.body.innerHTML = '';
    parent = h('div');
    const home = h('canvas', { tabindex: '0' });
    parent.append(home);
    document.body.append(parent);
    ov = createOverlay({ parent, focusHome: () => home });
    const bar = h('div', { [NO_RESTORE_FOCUS_ATTR]: '' });
    const opener = button('open', () => {});
    bar.append(opener);
    ov.layers.hud.append(bar);
    opener.focus();
    ov.stack.push({ title: 'Help', content: button('x', () => {}) });
    key('Escape');
    expect(document.activeElement).toBe(home);

    // A stacked panel still gets focus back from the one above it.
    const lower = ov.stack.push({ title: 'One', content: button('low', () => {}) });
    ov.stack.push({ title: 'Two', content: button('up', () => {}) });
    key('Escape');
    expect(document.activeElement?.textContent).toBe('low');
    lower.close();
    expect(document.activeElement).toBe(home);

    // Nothing focused before opening (body) also goes home.
    (document.activeElement as HTMLElement).blur();
    ov.stack.push({ title: 'T', content: button('t', () => {}) }).close();
    expect(document.activeElement).toBe(home);

    // Unmarked openers are restored as usual, in the hud layer too.
    const other = button('other', () => {});
    ov.layers.hud.append(other);
    other.focus();
    ov.stack.push({ title: 'T', content: button('t', () => {}) }).close();
    expect(document.activeElement).toBe(other);
  });

  it('pad nav: d-pad moves focus in the top modal, A clicks, sliders step, B closes', () => {
    const held = new Set<number>();
    const pad: PadLike = {
      get buttons() {
        return Array.from({ length: 16 }, (_, i) => ({ pressed: held.has(i) }));
      },
      axes: [0, 0],
    };
    const nav = new PadNav(ov.stack, { getGamepads: () => [pad] });
    const tap = (b: number) => {
      held.add(b);
      nav.update();
      held.delete(b);
      nav.update();
    };
    tap(13); // nothing open: ignored
    const clicked = vi.fn();
    const vol = slider('Vol', 5, () => {}, { min: 0, max: 10, step: 1 });
    const range = vol.input;
    const closed = vi.fn();
    ov.stack.push({
      title: 'P',
      content: h('div', {}, button('a', clicked), vol.element),
      onClose: closed,
    });
    expect(document.activeElement?.textContent).toBe('a');
    tap(0);
    expect(clicked).toHaveBeenCalledTimes(1);
    tap(13);
    expect(document.activeElement).toBe(range);
    tap(15);
    expect(range.value).toBe('6');
    tap(1);
    expect(closed).toHaveBeenCalledWith('escape');
    expect(ov.stack.size).toBe(0);
  });

  it('stacks panels: lower ones go inert; non-dismissible ignores Esc', () => {
    const first = ov.stack.push({ title: 'One', content: button('x', () => {}) });
    const second = ov.stack.push({
      title: 'Two',
      content: button('y', () => {}),
      dismissible: false,
    });
    expect(first.element.closest('.tc-panel-host')!.hasAttribute('inert')).toBe(true);
    key('Escape');
    expect(ov.stack.size).toBe(2);
    second.close();
    expect(first.element.closest('.tc-panel-host')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.textContent).toBe('x');
    const changes = vi.fn();
    ov.stack.onChange(changes);
    ov.stack.clear();
    expect(changes).toHaveBeenCalled();
    expect(ov.stack.size).toBe(0);
  });

  it('non-modal panels do not block or trap', () => {
    ov.stack.push({ label: 'Journal', content: h('p', null, 'hi'), modal: false });
    expect(ov.stack.hasModal).toBe(false);
    expect(ov.layers.hud.inert).toBe(false);
    expect(key('Tab').defaultPrevented).toBe(false);
  });

  it('backdrop click closes dismissible modals', () => {
    const onClose = vi.fn();
    const p = ov.stack.push({ title: 'T', content: h('p'), onClose });
    (p.element.parentElement!.querySelector('.tc-backdrop') as HTMLElement).click();
    expect(onClose).toHaveBeenCalledWith('backdrop');
  });
});

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses, caps count, lives in a polite region', () => {
    const host = h('div');
    const t = new Toaster(host, 2);
    expect(t.element.getAttribute('aria-live')).toBe('polite');
    t.show('a', { duration: 1000 });
    t.show('b', { duration: 0, tone: 'warn' });
    t.show('c');
    expect(t.count).toBe(2);
    expect(t.element.textContent).toBe('bc');
    vi.advanceTimersByTime(4000);
    expect(t.element.textContent).toBe('b');
    (t.element.firstChild as HTMLElement).click();
    expect(t.count).toBe(0);
  });
});

describe('caption card', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reading time and reveal pacing are sane', () => {
    expect(readingTimeMs('Hi')).toBe(2000);
    expect(readingTimeMs('x'.repeat(1000))).toBe(12000);
    expect(readingTimeMs('x'.repeat(100))).toBe(1200 + 4500);
    expect(revealDelayMs('.', 50)).toBeGreaterThan(revealDelayMs('a', 50));
  });

  it('types out, holds, then resolves and hides; live region gets the full line up front', async () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: false, cps: 100 });
    const chars: string[] = [];
    const done = vi.fn();
    card.say('Hi you', { speaker: 'NARRATOR', hold: 500, onChar: (c) => chars.push(c) }).then(done);
    const live = host.querySelector('[aria-live]')!;
    expect(live.textContent).toBe('NARRATOR: Hi you');
    expect(card.element.hidden).toBe(false);
    const text = card.element.querySelector('.tc-caption-text')!;
    expect(text.textContent).toBe('Hi you'); // layout reserved
    expect(text.querySelector('.tc-caption-pending')!.textContent!.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(text.querySelector('.tc-caption-pending')!.textContent).toBe('');
    expect(chars.join('')).toBe('Hiyou');
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toHaveBeenCalled();
    expect(card.element.hidden).toBe(true);
  });

  it('click skips typing, second click advances to the queued line', async () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: false, cps: 10 });
    const first = vi.fn();
    card.say('A long line', { hold: 0 }).then(first);
    card.say('Next', { hold: 0 });
    expect(card.queued).toBe(1);
    card.element.click();
    expect(card.element.querySelector('.tc-caption-pending')!.textContent).toBe('');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first).not.toHaveBeenCalled(); // hold 0 waits for a click
    card.element.click();
    await Promise.resolve();
    expect(first).toHaveBeenCalled();
    expect(card.currentText).toBe('Next');
    card.clear();
    expect(card.busy).toBe(false);
  });

  it('overlap and corner order are pure', () => {
    const box = { x: 0, y: 0, width: 100, height: 50 };
    expect(overlapArea(box, [])).toBe(0);
    expect(overlapArea(box, [{ x: 50, y: 25, width: 100, height: 100 }])).toBe(50 * 25);
    expect(overlapArea(box, [{ x: 100, y: 0, width: 10, height: 10 }])).toBe(0); // touching edge
    expect(cornerOrder('bottom-right')).toEqual([
      'bottom-right',
      'bottom-left',
      'top-right',
      'top-left',
    ]);
    expect(cornerOrder('top-left')).toEqual([
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
  });

  it('suspend hides and freezes the line; resume carries on with a fresh hold', async () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: false, cps: 100 });
    const done = vi.fn();
    card.say('Hello there', { hold: 500 }).then(done);
    card.suspend(true);
    expect(card.suspended).toBe(true);
    expect(card.element.hasAttribute('data-suspended')).toBe(true);
    const pending = () => card.element.querySelector('.tc-caption-pending')!.textContent;
    const before = pending();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending()).toBe(before); // typing frozen
    expect(done).not.toHaveBeenCalled();
    card.say('Queued while hidden');
    expect(card.queued).toBe(1);
    card.suspend(false);
    expect(card.element.hasAttribute('data-suspended')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(pending()).toBe('');
    card.suspend(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).not.toHaveBeenCalled(); // hold frozen too
    card.suspend(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toHaveBeenCalled();
    expect(card.currentText).toBe('Queued while hidden');
  });

  it('speaker sits under the portrait, or above the text without one', () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: true });
    card.say('With face', { speaker: 'BOT', portrait: h('canvas'), hold: 0 });
    const speaker = card.element.querySelector('.tc-caption-speaker')!;
    expect(speaker.parentElement!.classList.contains('tc-caption-side')).toBe(true);
    card.advance();
    card.say('No face', { speaker: 'BOT', hold: 0 });
    expect(speaker.parentElement!.classList.contains('tc-caption-body')).toBe(true);
    expect(card.element.querySelector<HTMLElement>('.tc-caption-side')!.hidden).toBe(true);
  });

  it('onPlace runs when a line is laid out in its corner, after the corner is reset', () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: true });
    const seen: string[] = [];
    card.onPlace((el) => {
      seen.push(el.dataset.corner!);
      el.dataset.corner = 'top-left';
      el.style.maxWidth = '300px';
    });
    card.say('One', { hold: 0 });
    expect(seen).toEqual(['bottom-right']);
    expect(card.element.dataset.corner).toBe('top-left');
    card.advance();
    card.say('Two', { hold: 0, corner: 'bottom-left' });
    expect(seen).toEqual(['bottom-right', 'bottom-left']);
    card.dock(h('div'));
    card.relayout();
    expect(seen.length).toBe(2);
    card.dock(null);
    expect(seen.length).toBe(3);
    card.destroy();
  });

  it('reduced motion shows the line at once', () => {
    const host = h('div');
    const card = new CaptionCard(host, { reducedMotion: true });
    const onChar = vi.fn();
    card.say('Instant.', { onChar });
    expect(card.element.querySelector('.tc-caption-pending')!.textContent).toBe('');
    expect(onChar).not.toHaveBeenCalled();
  });
});

describe('widgets', () => {
  it('slider reports values and aria-valuetext', () => {
    const fn = vi.fn();
    const s = slider('Music', 0.5, fn, { format: (v) => `${Math.round(v * 100)}%` });
    expect(s.input.getAttribute('aria-valuetext')).toBe('50%');
    s.input.value = '0.25';
    s.input.dispatchEvent(new Event('input'));
    expect(fn).toHaveBeenCalledWith(0.25);
    expect(s.input.getAttribute('aria-valuetext')).toBe('25%');
  });
});
