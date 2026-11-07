# engine/i18n

Strings in several languages without a dependency: one table per locale, ICU-style messages with
placeholders, plurals and select, numbers, dates, durations and lists through `Intl`, a fallback
chain, lazy table loading and a runtime locale swap the UI subscribes to. No network: a lazy
table is whatever promise the game hands over (usually `import('./ru.json')`). No game nouns.

## Quick use

<!-- snippet:check -->
```ts
import { createI18n, negotiateLocale } from '@thunderclap-engine/engine/i18n';

const i18n = createI18n({
  locale: negotiateLocale(['en', 'de']),
  fallback: 'en',
  tables: {
    en: { start: 'Start', items: '{count, plural, one {# item} other {# items}}' },
    de: { start: 'Los', items: '{count, plural, one {# Gegenstand} other {# Gegenstände}}' },
  },
});
i18n.t('items', { count: 3 }); // "3 items"
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createI18n(desc)` | tables, fallback chain and the current locale |
| `i18n.t(key, args?)` | a formatted message |
| `negotiateLocale(available)` | the best table for `navigator.languages` |
| `formatMessage / parseMessage` | ICU-style messages outside an `I18n` |
| `directionOf(locale)` | `ltr` or `rtl` |
| `compileTable(table)` | parse a table up front |

## Usage

```ts
import { createI18n, negotiateLocale } from '@thunderclap-engine/engine/i18n';

const i18n = createI18n({
  locale: negotiateLocale(['en', 'ru', 'ar']),      // navigator.languages → best table
  fallback: 'en',
  tables: {
    en: { menu: { start: 'Start' }, saved: 'Saved',
          items: '{count, plural, =0 {No items} one {# item} other {# items}}',
          who: '{g, select, female {She} male {He} other {They}} left {name}.' },
    ru: () => import('./locales/ru.json'),           // loaded on first use
    ar: () => fetch('/locales/ar.json').then((r) => r.json()),
  },
  missing: 'key',                                    // or 'throw', or (key, locale) => string
  onMissing: (key, locale) => analytics.track('i18n.missing', { key, locale }),
});
await i18n.ready;                                    // the starting chain is loaded

i18n.t('menu.start');                                // 'Start'
i18n.t('items', { count: 3 });                       // '3 items'
i18n.t('who', { g: 'female', name: 'Ada' });         // 'She left Ada.'
ui.toasts.show(i18n.t('saved'));                     // text reaches the overlay as a string
i18n.formatNumber(1234.5);                           // '1,234.5'
i18n.formatDate(Date.now(), { dateStyle: 'long' });
i18n.formatDuration(61_000);                         // '1:01'
i18n.formatList(['a', 'b', 'c']);                    // 'a, b, and c'
```

### Re-render on a locale change

```ts
function render() {
  ui.root.dir = i18n.direction;                      // 'rtl' for Arabic, Hebrew, Persian, Urdu...
  startButton.textContent = i18n.t('menu.start');
  hud.setLabel(i18n.t('items', { count: inventory.size }));
}
render();
const off = i18n.subscribe(render);                  // runs after every setLocale
await i18n.setLocale('ar');                          // loads the table if needed, then render()
```

## Messages

Parsed once per key when a table loads; formatting walks the AST and allocates only the output
string. Every syntax error names the key and the 1-based column (`MessageSyntaxError`).

| Form | Meaning |
|---|---|
| `{name}` | An argument. Numbers go through `Intl.NumberFormat`, `Date`s through `Intl.DateTimeFormat`, everything else through `String`. A missing argument prints `{name}`. |
| `{n, number}`, `{n, number, integer}`, `{n, number, percent}` | Number styles. |
| `{d, date}`, `{d, date, short\|medium\|long\|full}`, `{d, time, …}` | `dateStyle` / `timeStyle`. |
| `{count, plural, offset:1 =0 {none} one {# item} other {# items}}` | `Intl.PluralRules` cardinal categories (`zero one two few many other`), exact `=N` forms first, `#` is the number minus `offset`, formatted. `other` is required. |
| `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}` | Ordinal rules. |
| `{g, select, male {he} female {she} other {they}}` | Matches `String(arg)`; `other` is required. |
| `'{'`, `'#'`, `''` | Quote a special character; two apostrophes are one. Other apostrophes are literal. |

Plural categories and digits follow the locale of the table the string came from: an English
string reached through the fallback chain under `ru` is pluralised in English.

## Behaviour

- **Keys** are dotted paths into the nested table (`menu.start`).
- **Chain** for a locale: its table, the table of its language (`pt-BR` → `pt`), then each
  `fallback` and its language, each once. `t` returns the first hit. A `locale` or `setLocale`
  tag without a table of its own resolves to one sharing its language (`en-US` → `en`); with
  none, `createI18n` keeps the tag and `t` reports every key missing, and `setLocale` rejects.
- **Missing** keys: `'key'` (default) returns the key, `'throw'` throws, a function decides.
  `onMissing(key, locale)` fires once per key and locale either way.
- **Lazy tables** load on the first `setLocale` that needs them, one pending promise per locale
  (concurrent calls share it); a failed load rejects `setLocale`, keeps the current locale and is
  retried on the next call. When two `setLocale` calls overlap the later one wins. Inline tables
  are compiled synchronously, so `t` works before `ready` when the starting chain is inline. A
  loaded value with a lone `default` key (an ES module) is unwrapped.
- **Direction** is `'rtl'` when the language subtag is in `RTL_LANGUAGES`, else `'ltr'`. The
  store never touches the DOM; set `dir` yourself in the subscriber.
- **formatDuration** takes milliseconds: `digital` (default) is `m:ss` or `h:mm:ss` in the
  locale's digits (`hours: 'always'` keeps the hours field); `long`, `short` and `narrow` use
  `Intl.DurationFormat` where it exists and per-unit `Intl.NumberFormat` joined by `formatList`
  elsewhere. `formatList` falls back to `, ` without `Intl.ListFormat`.
- `Intl` objects are cached per locale and options; nothing is rebuilt per call.

## API

- `createI18n(desc: I18nDesc) → I18n`. `I18nDesc` is `{ locale, fallback?, tables, missing?, onMissing? }` with `tables: Record<string, TableSource>`, `TableSource = Table | () => Promise<Table | { default: Table }>`, `Table` a nested record of strings, `MissingPolicy = 'key' | 'throw' | (key, locale) => string`.
- `I18n`: `locale`, `locales`, `direction: TextDirection`, `ready: Promise<void>`, `t(key, args?: MessageArgs)`, `has(key)`, `setLocale(locale): Promise<void>`, `subscribe(fn): () => void`, `formatNumber(n, opts?)`, `formatDate(d, opts?)`, `formatDuration(ms, opts?: DurationOptions)`, `formatList(items, opts?)`. `DurationOptions` is `{ style?: 'digital' | 'long' | 'short' | 'narrow', hours?: 'auto' | 'always' }`.
- `negotiateLocale(available, requested = requestedLocales(), fallback = available[0])`: for each requested tag in order, an exact match else a language match; else `fallback`. `requestedLocales()` is `navigator.languages` (or `[navigator.language]`, or `[]`).
- `directionOf(locale)`, `languageOf(locale)`, `RTL_LANGUAGES`, `TextDirection`.
- Lower level: `parseMessage(source, key?) → MessageAst`, `formatMessage(ast, args, locale, intl)`, `createIntlCache() → IntlCache`, `compileTable(table, locale)`, `MessageSyntaxError { key, column }`. AST types: `MessageNode` (a string, `ArgNode`, `FormatNode`, `HashNode`, `PluralNode`, `SelectNode`), `MessageArgs`, `MessageArgValue`.

## Harness

`harness/i18n.html` (no WebGPU): a locale switcher over `en`, `ru` and a lazily loaded `ar`, a
plural counter and an RTL sample whose `dir` follows `direction`; `window.__harnessI18n` exposes
`locale`, `sample`, `direction`, `negotiated` and `renders`. `e2e/i18n.spec.ts` runs it on the
matrix.
