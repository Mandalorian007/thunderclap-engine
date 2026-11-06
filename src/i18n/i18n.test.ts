import { describe, expect, it, vi } from 'vitest';
import { compileTable, createI18n, type Table } from './i18n';
import { MessageSyntaxError } from './message';

const en: Table = {
  menu: { start: 'Start', quit: 'Quit' },
  saved: 'Saved',
  items: '{count, plural, =0 {No items} one {# item} other {# items}}',
  hi: 'Hi {name}',
};
const enGB: Table = { menu: { start: 'Begin' } };
const ru: Table = {
  menu: { start: 'Начать' },
  items: '{count, plural, one {# предмет} few {# предмета} many {# предметов} other {# предмета}}',
};
const ar: Table = { saved: 'تم الحفظ' };

describe('createI18n', () => {
  it('nested keys, placeholders, has, locales, direction', () => {
    const i18n = createI18n({ locale: 'en', tables: { en, ru } });
    expect(i18n.locale).toBe('en');
    expect(i18n.locales).toEqual(['en', 'ru']);
    expect(i18n.direction).toBe('ltr');
    expect(i18n.t('menu.start')).toBe('Start');
    expect(i18n.t('hi', { name: 'Ada' })).toBe('Hi Ada');
    expect(i18n.t('items', { count: 0 })).toBe('No items');
    expect(i18n.t('items', { count: 3 })).toBe('3 items');
    expect(i18n.has('menu.quit')).toBe(true);
    expect(i18n.has('menu.nope')).toBe(false);
  });

  it('inline tables are usable synchronously; ready resolves', async () => {
    const i18n = createI18n({ locale: 'ru', tables: { en, ru } });
    expect(i18n.t('menu.start')).toBe('Начать');
    await expect(i18n.ready).resolves.toBeUndefined();
  });

  it('missing keys: key by default, throw, custom, onMissing once per key and locale', () => {
    const onMissing = vi.fn();
    const a = createI18n({ locale: 'en', tables: { en }, onMissing });
    expect(a.t('nope')).toBe('nope');
    expect(a.t('nope')).toBe('nope');
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith('nope', 'en');

    const b = createI18n({ locale: 'en', tables: { en }, missing: 'throw' });
    expect(() => b.t('nope')).toThrow(/missing "nope" in "en"/);

    const c = createI18n({
      locale: 'en',
      tables: { en },
      missing: (key, locale) => `[${locale}:${key}]`,
    });
    expect(c.t('nope')).toBe('[en:nope]');
  });

  it('fallback chain: locale, its language, then the fallbacks', () => {
    const i18n = createI18n({
      locale: 'en-GB',
      fallback: ['ru', 'en'],
      tables: { en, 'en-GB': enGB, ru, ar },
    });
    expect(i18n.locale).toBe('en-GB');
    expect(i18n.t('menu.start')).toBe('Begin'); // en-GB
    expect(i18n.t('menu.quit')).toBe('Quit'); // en (language)
    expect(i18n.t('saved')).toBe('Saved'); // en before ru
  });

  it('plural rules come from the table that held the string', async () => {
    const i18n = createI18n({ locale: 'ru', fallback: 'en', tables: { en, ru } });
    expect(i18n.t('items', { count: 2 })).toBe('2 предмета');
    expect(i18n.t('items', { count: 5 })).toBe('5 предметов');
    // `hi` is only in en: formatted with English rules and digits.
    expect(i18n.t('hi', { name: 'Ada' })).toBe('Hi Ada');
    const ar2 = createI18n({ locale: 'ar', fallback: 'en', tables: { en, ar } });
    // The English plural string under an Arabic locale still uses English categories.
    expect(ar2.t('items', { count: 2 })).toBe('2 items');
  });

  it('a locale tag resolves to a table by language; unknown locales reject', async () => {
    const i18n = createI18n({ locale: 'en-US', tables: { en, ru } });
    expect(i18n.locale).toBe('en');
    await expect(i18n.setLocale('ru-RU')).resolves.toBeUndefined();
    expect(i18n.locale).toBe('ru');
    await expect(i18n.setLocale('ja')).rejects.toThrow(/no table for locale "ja"/);
    expect(i18n.locale).toBe('ru');
    expect(() => createI18n({ locale: 'en', tables: {} })).toThrow(/tables is empty/);
  });

  it('lazy tables: one pending promise per locale, loaded once, ready waits', async () => {
    let resolveRu: (t: Table) => void = () => {};
    const loader = vi.fn(() => new Promise<Table>((r) => (resolveRu = r)));
    const i18n = createI18n({ locale: 'ru', fallback: 'en', tables: { en, ru: loader } });
    expect(loader).toHaveBeenCalledTimes(1);
    // Not swapped yet: the starting locale is named but has no strings.
    expect(i18n.locale).toBe('ru');
    expect(i18n.t('menu.start')).toBe('menu.start');
    const again = i18n.setLocale('ru');
    expect(loader).toHaveBeenCalledTimes(1);
    resolveRu(ru);
    await i18n.ready;
    await again;
    expect(i18n.t('menu.start')).toBe('Начать');
    await i18n.setLocale('en');
    await i18n.setLocale('ru');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a lazy table shaped like a module is unwrapped', async () => {
    const i18n = createI18n({
      locale: 'en',
      tables: { en, ru: async () => ({ default: ru }) },
    });
    await i18n.setLocale('ru');
    expect(i18n.t('menu.start')).toBe('Начать');
  });

  it('a failed load rejects, keeps the old locale and can be retried', async () => {
    let fail = true;
    const loader = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return ru;
    });
    const i18n = createI18n({ locale: 'en', tables: { en, ru: loader } });
    await expect(i18n.setLocale('ru')).rejects.toThrow('offline');
    expect(i18n.locale).toBe('en');
    fail = false;
    await i18n.setLocale('ru');
    expect(i18n.locale).toBe('ru');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('the latest setLocale wins when loads overlap', async () => {
    let resolveRu: (t: Table) => void = () => {};
    const i18n = createI18n({
      locale: 'en',
      tables: { en, ru: () => new Promise<Table>((r) => (resolveRu = r)), ar },
    });
    const first = i18n.setLocale('ru');
    await i18n.setLocale('ar');
    expect(i18n.locale).toBe('ar');
    resolveRu(ru);
    await first;
    expect(i18n.locale).toBe('ar');
  });

  it('subscribe fires after every swap, with the store; unsubscribe stops it', async () => {
    const i18n = createI18n({ locale: 'en', tables: { en, ru, ar } });
    const seen: string[] = [];
    const off = i18n.subscribe((s) => seen.push(`${s.locale}:${s.direction}:${s.t('menu.start')}`));
    await i18n.setLocale('ru');
    await i18n.setLocale('ar');
    off();
    await i18n.setLocale('en');
    expect(seen).toEqual(['ru:ltr:Начать', 'ar:rtl:menu.start']);
    expect(i18n.direction).toBe('ltr');
  });

  it('a malformed string fails at load, naming key and column', () => {
    expect(() => createI18n({ locale: 'en', tables: { en: { menu: { start: 'Hi {' } } } })).toThrow(
      MessageSyntaxError,
    );
    expect(() => compileTable({ a: { b: 'x }' } }, 'en')).toThrow(/"a\.b" column 3/);
    expect(() => compileTable({ a: 1 as unknown as string }, 'en')).toThrow(/not a string/);
  });

  it('formatNumber, formatDate, formatList follow the locale', async () => {
    const i18n = createI18n({ locale: 'en', tables: { en, ru } });
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
    expect(i18n.formatNumber(0.5, { style: 'percent' })).toBe('50%');
    expect(i18n.formatList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(i18n.formatList(['a', 'b'], { type: 'disjunction' })).toBe('a or b');
    const d = new Date(2026, 4, 6, 9, 5);
    expect(i18n.formatDate(d, { dateStyle: 'long' })).toBe('May 6, 2026');
    expect(i18n.formatDate(d.getTime(), { month: 'short' })).toBe('May');
    await i18n.setLocale('ru');
    // Russian groups with a narrow no-break space.
    expect(i18n.formatNumber(1234.5).replace(/\s/g, ' ')).toBe('1 234,5');
    expect(i18n.formatList(['a', 'b', 'c'])).toBe('a, b и c');
    expect(i18n.formatDate(d, { dateStyle: 'long' })).toBe('6 мая 2026 г.');
  });

  it('formatDuration: digital by default, words otherwise', async () => {
    const i18n = createI18n({ locale: 'en', tables: { en, ar } });
    expect(i18n.formatDuration(0)).toBe('0:00');
    expect(i18n.formatDuration(59_999)).toBe('0:59');
    expect(i18n.formatDuration(61_000)).toBe('1:01');
    expect(i18n.formatDuration(3_600_000 + 5_000)).toBe('1:00:05');
    expect(i18n.formatDuration(36_000_000 + 60_000)).toBe('10:01:00');
    expect(i18n.formatDuration(5_000, { hours: 'always' })).toBe('0:00:05');
    expect(i18n.formatDuration(-5)).toBe('0:00');
    expect(i18n.formatDuration(3_725_000, { style: 'long' })).toMatch(
      /1 hour.*2 minutes.*5 seconds/,
    );
    expect(i18n.formatDuration(90_000, { style: 'short' })).toMatch(/1 min.*30 sec/);
    expect(i18n.formatDuration(90_000, { style: 'narrow' })).toMatch(/1m.*30s/);
    expect(i18n.formatDuration(0, { style: 'long' })).toMatch(/0 seconds/);
    await i18n.setLocale('ar');
    const d = new Intl.NumberFormat('ar', { minimumIntegerDigits: 2 });
    expect(i18n.formatDuration(61_000)).toBe(
      `${new Intl.NumberFormat('ar').format(1)}:${d.format(1)}`,
    );
  });
});
