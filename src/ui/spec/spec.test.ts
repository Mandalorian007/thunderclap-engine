// The spec layout, model and press (ws/ui-spec; ported from Forge Wilds' generic ui-layout and
// ui-press tests): a stack shares its free length by grow and a hidden word closes up, a press
// lands on the word it is over (in a list's row at its scroll), a scroll col and a tap col, a wrap
// text's counted lines and term column, the tabs' shares, a typo throws, unchanged sets leave
// nothing dirty, and the layout and an idle apply allocate nothing once warm.

import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSpec } from './compile';
import { measureWith, wrapCount } from './measure';
import type { SpecValue } from './model';
import { panel, type SpecPanel } from './panel';
import { SPEC_HOLD_MS, SPEC_HOLD_SLOP, SpecPressable, type SpecTimer } from './press';
import { K_TEXT, TERM_MIN, tabShares, typeMeasure } from './units';
import { b, type PanelSpec, SPEC_LINE, type SpecNode } from './words';

/** A panel laid out in a frame (no presenter). */
function laid(
  spec: PanelSpec,
  fill: (p: SpecPanel) => void,
  w: number,
  h = 0,
  text = 1,
): SpecPanel {
  const p = panel(spec, { schedule: null });
  fill(p);
  p.boxes.layout(w, h, text);
  return p;
}

/** Word `id`'s index. */
function at(p: SpecPanel, id: string): number {
  const i = p.spec.ids.indexOf(id);
  if (i === -1) throw new Error(`no word ${id}`);
  return i;
}

/** A pack: a grid of 12 slots, a drops row shown while something is picked, and an 8-across list of goods. */
const PACK: PanelSpec = {
  id: 'pack',
  body: {
    k: 'col',
    gap: 8,
    pad: 12,
    children: [
      { k: 'text', text: b('title'), style: 'head' },
      {
        k: 'grid',
        id: 'slots',
        cols: 6,
        cell: 56,
        gap: 4,
        children: Array.from(
          { length: 12 },
          (_, i): SpecNode => ({
            k: 'slot',
            id: `slot.${i}`,
            item: b(`slot.${i}.item`),
            count: b(`slot.${i}.count`),
            size: 56,
          }),
        ),
      },
      {
        k: 'row',
        id: 'drops',
        show: b('picked'),
        gap: 4,
        children: [
          { k: 'button', id: 'one', text: 'Drop one', w: 120 },
          { k: 'button', id: 'all', text: 'Drop all', w: 120 },
        ],
      },
      {
        k: 'list',
        id: 'goods',
        cols: 8,
        rowH: 60,
        gap: 4,
        h: 128,
        row: {
          k: 'col',
          children: [
            { k: 'button', id: 'give', text: b('row.name'), h: 40 },
            { k: 'text', text: b('row.count'), style: 'count' },
          ],
        },
      },
    ],
  },
};

const GOODS = Array.from({ length: 40 }, (_, i) => `g${i}`);

function fillPack(p: SpecPanel): void {
  const m = p.model;
  m.set('title', 'Pack');
  m.set('picked', true);
  for (let i = 0; i < 12; i++) {
    m.set(`slot.${i}.item`, i % 3 === 0 ? '' : `thing ${i}`);
    m.set(`slot.${i}.count`, i);
  }
  m.setList('goods', GOODS);
  for (let i = 0; i < GOODS.length; i++) {
    const r = m.row('goods', GOODS[i]!);
    r.set('name', `good ${i}`);
    r.set('count', `${i}`);
  }
}

describe('spec layout', () => {
  afterEach(() => measureWith(null));

  it('a col stacks, a row shares its free width by grow, padding insets, and a hidden word closes up', () => {
    const spec: PanelSpec = {
      id: 't',
      body: {
        k: 'col',
        pad: [10, 20, 30, 40],
        gap: 5,
        children: [
          { k: 'text', id: 'a', text: 'a', style: 'label' },
          { k: 'text', id: 'gone', text: 'b', style: 'label', show: b('more') },
          {
            k: 'row',
            id: 'r',
            gap: 4,
            align: 'center',
            children: [
              { k: 'button', id: 'x', text: 'x', w: 50 },
              { k: 'meter', id: 'm', value: 0.5, grow: 1, h: 6 },
              { k: 'button', id: 'y', text: 'y', grow: 2 },
            ],
          },
        ],
      },
    };
    const p = laid(spec, (q) => q.model.set('more', false), 300);
    const bx = p.boxes;
    const [a, gone, r, x, m, y] = ['a', 'gone', 'r', 'x', 'm', 'y'].map((id) => at(p, id)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect([bx.x[a], bx.y[a], bx.w[a], bx.h[a]]).toEqual([40, 10, 240, 16]);
    expect(bx.on[gone]).toBe(0);
    expect(bx.y[r]).toBe(10 + 16 + 5);
    expect(bx.h[0]).toBe(10 + 16 + 5 + 40 + 30);
    // 240 across: 50 fixed, 2 gaps of 4, 182 free by 1 : 2 (cut to 1/64 px, the last share the rest).
    expect([bx.w[x], bx.w[m], bx.w[y]]).toEqual([50, 60.65625, 121.34375]);
    expect([bx.x[x], bx.x[m], bx.x[y]]).toEqual([40, 94, 158.65625]);
    expect(bx.y[m]).toBe(bx.y[r]! + (40 - 6) / 2);
    p.model.set('more', true);
    expect(p.model.relayout).toBe(true);
    p.boxes.layout(300, 0, 1);
    expect(bx.on[gone]).toBe(1);
    expect(bx.y[r]).toBe(10 + 2 * (16 + 5));
  });

  it('a frame 0 wide lays the panel out at its natural width', () => {
    const p = laid(PACK, fillPack, 0);
    // The grid: 6 cells of 56 and 5 gaps of 4, inside 12 of padding each side.
    expect(p.boxes.w[0]).toBe(6 * 56 + 5 * 4 + 24);
  });

  it('a press lands on the word it is over: a slot in a grid, a row button at its scroll, never a hidden one', () => {
    const p = laid(PACK, fillPack, 600);
    const bx = p.boxes;
    const s = at(p, 'slot.8');
    expect(bx.hit(bx.x[s]! + 1, bx.y[s]! + 1)).toBe(s);
    expect(bx.hitRow).toBe(-1);
    // The gap between two slots is no slot's.
    expect(bx.hit(bx.x[s]! + 56 + 3, bx.y[s]! + 10)).toBe(-1);
    // The goods: 8 across, 60 high, 4 apart; a press in row 2, column 3, then scrolled one row.
    const list = at(p, 'goods');
    const give = at(p, 'give');
    const px = bx.x[list]! + 3 * (bx.cellW[list]! + 4) + 10;
    const py = bx.y[list]! + 64 + 10;
    expect(bx.hit(px, py)).toBe(give);
    expect(bx.hitRow).toBe(8 + 3);
    bx.scroll[list] = 64;
    expect(bx.hit(px, py)).toBe(give);
    expect(bx.hitRow).toBe(16 + 3);
    // Hidden: the drops row while nothing is picked.
    const one = at(p, 'one');
    const [ox, oy] = [bx.x[one]! + 5, bx.y[one]! + 5];
    expect(bx.hit(ox, oy)).toBe(one);
    p.model.set('picked', false);
    p.boxes.layout(600, 0, 1);
    expect(bx.hit(ox, oy)).not.toBe(one);
  });

  it('a list of 30, 90 or 250 rows has the same boxes (its row is laid out once)', () => {
    const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const spec: PanelSpec = {
      id: 'rows',
      body: {
        k: 'col',
        children: [
          {
            k: 'list',
            id: 'l',
            rowH: 30,
            h: 300,
            row: { k: 'text', text: b('row.t'), style: 'body' },
          },
        ],
      },
    };
    const boxesAt = (n: number): number[] => {
      const p = laid(spec, (q) => q.model.setList('l', keys.slice(0, n)), 200);
      expect(p.spec.n).toBe(3);
      return [...p.boxes.h, ...p.boxes.y];
    };
    expect(boxesAt(90)).toEqual(boxesAt(30));
    expect(boxesAt(250)).toEqual(boxesAt(30));
  });

  it('every bound key is one the words name; a typo throws', () => {
    const p = panel(PACK, { schedule: null });
    expect(() => p.model.set('titel', 'x')).toThrow(/no key titel/);
    expect(() => p.model.list('goods').row('0').set('colour', 'x')).toThrow(/no field colour/);
    expect(() => p.model.list('nope')).toThrow(/no list nope/);
    expect([...compileSpec(PACK).listIds]).toEqual(['goods']);
    expect(() =>
      compileSpec({
        id: 'x',
        body: { k: 'col', children: [{ k: 'text', text: b('row.a'), style: 'body' }] },
      }),
    ).toThrow(/outside a list's row/);
  });

  it('a scroll col lays its children out in its content, takes what its stack leaves, and a press in it lands at its scroll', () => {
    const spec: PanelSpec = {
      id: 'scrolls',
      body: {
        k: 'col',
        children: [
          { k: 'button', id: 'head', text: 'head', h: 40 },
          {
            k: 'col',
            id: 'body',
            scroll: true,
            grow: 1,
            children: Array.from({ length: 10 }, (_, i) => ({
              k: 'button' as const,
              id: `b${i}`,
              text: `${i}`,
              h: 40,
            })),
          },
        ],
      },
    };
    const p = laid(spec, () => {}, 200, 200);
    const bx = p.boxes;
    const sc = at(p, 'body');
    expect(p.spec.scrolls[sc]).toBe(1);
    expect(p.spec.scroller[at(p, 'b3')]).toBe(sc);
    expect(p.spec.scroller[at(p, 'head')]).toBe(-1);
    expect(bx.y[sc]).toBe(40);
    expect(bx.h[sc]).toBe(160);
    expect(bx.content[sc]).toBe(400);
    expect(bx.y[at(p, 'b9')]! - bx.y[sc]!).toBe(360);
    expect(bx.nh[0]! + bx.content[sc]!).toBe(440);
    const [x, y] = [10, bx.y[sc]! + 5];
    expect(bx.hit(x, y)).toBe(at(p, 'b0'));
    bx.scroll[sc] = 200;
    expect(bx.hit(x, y)).toBe(at(p, 'b5'));
    expect(bx.hit(x, 20)).toBe(at(p, 'head'));
    const nested = {
      id: 'x',
      body: {
        k: 'col',
        children: [
          { k: 'col', scroll: true, children: [{ k: 'col', scroll: true, children: [] }] },
        ],
      },
    } as const satisfies PanelSpec;
    expect(() => compileSpec(nested)).toThrow(/inside another/);
    expect(() =>
      compileSpec({
        id: 'x',
        body: { k: 'col', children: [{ k: 'row', scroll: true, children: [] }] },
      }),
    ).toThrow(/row/);
    expect(() => compileSpec({ id: 'x', body: { k: 'col', scroll: true, children: [] } })).toThrow(
      /body/,
    );
  });

  it('a tap col is pressed as one where nothing else pressable in it is', () => {
    const spec: PanelSpec = {
      id: 'card',
      body: {
        k: 'col',
        children: [
          {
            k: 'col',
            id: 'card',
            tap: true,
            grow: 1,
            children: [
              { k: 'text', text: 'a card', style: 'body' },
              { k: 'button', id: 'more', text: 'more', h: 40 },
            ],
          },
        ],
      },
    };
    const p = laid(spec, () => {}, 200, 200);
    const bx = p.boxes;
    const card = at(p, 'card');
    const more = at(p, 'more');
    expect(bx.hit(10, 5)).toBe(card);
    expect(bx.hit(10, 180)).toBe(card);
    expect(bx.hit(bx.x[more]! + 2, bx.y[more]! + 2)).toBe(more);
    expect(() =>
      compileSpec({
        id: 'x',
        body: { k: 'col', children: [{ k: 'col', tap: true, children: [] }] },
      }),
    ).toThrow(/needs an id/);
    expect(() =>
      compileSpec({ id: 'x', body: { k: 'col', id: 'x', tap: true, children: [] } }),
    ).toThrow(/body/);
  });

  it('a wrap text has the lines its words take at its width, and a key line its term column', () => {
    measureWith((s, px) => Array.from(s).length * px * 0.5);
    const spec: PanelSpec = {
      id: 'wraps',
      body: {
        k: 'col',
        children: [
          { k: 'text', id: 'help', text: b('help'), style: 'body', wrap: true },
          {
            k: 'text',
            id: 'line',
            term: 'Tap and hold a block',
            text: 'Break it',
            style: 'body',
            wrap: true,
          },
          {
            k: 'col',
            id: 'list',
            scroll: true,
            grow: 1,
            children: Array.from({ length: 6 }, (_, j) => ({
              k: 'button' as const,
              id: `b${j}`,
              text: `${j}`,
              h: 60,
            })),
          },
        ],
      },
    };
    const p = panel(spec, { schedule: null });
    const bx = p.boxes;
    const [help, line, list] = [at(p, 'help'), at(p, 'line'), at(p, 'list')];
    p.model.set('help', 'word '.repeat(20).trim());
    bx.layout(300, 300, 1);
    expect(bx.h[help]).toBe(3 * SPEC_LINE.body);
    const measured = bx.measured;
    bx.layout(300, 300, 1);
    expect(bx.measured).toBe(measured);
    p.model.set('help', '');
    bx.layout(300, 300, 1);
    expect(bx.h[help]).toBe(SPEC_LINE.body);
    p.model.set('help', 'word '.repeat(40).trim());
    bx.layout(300, 300, 1);
    expect(bx.h[help]).toBe(5 * SPEC_LINE.body);
    expect(bx.termW[line]).toBe(126);
    expect(bx.h[line]).toBe(2 * SPEC_LINE.body);
    expect(TERM_MIN).toBe(120);
    bx.layout(250, 300, 1);
    expect(bx.termW[line]).toBe(TERM_MIN);
    bx.layout(300, 300, 1);
    expect(bx.h[list]).toBe(300 - bx.h[help]! - bx.h[line]!);
    expect(bx.content[list]).toBe(360);
    expect(typeMeasure('a b', 'body', 300, 17, 0, false)).toBe(1);
    expect(typeMeasure('x'.repeat(90), 'body', 300, 17, 0, false)).toBe(3);
    expect(typeMeasure('a\nb', 'body', 300, 17, 0, false)).toBe(2);
    expect(typeMeasure('{w}a{/} b', 'body', 300, 17, 0, false)).toBe(wrapCount('a b', 300, 13));
    expect(() =>
      compileSpec({
        id: 'x',
        body: {
          k: 'col',
          children: [{ k: 'text', text: '', style: 'body', wrap: true, lines: b('n') }],
        },
      }),
    ).toThrow(/counts its own lines/);
  });

  it('a text is its lines high at any text scale (the line height rounded)', () => {
    for (const text of [1, 1.15, 1.3]) {
      const p = laid(PACK, fillPack, 330, 0, text);
      const c = p.spec;
      for (let i = 0; i < c.n; i++) {
        if (c.kind[i] !== K_TEXT || p.boxes.on[i] === 0 || c.inList[i] !== -1) continue;
        const style = (c.nodes[i] as { style: keyof typeof SPEC_LINE }).style;
        expect(p.boxes.h[i]).toBe(c.lines[i]! * Math.round(SPEC_LINE[style] * text));
      }
    }
  });

  it("a fill tabs' shares: by weight, none under its least, whole sums to its width", () => {
    const out = new Float64Array(8);
    tabShares(3, 50, 300, () => 1, out);
    expect([...out.subarray(0, 3)]).toEqual([100, 100, 100]);
    const words = ['Graphics', 'Controls', 'Audio', 'Accessibility', 'HUD', 'How to play'];
    tabShares(6, 64, 520, (i) => words[i]!.length, out);
    const got = [...out.subarray(0, 6)];
    expect([got[2], got[4]]).toEqual([64, 64]);
    expect(got.reduce((a, x) => a + x, 0)).toBe(520);
    const per = (i: number): number => got[i]! / words[i]!.length;
    for (const i of [0, 1, 3]) expect(Math.abs(per(i) - per(5))).toBeLessThan(1);
    tabShares(4, 100, 300, () => 1, out);
    expect([...out.subarray(0, 4)]).toEqual([100, 100, 100, 100]);
  });
});

describe('spec model', () => {
  it('unchanged row sets leave nothing dirty and ask for no frame; one change, one bit', () => {
    const p = laid(PACK, fillPack, 600);
    p.model.clean();
    let asked = 0;
    p.model.onChange = () => asked++;
    fillPack(p);
    const l = p.model.list('goods');
    expect(l.dirtyN).toBe(0);
    expect(p.model.dirtyN).toBe(0);
    expect(p.model.pending).toBe(false);
    expect(asked).toBe(0);
    l.row('g7').set('name', 'a lantern');
    expect(l.dirtyN).toBe(1);
    expect(l.dirtyRows[0]!.dirty).toBe(1 << l.fieldIndex.get('name')!);
    expect(asked).toBe(1);
  });

  it('a value change marks its key and lays out nothing; a show or a list length lays out again', () => {
    const p = laid(PACK, fillPack, 600);
    p.model.clean();
    p.model.set('title', 'Bag');
    expect(p.model.relayout).toBe(false);
    expect(p.model.dirtyN).toBe(1);
    expect(p.spec.keys[p.model.dirtyKeys[0]!]).toBe('title');
    p.model.set('picked', false);
    expect(p.model.relayout).toBe(true);
  });

  it('a panel applies once a frame, and an idle apply does nothing', () => {
    let ran: (() => void) | null = null;
    const p = panel(PACK, { schedule: (f) => (ran = f) });
    const applied: boolean[] = [];
    p.presenters.push({ apply: (relaid) => applied.push(relaid), dispose: () => {} });
    fillPack(p);
    p.frame(600, 0);
    expect(ran).not.toBeNull();
    ran!();
    expect(applied).toEqual([true]);
    const n = p.applies;
    p.apply();
    expect(p.applies).toBe(n);
    p.model.set('title', 'Bag');
    ran!();
    expect(applied).toEqual([true, false]);
  });
});

/** A clock that runs only when told. */
class Clock implements SpecTimer {
  now = 0;
  private due: { at: number; f: () => void } | null = null;
  set(f: () => void, ms: number): unknown {
    this.due = { at: this.now + ms, f };
    return this.due;
  }
  clear(h: unknown): void {
    if (this.due === h) this.due = null;
  }
  run(ms: number): void {
    this.now += ms;
    const d = this.due;
    if (d && d.at <= this.now) {
      this.due = null;
      d.f();
    }
  }
}

function pressable(holds: boolean): { p: SpecPressable; clock: Clock; got: string[] } {
  const clock = new Clock();
  const p = new SpecPressable(holds, clock);
  const got: string[] = [];
  p.onTap = (shift) => got.push(shift ? 'tap+shift' : 'tap');
  p.onHold = () => got.push('hold');
  return { p, clock, got };
}

describe('spec press', () => {
  it('a short press is a tap; held still it is a hold, and its click is swallowed', () => {
    const { p, clock, got } = pressable(true);
    p.down(10, 10);
    clock.run(SPEC_HOLD_MS - 1);
    p.cancel();
    p.click();
    expect(got).toEqual(['tap']);
    p.down(10, 10);
    clock.run(SPEC_HOLD_MS);
    p.cancel();
    p.click();
    expect(got).toEqual(['tap', 'hold']);
    p.down(10, 10);
    p.cancel();
    p.click(true);
    expect(got).toEqual(['tap', 'hold', 'tap+shift']);
  });

  it('a hold whose release lands elsewhere swallows no click of the next press', () => {
    const { p, clock, got } = pressable(true);
    p.down(10, 10);
    clock.run(SPEC_HOLD_MS);
    p.begin();
    p.click();
    expect(got).toEqual(['hold', 'tap']);
  });

  it('a drift past the slop is no hold; a drift within it still is', () => {
    const { p, clock, got } = pressable(true);
    p.down(0, 0);
    p.move(SPEC_HOLD_SLOP, 0);
    clock.run(SPEC_HOLD_MS);
    expect(got).toEqual(['hold']);
    p.click();
    p.down(0, 0);
    p.move(SPEC_HOLD_SLOP + 1, 0);
    clock.run(SPEC_HOLD_MS);
    p.click();
    expect(got).toEqual(['hold', 'tap']);
  });

  it('a right click is a hold at once; a word that cannot hold only taps', () => {
    const holds = pressable(true);
    holds.p.context();
    expect(holds.got).toEqual(['hold']);
    holds.p.down(0, 0, 2);
    holds.clock.run(SPEC_HOLD_MS);
    expect(holds.got).toEqual(['hold']);
    const taps = pressable(false);
    taps.p.down(0, 0);
    taps.clock.run(SPEC_HOLD_MS * 2);
    taps.p.context();
    taps.p.click();
    expect(taps.got).toEqual(['tap']);
  });
});

// Allocation: the young generation's growth while `run` runs, after a full collection, retried
// until no collection ran during it (Forge Wilds' ui-alloc.ts way, in-process here).
v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
function young(): number {
  for (const s of v8.getHeapSpaceStatistics())
    if (s.space_name === 'new_space') return s.space_used_size;
  return 0;
}
function allocated(run: () => void): number {
  for (let attempt = 0; attempt < 8; attempt++) {
    gc();
    const prof = new v8.GCProfiler();
    prof.start();
    const a = young();
    run();
    const after = young();
    if (prof.stop().statistics.length === 0) return after - a;
  }
  throw new Error('a collection ran during every attempt');
}

function lay(p: SpecPanel, w: number, n: number, big: number): void {
  for (let i = 0; i < n; i++) p.boxes.layout(w, 0, i < n / 2 ? 1 : big);
}

function setAgain(p: SpecPanel, vals: readonly SpecValue[], n: number): void {
  const l = p.model.list('goods');
  const fields = l.fields.length;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < GOODS.length; i++) {
      const r = l.rows.get(GOODS[i]!)!;
      for (let f = 0; f < fields; f++) r.setAt(f, vals[i * fields + f]!);
    }
  }
}

function idles(p: SpecPanel, n: number): void {
  for (let i = 0; i < n; i++) p.apply();
}

describe('spec budget', () => {
  it('layouts, unchanged row sets and idle applies allocate nothing once warm', () => {
    const p = panel(PACK, { schedule: null });
    fillPack(p);
    p.frame(600, 0);
    p.apply();
    const l = p.model.list('goods');
    const vals: SpecValue[] = [];
    for (const k of GOODS) for (const v of l.rows.get(k)!.vals) vals.push(v!);
    // Warm: V8's optimized code (the interpreter boxes fractions).
    for (let i = 0; i < 400; i++) {
      lay(p, 600, 50, 1.25);
      setAgain(p, vals, 10);
      p.apply();
    }
    // Each measured over many calls less the same over a few: the measure's own fixed cost cancels.
    const many = (f: (n: number) => void, n: number): number =>
      allocated(() => f(n)) - allocated(() => f(2));
    const layouts = many((n) => lay(p, 600, n, 1.25), 1000);
    const sets = many((n) => setAgain(p, vals, n), 14);
    const idle = many((n) => idles(p, n), 1000);
    expect(layouts, `${layouts} bytes over 1,000 layouts`).toBeLessThanOrEqual(1024);
    expect(
      sets,
      `${sets} bytes over ${14 * GOODS.length * 2} unchanged row sets`,
    ).toBeLessThanOrEqual(1024);
    expect(idle, `${idle} bytes over 1,000 idle applies`).toBeLessThanOrEqual(1024);
    expect(l.dirtyN).toBe(0);
    expect(p.model.dirtyN).toBe(0);
  });

  it('counts its work: one layout per frame change, none for a value change', () => {
    const p = panel(PACK, { schedule: null });
    fillPack(p);
    p.frame(600, 0);
    p.apply();
    const runs = p.boxes.runs;
    p.model.set('title', 'Bag');
    p.apply();
    expect(p.boxes.runs).toBe(runs);
    p.frame(500, 0);
    p.apply();
    expect(p.boxes.runs).toBe(runs + 1);
    p.apply();
    expect(p.boxes.runs).toBe(runs + 1);
  });
});
