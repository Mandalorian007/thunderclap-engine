/**
 * Localisation harness page: `@thunderclap-engine/engine/i18n` with no WebGPU, so e2e/i18n.spec.ts can
 * verify it on every matrix row. Noun-free.
 *
 * - Three tables: `en` and `ru` inline, `ar` loaded on demand (a loader that resolves next tick).
 * - A locale switcher, a plural counter (`t('items', { count })`), and an RTL sample whose `dir`
 *   follows `i18n.direction`.
 * - Every re-render runs from `subscribe`, the way a game's menu would.
 */
import { createI18n, negotiateLocale, type Table } from '@thunderclap-engine/engine/i18n';
import type { HarnessI18nApi, HarnessI18nState } from './i18n-state';

const root = document.getElementById('root') as HTMLElement;

const en: Table = {
  title: 'Localisation',
  items: '{count, plural, =0 {No items} one {# item} other {# items}}',
  sample: 'The quick brown fox jumps over the lazy dog.',
  more: 'More',
  fewer: 'Fewer',
};
const ru: Table = {
  title: 'Локализация',
  items:
    '{count, plural, =0 {Нет предметов} one {# предмет} few {# предмета} many {# предметов} other {# предмета}}',
  sample: 'Съешь же ещё этих мягких французских булок.',
  more: 'Больше',
  fewer: 'Меньше',
};
const ar: Table = {
  title: 'الترجمة',
  items:
    '{count, plural, =0 {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}',
  sample: 'نص حكيم له سر قاطع وذو شأن عظيم.',
  // `more` and `fewer` fall back to English on purpose.
};

const i18n = createI18n({
  locale: 'en',
  fallback: 'en',
  tables: {
    en,
    ru,
    ar: () => new Promise<Table>((resolve) => setTimeout(() => resolve(ar), 0)),
  },
});

const state: HarnessI18nState = {
  ready: false,
  locale: i18n.locale,
  direction: i18n.direction,
  sample: '',
  count: 1,
  negotiated: negotiateLocale(i18n.locales),
  renders: 0,
};

const el = (tag: string, id: string, text = ''): HTMLElement => {
  const e = document.createElement(tag);
  e.id = id;
  e.textContent = text;
  return e;
};
const title = el('h1', 'title');
const switcher = el('div', 'switcher');
switcher.className = 'row';
for (const loc of i18n.locales) {
  const b = el('button', `loc-${loc}`, loc);
  b.addEventListener('click', () => void api.setLocale(loc));
  switcher.append(b);
}
const sample = el('p', 'sample');
const counter = el('div', 'counter');
counter.className = 'row';
const fewer = el('button', 'count-dec');
const more = el('button', 'count-inc');
fewer.addEventListener('click', () => api.setCount(state.count - 1));
more.addEventListener('click', () => api.setCount(state.count + 1));
counter.append(fewer, more);
const rtl = el('p', 'rtl');
root.append(title, switcher, sample, counter, rtl);

function render(): void {
  title.textContent = i18n.t('title');
  sample.textContent = i18n.t('items', { count: state.count });
  fewer.textContent = i18n.t('fewer');
  more.textContent = i18n.t('more');
  rtl.textContent = i18n.t('sample');
  rtl.dir = i18n.direction;
  root.dir = i18n.direction;
  document.documentElement.lang = i18n.locale;
  state.locale = i18n.locale;
  state.direction = i18n.direction;
  state.sample = sample.textContent;
  state.renders++;
}

const api: HarnessI18nApi = {
  state,
  async setLocale(locale) {
    await i18n.setLocale(locale);
  },
  setCount(n) {
    state.count = Math.max(0, n);
    render();
  },
};
window.__harnessI18n = api;

i18n.subscribe(render);
void i18n.ready.then(() => {
  render();
  state.ready = true;
});
