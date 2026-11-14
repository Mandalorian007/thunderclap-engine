// @vitest-environment happy-dom
// The DOM presenter (ws/ui-spec; the generic half of Forge Wilds' ui-dom tests): an idle frame
// writes nothing, a changed key writes only the words that bind it, list rows are pooled by key,
// a scroll lays out nothing, a field follows and submits, a held button lets go on keyup and on
// blur, and a press says tap (shift: one).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpecPanel } from './panel';
import { panel } from './panel';
import { type DomPresenter, presentDom } from './present-dom';
import { b, type PanelEvent, type PanelSpec } from './words';

const SPEC: PanelSpec = {
  id: 'bag',
  body: {
    k: 'col',
    gap: 6,
    pad: 8,
    children: [
      { k: 'text', text: b('title'), style: 'head' },
      { k: 'meter', id: 'hp', value: b('hp'), w: 200, h: 12 },
      { k: 'button', id: 'use', text: 'Use', w: 100, h: 40 },
      { k: 'button', id: 'go', text: 'Go', press: 'held', w: 100, h: 40 },
      { k: 'field', id: 'say', kind: 'chat', value: b('say'), h: 36 },
      { k: 'button', id: 'send', text: 'Send', submits: 'say', w: 100, h: 40 },
      {
        k: 'list',
        id: 'things',
        rowH: 30,
        gap: 2,
        h: 90,
        row: { k: 'text', text: b('row.name'), style: 'body' },
      },
    ],
  },
};

let host: HTMLElement;
let p: SpecPanel;
let d: DomPresenter;
let events: PanelEvent[];

function keys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `t${i}`);
}

function fill(n: number): void {
  p.model.setList('things', keys(n));
  for (let i = 0; i < n; i++) p.model.row('things', `t${i}`).set('name', `thing ${i}`);
}

function el(id: string): HTMLElement {
  return host.querySelector(`[data-tc-id="bag/${id}"]`) as HTMLElement;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  p = panel(SPEC, { schedule: null });
  events = [];
  p.onEvent = (e) => events.push(e);
  d = presentDom(p, host);
  p.model.set('title', 'Bag');
  p.model.set('hp', 0.5);
  fill(6);
  p.frame(320, 0);
  p.apply();
});

afterEach(() => {
  p.dispose();
  host.remove();
});

describe('presentDom', () => {
  it('draws every word at its box, the host at the panel', () => {
    expect(host.textContent).toContain('Bag');
    expect(host.style.width).toBe('320px');
    expect(host.querySelectorAll('[role=listitem]').length).toBe(6);
    expect(host.querySelector('[role=meter]')!.getAttribute('aria-valuenow')).toBe('0.5');
    expect(host.getAttribute('data-tc-page')).toBe('bag');
  });

  it('an idle frame writes nothing', () => {
    const w = d.writes;
    const a = p.applies;
    for (let i = 0; i < 10; i++) p.apply();
    p.model.set('title', 'Bag');
    p.apply();
    expect(d.writes).toBe(w);
    expect(p.applies).toBe(a);
  });

  it('a changed key writes only the words that bind it', () => {
    const w = d.writes;
    p.model.set('title', 'Pack');
    p.apply();
    expect(d.writes - w).toBe(1);
    expect(host.textContent).toContain('Pack');
    const w2 = d.writes;
    p.model.row('things', 't3').set('name', 'renamed');
    p.apply();
    expect(d.writes - w2).toBe(1);
    expect(host.textContent).toContain('renamed');
  });

  it('pools list rows by key', () => {
    expect(d.rowsBuilt).toBe(6);
    fill(2);
    p.apply();
    expect(host.querySelectorAll('[role=listitem]:not([data-off])').length).toBe(2);
    fill(6);
    p.apply();
    expect(d.rowsBuilt).toBe(6);
    // A resort moves rows, builds none.
    p.model.setList('things', keys(6).reverse());
    p.apply();
    expect(d.rowsBuilt).toBe(6);
    const first = host.querySelector('[role=listitem]')!;
    expect(first.textContent).toBe('thing 5');
    // A resort and a changed field in the same frame: both drawn.
    p.model.row('things', 't0').set('name', 'moved');
    p.model.setList('things', keys(6));
    p.apply();
    expect(host.querySelector('[role=listitem]')!.textContent).toBe('moved');
  });

  it('a scroll lays out nothing', () => {
    const a = p.applies;
    const w = d.writes;
    const list = host.querySelector('[role=list]') as HTMLElement;
    list.scrollTop = 40;
    list.dispatchEvent(new Event('scroll'));
    p.apply();
    expect(p.applies).toBe(a);
    expect(d.writes).toBe(w);
    expect(p.boxes.scroll[Number(list.getAttribute('data-tcs'))]).toBe(40);
  });

  it('a field follows what is typed, says enter and presses what it submits', () => {
    const f = el('say') as HTMLInputElement;
    f.value = 'hello';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    expect(p.model.get('say')).toBe('hello');
    expect(events.at(-1)).toMatchObject({ id: 'say', type: 'input', value: 'hello' });
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(events.map((e) => `${e.id}:${e.type}`).slice(-2)).toEqual(['say:enter', 'send:tap']);
    // The game clears it: written, though the model already followed.
    p.model.set('say', '');
    p.apply();
    expect(f.value).toBe('');
  });

  it('a held button lets go on keyup and on blur', () => {
    const go = el('go');
    go.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    go.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
    go.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(events.map((e) => e.type)).toEqual(['down', 'up']);
    go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    go.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(events.map((e) => e.type)).toEqual(['down', 'up', 'down', 'up']);
  });

  it('a press says tap, a shift press one', () => {
    const use = el('use');
    use.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    use.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(events).toEqual([
      { panel: 'bag', id: 'use', row: null, type: 'tap', value: null },
      { panel: 'bag', id: 'use', row: null, type: 'tap', value: null, one: true },
    ]);
  });

  it('dispose takes it down', () => {
    p.dispose();
    expect(host.childElementCount).toBe(0);
    expect(p.presenters.length).toBe(0);
  });

  it("today's ui widgets as specs: button, toggle, slider, field, meter, slots, tabs", () => {
    const WIDGETS: PanelSpec = {
      id: 'w',
      body: {
        k: 'col',
        gap: 4,
        children: [
          { k: 'button', id: 'ok', text: 'OK', w: 80, h: 40 },
          { k: 'button', id: 'mute', text: 'Mute', press: 'toggle', on: b('mute'), w: 80, h: 40 },
          { k: 'range', id: 'vol', min: 0, max: 10, step: 1, value: b('vol'), w: 160, h: 24 },
          { k: 'field', id: 'name', kind: 'name', value: b('name'), w: 160, h: 32 },
          { k: 'meter', id: 'bar', value: b('bar'), label: 'Bar', w: 160, h: 10 },
          {
            k: 'row',
            role: 'listbox',
            gap: 2,
            children: [0, 1, 2].map((i) => ({
              k: 'slot' as const,
              id: `s${i}`,
              item: b(`s${i}`),
              keyLabel: `${i + 1}`,
              size: 40,
            })),
          },
          { k: 'tabs', id: 'tab', selected: b('tab'), optionW: 60, h: 32 },
        ],
      },
    };
    const h2 = document.createElement('div');
    document.body.appendChild(h2);
    const q = panel(WIDGETS, { schedule: null });
    const got: PanelEvent[] = [];
    q.onEvent = (e) => got.push(e);
    presentDom(q, h2);
    q.model.setAll({
      mute: true,
      vol: 3,
      name: 'Ada',
      bar: 0.25,
      s0: 'a',
      s1: '',
      s2: 'c',
      tab: 'two',
    });
    q.model.setList('tab', ['one', 'two']);
    q.model.row('tab', 'one').set('label', 'One');
    q.model.row('tab', 'two').set('label', 'Two');
    q.frame(0, 0);
    q.apply();
    const at = (id: string) => h2.querySelector(`[data-tc-id="w/${id}"]`) as HTMLElement;
    expect(at('ok').tagName).toBe('BUTTON');
    expect(at('mute').getAttribute('aria-pressed')).toBe('true');
    expect((at('vol') as HTMLInputElement).value).toBe('3');
    expect((at('name') as HTMLInputElement).value).toBe('Ada');
    expect(h2.querySelector('[role=meter]')!.getAttribute('aria-valuenow')).toBe('0.25');
    expect(h2.querySelectorAll('[role=listbox] button').length).toBe(3);
    const tabs = h2.querySelectorAll('[role=tab]');
    expect([...tabs].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    at('mute').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (tabs[0] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(got.map((e) => `${e.id}:${e.type}:${e.value}`)).toEqual([
      'mute:toggle:false',
      'tab:pick:one',
    ]);
    q.dispose();
    h2.remove();
  });
});
