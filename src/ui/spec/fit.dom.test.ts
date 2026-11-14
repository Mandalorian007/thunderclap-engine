// @vitest-environment happy-dom
// The game fit hooks (ws/ui-fit), each on both presenters: a stack's aim, an icon's ring, a
// windowed list, a slide, a body that slides, give-way, a field's close key and type-ahead, a held
// slot, finding a word's element and a list's rows, the game's class names, a world surface on a
// bare device, and a measure in the game's own type.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from '../../render/fake-gpu';
import { Renderer } from '../../render/renderer';
import * as ui from '../index';
import type { PanelCanvas, PanelContext2D } from '../world-panel/paint';
import { createWorldPanel, type WorldPanel } from '../world-panel/panel';
import { compileSpec } from './compile';
import { hud } from './hud';
import { panel, type SpecPanel, specGivesWay } from './panel';
import { type DomPresenter, presentDom } from './present-dom';
import { presentWorld, type WorldPresenter } from './present-world';
import { R_AIM, R_RING, typeMeasure, typeMeasureIn } from './units';
import { b, type PanelEvent, type PanelSpec } from './words';
import { worldScreen } from './world-screen';

/** A Canvas2D stub that logs arcs and text. */
function stubCanvas(width: number, height: number): PanelCanvas & { log: string[] } {
  const log: string[] = [];
  const ctx = {
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    arc: (_x: number, _y: number, _r: number, a0: number, a1: number) =>
      log.push(`arc ${(a1 - a0).toFixed(3)}`),
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    clearRect: () => {},
    fillRect: () => {},
    fillText: (t: string, _x: number, y: number) => log.push(`text ${t} ${Math.round(y)}`),
    measureText: (t: string) => ({ width: t.length * 8 }),
  } satisfies PanelContext2D;
  return { width, height, getContext: () => ctx, log };
}

const SPEC: PanelSpec = {
  id: 'fit',
  giveWay: 'small',
  body: {
    k: 'col',
    gap: 4,
    pad: 8,
    children: [
      { k: 'row', id: 'aimed', aim: 'north', h: 20, children: [] },
      { k: 'row', id: 'bound', aim: b('aim'), h: 20, children: [] },
      { k: 'icon', id: 'cool', glyph: 'M0 0 L10 10', ring: b('cool'), size: 24 },
      {
        k: 'field',
        id: 'find',
        kind: 'search',
        value: b('find'),
        typeAhead: true,
        closeKey: 'KeyE',
        w: 200,
        h: 32,
      },
      { k: 'slot', id: 'grab', item: b('grab'), press: 'held', size: 48 },
      {
        k: 'list',
        id: 'things',
        rowH: 20,
        gap: 0,
        h: 60,
        window: 20,
        row: { k: 'text', id: 'name', text: b('row.name'), style: 'body' },
      },
    ],
  },
};

function seed(p: SpecPanel, n = 50): void {
  p.model.setAll({ aim: 'east', cool: 0.25, find: '', grab: 'stone' });
  p.model.setList(
    'things',
    Array.from({ length: n }, (_, i) => `t${i}`),
  );
  for (let i = 0; i < n; i++) p.model.row('things', `t${i}`).set('name', `thing ${i}`);
}

describe('exports and compile', () => {
  it('the kinds, roles, compiler, press, glyph helpers, rows and measure are public', () => {
    for (const name of [
      'K_COL',
      'K_LIST',
      'R_TEXT',
      'R_AIM',
      'R_RING',
      'compileSpec',
      'SpecPressable',
      'viewOf',
      'partsOf',
      'maxRowsAt',
      'typeMeasure',
      'typeMeasureIn',
      'specGivesWay',
      'SPEC_SLIDE_MS',
    ])
      expect(ui, name).toHaveProperty(name);
  });

  it('keeps an aim, a ring, a window, a held slot, the type-ahead field, give-way and slide', () => {
    const c = compileSpec({ ...SPEC, slide: 'down' });
    const id = (s: string) => c.ids.indexOf(s);
    expect(Array.from(c.aims)).toEqual([id('aimed'), id('bound')]);
    const aimKey = c.keyIndex.get('aim')!;
    expect(Array.from(c.keyBinds[aimKey]!)).toEqual([id('bound'), R_AIM]);
    expect(Array.from(c.keyBinds[c.keyIndex.get('cool')!]!)).toEqual([id('cool'), R_RING]);
    expect(c.win[id('things')]).toBe(20);
    expect(c.win[id('grab')]).toBe(-1);
    expect(c.ahead).toBe(id('find'));
    expect(c.giveWay).toBe('small');
    expect(c.slide).toBe('down');
  });

  it('refuses two type-ahead fields and a negative window', () => {
    const f = { k: 'field', id: 'a', kind: 'search', typeAhead: true } as const;
    expect(() =>
      compileSpec({ id: 'x', body: { k: 'col', children: [f, { ...f, id: 'b' }] } }),
    ).toThrow(/two type-ahead/);
    expect(() =>
      compileSpec({
        id: 'y',
        body: {
          k: 'col',
          children: [
            {
              k: 'list',
              id: 'l',
              rowH: 10,
              window: -1,
              row: { k: 'text', text: 'x', style: 'body' },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('gives way by the one rule', () => {
    expect(specGivesWay(undefined, true, true)).toBe(false);
    expect(specGivesWay('small', true, false)).toBe(false);
    expect(specGivesWay('small', true, true)).toBe(true);
    expect(specGivesWay('always', true, false)).toBe(true);
    expect(specGivesWay('always', false, true)).toBe(false);
  });

  it('measures in the game’s own type stacks', () => {
    ui.measureWith((s, px, _w, family) => s.length * px * (family.includes('Wide') ? 1 : 0.5));
    try {
      const text = 'a few words that wrap';
      const plain = typeMeasure(text, 'body', 120, 20, 0, false);
      const wide = typeMeasureIn({ sans: 'Wide, sans-serif' })(text, 'body', 120, 20, 0, false);
      expect(wide).toBeGreaterThan(plain);
      const p = panel(SPEC, { schedule: null, families: { sans: 'Wide' } });
      expect(p.boxes.measure).not.toBe(typeMeasure);
    } finally {
      ui.measureWith(null);
    }
  });

  it('a stack’s aim: fixed or bound', () => {
    const p = panel(SPEC, { schedule: null });
    seed(p, 0);
    expect(p.aimOf('aimed')).toBe('north');
    expect(p.aimOf('bound')).toBe('east');
    expect(p.aimOf('nope')).toBe('');
  });
});

describe('presentDom fit', () => {
  let host: HTMLElement;
  let p: SpecPanel;
  let d: DomPresenter;
  let events: PanelEvent[];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    p = panel(SPEC, { schedule: null });
    events = [];
    p.onEvent = (e) => events.push(e);
    d = presentDom(p, host, { classes: { 'tcs-slot': 'game-slot', 'tcs-given': 'given-way' } });
    seed(p);
    p.frame(320, 0);
    p.apply();
  });

  afterEach(() => {
    p.dispose();
    host.remove();
  });

  const say = () => events.map((e) => `${e.id}:${e.type}:${e.value}`);

  it('writes an aim, an icon ring and the game’s classes', () => {
    expect(d.el('aimed')!.getAttribute('data-aim')).toBe('north');
    expect(d.el('bound')!.getAttribute('data-aim')).toBe('east');
    p.model.set('aim', 'west');
    p.apply();
    expect(d.el('bound')!.getAttribute('data-aim')).toBe('west');
    const ring = d.el('cool')!.querySelector('.tcs-ring') as HTMLElement;
    expect(ring.style.getPropertyValue('--tcs-ring')).toBe('0.25');
    p.model.set('cool', 2);
    p.apply();
    expect(ring.style.getPropertyValue('--tcs-ring')).toBe('1');
    expect(d.el('grab')!.classList.contains('game-slot')).toBe(true);
    expect(d.el('grab')!.getAttribute('data-id')).toBe('grab');
  });

  it('a windowed list binds only the rows near its view, and more as it scrolls', () => {
    const bound = d.rows('things');
    expect(bound[0]).toBe('t0');
    // 60 units of view and 20 either side: 5 rows of 20.
    expect(bound.length).toBeLessThanOrEqual(5);
    expect(d.el('name', 't40')).toBeNull();
    const scroller = d.el('things')!;
    expect(d.reveal('things', 't40')).toBe(true);
    expect(d.rows('things')).toContain('t40');
    expect(d.rows('things')).not.toContain('t0');
    expect(d.el('name', 't40')!.textContent).toBe('thing 40');
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(d.rows('things')).toContain('t0');
    expect(events.some((e) => e.id === 'things' && e.type === 'scroll' && e.value === 0)).toBe(
      true,
    );
    expect(d.reveal('things', 'nope')).toBe(false);
  });

  it('a slide moves rows from where they stood (FLIP)', () => {
    const animate = vi.fn();
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const was = proto.animate;
    proto.animate = animate;
    try {
      const keys = Array.from({ length: 50 }, (_, i) => `t${i}`);
      // t2 to the top: t0, the top row in view, keeps its place (the view scrolls a row), so t0
      // and t1 stand still on screen, t2 comes up three rows, and the rows below t2 come up one.
      p.model.setList('things', ['t2', 't0', 't1', ...keys.slice(3)], 'slide');
      p.apply();
      expect(d.rows('things').slice(0, 3)).toEqual(['t2', 't0', 't1']);
      const moves = animate.mock.calls.map((c) => (c[0] as Keyframe[])[0]!.transform);
      expect(moves).toEqual(['translateY(60px)', 'translateY(20px)', 'translateY(20px)']);
      expect(d.el('things')!.scrollTop).toBe(20);
    } finally {
      proto.animate = was;
    }
  });

  it('gives way: hidden, inert, its classes', () => {
    hud({ items: [] }).giveWay(true, true);
    p.giveWay(true, false);
    p.apply();
    expect(host.hasAttribute('data-given')).toBe(false);
    p.giveWay(true, true);
    p.apply();
    expect(host.hasAttribute('data-given')).toBe(true);
    expect(host.classList.contains('given-way')).toBe(true);
    p.giveWay(false, true);
    p.apply();
    expect(host.hasAttribute('data-given')).toBe(false);
  });

  it('type-ahead: a letter typed with no field focused goes into the field; `/` focuses it', () => {
    const find = d.el('find') as HTMLInputElement;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS' }));
    expect(find.value).toBe('s');
    expect(document.activeElement).toBe(find);
    expect(p.model.get('find')).toBe('s');
    find.blur();
    // Not its close key, not a repeat.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', repeat: true }));
    expect(find.value).toBe('s');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    expect(document.activeElement).toBe(find);
  });

  it('a close key in the empty field closes; with text, or a finger’s, it types', () => {
    const find = d.el('find') as HTMLInputElement;
    find.focus();
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
    expect(say()).toContain('find:close:null');
    events.length = 0;
    find.value = 'x';
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
    expect(say()).not.toContain('find:close:null');
    find.value = '';
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
    expect(say()).not.toContain('find:close:null');
  });

  it('a held slot says down and up, never tap', () => {
    const grab = d.el('grab')!;
    grab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    grab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    grab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(say().filter((s) => s.startsWith('grab:'))).toEqual(['grab:down:null', 'grab:up:null']);
  });

  it('a body that slides marks its side', () => {
    const q = panel({ ...SPEC, id: 'sl', slide: 'down', fade: 200 }, { schedule: null });
    const h = document.createElement('div');
    presentDom(q, h);
    q.frame(320, 0);
    q.apply();
    expect(h.querySelector('.tcs-body')!.getAttribute('data-slide')).toBe('down');
    q.dispose();
  });
});

describe('presentWorld fit', () => {
  let p: SpecPanel;
  let surface: WorldPanel;
  let canvas: ReturnType<typeof stubCanvas>;
  let wv: WorldPresenter;
  let events: PanelEvent[];
  let t: number;
  let frames: (() => void)[];

  function make(spec: PanelSpec = SPEC): void {
    const fake = createFakeDevice();
    canvas = stubCanvas(400, 400);
    surface = createWorldPanel(new Renderer(fakeRendererGpu(fake)), {
      width: 4,
      height: 4,
      resolution: 100,
      canvas,
    });
    p = panel(spec, { schedule: null });
    events = [];
    p.onEvent = (e) => events.push(e);
    t = 0;
    frames = [];
    wv = presentWorld(p, surface, { now: () => t, frame: (f) => frames.push(f) });
    seed(p);
    p.apply();
    surface.repaint();
  }

  beforeEach(() => make());
  afterEach(() => p.dispose());

  const say = () => events.map((e) => `${e.id}:${e.type}:${e.value}`);

  it('paints an icon’s ring as a share of a turn', () => {
    expect(canvas.log).toContain(`arc ${(0.25 * Math.PI * 2).toFixed(3)}`);
  });

  it('gives way: nothing painted, nothing pressed', () => {
    p.giveWay(true, true);
    p.apply();
    canvas.log.length = 0;
    surface.repaint();
    expect(canvas.log).toEqual([]);
    expect(wv.key({ key: 'a', code: 'KeyA' })).toBe(false);
  });

  it('type-ahead and the close key, from the surface’s keys', () => {
    expect(wv.key({ key: 'S', code: 'KeyS' })).toBe(true);
    expect(p.model.get('find')).toBe('s');
    expect(wv.focusId.id).toBe('find');
    wv.key({ key: 'Backspace' });
    wv.key({ key: 'e', code: 'KeyE' });
    expect(say()).toContain('find:close:null');
  });

  it('a held slot says down and up', () => {
    const r = wv.rectOf('grab')!;
    wv.pointerDown(r.x + 2, r.y + 2);
    wv.pointerUp(r.x + 2, r.y + 2, true);
    expect(say().filter((s) => s.startsWith('grab:'))).toEqual(['grab:down:null', 'grab:up:null']);
  });

  it('rows in view, reveal, and a scroll event', () => {
    expect(wv.rows('things')[0]).toBe('t0');
    expect(wv.rows('things')).not.toContain('t40');
    expect(wv.reveal('things', 't40')).toBe(true);
    expect(wv.rows('things')).toContain('t40');
    expect(events.some((e) => e.id === 'things' && e.type === 'scroll')).toBe(true);
  });

  it('a slide paints rows on their way, then at their places', () => {
    const keys = Array.from({ length: 50 }, (_, i) => `t${i}`);
    p.model.setList('things', ['t2', 't0', 't1', ...keys.slice(3)], 'slide');
    p.apply();
    expect(frames.length).toBe(1);
    const yOf = (s: string) => {
      const line = canvas.log.filter((l) => l.startsWith(`text ${s} `)).pop()!;
      return Number(line.split(' ').pop());
    };
    canvas.log.length = 0;
    surface.repaint();
    const startY = yOf('thing 2');
    t = 1000;
    frames.shift()!();
    canvas.log.length = 0;
    surface.repaint();
    const endY = yOf('thing 2');
    // t2 starts where it stood on screen and ends at the top (t0 kept its place: a row's scroll).
    expect(startY - endY).toBe(60);
    expect(frames.length).toBe(0);
  });

  it('a body that slides paints on its way out', () => {
    p.dispose();
    make({ ...SPEC, id: 'sl', slide: 'down', body: { ...SPEC.body, show: b('open') } });
    p.model.set('open', true);
    p.apply();
    p.model.set('open', false);
    p.apply();
    canvas.log.length = 0;
    surface.repaint();
    expect(canvas.log.length).toBeGreaterThan(0);
    t = 10_000;
    frames.shift()!();
    canvas.log.length = 0;
    surface.repaint();
    expect(canvas.log).toEqual([]);
  });

  it('a world panel and a screen on a bare device: painted and uploaded, drawn by the game', () => {
    const fake = createFakeDevice();
    const bare = createWorldPanel(
      { device: fake.device },
      {
        width: 1,
        height: 1,
        resolution: 64,
        canvas: stubCanvas(64, 64),
      },
    );
    const q = panel(SPEC, { schedule: null });
    presentWorld(q, bare);
    seed(q);
    q.apply();
    bare.prepare({} as GPUCommandEncoder);
    expect(bare.stats.uploads).toBe(1);
    expect(bare.texture.width).toBe(64);
    const pass = { setBindGroup: vi.fn(), setPipeline: vi.fn(), draw: vi.fn() };
    bare.draw(pass as unknown as GPURenderPassEncoder);
    expect(pass.draw).not.toHaveBeenCalled();
    const screen = worldScreen({ device: fake.device }, { canvas: stubCanvas(1280, 720) });
    expect(screen.texture).toBeDefined();
    q.dispose();
    bare.dispose();
    screen.dispose();
  });
});
