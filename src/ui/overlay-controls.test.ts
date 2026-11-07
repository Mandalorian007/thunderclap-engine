// @vitest-environment happy-dom
/**
 * ws/input-12: every overlay button has a stable id (a game-supplied `id`, else page/key with a
 * `#n` for duplicates); `onControl` names each click by it and `activate(id)` clicks the button
 * that id names, found again by id rather than by DOM node.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import {
  CONTROL_ID_ATTR,
  CONTROL_PAGE_ATTR,
  controlId,
  createOverlay,
  type Overlay,
} from './overlay';
import { button } from './widgets';

describe('overlay control ids (ws/input-12)', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ov.destroy());

  it('derives page/key from the panel title, suffixes duplicates, and a game id wins', () => {
    const start = button('Start', () => {});
    const a = button('Back', () => {});
    const b = button('Back', () => {});
    const own = button('Quit', () => {}, { id: 'quit-game' });
    ov.stack.push({ title: 'Main menu', content: h('div', {}, start, a, b, own) });
    expect(own.getAttribute(CONTROL_ID_ATTR)).toBe('quit-game');
    expect(controlId(start, ov.root)).toBe('Main menu/Start');
    expect(controlId(a, ov.root)).toBe('Main menu/Back');
    expect(controlId(b, ov.root)).toBe('Main menu/Back#2');
    expect(controlId(own, ov.root)).toBe('quit-game');
    // A marked page wins over the panel name; a bare button off any page is its key.
    const marked = h(
      'div',
      { [CONTROL_PAGE_ATTR]: 'pause' },
      button('Resume', () => {}),
    );
    ov.layers.hud.append(marked);
    expect(controlId(marked.firstElementChild!, ov.root)).toBe('pause/Resume');
    const loose = button('Go', () => {});
    ov.layers.hud.append(loose);
    expect(controlId(loose, ov.root)).toBe('Go');
    expect(controlId(h('button'), ov.root)).toBeNull();
    // Without an explicit id the button renders exactly as before.
    expect(start.hasAttribute(CONTROL_ID_ATTR)).toBe(false);
  });

  it('onControl hears every click by id; activate clicks a rebuilt button by the same id', () => {
    const heard: string[] = [];
    const off = ov.onControl((id) => heard.push(id));
    let clicks = 0;
    const page = () => {
      const p = ov.stack.push({
        title: 'Settings',
        content: h(
          'div',
          {},
          button('Back', () => {}),
          button('Back', () => clicks++),
        ),
      });
      return p;
    };
    const first = page();
    (ov.root.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(heard).toEqual(['Settings/Back#2']);
    expect(clicks).toBe(1);
    first.close();
    // A new page with new nodes: the id still finds the second Back.
    page();
    expect(ov.activate('Settings/Back#2')).toBe(true);
    expect(clicks).toBe(2);
    expect(heard).toEqual(['Settings/Back#2', 'Settings/Back#2']);
    expect(ov.activate('Settings/Nope')).toBe(false);
    off();
    ov.activate('Settings/Back#2');
    expect(heard).toHaveLength(2);
  });

  it('activate skips a disabled button', () => {
    const btn = button('Save', () => {}, { id: 'save' });
    btn.disabled = true;
    ov.layers.hud.append(btn);
    expect(ov.activate('save')).toBe(false);
  });
});
