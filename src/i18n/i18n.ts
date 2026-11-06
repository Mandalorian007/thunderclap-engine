/**
 * The string store: one table per locale (inline or loaded on demand), parsed once into an AST
 * per key, looked up along a fallback chain, swapped at runtime with a subscription so the UI
 * re-renders. Numbers, dates, durations and lists go through `Intl` for the current locale.
 */
import {
  createIntlCache,
  formatMessage,
  type MessageArgs,
  type MessageAst,
  parseMessage,
} from './message';
import { directionOf, languageOf, type TextDirection } from './negotiate';

/** Nested string table: `{ menu: { start: 'Start' } }` is the key `menu.start`. */
export type Table = { readonly [key: string]: string | Table };
/** A table, or a loader for one (`() => import('./ru.json')` works: a lone `default` is unwrapped). */
export type TableSource = Table | (() => Promise<Table | { default: Table }>);
/** What `t` returns for a key no table in the chain has. Default `'key'`: the key itself. */
export type MissingPolicy = 'key' | 'throw' | ((key: string, locale: string) => string);

export interface I18nDesc {
  /** The starting locale: a key of `tables`, or a tag whose language one of them shares. */
  locale: string;
  /** Looked up after the locale and its language, in order. */
  fallback?: string | readonly string[];
  tables: Record<string, TableSource>;
  missing?: MissingPolicy;
  /** Called once per missing key and locale, whatever `missing` does. */
  onMissing?: (key: string, locale: string) => void;
}

export interface DurationOptions {
  /** `digital` (default): `m:ss` or `h:mm:ss` in the locale's digits. Others: words per unit. */
  style?: 'digital' | 'long' | 'short' | 'narrow';
  /** Show the hours field even when it is zero (digital style). */
  hours?: 'auto' | 'always';
}

export interface I18n {
  /** The active locale, as named in `tables`. */
  readonly locale: string;
  /** Every locale that has a table, in table order. */
  readonly locales: readonly string[];
  readonly direction: TextDirection;
  /** Resolves when the starting locale and its fallback chain are loaded. */
  readonly ready: Promise<void>;
  /** The message for `key` formatted with `args`, from the first table in the chain that has it. */
  t(key: string, args?: MessageArgs): string;
  /** Whether any table in the chain has `key`. */
  has(key: string): boolean;
  /** Loads `locale` and its chain if needed, then swaps and notifies. Rejects for an unknown locale. */
  setLocale(locale: string): Promise<void>;
  /** Called after every locale swap. Returns unsubscribe. */
  subscribe(fn: (i18n: I18n) => void): () => void;
  formatNumber(value: number, opts?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number, opts?: Intl.DateTimeFormatOptions): string;
  formatDuration(ms: number, opts?: DurationOptions): string;
  formatList(items: readonly string[], opts?: Intl.ListFormatOptions): string;
}

type Compiled = ReadonlyMap<string, MessageAst | string>;
interface Layer {
  locale: string;
  table: Compiled;
}

/** Flattens a table to dotted keys and parses every string. Throws `MessageSyntaxError`. */
export function compileTable(table: Table, locale: string): Compiled {
  const out = new Map<string, MessageAst | string>();
  const visit = (node: Table, prefix: string) => {
    for (const k of Object.keys(node)) {
      const v = node[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        const ast = parseMessage(v, key);
        out.set(key, ast.length === 1 && typeof ast[0] === 'string' ? ast[0] : ast);
      } else if (v && typeof v === 'object') {
        visit(v, key);
      } else {
        throw new TypeError(`i18n: table "${locale}" key "${key}" is not a string or object`);
      }
    }
  };
  visit(table, '');
  return out;
}

function unwrap(loaded: Table | { default: Table }): Table {
  const keys = Object.keys(loaded);
  if (keys.length === 1 && keys[0] === 'default' && typeof loaded.default === 'object') {
    return loaded.default as Table;
  }
  return loaded as Table;
}

interface DurationFormatLike {
  format(d: { hours?: number; minutes?: number; seconds?: number }): string;
}
type DurationFormatCtor = new (locale: string, opts: { style: string }) => DurationFormatLike;

export function createI18n(desc: I18nDesc): I18n {
  const sources = desc.tables;
  const locales: readonly string[] = Object.keys(sources);
  if (locales.length === 0) throw new Error('i18n: tables is empty');
  const fallbacks =
    desc.fallback === undefined
      ? []
      : typeof desc.fallback === 'string'
        ? [desc.fallback]
        : desc.fallback;
  const missing = desc.missing ?? 'key';
  const intl = createIntlCache();
  const compiled = new Map<string, Compiled>();
  const pending = new Map<string, Promise<void>>();
  const subscribers = new Set<(i18n: I18n) => void>();
  const reported = new Set<string>();
  const formats = new Map<string, unknown>();

  let locale = desc.locale;
  let ready: Promise<void> = Promise.resolve();
  let direction = directionOf(locale);
  let chain: Layer[] = [];
  let generation = 0;

  /** The table key for `tag`: exact, else one sharing its language. Null when none. */
  const resolve = (tag: string): string | null => {
    if (tag in sources) return tag;
    const lower = tag.toLowerCase();
    const exact = locales.find((l) => l.toLowerCase() === lower);
    if (exact) return exact;
    const lang = languageOf(tag);
    return locales.find((l) => languageOf(l) === lang) ?? null;
  };

  /** Table keys to consult for `key`, most specific first, each once. */
  const chainFor = (resolved: string): string[] => {
    const out: string[] = [];
    const push = (tag: string) => {
      const r = resolve(tag);
      if (r && !out.includes(r)) out.push(r);
    };
    push(resolved);
    push(languageOf(resolved));
    for (const f of fallbacks) {
      push(f);
      push(languageOf(f));
    }
    return out;
  };

  const load = (key: string): Promise<void> | null => {
    if (compiled.has(key)) return null;
    const source = sources[key];
    if (typeof source !== 'function') {
      compiled.set(key, compileTable(source, key));
      return null;
    }
    let p = pending.get(key);
    if (!p) {
      p = source().then(
        (loaded) => {
          compiled.set(key, compileTable(unwrap(loaded), key));
          pending.delete(key);
        },
        (err) => {
          pending.delete(key);
          throw err;
        },
      );
      pending.set(key, p);
    }
    return p;
  };

  const apply = (resolved: string, keys: string[]) => {
    locale = resolved;
    direction = directionOf(resolved);
    chain = keys.map((k) => ({ locale: k, table: compiled.get(k) as Compiled }));
    for (const fn of subscribers) fn(api);
  };

  const find = (key: string): Layer | null => {
    for (let i = 0; i < chain.length; i++) if (chain[i].table.has(key)) return chain[i];
    return null;
  };

  const cached = <T>(kind: string, opts: object | undefined, make: () => T): T => {
    const k = `${kind}|${locale}|${opts ? JSON.stringify(opts) : ''}`;
    let f = formats.get(k) as T | undefined;
    if (!f) {
      f = make();
      formats.set(k, f);
    }
    return f;
  };

  const setLocale = (tag: string): Promise<void> => {
    const resolved = resolve(tag);
    if (!resolved) return Promise.reject(new Error(`i18n: no table for locale "${tag}"`));
    const keys = chainFor(resolved);
    const gen = ++generation;
    const loads: Promise<void>[] = [];
    for (const k of keys) {
      const p = load(k);
      if (p) loads.push(p);
    }
    if (loads.length === 0) {
      apply(resolved, keys);
      return Promise.resolve();
    }
    return Promise.all(loads).then(() => {
      // A later setLocale won; leave its result in place.
      if (gen !== generation) return;
      apply(resolved, keys);
    });
  };

  const api: I18n = {
    get locale() {
      return locale;
    },
    locales,
    get direction() {
      return direction;
    },
    get ready() {
      return ready;
    },
    t(key, args) {
      const layer = find(key);
      if (!layer) {
        const tag = `${locale}\u0000${key}`;
        if (desc.onMissing && !reported.has(tag)) {
          reported.add(tag);
          desc.onMissing(key, locale);
        }
        if (missing === 'key') return key;
        if (missing === 'throw') throw new Error(`i18n: missing "${key}" in "${locale}"`);
        return missing(key, locale);
      }
      const entry = layer.table.get(key) as MessageAst | string;
      return typeof entry === 'string' ? entry : formatMessage(entry, args, layer.locale, intl);
    },
    has(key) {
      return find(key) !== null;
    },
    setLocale,
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    formatNumber(value, opts) {
      return cached('n', opts, () => new Intl.NumberFormat(locale, opts)).format(value);
    },
    formatDate(value, opts) {
      return cached('d', opts, () => new Intl.DateTimeFormat(locale, opts)).format(value);
    },
    formatDuration(ms, opts) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const style = opts?.style ?? 'digital';
      if (style === 'digital') {
        const two = cached(
          'n',
          { minimumIntegerDigits: 2, useGrouping: false },
          () => new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }),
        );
        const one = cached(
          'n',
          { useGrouping: false },
          () => new Intl.NumberFormat(locale, { useGrouping: false }),
        );
        if (hours > 0 || opts?.hours === 'always') {
          return `${one.format(hours)}:${two.format(minutes)}:${two.format(seconds)}`;
        }
        return `${one.format(minutes)}:${two.format(seconds)}`;
      }
      const DF = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat;
      const parts: { hours?: number; minutes?: number; seconds?: number } = {};
      if (hours > 0) parts.hours = hours;
      if (minutes > 0) parts.minutes = minutes;
      if (seconds > 0 || total === 0) parts.seconds = seconds;
      // `Intl.DurationFormat` prints nothing for an all-zero duration; the unit path says "0 seconds".
      if (DF && total > 0) {
        return cached('dur', { style }, () => new DF(locale, { style })).format(parts);
      }
      // Older engines: one unit per field, joined as a list.
      const items: string[] = [];
      const unitDisplay = style === 'long' ? 'long' : style;
      for (const unit of ['hour', 'minute', 'second'] as const) {
        const v = parts[`${unit}s`];
        if (v === undefined) continue;
        items.push(
          cached(
            'n',
            { style: 'unit', unit, unitDisplay },
            () => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay }),
          ).format(v),
        );
      }
      return api.formatList(items, { style: style === 'long' ? 'long' : 'narrow', type: 'unit' });
    },
    formatList(items, opts) {
      if (typeof Intl.ListFormat !== 'function') return items.join(', ');
      return cached('l', opts, () => new Intl.ListFormat(locale, opts)).format(items);
    },
  };

  ready = setLocale(desc.locale);
  return api;
}
