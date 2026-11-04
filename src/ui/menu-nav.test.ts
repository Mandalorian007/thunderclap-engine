// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { InputDevice } from '../input/types';
import { h } from './dom';
import { type MenuNavInput, menuNav } from './menu-nav';

type A = 'up' | 'down' | 'confirm' | 'north' | 'south' | 'ok';

/** One tick of input: the actions pressed this tick and the last device. */
function tick(pressed: A[], lastDevice: InputDevice = 'keyboard'): MenuNavInput<A> {
  return { pressed: (a) => pressed.includes(a), lastDevice };
}

function menu() {
  const clicks: string[] = [];
  const b = (name: string) => {
    const el = h('button', { type: 'button' }, name);
    el.addEventListener('click', () => clicks.push(name));
    return el;
  };
  const root = h('div', null, b('Play'), b('Settings'), b('Quit'));
  document.body.append(root);
  return { root, clicks, label: () => document.activeElement?.textContent ?? null };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('menuNav', () => {
  it('down from outside focuses the first control, up the last, and both wrap', () => {
    const m = menu();
    expect(menuNav(tick(['down']), m.root)).toBe('moved');
    expect(m.label()).toBe('Play');
    expect(menuNav(tick(['down']), m.root)).toBe('moved');
    expect(m.label()).toBe('Settings');
    menuNav(tick(['down']), m.root);
    menuNav(tick(['down']), m.root);
    expect(m.label()).toBe('Play');
    menuNav(tick(['up']), m.root);
    expect(m.label()).toBe('Quit');

    (document.activeElement as HTMLElement).blur();
    menuNav(tick(['up']), m.root);
    expect(m.label()).toBe('Quit');
  });

  it('confirm clicks the focused control only when it came from a gamepad', () => {
    const m = menu();
    menuNav(tick(['down']), m.root);
    // Enter and Space reach the focused button natively; menuNav leaves them alone.
    expect(menuNav(tick(['confirm'], 'keyboard'), m.root)).toBeNull();
    expect(m.clicks).toEqual([]);
    expect(menuNav(tick(['confirm'], 'gamepad'), m.root)).toBe('clicked');
    expect(m.clicks).toEqual(['Play']);
  });

  it('does nothing with no input, an empty menu, or confirm with nothing focused', () => {
    const m = menu();
    expect(menuNav(tick([]), m.root)).toBeNull();
    expect(menuNav(tick(['confirm'], 'gamepad'), m.root)).toBeNull();
    expect(m.clicks).toEqual([]);
    const empty = h('div');
    document.body.append(empty);
    expect(menuNav(tick(['down']), empty)).toBeNull();
  });

  it('takes the game’s own action names', () => {
    const m = menu();
    const actions = { up: 'north', down: 'south', confirm: 'ok' } as const;
    expect(menuNav(tick(['south']), m.root, actions)).toBe('moved');
    expect(m.label()).toBe('Play');
    expect(menuNav(tick(['down']), m.root, actions)).toBeNull();
    menuNav(tick(['ok'], 'gamepad'), m.root, actions);
    expect(m.clicks).toEqual(['Play']);
  });
});
