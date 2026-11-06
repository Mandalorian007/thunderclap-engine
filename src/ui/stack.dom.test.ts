// @vitest-environment happy-dom
/**
 * PanelStack arrow navigation (ws/ergo-2d): ArrowUp/ArrowDown walk the top panel's focusable
 * elements and wrap; ArrowLeft/ArrowRight join in with `arrowNav: 'both'`; `'none'` turns it off;
 * a focused text field, select or slider keeps the arrows it uses itself; only the top panel moves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import { type PanelOptions, PanelStack } from './stack';

let container: HTMLElement;
let stack: PanelStack;

const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};

function buttons(...labels: string[]): HTMLElement[] {
  return labels.map((l) => h('button', { type: 'button' }, l));
}

function push(content: Node, opts: Partial<PanelOptions> = {}) {
  return stack.push({ title: 'Panel', content, ...opts });
}

beforeEach(() => {
  document.body.innerHTML = '';
  container = h('div');
  document.body.append(container);
  stack = new PanelStack(container);
});

afterEach(() => stack.destroy());

describe('PanelStack arrows', () => {
  it('ArrowDown and ArrowUp move focus through the panel, wrapping', () => {
    const [a, b, c] = buttons('A', 'B', 'C');
    push(h('div', null, a, b, c));
    expect(document.activeElement).toBe(a);
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
    key('ArrowDown');
    expect(document.activeElement).toBe(c);
    key('ArrowDown');
    expect(document.activeElement).toBe(a);
    key('ArrowUp');
    expect(document.activeElement).toBe(c);
  });

  it('by default the horizontal arrows do nothing; arrowNav both uses them; none uses no arrow', () => {
    const [a, b] = buttons('A', 'B');
    push(h('div', null, a, b));
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(a);
    stack.clear();

    const [c, d] = buttons('C', 'D');
    push(h('div', null, c, d), { arrowNav: 'both' });
    key('ArrowRight');
    expect(document.activeElement).toBe(d);
    key('ArrowLeft');
    expect(document.activeElement).toBe(c);
    stack.clear();

    const [e, f] = buttons('E', 'F');
    push(h('div', null, e, f), { arrowNav: 'none' });
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(e);
  });

  it('a modal panel with focus on itself starts from the first (down) or last (up) element', () => {
    const [a, b] = buttons('A', 'B');
    const panel = push(h('div', null, a, b));
    panel.element.focus();
    key('ArrowUp');
    expect(document.activeElement).toBe(b);
    panel.element.focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(a);
  });

  it('leaves the arrows a focused control uses itself: text caret, select, slider, textarea', () => {
    const text = h('input', { type: 'text' });
    const select = h('select', null, h('option', null, 'one'), h('option', null, 'two'));
    const range = h('input', { type: 'range', min: '0', max: '10' });
    const area = h('textarea');
    const [btn] = buttons('OK');
    push(h('div', null, text, select, range, area, btn), { arrowNav: 'both' });
    expect(document.activeElement).toBe(text);
    // A text field keeps left/right only: up/down still walk.
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(text);
    key('ArrowDown');
    expect(document.activeElement).toBe(select);
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(select);
    range.focus();
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(range);
    area.focus();
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(area);
    btn.focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(text);
  });

  it('a role=slider element keeps both axes under arrowNav both', () => {
    const slider = h('div', { role: 'slider', tabindex: '0' });
    const [btn] = buttons('OK');
    push(h('div', null, slider, btn), { arrowNav: 'both' });
    slider.focus();
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(slider);
  });

  it('only the top panel moves; a non-modal panel moves only while focus is inside it', () => {
    const [a, b] = buttons('A', 'B');
    push(h('div', null, a, b));
    const [c, d] = buttons('C', 'D');
    const top = push(h('div', null, c, d), { modal: false });
    expect(document.activeElement).toBe(c);
    key('ArrowDown');
    expect(document.activeElement).toBe(d);
    // Focus outside a non-modal top panel: the arrow is the page's (and the game's).
    a.focus();
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(a);
    top.close();
    a.focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(b);
  });

  it('modified arrows and arrows on an empty panel pass through', () => {
    const [a, b] = buttons('A', 'B');
    push(h('div', null, a, b));
    expect(key('ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(a);
    stack.clear();
    push(h('p', null, 'nothing to focus'));
    expect(key('ArrowDown').defaultPrevented).toBe(false);
  });
});
