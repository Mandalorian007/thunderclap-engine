import { describe, expect, it } from 'vitest';
import { createIntlCache, formatMessage, MessageSyntaxError, parseMessage } from './message';

const intl = createIntlCache();
const fmt = (src: string, args?: Record<string, unknown>, locale = 'en') =>
  formatMessage(parseMessage(src, 'k'), args as never, locale, intl);

describe('parseMessage', () => {
  it('plain text is one string node', () => {
    expect(parseMessage('Hello')).toEqual(['Hello']);
    expect(parseMessage('')).toEqual([]);
  });

  it('arguments and surrounding text', () => {
    expect(parseMessage('Hi {name}!')).toEqual(['Hi ', { kind: 'arg', name: 'name' }, '!']);
    expect(parseMessage('{ a }{b}')).toEqual([
      { kind: 'arg', name: 'a' },
      { kind: 'arg', name: 'b' },
    ]);
  });

  it('typed arguments with and without a style', () => {
    expect(parseMessage('{n, number}')).toEqual([{ kind: 'number', name: 'n', style: null }]);
    expect(parseMessage('{n, number, percent}')).toEqual([
      { kind: 'number', name: 'n', style: 'percent' },
    ]);
    expect(parseMessage('{d, date, short}')).toEqual([{ kind: 'date', name: 'd', style: 'short' }]);
    expect(parseMessage('{d, time}')).toEqual([{ kind: 'time', name: 'd', style: null }]);
  });

  it('plural with offset, exact forms, categories and #', () => {
    const [node] = parseMessage(
      '{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}',
    );
    expect(node).toMatchObject({ kind: 'plural', name: 'n', ordinal: false, offset: 1 });
    const p = node as Extract<typeof node, { kind: 'plural' }>;
    expect([...p.exact.keys()]).toEqual([0, 1]);
    expect(p.categories.get('one')).toEqual(['you and ', { kind: 'hash' }, ' other']);
    expect(p.other).toEqual(['you and ', { kind: 'hash' }, ' others']);
  });

  it('selectordinal', () => {
    const [node] = parseMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}');
    expect(node).toMatchObject({ kind: 'plural', ordinal: true, offset: 0 });
  });

  it('select', () => {
    const [node] = parseMessage('{g, select, male {he} female {she} other {they}}');
    expect(node).toMatchObject({ kind: 'select', name: 'g' });
    const s = node as Extract<typeof node, { kind: 'select' }>;
    expect([...s.cases.keys()]).toEqual(['male', 'female']);
    expect(s.other).toEqual(['they']);
  });

  it('nested select inside plural keeps # bound to the plural', () => {
    expect(
      fmt(
        '{n, plural, one {{g, select, m {his # thing} other {their # thing}}} other {# things}}',
        {
          n: 1,
          g: 'm',
        },
      ),
    ).toBe('his 1 thing');
  });

  it('# outside a plural is literal', () => {
    expect(parseMessage('item #1')).toEqual(['item #1']);
  });

  it('apostrophe quoting', () => {
    expect(parseMessage("'{'name'}'")).toEqual(['{name}']);
    expect(parseMessage("it''s")).toEqual(["it's"]);
    expect(parseMessage("don't {x}")).toEqual(["don't ", { kind: 'arg', name: 'x' }]);
    expect(parseMessage("'{a''b}'")).toEqual(["{a'b}"]);
    // Unterminated quote runs to the end, as in ICU.
    expect(parseMessage("'{x")).toEqual(['{x']);
    expect(fmt("{n, plural, other {'#' is #}}", { n: 2 })).toBe('# is 2');
  });

  describe('malformed input names the key and column', () => {
    const cases: [string, number, RegExp][] = [
      ['Hello {', 8, /argument name/],
      ['Hello {name', 12, /expected '}'/],
      ['Hello }', 7, /unmatched/],
      ['{n, bogus}', 5, /unknown argument type 'bogus'/],
      ['{n, plural, one {x}}', 20, /needs an 'other'/],
      ['{n, plural, lots {x} other {y}}', 13, /unknown plural category 'lots'/],
      ['{n, plural, offset:x other {y}}', 20, /bad offset/],
      ['{n, plural, other {y}', 22, /unexpected end/],
      ['{g, select, a {x}}', 18, /needs an 'other'/],
      ['{n, plural, other x}', 19, /expected '\{'/],
      ['{, plural}', 2, /argument name/],
      ['{n, number', 11, /expected '}'/],
    ];
    for (const [src, column, re] of cases) {
      it(JSON.stringify(src), () => {
        let err: unknown;
        try {
          parseMessage(src, 'menu.start');
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(MessageSyntaxError);
        const e = err as MessageSyntaxError;
        expect(e.key).toBe('menu.start');
        expect(e.column).toBe(column);
        expect(e.message).toMatch(/^i18n: "menu\.start" column \d+: /);
        expect(e.message).toMatch(re);
      });
    }
  });
});

describe('formatMessage', () => {
  it('substitutes arguments; numbers and dates go through Intl', () => {
    expect(fmt('Hi {name}!', { name: 'Ada' })).toBe('Hi Ada!');
    expect(fmt('{n}', { n: 1234.5 })).toBe('1,234.5');
    expect(fmt('{n}', { n: 1234.5 }, 'de')).toBe('1.234,5');
    expect(fmt('{b} {z}', { b: true, z: null })).toBe('true null');
    expect(fmt('{d}', { d: new Date(Date.UTC(2026, 0, 2, 12)) })).toMatch(/2026/);
  });

  it('a missing argument renders as its placeholder', () => {
    expect(fmt('Hi {name}!', {})).toBe('Hi {name}!');
    expect(fmt('Hi {name}!')).toBe('Hi {name}!');
    expect(fmt('{n, number}', {})).toBe('{n}');
    expect(fmt('{n, plural, one {#} other {many}}', {})).toBe('many');
  });

  it('number and date styles', () => {
    expect(fmt('{n, number, integer}', { n: 3.7 })).toBe('4');
    expect(fmt('{n, number, percent}', { n: 0.25 })).toBe('25%');
    const d = new Date(2026, 4, 6, 9, 5);
    expect(fmt('{d, date, long}', { d })).toBe('May 6, 2026');
    expect(fmt('{d, date, short}', { d })).toBe('5/6/26');
    expect(fmt('{d, time}', { d })).toMatch(/9:05/);
    expect(fmt('{d, date}', { d: d.getTime() })).toMatch(/May 6, 2026/);
  });

  const items = '{n, plural, =0 {none} one {# item} other {# items}}';

  it('plural in English: exact, one, other', () => {
    expect(fmt(items, { n: 0 })).toBe('none');
    expect(fmt(items, { n: 1 })).toBe('1 item');
    expect(fmt(items, { n: 2 })).toBe('2 items');
    expect(fmt(items, { n: 1000 })).toBe('1,000 items');
  });

  it('plural in Russian: one, few, many', () => {
    const ru =
      '{n, plural, one {# предмет} few {# предмета} many {# предметов} other {# предмета}}';
    expect(fmt(ru, { n: 1 }, 'ru')).toBe('1 предмет');
    expect(fmt(ru, { n: 2 }, 'ru')).toBe('2 предмета');
    expect(fmt(ru, { n: 5 }, 'ru')).toBe('5 предметов');
    expect(fmt(ru, { n: 11 }, 'ru')).toBe('11 предметов');
    expect(fmt(ru, { n: 21 }, 'ru')).toBe('21 предмет');
    expect(fmt(ru, { n: 1.5 }, 'ru')).toBe('1,5 предмета');
  });

  it('plural in Arabic: zero, one, two, few, many', () => {
    const ar = '{n, plural, zero {Z} one {O} two {T} few {F#} many {M#} other {X}}';
    const d = (n: number) => new Intl.NumberFormat('ar').format(n);
    expect(fmt(ar, { n: 0 }, 'ar')).toBe('Z');
    expect(fmt(ar, { n: 1 }, 'ar')).toBe('O');
    expect(fmt(ar, { n: 2 }, 'ar')).toBe('T');
    expect(fmt(ar, { n: 3 }, 'ar')).toBe(`F${d(3)}`);
    expect(fmt(ar, { n: 11 }, 'ar')).toBe(`M${d(11)}`);
    expect(fmt(ar, { n: 100 }, 'ar')).toBe('X');
  });

  it('offset applies to # and to the category, not to exact forms', () => {
    const src =
      '{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}';
    expect(fmt(src, { n: 0 })).toBe('nobody');
    expect(fmt(src, { n: 1 })).toBe('you');
    expect(fmt(src, { n: 2 })).toBe('you and 1 other');
    expect(fmt(src, { n: 5 })).toBe('you and 4 others');
  });

  it('selectordinal', () => {
    const src = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect([1, 2, 3, 4, 11, 22].map((n) => fmt(src, { n }))).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '22nd',
    ]);
  });

  it('select with other', () => {
    const src = '{g, select, male {he} female {she} other {they}}';
    expect(fmt(src, { g: 'male' })).toBe('he');
    expect(fmt(src, { g: 'female' })).toBe('she');
    expect(fmt(src, { g: 'x' })).toBe('they');
    expect(fmt(src, {})).toBe('they');
  });

  it('a non-number plural argument uses other', () => {
    expect(fmt(items, { n: 'lots' })).toBe('lots items');
  });

  it('the Intl cache reuses formatters per locale', () => {
    const c = createIntlCache();
    expect(c.plural('en', false)).toBe(c.plural('en', false));
    expect(c.plural('en', false)).not.toBe(c.plural('en', true));
    expect(c.number('en', null)).toBe(c.number('en', null));
    expect(c.number('en', null)).not.toBe(c.number('de', null));
    expect(c.date('en', 'date', 'short')).toBe(c.date('en', 'date', 'short'));
  });
});
