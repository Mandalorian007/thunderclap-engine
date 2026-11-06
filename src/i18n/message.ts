/**
 * ICU-style message syntax: a parser that runs once per string when a table loads, and a
 * formatter that walks the resulting AST and builds only the output string.
 *
 * Supported forms:
 * - `{name}`: an argument. Numbers go through `Intl.NumberFormat`, dates through
 *   `Intl.DateTimeFormat`, everything else through `String`.
 * - `{n, number}`, `{n, number, integer | percent}`; `{d, date}`, `{d, date, short | medium |
 *   long | full}`; `{d, time}`, `{d, time, short | medium | long | full}`.
 * - `{count, plural, offset:1 =0 {none} one {# item} other {# items}}`: `Intl.PluralRules`
 *   cardinal categories (`zero one two few many other`), exact `=N` forms checked first, `#` the
 *   number minus the offset, formatted for the locale. `selectordinal` uses ordinal rules.
 * - `{g, select, male {he} female {she} other {they}}`.
 * - `'{'` quotes a special character (`{ } #`), `''` is one apostrophe; any other apostrophe is
 *   literal.
 *
 * Every error names the key and the 1-based column where parsing stopped.
 */

export type MessageArgValue = string | number | boolean | Date | null | undefined;
export type MessageArgs = Readonly<Record<string, MessageArgValue>>;

export interface ArgNode {
  kind: 'arg';
  name: string;
}
export interface FormatNode {
  kind: 'number' | 'date' | 'time';
  name: string;
  style: string | null;
}
export interface HashNode {
  kind: 'hash';
}
export interface PluralNode {
  kind: 'plural';
  name: string;
  ordinal: boolean;
  offset: number;
  /** `=N` forms, keyed by the exact value. */
  exact: ReadonlyMap<number, MessageAst>;
  /** `zero one two few many`, when present. */
  categories: ReadonlyMap<string, MessageAst>;
  other: MessageAst;
}
export interface SelectNode {
  kind: 'select';
  name: string;
  cases: ReadonlyMap<string, MessageAst>;
  other: MessageAst;
}
/** Literal text is a plain string. */
export type MessageNode = string | ArgNode | FormatNode | HashNode | PluralNode | SelectNode;
export type MessageAst = readonly MessageNode[];

export class MessageSyntaxError extends Error {
  readonly key: string;
  /** 1-based column in the message where parsing stopped. */
  readonly column: number;
  constructor(key: string, column: number, detail: string) {
    super(`i18n: "${key}" column ${column}: ${detail}`);
    this.name = 'MessageSyntaxError';
    this.key = key;
    this.column = column;
  }
}

const SPECIAL = new Set(['{', '}', '#']);
const IDENT = /[A-Za-z0-9_]/;
const WS = /\s/;

class Parser {
  pos = 0;
  constructor(
    readonly src: string,
    readonly key: string,
  ) {}

  fail(detail: string, at = this.pos): never {
    throw new MessageSyntaxError(this.key, Math.min(at, this.src.length) + 1, detail);
  }

  skipWs(): void {
    while (this.pos < this.src.length && WS.test(this.src[this.pos])) this.pos++;
  }

  ident(what: string): string {
    const start = this.pos;
    while (this.pos < this.src.length && IDENT.test(this.src[this.pos])) this.pos++;
    if (this.pos === start) this.fail(`expected ${what}`);
    return this.src.slice(start, this.pos);
  }

  expect(ch: string): void {
    if (this.src[this.pos] !== ch) {
      this.fail(
        this.pos >= this.src.length ? `unexpected end, expected '${ch}'` : `expected '${ch}'`,
      );
    }
    this.pos++;
  }

  /** Parses up to `}` (nested) or the end (top level). */
  sequence(nested: boolean, inPlural: boolean): MessageAst {
    const out: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === "'") {
        const next = s[this.pos + 1];
        if (next === "'") {
          text += "'";
          this.pos += 2;
        } else if (next !== undefined && SPECIAL.has(next)) {
          // Quoted literal to the next lone apostrophe (or the end, as ICU does).
          this.pos++;
          while (this.pos < s.length) {
            if (s[this.pos] === "'") {
              if (s[this.pos + 1] === "'") {
                text += "'";
                this.pos += 2;
                continue;
              }
              this.pos++;
              break;
            }
            text += s[this.pos++];
          }
        } else {
          text += c;
          this.pos++;
        }
      } else if (c === '{') {
        flush();
        out.push(this.argument(inPlural));
      } else if (c === '}') {
        if (!nested) this.fail("unmatched '}'");
        flush();
        return out;
      } else if (c === '#' && inPlural) {
        flush();
        out.push({ kind: 'hash' });
        this.pos++;
      } else {
        text += c;
        this.pos++;
      }
    }
    if (nested) this.fail("unexpected end, expected '}'");
    flush();
    return out;
  }

  argument(inPlural: boolean): MessageNode {
    this.expect('{');
    this.skipWs();
    const name = this.ident('an argument name');
    this.skipWs();
    if (this.src[this.pos] === '}') {
      this.pos++;
      return { kind: 'arg', name };
    }
    if (this.src[this.pos] !== ',') {
      this.fail(
        this.pos >= this.src.length ? "unexpected end, expected '}' or ','" : "expected '}' or ','",
      );
    }
    this.pos++;
    this.skipWs();
    const typeAt = this.pos;
    const type = this.ident('an argument type');
    this.skipWs();
    switch (type) {
      case 'number':
      case 'date':
      case 'time': {
        let style: string | null = null;
        if (this.src[this.pos] === ',') {
          this.pos++;
          this.skipWs();
          style = this.ident('a style');
          this.skipWs();
        }
        this.expect('}');
        return { kind: type, name, style };
      }
      case 'plural':
      case 'selectordinal':
        this.expect(',');
        return this.plural(name, type === 'selectordinal');
      case 'select':
        this.expect(',');
        return this.select(name, inPlural);
      default:
        this.fail(`unknown argument type '${type}'`, typeAt);
    }
  }

  plural(name: string, ordinal: boolean): PluralNode {
    const exact = new Map<number, MessageAst>();
    const categories = new Map<string, MessageAst>();
    let other: MessageAst | null = null;
    let offset = 0;
    this.skipWs();
    if (this.src.startsWith('offset:', this.pos)) {
      this.pos += 'offset:'.length;
      this.skipWs();
      const at = this.pos;
      const digits = this.ident('an offset');
      offset = Number(digits);
      if (!Number.isInteger(offset)) this.fail(`bad offset '${digits}'`, at);
      this.skipWs();
    }
    for (;;) {
      this.skipWs();
      if (this.src[this.pos] === '}') break;
      if (this.pos >= this.src.length) this.fail("unexpected end, expected '}'");
      const at = this.pos;
      if (this.src[this.pos] === '=') {
        this.pos++;
        const digits = this.ident('a number after =');
        const n = Number(digits);
        if (!Number.isFinite(n)) this.fail(`bad exact form '=${digits}'`, at);
        exact.set(n, this.caseBody(true));
        continue;
      }
      const selector = this.ident('a plural category');
      if (selector === 'other') other = this.caseBody(true);
      else if (CATEGORIES.has(selector)) categories.set(selector, this.caseBody(true));
      else this.fail(`unknown plural category '${selector}'`, at);
    }
    if (!other) this.fail("plural needs an 'other' case");
    this.pos++;
    return { kind: 'plural', name, ordinal, offset, exact, categories, other };
  }

  select(name: string, inPlural: boolean): SelectNode {
    const cases = new Map<string, MessageAst>();
    let other: MessageAst | null = null;
    for (;;) {
      this.skipWs();
      if (this.src[this.pos] === '}') break;
      if (this.pos >= this.src.length) this.fail("unexpected end, expected '}'");
      const selector = this.ident('a select case');
      const body = this.caseBody(inPlural);
      if (selector === 'other') other = body;
      else cases.set(selector, body);
    }
    if (!other) this.fail("select needs an 'other' case");
    this.pos++;
    return { kind: 'select', name, cases, other };
  }

  caseBody(inPlural: boolean): MessageAst {
    this.skipWs();
    this.expect('{');
    const body = this.sequence(true, inPlural);
    this.expect('}');
    return body;
  }
}

const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many']);

/** Parses one message. Throws `MessageSyntaxError` naming `key` and the column. */
export function parseMessage(source: string, key = 'message'): MessageAst {
  return new Parser(source, key).sequence(false, false);
}

/** Per-locale `Intl` objects, built once and reused by every format call. */
export interface IntlCache {
  plural(locale: string, ordinal: boolean): Intl.PluralRules;
  number(locale: string, style: string | null): Intl.NumberFormat;
  date(locale: string, kind: 'date' | 'time', style: string | null): Intl.DateTimeFormat;
}

const DATE_STYLES = new Set(['short', 'medium', 'long', 'full']);

export function createIntlCache(): IntlCache {
  const plurals = new Map<string, Intl.PluralRules>();
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  return {
    plural(locale, ordinal) {
      const k = `${locale}|${ordinal ? 'o' : 'c'}`;
      let r = plurals.get(k);
      if (!r) {
        r = new Intl.PluralRules(locale, { type: ordinal ? 'ordinal' : 'cardinal' });
        plurals.set(k, r);
      }
      return r;
    },
    number(locale, style) {
      const k = `${locale}|${style ?? ''}`;
      let f = numbers.get(k);
      if (!f) {
        const opts: Intl.NumberFormatOptions =
          style === 'integer'
            ? { maximumFractionDigits: 0 }
            : style === 'percent'
              ? { style: 'percent' }
              : {};
        f = new Intl.NumberFormat(locale, opts);
        numbers.set(k, f);
      }
      return f;
    },
    date(locale, kind, style) {
      const k = `${locale}|${kind}|${style ?? ''}`;
      let f = dates.get(k);
      if (!f) {
        const s =
          style && DATE_STYLES.has(style)
            ? (style as Intl.DateTimeFormatOptions['dateStyle'])
            : undefined;
        const opts: Intl.DateTimeFormatOptions =
          kind === 'date' ? { dateStyle: s ?? 'medium' } : { timeStyle: s ?? 'short' };
        f = new Intl.DateTimeFormat(locale, opts);
        dates.set(k, f);
      }
      return f;
    },
  };
}

/**
 * Formats a parsed message for `locale`. A missing argument renders as `{name}` so the UI never
 * shows an empty string. Allocates only the output string.
 */
export function formatMessage(
  ast: MessageAst,
  args: MessageArgs | undefined,
  locale: string,
  intl: IntlCache,
): string {
  return walk(ast, args, locale, intl, null);
}

/** The value `#` prints: the plural number minus its offset, or a non-number argument as text. */
type Hash = number | string | null;

function walk(
  ast: MessageAst,
  args: MessageArgs | undefined,
  locale: string,
  intl: IntlCache,
  hash: Hash,
): string {
  let out = '';
  for (let i = 0; i < ast.length; i++) {
    const node = ast[i];
    if (typeof node === 'string') {
      out += node;
      continue;
    }
    switch (node.kind) {
      case 'hash':
        if (hash === null) out += '#';
        else if (typeof hash === 'number') out += intl.number(locale, null).format(hash);
        else out += hash;
        break;
      case 'arg': {
        const v = args?.[node.name];
        if (v === undefined) out += `{${node.name}}`;
        else if (typeof v === 'number') out += intl.number(locale, null).format(v);
        else if (v instanceof Date) out += intl.date(locale, 'date', null).format(v);
        else out += String(v);
        break;
      }
      case 'number': {
        const v = args?.[node.name];
        if (typeof v === 'number') out += intl.number(locale, node.style).format(v);
        else out += v === undefined ? `{${node.name}}` : String(v);
        break;
      }
      case 'date':
      case 'time': {
        const v = args?.[node.name];
        if (v instanceof Date || typeof v === 'number')
          out += intl.date(locale, node.kind, node.style).format(v);
        else out += v === undefined ? `{${node.name}}` : String(v);
        break;
      }
      case 'plural': {
        const v = args?.[node.name];
        if (typeof v !== 'number') {
          // Not a number: `other`, with `#` printing the argument (or its placeholder) as text.
          const text = v === undefined ? `{${node.name}}` : String(v);
          out += walk(node.other, args, locale, intl, text);
          break;
        }
        const inner = v - node.offset;
        const exact = node.exact.get(v);
        const branch =
          exact ??
          node.categories.get(intl.plural(locale, node.ordinal).select(inner)) ??
          node.other;
        out += walk(branch, args, locale, intl, inner);
        break;
      }
      case 'select': {
        const v = args?.[node.name];
        const branch = (v === undefined ? undefined : node.cases.get(String(v))) ?? node.other;
        out += walk(branch, args, locale, intl, hash);
        break;
      }
    }
  }
  return out;
}
