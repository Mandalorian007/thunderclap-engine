// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from './dom';
import { menuNav } from './menu-nav';
import { NOTIFY_CSS } from './notify';
import { createOverlay, type Overlay } from './overlay';

describe('notifications', () => {
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

  it('stacks cards in a polite live region on the toasts layer, with actions and timeouts', () => {
    let acted = 0;
    const n = ov.notify({
      title: 'Saved',
      body: 'Slot 3',
      icon: '✓',
      tone: 'success',
      actions: [{ label: 'Undo', onClick: () => acted++ }],
      timeout: 1000,
    });
    const stack = ov.notifications.element;
    expect(stack.parentElement).toBe(ov.layers.toasts);
    expect(stack.getAttribute('role')).toBe('status');
    expect(stack.getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('tc-ui-notify')?.textContent).toBe(NOTIFY_CSS);
    expect(n.element.dataset.tone).toBe('success');
    expect(n.element.querySelector('.tc-notification-title')?.textContent).toBe('Saved');
    expect(n.element.querySelector('.tc-notification-body')?.textContent).toBe('Slot 3');
    expect(ov.notifications.count).toBe(1);

    // Hover pauses the timeout; leaving re-arms it.
    vi.advanceTimersByTime(900);
    n.element.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(5000);
    expect(n.open).toBe(true);
    n.element.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(999);
    expect(n.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(n.open).toBe(false);
    expect(n.element.isConnected).toBe(false);
    expect(ov.notifications.count).toBe(0);

    const m = ov.notify({
      title: 'Quest',
      actions: [{ label: 'Go', onClick: () => acted++ }],
      timeout: 0,
    });
    vi.advanceTimersByTime(60000);
    expect(m.open).toBe(true); // sticky
    m.element.querySelector<HTMLButtonElement>('.tc-notification-action')!.click();
    expect(acted).toBe(1);
    expect(m.open).toBe(false); // an action dismisses unless `keep`

    const newest = ov.notify({ title: 'B', timeout: 0 });
    ov.notify({ title: 'C', timeout: 0 });
    expect(stack.firstElementChild?.textContent).toContain('C'); // newest on top
    newest.element.querySelector<HTMLButtonElement>('.tc-notification-close')!.click();
    expect(newest.open).toBe(false);
    ov.notifications.dismissAll();
    expect(ov.notifications.count).toBe(0);
    expect(stack.childElementCount).toBe(0);
  });

  it('is pad-navigable through menuNav and Escape dismisses the focused card', () => {
    let fired = 0;
    const n = ov.notify({
      title: 'Invite',
      actions: [
        { label: 'Accept', onClick: () => fired++ },
        { label: 'Later', onClick: () => {}, keep: true },
      ],
      timeout: 0,
    });
    const pressed = new Set<string>();
    const input = { pressed: (a: string) => pressed.has(a), lastDevice: 'gamepad' as const };
    expect(ov.notifications.focus()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Accept');
    pressed.add('down');
    menuNav(input, ov.notifications.element);
    expect(document.activeElement?.textContent).toBe('Later');
    pressed.clear();
    pressed.add('confirm');
    menuNav(input, ov.notifications.element);
    expect(n.open).toBe(true); // `keep`
    pressed.clear();
    pressed.add('up');
    menuNav(input, ov.notifications.element);
    pressed.clear();
    pressed.add('confirm');
    menuNav(input, ov.notifications.element);
    expect(fired).toBe(1);
    expect(n.open).toBe(false);

    const m = ov.notify({ title: 'Again', timeout: 0 });
    ov.notifications.focus();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(m.open).toBe(false);
    expect(ov.notifications.focus()).toBe(false);
  });
});
