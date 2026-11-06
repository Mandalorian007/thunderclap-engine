// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { append, consumesArrows, focusableWithin, h } from './dom';

describe('h', () => {
  it('takes a cssText string for style and keeps the object form', () => {
    const a = h('div', { style: 'color: red; --tc-x: 3' });
    expect(a.style.color).toBe('red');
    expect(a.style.getPropertyValue('--tc-x').trim()).toBe('3');
    const b = h('div', { style: { color: 'blue', '--tc-y': '4' } });
    expect(b.style.color).toBe('blue');
    expect(b.style.getPropertyValue('--tc-y').trim()).toBe('4');
  });

  it('sets class, dataset, listeners and attributes; omits false and null', () => {
    let clicks = 0;
    const el = h(
      'button',
      {
        class: 'x',
        dataset: { k: 'v' },
        'aria-label': 'y',
        disabled: true,
        hidden: false,
        title: null,
        on: { click: () => clicks++ },
      },
      'text',
      3,
      null,
    );
    expect(el.className).toBe('x');
    expect(el.dataset.k).toBe('v');
    expect(el.getAttribute('aria-label')).toBe('y');
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.textContent).toBe('text3');
    el.disabled = false;
    el.click();
    expect(clicks).toBe(1);
    append(el, 'more');
    expect(el.textContent).toBe('text3more');
  });

  it('focusableWithin skips hidden and inert subtrees; consumesArrows per control', () => {
    const root = h(
      'div',
      null,
      h('button', null, 'a'),
      h('div', { hidden: true }, h('button', null, 'b')),
      h('div', { inert: true }, h('button', null, 'c')),
    );
    expect(focusableWithin(root).map((e) => e.textContent)).toEqual(['a']);
    expect(consumesArrows(h('input', { type: 'text' }), true)).toBe(true);
    expect(consumesArrows(h('input', { type: 'text' }), false)).toBe(false);
    expect(consumesArrows(h('select'), false)).toBe(true);
    expect(consumesArrows(h('button'), true)).toBe(false);
  });
});
