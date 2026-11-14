/**
 * The layout's units (ws/ui-spec, from Forge Wilds' `ui/spec/layout/units.ts`): the word kinds,
 * what a key does to a word it binds (its role), the aligns, a press's least size, a text's
 * measure and the tabs' shares.
 */

import { SPEC_FAMILY, type WrapOptions, wrapCount } from './measure';
import { SPEC_LINE, SPEC_TYPE, type SpecNode, type SpecTextStyle } from './words';

// Word kinds.
export const K_COL = 0;
export const K_ROW = 1;
export const K_GRID = 2;
export const K_LIST = 3;
export const K_TEXT = 4;
export const K_SLOT = 5;
export const K_METER = 6;
export const K_ICON = 7;
export const K_BUTTON = 8;
export const K_FIELD = 9;
export const K_TABS = 10;
export const K_RANGE = 11;

export const KIND: Readonly<Record<SpecNode['k'], number>> = {
  col: K_COL,
  row: K_ROW,
  grid: K_GRID,
  list: K_LIST,
  text: K_TEXT,
  slot: K_SLOT,
  meter: K_METER,
  icon: K_ICON,
  button: K_BUTTON,
  field: K_FIELD,
  tabs: K_TABS,
  range: K_RANGE,
};

// What a key does to a node it binds (the presenter's write).
export const R_TEXT = 0;
export const R_VALUE = 1;
export const R_SHOW = 2;
export const R_STATE = 3;
export const R_LABEL = 4;
export const R_ON = 5;
export const R_ENABLED = 6;
export const R_BADGE = 7;
export const R_PLACEHOLDER = 8;
export const R_ITEM = 9;
export const R_COUNT = 10;
export const R_SELECTED = 11;
export const R_TINT = 12;
/** A button's ring: ms to fill over, 0 empty, < 0 full. */
export const R_RING = 13;
/** A key label (`keyLabel`): a slot's (its corner) or a button's (after its words). */
export const R_KEY = 14;
/** A text's bound lines (a box moves: the presenter writes its line clamp). */
export const R_LINES = 15;
/** A list's bound `maxRows` (a box moves; nothing else to write). */
export const R_ROWS = 17;
/** A range's value in words (for screen readers). */
export const R_VALUETEXT = 18;
/** Its look plays again (`again`: each set restarts it). */
export const R_AGAIN = 19;
/** A meter's mark m: R_MARK + 3m (where), + 1 (its state), + 2 (its words). */
export const R_MARK = 20;

// Cross-axis alignment.
const A_START = 0;
export const A_CENTER = 1;
export const A_END = 2;
export const A_STRETCH = 3;
export const ALIGN = { start: A_START, center: A_CENTER, end: A_END, stretch: A_STRETCH } as const;

/** The smallest press target, units (WCAG-sized on a touch screen). */
export const MIN_TARGET = 40;

/**
 * How many lines `text` takes set `w` units wide in `style` at line height
 * `lh` (wrap text `node`'s, words.ts `TextNode.wrap`; `term`: its term's),
 * always counted by `wrapLines` (spec/measure.ts, the one line counter): in
 * the type the presenter sets it in (the page reads its CSS's), else in the
 * style's own (`typeMeasure`).
 */
export type Measure = (
  text: string,
  style: SpecTextStyle,
  w: number,
  lh: number,
  node: number,
  term: boolean,
) => number;

/** A wrap text's term column's least width (units). */
export const TERM_MIN = 120;
/** The gap after a term (units). */
export const TERM_GAP = 10;

/** A marked text's `{w}`/`{/}` marks (not words). */
const MARKS = /\{w\}|\{\/\}/g;

/**
 * A fill tabs' options' widths in its width `w` (units), into `out`: equal
 * shares, or by `weight` (`weigh`: their words' length), none under `least`
 * (its `optionW`). One that would be under it takes `least` and the others
 * share what is left by their weights (so a short one doesn't take its room
 * from the last); each floored, the last taking what is left (at least
 * `least`: they run past the end then). The page's and a headset's (both
 * presenters place them so).
 */
export function tabShares(
  n: number,
  least: number,
  w: number,
  weight: (i: number) => number,
  out: Float64Array,
): void {
  // The options at `least`: marked with a negative width until the shares are known.
  for (let i = 0; i < n; i++) out[i] = 0;
  for (let changed = true; changed; ) {
    changed = false;
    let total = 0;
    let left = w;
    for (let i = 0; i < n; i++) {
      if (out[i]! < 0) left -= least;
      else total += weight(i);
    }
    for (let i = 0; i < n; i++) {
      if (out[i]! < 0) continue;
      if (total > 0 && (left * weight(i)) / total < least) {
        out[i] = -1;
        changed = true;
      }
    }
    if (changed) continue;
    for (let i = 0; i < n; i++)
      if (out[i]! >= 0) out[i] = total > 0 ? (left * weight(i)) / total : least;
  }
  let x = 0;
  for (let i = 0; i < n; i++) {
    const share = out[i]! < 0 ? least : i === n - 1 ? w - x : Math.floor(out[i]!);
    out[i] = Math.max(least, share);
    x += out[i]!;
  }
}

/** A text's type as a line count reads it (spec/measure.ts `WrapOptions`: its weight, family, slant and tracking). */
export type WrapType = Pick<WrapOptions, 'weight' | 'family' | 'italic' | 'track'>;

/**
 * `text`'s lines `w` units wide in type `px` high (`type`: its weight, and its
 * family, slant and tracking where not the page's sans-serif's):
 * spec/measure.ts `wrapCount` (breaks at spaces, a word too long cut
 * anywhere, never fewer lines than the page draws), its marks left out.
 */
export function wrapLines(text: string, w: number, px: number, type: WrapType): number {
  return wrapCount(text.includes('{') ? text.replace(MARKS, '') : text, w, px, type);
}

/**
 * The measure where a presenter sets no type of its own (Node, a headset):
 * the style's type (words.ts `TYPE`: its size, weight and family), scaled
 * with its line height.
 */
export const typeMeasure: Measure = (text, style, w, lh) => {
  const t = SPEC_TYPE[style];
  return wrapLines(text, w, (t.px * lh) / SPEC_LINE[style], {
    weight: t.weight,
    family: SPEC_FAMILY[t.family],
  });
};

/** Cuts `v` to the page's layout unit (1/64 px), down. */
export function cut(v: number): number {
  return Math.floor(v * 64) / 64;
}
