// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from './dom';
import { LOADING_CSS } from './loading';
import { createOverlay, type Overlay } from './overlay';

describe('loading screen', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    ov.destroy();
    vi.useRealTimers();
  });

  it('shows progress, rotates tips, marks the root busy and blocks input; done resolves', async () => {
    const l = ov.loading({
      title: 'Loading',
      tip: ['One', 'Two'],
      tipInterval: 1000,
      progress: 0.25,
    });
    expect(document.getElementById('tc-ui-loading')?.textContent).toBe(LOADING_CSS);
    expect(l.element.parentElement?.parentElement).toBe(ov.layers.panels);
    expect(l.element.classList.contains('tc-loading')).toBe(true);
    expect(ov.root.getAttribute('aria-busy')).toBe('true');
    expect(ov.stack.hasModal).toBe(true);
    expect(ov.layers.hud.hasAttribute('inert')).toBe(true);
    const bar = l.element.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuetext')).toBe('25%');
    expect(l.element.querySelector('.tc-ui-bar-value')?.textContent).toBe('25%');
    l.set(0.5, 'Textures');
    expect(l.progress).toBe(0.5);
    expect(bar.getAttribute('aria-valuetext')).toBe('50%');
    expect(l.element.querySelector('.tc-ui-bar-value')?.textContent).toBe('Textures');
    const tip = l.element.querySelector('.tc-loading-tip')!;
    expect(tip.getAttribute('aria-live')).toBe('polite');
    expect(tip.textContent).toBe('One');
    vi.advanceTimersByTime(1000);
    expect(tip.textContent).toBe('Two');
    l.tip('Fixed');
    vi.advanceTimersByTime(2000);
    expect(tip.textContent).toBe('Fixed');

    // Escape does not dismiss it, and keys are swallowed at the capture phase.
    let reached = 0;
    document.body.addEventListener('keydown', () => reached++);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(reached).toBe(0);
    expect(l.visible).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(reached).toBe(1);

    const p = l.done();
    expect(l.done()).toBe(p);
    expect(l.element.hasAttribute('data-done')).toBe(true);
    l.element.dispatchEvent(new Event('transitionend'));
    await p;
    expect(l.visible).toBe(false);
    expect(ov.root.hasAttribute('aria-busy')).toBe(false);
    expect(ov.stack.hasModal).toBe(false);
    expect(l.element.isConnected).toBe(false);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('done falls back to a timer without transitionend, and is immediate under reduced motion', async () => {
    const l = ov.loading();
    const p = l.done();
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    const quick = ov.loading({ reducedMotion: true });
    await quick.done();
    expect(quick.visible).toBe(false);
    expect(ov.root.hasAttribute('aria-busy')).toBe(false);
  });
});
