// @vitest-environment happy-dom
// The DOM presenter's game fit, round two (ws/ui-input-fit, Forge's D4b asks): only the boxes
// that changed are written, a window rebinds with slack, a list's new count lays out, a tail goes
// to its end once placed (and back after WebKit's reset), no forced layout for flash, ring and
// again, type-ahead held back and stopped, a range's input and change, a submit's text, the
// game's reduced motion, mapped classes, `--fill`, and `held` dropped on blur and touchcancel.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSpecStill, specEaseIn, specEaseOut, specStill } from './motion';
import { panel, type SpecPanel } from './panel';
import { type DomOptions, type DomPresenter, presentDom } from './present-dom';
import { b, type PanelEvent, type PanelSpec } from './words';

const LIST: PanelSpec = {
  id: 'cat',
  body: {
    k: 'col',
    children: [
      {
        k: 'list',
        id: 'things',
        rowH: 24,
        gap: 2,
        h: 300,
        window: 120,
        row: {
          k: 'row',
          gap: 4,
          children: [
            { k: 'text', id: 'name', text: b('row.name'), style: 'body', grow: 1 },
            { k: 'text', id: 'n', text: b('row.n'), style: 'body', w: 40 },
          ],
        },
      },
    ],
  },
};

const CHAT: PanelSpec = {
  id: 'chat',
  body: {
    k: 'col',
    children: [
      {
        k: 'list',
        id: 'log',
        rowH: 20,
        h: 200,
        tail: true,
        row: {
          k: 'row',
          gap: 4,
          children: [
            { k: 'text', id: 'who', text: b('row.who'), style: 'body', w: 60 },
            { k: 'text', id: 'say', text: b('row.say'), style: 'body', grow: 1 },
          ],
        },
      },
    ],
  },
};

let p: SpecPanel | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  p?.dispose();
  host?.remove();
  p = host = null;
});

const WIDGETS: PanelSpec = {
  id: 'kit',
  held: true,
  body: {
    k: 'col',
    gap: 6,
    pad: 8,
    children: [
      { k: 'text', id: 'news', text: b('news'), style: 'body', flash: true, w: 200 },
      { k: 'button', id: 'use', text: 'Use', again: b('bump'), ring: b('cool'), w: 100, h: 40 },
      { k: 'button', id: 'go', text: 'Go', press: 'held', w: 100, h: 40 },
      { k: 'range', id: 'vol', min: 0, max: 8, step: 1, value: b('vol'), w: 160, h: 24 },
      {
        k: 'field',
        id: 'say',
        kind: 'chat',
        value: b('say'),
        typeAhead: true,
        closeKey: 'KeyT',
        w: 200,
        h: 36,
      },
      { k: 'button', id: 'send', text: 'Send', submits: 'say', w: 100, h: 40 },
      { k: 'tabs', id: 'tab', selected: b('tab'), optionW: 60, h: 32 },
      {
        k: 'list',
        id: 'things',
        rowH: 20,
        h: 60,
        row: { k: 'text', text: b('row.name'), style: 'body' },
      },
    ],
  },
};

function make(spec: PanelSpec, opts: DomOptions = {}): DomPresenter {
  host = document.createElement('div');
  document.body.appendChild(host);
  p = panel(spec, { schedule: null });
  const d = presentDom(p, host, opts);
  p.frame(400, 0);
  return d;
}

function widgets(opts: DomOptions = {}): { d: DomPresenter; events: PanelEvent[] } {
  const d = make(WIDGETS, opts);
  const events: PanelEvent[] = [];
  p!.onEvent = (e) => events.push(e);
  p!.model.setAll({ news: '', bump: 0, cool: 0, vol: 2, say: '', tab: 'one' });
  p!.model.setList('tab', ['one', 'two']);
  p!.model.row('tab', 'one').set('label', 'One');
  p!.model.row('tab', 'two').set('label', 'Two');
  p!.apply();
  return { d, events };
}

const say = (e: PanelEvent) => `${e.id}:${e.type}:${String(e.value)}`;

describe('DOM writes', () => {
  it('a 60 px scroll of a window list', () => {
    const d = make(LIST);
    const n = 500;
    p!.model.setList(
      'things',
      Array.from({ length: n }, (_, i) => `t${i}`),
    );
    for (let i = 0; i < n; i++) {
      const r = p!.model.row('things', `t${i}`);
      r.set('name', `thing ${i}`);
      r.set('n', i);
    }
    p!.apply();
    const list = host!.querySelector('[role=list]') as HTMLElement;
    let total = 0;
    for (let s = 1; s <= 20; s++) {
      const w = d.writes;
      list.scrollTop = s * 60;
      list.dispatchEvent(new Event('scroll'));
      p!.apply();
      total += d.writes - w;
    }
    // Before ws/ui-input-fit: 425 (every bound row's every box, every pixel).
    console.log(`window scroll: ${total / 20} writes per 60 px`);
    expect(total / 20).toBeLessThan(43);
    // Every row near the view is bound; the far ones are not.
    const bound = host!.querySelectorAll('[role=listitem]:not([data-off])').length;
    expect(bound).toBeGreaterThan(300 / 26);
    expect(bound).toBeLessThan(40);
  });

  it('a chat line', () => {
    const d = make(CHAT);
    const keys: string[] = [];
    let total = 0;
    for (let i = 0; i < 60; i++) {
      keys.push(`m${i}`);
      const w = d.writes;
      p!.model.setList('log', keys.slice(-40));
      const r = p!.model.row('log', `m${i}`);
      r.set('who', 'ann');
      r.set('say', `line ${i}`);
      p!.apply();
      if (i >= 40) total += d.writes - w;
    }
    // Before ws/ui-input-fit: 767 (every row's every box, and a move for every row).
    console.log(`chat line: ${total / 20} writes per line`);
    expect(total / 20).toBeLessThan(77);
    // Still in order.
    const rows = [...host!.querySelectorAll('[role=listitem]:not([data-off])')];
    expect(rows.map((r) => r.getAttribute('data-tcs-row'))).toEqual(keys.slice(-40));
  });

  it('a layout that moved nothing writes nothing; one that moved a box writes it', () => {
    const d = make(LIST);
    p!.model.setList('things', ['a', 'b']);
    p!.apply();
    const w = d.writes;
    p!.model.relayout = true;
    p!.model.changed();
    p!.apply();
    expect(d.writes).toBe(w);
    p!.frame(300, 0);
    p!.apply();
    expect(d.writes - w).toBeGreaterThan(0);
    expect(host!.style.width).toBe('300px');
  });

  it('a list of fixed height lays out again when its count changes (its content follows)', () => {
    make(LIST);
    p!.model.setList('things', ['a', 'b']);
    p!.apply();
    const inner = host!.querySelector('[role=list] > div') as HTMLElement;
    expect(inner.style.height).toBe(`${2 * 24 + 2}px`);
    p!.model.setList('things', ['a', 'b', 'c']);
    expect(p!.model.relayout).toBe(true);
    p!.apply();
    expect(inner.style.height).toBe(`${3 * 24 + 2 * 2}px`);
  });
});

/** A scroller whose heights are its content's (happy-dom lays out nothing), clamped like a page's. */
function scrolling(el: HTMLElement, inner: HTMLElement, view: () => number): void {
  let top = 0;
  const content = () => Number.parseFloat(inner.style.height || '0');
  Object.defineProperty(el, 'clientHeight', { get: view, configurable: true });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => Math.max(content(), view()),
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, Math.max(content(), view()) - view()));
    },
    configurable: true,
  });
}

describe('a tail list', () => {
  const TAIL: PanelSpec = { ...CHAT, body: { ...CHAT.body, show: b('open') } as PanelSpec['body'] };

  it('goes to its new end once its rows are placed, and back after a hidden log’s reset', () => {
    make(TAIL);
    p!.model.set('open', true);
    const list = host!.querySelector('[role=list]') as HTMLElement;
    const inner = list.firstElementChild as HTMLElement;
    let shown = true;
    scrolling(list, inner, () => (shown ? 200 : 0));
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      keys.push(`m${i}`);
      p!.model.setList('log', keys.slice());
      p!.apply();
      // At its end after every line: the end the new content made (before, the old end).
      expect(list.scrollTop).toBe(list.scrollHeight - 200);
    }
    expect(list.scrollTop).toBe(30 * 20 - 200);
    // Hidden, a line comes, and the page resets its scroll (WebKit's 0); shown again: at its end.
    p!.model.set('open', false);
    p!.apply();
    shown = false;
    keys.push('m30');
    p!.model.setList('log', keys.slice());
    p!.apply();
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
    shown = true;
    p!.model.set('open', true);
    p!.apply();
    expect(list.scrollTop).toBe(31 * 20 - 200);
  });

  it('a player who scrolled up stays there as lines come', () => {
    make(TAIL);
    p!.model.set('open', true);
    const list = host!.querySelector('[role=list]') as HTMLElement;
    scrolling(list, list.firstElementChild as HTMLElement, () => 200);
    const keys = Array.from({ length: 30 }, (_, i) => `m${i}`);
    p!.model.setList('log', keys.slice());
    p!.apply();
    list.scrollTop = 100;
    list.dispatchEvent(new Event('scroll'));
    keys.push('m30');
    p!.model.setList('log', keys.slice());
    p!.apply();
    expect(list.scrollTop).toBe(100);
    // Back at its end: it follows again.
    list.scrollTop = 10_000;
    list.dispatchEvent(new Event('scroll'));
    keys.push('m31');
    p!.model.setList('log', keys.slice());
    p!.apply();
    expect(list.scrollTop).toBe(32 * 20 - 200);
  });
});

describe('the game fit', () => {
  it('flash, ring and again force no layout, and play again from their start', () => {
    const { d } = widgets();
    const reads = vi.fn();
    const proto = HTMLElement.prototype;
    const was = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
    Object.defineProperty(proto, 'offsetWidth', {
      get() {
        reads();
        return 0;
      },
      configurable: true,
    });
    try {
      const use = d.el('use')!;
      const ring = use.querySelector('.tcs-ring')!;
      const news = d.el('news') ?? (host!.querySelector('[data-id=news]') as HTMLElement);
      // Played once: the class goes on.
      p!.model.setAll({ bump: 1, cool: 500, news: 'hi' });
      p!.apply();
      expect(use.classList.contains('tcs-again')).toBe(true);
      expect(ring.getAttribute('data-ring')).toBe('run');
      expect(news.classList.contains('tcs-flash')).toBe(true);
      // Again: their animations (one ran out, so the page no longer lists it) start over.
      const anim = () => {
        const a = { playState: 'running', currentTime: 120 as number | null, play: vi.fn() };
        return a as unknown as Animation & { play: ReturnType<typeof vi.fn> };
      };
      const a1 = anim();
      const a2 = anim();
      const a3 = anim();
      let list1: Animation[] = [a1];
      use.getAnimations = () => list1;
      ring.getAnimations = () => [a2];
      news.getAnimations = () => [a3];
      p!.model.setAll({ bump: 2, cool: 400, news: 'ho' });
      p!.apply();
      for (const a of [a1, a2, a3]) {
        expect(a.currentTime).toBe(0);
        expect(a.play).toHaveBeenCalledTimes(1);
      }
      a1.currentTime = 300;
      list1 = [];
      p!.model.set('bump', 3);
      p!.apply();
      expect(a1.currentTime).toBe(0);
      expect(a1.play).toHaveBeenCalledTimes(2);
      expect((ring as HTMLElement).style.getPropertyValue('--tcs-ring-ms')).toBe('400ms');
      p!.model.set('news', '');
      p!.apply();
      expect(news.classList.contains('tcs-flash')).toBe(false);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      if (was) Object.defineProperty(proto, 'offsetWidth', was);
      else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    }
  });

  it('type-ahead stops the keys it takes, and the game can hold it back', () => {
    let hold = false;
    const { d } = widgets({ holdTypeAhead: () => hold });
    const game = vi.fn();
    document.addEventListener('keydown', game);
    try {
      const field = d.el('say') as HTMLInputElement;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
      expect(field.value).toBe('p');
      expect(game).not.toHaveBeenCalled();
      field.blur();
      hold = true;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
      expect(field.value).toBe('p');
      expect(game).toHaveBeenCalledTimes(1);
      // A key already taken (default prevented) is not typed either.
      hold = false;
      const e = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
      e.preventDefault();
      document.body.dispatchEvent(e);
      expect(field.value).toBe('p');
    } finally {
      document.removeEventListener('keydown', game);
    }
  });

  it('a close key in the empty field stops there: the game’s key that opens the panel never hears it', () => {
    const { d, events } = widgets();
    const game = vi.fn();
    document.addEventListener('keydown', game);
    try {
      const field = d.el('say') as HTMLInputElement;
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }));
      expect(events.map(say)).toContain('say:close:null');
      expect(game).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', game);
    }
  });

  it('a range says input while dragged and change on let-go, its track filled (`--fill`)', () => {
    const { d, events } = widgets();
    const vol = d.el('vol') as HTMLInputElement;
    expect(vol.style.getPropertyValue('--fill')).toBe('25%');
    vol.value = '3';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    vol.value = '5';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    expect(vol.style.getPropertyValue('--fill')).toBe('62.5%');
    vol.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events.filter((e) => e.id === 'vol').map(say)).toEqual([
      'vol:input:3',
      'vol:input:5',
      'vol:change:5',
    ]);
    // Set by the game: filled, once.
    const w = d.writes;
    p!.model.set('vol', 8);
    p!.apply();
    expect(vol.style.getPropertyValue('--fill')).toBe('100%');
    expect(d.writes - w).toBe(2);
  });

  it('a submit’s tap carries its field’s text (a click and the field’s Enter alike)', () => {
    const { d, events } = widgets();
    const field = d.el('say') as HTMLInputElement;
    field.value = 'hello';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    d.el('send')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(events.filter((e) => e.id === 'send').map(say)).toEqual([
      'send:tap:hello',
      'send:tap:hello',
    ]);
    d.el('use')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events.at(-1)!.value).toBe(null);
  });

  it('the game’s reduced motion stills every panel; ease-in is public', () => {
    widgets();
    try {
      setSpecStill(true);
      expect(specStill()).toBe(true);
      p!.model.set('vol', 4);
      p!.apply();
      expect(host!.hasAttribute('data-still')).toBe(true);
      setSpecStill(false);
      expect(specStill()).toBe(false);
      p!.model.set('vol', 5);
      p!.apply();
      expect(host!.hasAttribute('data-still')).toBe(false);
    } finally {
      setSpecStill(null);
    }
    expect(specEaseIn(0)).toBe(0);
    expect(specEaseIn(1)).toBe(1);
    expect(specEaseIn(0.5)).toBeLessThan(0.5);
    expect(specEaseIn(0.5)).toBeCloseTo(1 - specEaseOut(0.5), 2);
  });

  it('maps a tab’s, a list’s content’s classes; a button’s label is its own class', () => {
    const { d } = widgets({
      classes: { 'tcs-tab': 'g-tab', 'tcs-inner': 'g-rows', 'tcs-label': 'g-label' },
    });
    const tab = d.el('tab', 'one')!;
    expect(tab.classList.contains('g-tab')).toBe(true);
    expect(host!.querySelector('[role=list] > .tcs-inner')!.classList.contains('g-rows')).toBe(
      true,
    );
    const label = d.el('use')!.querySelector('.tcs-label')!;
    expect(label.classList.contains('tcs-t-label')).toBe(false);
    expect(label.classList.contains('g-label')).toBe(true);
    expect(tab.querySelector('.tcs-label')!.classList.contains('tcs-t-label')).toBe(false);
    // Its look is the label type's still.
    expect(document.getElementById('tc-spec-style')!.textContent).toContain(
      '.tcs-t-label,.tcs-label{',
    );
  });

  it('`held` and a held button let go when the window loses focus or the fingers are taken', () => {
    const { d, events } = widgets();
    const go = d.el('go')!;
    go.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(events.map(say)).toEqual([':held:true', 'go:down:null']);
    window.dispatchEvent(new Event('blur'));
    expect(events.map(say).slice(2)).toEqual(['go:up:null', ':held:false']);
    events.length = 0;
    go.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new Event('touchcancel'));
    expect(events.map(say)).toEqual([':held:true', 'go:down:null', 'go:up:null', ':held:false']);
    // The lost pointer's own up later says nothing more.
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(events.length).toBe(4);
  });
});
