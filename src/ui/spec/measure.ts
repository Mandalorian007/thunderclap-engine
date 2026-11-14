/**
 * Counting a text's lines at a width (ws/ui-spec, from Forge Wilds' `ui/spec/measure.ts`): what a
 * game binds a text's `lines` to, and what the layout counts a `wrap` text with. It breaks at
 * spaces (a word too long for a line is cut anywhere) and each `\n`, so it never counts fewer
 * lines than the page draws with `overflow-wrap: anywhere`. It measures with an
 * `OffscreenCanvas`'s `measureText` where there is one and estimates each character's width
 * elsewhere (Node, tests). Deterministic for a given device.
 */

/** The default sans-serif stack (the theme's `fontSans`). */
export const SPEC_SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** The default serif stack (the theme's `fontSerif`). */
export const SPEC_SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
/** The default monospace stack (the theme's `fontMono`). */
export const SPEC_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Each family's default stack, by its `SPEC_TYPE` name. */
export const SPEC_FAMILY: Readonly<Record<'sans' | 'serif' | 'mono', string>> = {
  sans: SPEC_SANS,
  serif: SPEC_SERIF,
  mono: SPEC_MONO,
};

/** A width measurer: a string's width in px at `px`, `weight`, in `family`, italic or upright. */
export type SpecMeasurer = (
  s: string,
  px: number,
  weight: number,
  family: string,
  italic?: boolean,
) => number;

/** The share of a line counted as room (the canvas and the page round differently). */
const ROOM = 0.96;

let measurer: SpecMeasurer | null = null;

/** Whether code point `c` is a wide character (CJK, emoji): a whole em. */
function wide(c: number): boolean {
  return (
    c >= 0x1100 &&
    (c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      c >= 0x1f000)
  );
}

function isMono(family: string): boolean {
  return /mono/i.test(family);
}

function isSerif(family: string): boolean {
  return !/sans|mono/i.test(family) && /serif|georgia|times|palatino/i.test(family);
}

/** A width from each character's estimate (no canvas). */
function estimate(s: string, px: number, weight: number, family: string): number {
  if (isMono(family)) {
    let n = 0;
    for (const ch of s) n += wide(ch.codePointAt(0)!) ? 1.2 : 0.6;
    return n * px;
  }
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 32) w += 0.28;
    else if (wide(c)) w += 1;
    else if (c === 0x40 || c === 0x4d || c === 0x57 || c === 0x6d || c === 0x77) w += 0.86;
    else if (c >= 0x41 && c <= 0x5a) w += 0.66;
    else if (
      c === 0x69 ||
      c === 0x6c ||
      c === 0x2e ||
      c === 0x2c ||
      c === 0x27 ||
      c === 0x3a ||
      c === 0x3b ||
      c === 0x7c ||
      c === 0x21
    )
      w += 0.28;
    else w += 0.56;
  }
  return w * px * (weight >= 600 ? 1.06 : 1) * (isSerif(family) ? 1.08 : 1);
}

function current(): SpecMeasurer {
  if (measurer) return measurer;
  measurer = estimate;
  if (typeof OffscreenCanvas === 'function') {
    try {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      if (ctx) {
        let font = '';
        measurer = (s, px, weight, family, italic) => {
          const f = `${italic ? 'italic ' : ''}${weight} ${px}px ${family}`;
          if (f !== font) {
            ctx.font = f;
            font = f;
          }
          return ctx.measureText(s).width;
        };
      }
    } catch {
      measurer = estimate;
    }
  }
  return measurer;
}

/** Measure with `m` (tests: a fixed width a character); null: the device's own again. */
export function measureWith(m: SpecMeasurer | null): void {
  measurer = m;
}

/** `s`'s width, px, at `px` and `weight`, in `family`. */
export function textWidth(s: string, px: number, weight = 400, family = SPEC_SANS): number {
  return current()(s, px, weight, family);
}

/** How a text is wrapped. */
export interface WrapOptions {
  /** Its type's weight (400). */
  weight?: number;
  /** Its type's family, a CSS stack (`SPEC_SANS`). */
  family?: string;
  italic?: boolean;
  /** Its letter-spacing, px (0). */
  track?: number;
  /** Room the first line gives to something before the text, px. */
  indent?: number;
  /** At most this many lines (the last then holds the rest, cut by the page with "…"). */
  most?: number;
}

/**
 * `text` cut into the lines the page draws it in at `width` px (type `px` high): at spaces, a
 * word too long cut anywhere, each `\n` a new line. An empty text is one empty line.
 */
export function wrapText(
  text: string,
  width: number,
  px: number,
  opts: WrapOptions = {},
): string[] {
  const m = current();
  const weight = opts.weight ?? 400;
  const family = opts.family ?? SPEC_SANS;
  const italic = opts.italic === true;
  const track = opts.track ?? 0;
  const mw = (s: string): number => m(s, px, weight, family, italic) + track * s.length;
  const room = Math.max(px, width * ROOM - 1);
  const most = opts.most ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  let first = Math.max(px, room - (opts.indent ?? 0));
  const space = mw(' ');
  for (const para of text.split('\n')) {
    let line = '';
    let used = 0;
    const words = para.split(' ');
    for (let wi = 0; wi < words.length; wi++) {
      let word = words[wi]!;
      const lineRoom = out.length === 0 ? first : room;
      let ww = mw(word);
      const need = line === '' ? ww : used + space + ww;
      if (need <= lineRoom) {
        line = line === '' ? word : `${line} ${word}`;
        used = need;
        continue;
      }
      if (line !== '') {
        out.push(line);
        if (out.length >= most) return finish(out, words.slice(wi).join(' '));
        line = '';
        used = 0;
      }
      while (ww > (out.length === 0 ? first : room)) {
        const r = out.length === 0 ? first : room;
        const chars = Array.from(word);
        let n = 1;
        let w = mw(chars[0]!);
        while (n < chars.length) {
          const next = w + mw(chars[n]!);
          if (next > r) break;
          w = next;
          n++;
        }
        out.push(chars.slice(0, n).join(''));
        word = chars.slice(n).join('');
        ww = mw(word);
        if (out.length >= most) return finish(out, [word, ...words.slice(wi + 1)].join(' '));
      }
      line = word;
      used = ww;
    }
    out.push(line);
    first = room;
    if (out.length >= most) break;
  }
  return out.slice(0, Math.min(out.length, most));
}

function finish(out: string[], rest: string): string[] {
  if (rest !== '') out[out.length - 1] = `${out[out.length - 1]} ${rest}`.trim();
  return out;
}

/** How many lines `text` takes at `width` px (type `px` high): at least 1, at most `most`. */
export function wrapCount(text: string, width: number, px: number, opts: WrapOptions = {}): number {
  if (text === '') return 1;
  return Math.max(1, wrapText(text, width, px, opts).length);
}
