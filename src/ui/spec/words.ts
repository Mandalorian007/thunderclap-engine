/**
 * The UI words (ws/ui-spec, E-041 P7): a panel is a tree of about a dozen words bound to a keyed
 * model, laid out by one pure function (`boxes.ts`) and drawn by a presenter (`presentDom` on
 * screens; a world presenter later). A word's size never comes from its text: a text has a fixed
 * number of lines (or `wrap`, counted by `measure.ts`), and text that does not fit is cut with an
 * ellipsis by the presenter. Generalized from Forge Wilds' `ui/spec/words.ts`.
 *
 * Units are CSS px at UI scale 1; a presenter multiplies them by its `scale`. A value is fixed in
 * the spec or bound to a model key with `b(key)`. Inside a list's row, `b('row.<field>')` binds
 * the row's own field: each row's values are held under its row key (`SpecRow`), never under a
 * key built from a template string.
 */

/** A value bound to a model key. */
export interface Bind {
  readonly b: string;
}

/** Binds a value to model key `key` (`row.<field>` inside a list's row). */
export function b(key: string): Bind {
  return { b: key };
}

/** A text: fixed, or bound. */
export type SpecStr = string | Bind;
/** A number: fixed, or bound. */
export type SpecNum = number | Bind;

/** A text's style: its line height (`SPEC_LINE`), its type (`SPEC_TYPE`) and its look (`.tcs-t-<style>`). */
export type SpecTextStyle =
  | 'head'
  | 'title'
  | 'body'
  | 'label'
  | 'note'
  | 'warn'
  | 'count'
  | 'display';

/** A type's family; each one's stack is a theme token (`fontSans`, `fontSerif`, `fontMono`). */
export type SpecFontFamily = 'sans' | 'serif' | 'mono';

/** Each style's line height, units at text scale 1 (the frame's `text` scales it, rounded). */
export const SPEC_LINE: Readonly<Record<SpecTextStyle, number>> = {
  head: 20,
  title: 17,
  body: 17,
  label: 16,
  note: 15,
  warn: 15,
  count: 15,
  display: 18,
};

/** Each style's type (px at text scale 1, weight and family): what a wrap text is counted in. */
export const SPEC_TYPE: Readonly<
  Record<
    SpecTextStyle,
    { readonly px: number; readonly weight: number; readonly family: SpecFontFamily }
  >
> = {
  head: { px: 15, weight: 600, family: 'sans' },
  title: { px: 13, weight: 600, family: 'sans' },
  body: { px: 13, weight: 400, family: 'sans' },
  label: { px: 12, weight: 400, family: 'sans' },
  note: { px: 11, weight: 400, family: 'sans' },
  warn: { px: 11, weight: 400, family: 'sans' },
  count: { px: 11, weight: 400, family: 'sans' },
  display: { px: 14, weight: 400, family: 'serif' },
};

/** Where a child sits across its stack. */
export type SpecAlign = 'start' | 'center' | 'end' | 'stretch';

/** What every word may carry. */
export interface SpecCommon {
  /** Its name: events name it, and the element carries it (`data-id`). Needed on anything pressed. */
  readonly id?: string;
  /** Extra classes for the presenter's CSS (the look; never the layout). */
  readonly cls?: string;
  /** A fixed width (else its natural width, or stretched). */
  readonly w?: number;
  /** A fixed height (else its natural height). */
  readonly h?: number;
  /** A share of its stack's free length along the stack. */
  readonly grow?: number;
  /** Shown while true (hidden: no box, and its stack closes up). */
  readonly show?: Bind;
  /** A state class from the model (`data-state`); '' for none. */
  readonly state?: Bind;
  /** For screen readers and the tooltip. */
  readonly label?: SpecStr;
  /** A colour the look takes (the presenter's `--tcs-tint`). */
  readonly tint?: SpecStr;
  /** Its look plays again each time this is set (a CSS animation restarted). */
  readonly again?: Bind;
}

/**
 * A stack: children down (`col`) or across (`row`). A `col` may `scroll` (its children scroll in
 * it), and a stack with an `id` and `tap` is pressed as one where nothing pressable inside takes
 * the press.
 */
export interface SpecStack extends SpecCommon {
  readonly k: 'col' | 'row';
  readonly gap?: number;
  /** Padding: all sides, or [top, right, bottom, left]. */
  readonly pad?: number | readonly [number, number, number, number];
  /** Where the children sit across the stack (default: stretch in a col, center in a row). */
  readonly align?: SpecAlign;
  /** A col only: its children scroll in it. Not nested, not in a list's row, not the body. */
  readonly scroll?: boolean;
  /** Pressed as one: a tap that lands on nothing else pressable says `tap` with its `id`. */
  readonly tap?: boolean;
  /**
   * A role for screen readers (`dialog`, `toolbar`, `group`, …), written on its element. The
   * body's role names the panel (a modal's dialog role belongs to `ui.stack`).
   */
  readonly role?: string;
  readonly children: readonly SpecNode[];
}

/** Fixed columns of fixed cells. */
export interface SpecGrid extends SpecCommon {
  readonly k: 'grid';
  readonly cols: number;
  /** A cell's width (and height, unless `cellH`). */
  readonly cell: number;
  readonly cellH?: number;
  readonly gap?: number;
  readonly children: readonly SpecNode[];
}

/**
 * Keyed rows from a model list (`model.setList(id, keys)`), each `row` laid out once in a cell of
 * its own (`rowH` high; `cols` across). On screens it is a real scroller whose rows are pooled:
 * a scroll writes nothing. Its height is `h`; growing, what its stack leaves; else as many rows
 * as it has, up to `maxRows`. A one-column list may have headings: a key starting with `#` is
 * drawn with `head`.
 */
export interface SpecList extends SpecCommon {
  readonly k: 'list';
  readonly id: string;
  readonly rowH: number;
  readonly cols?: number;
  readonly gap?: number;
  /** Up to this many rows of height (then it scrolls), when `h` isn't given. */
  readonly maxRows?: SpecNum;
  /** It follows its end: a list scrolled to its end stays there as rows come (a log). */
  readonly tail?: boolean;
  readonly row: SpecNode;
  /** The headings' word: keys starting with `#` (one column only). */
  readonly head?: SpecNode;
}

/**
 * A text with a fixed number of lines: its height is its lines times its style's line height.
 * In a row it needs a `w` or a `grow`. Its lines may be bound (a top-level key: the game counts
 * them with `wrapCount`), or it may `wrap` (the layout counts them at its width, at least
 * `lines`). A wrap text's `term` is drawn in a column of its own at its start.
 */
export interface SpecText extends SpecCommon {
  readonly k: 'text';
  readonly text: SpecStr;
  readonly style: SpecTextStyle;
  /** Its lines (default 1; bound: a top-level key's number); more is cut with "…". */
  readonly lines?: SpecNum;
  /** Lit runs: `{w}…{/}` in its text is drawn lit (`.tcs-lit`); nothing else is markup. */
  readonly marked?: boolean;
  /** A flash: each set shows, then fades; '' clears it. */
  readonly flash?: boolean;
  /** Its lines are what its text takes at its width (at least `lines`). */
  readonly wrap?: boolean;
  /** A key line's term (a wrap text's), drawn in a column at its start. */
  readonly term?: string;
  /** The term's column, a share of the text's width (default 0.42; at least 120 units, at most half). */
  readonly termW?: number;
  /** Where its words sit across its box (default start). */
  readonly textAlign?: 'start' | 'center' | 'end';
}

/**
 * An item stack: its item (`''` for an empty slot) and count. The game draws the item's picture
 * (`DomOptions.slotArt`); with none, its words are the item's name. A slot is pressed like a
 * button: moving a stack is a tap to pick and a tap to put (a finger, a mouse and a ray alike).
 */
export interface SpecSlot extends SpecCommon {
  readonly k: 'slot';
  readonly id: string;
  readonly item: Bind;
  readonly count?: Bind;
  /** The key that selects it, shown in its corner. */
  readonly keyLabel?: SpecStr;
  readonly size: number;
  /** A press held still (or a right click) is a hold. */
  readonly hold?: boolean;
  /** Pressable while true. */
  readonly enabled?: Bind;
}

/** A mark on a meter: where (0..1), its state, and its words. */
export interface SpecMark {
  readonly cls?: string;
  readonly at: SpecNum;
  readonly state?: Bind;
  readonly label?: Bind;
}

/** A bar, 0..1, with marks. Its height is `h` (default 16). */
export interface SpecMeter extends SpecCommon {
  readonly k: 'meter';
  readonly value: SpecNum;
  readonly marks?: readonly SpecMark[];
  /** Its value in words for screen readers (`aria-valuetext`). */
  readonly valueText?: Bind;
}

/** One path of a glyph drawn in parts, painted by its class, stroked (`line`) or filled. */
export interface SpecGlyphPart {
  readonly d: string;
  readonly cls?: string;
  readonly line?: boolean;
}

/** A glyph: an SVG path in a 24 × 24 view box (or `view`), stroked; or parts. */
export interface SpecIcon extends SpecCommon {
  readonly k: 'icon';
  readonly glyph: string | readonly SpecGlyphPart[];
  readonly view?: number | readonly [number, number];
  readonly size: number;
}

/** What a press on a button is: a tap, a toggle (flips), or held (`down` and `up`). */
export type SpecButtonPress = 'tap' | 'toggle' | 'held';

/** A button: words or a glyph. */
export interface SpecButton extends SpecCommon {
  readonly k: 'button';
  readonly id: string;
  readonly text?: SpecStr;
  /** A glyph path (24 × 24 view box) drawn before its words. */
  readonly icon?: string;
  readonly press?: SpecButtonPress;
  /** A press held still (or a right click) is a hold. */
  readonly hold?: boolean;
  /** Its on state (a toggle's, or a lit button's: `aria-pressed`). */
  readonly on?: Bind;
  /** Pressable while true. */
  readonly enabled?: Bind;
  /** A count in its corner ('' hides it). */
  readonly badge?: Bind;
  /** The key that presses it, after its words. */
  readonly keyLabel?: SpecStr;
  /** The field whose Enter presses it. */
  readonly submits?: string;
  /** A ring: n > 0 fills it over n ms (from empty, each set), 0 empties it, < 0 shows it full. */
  readonly ring?: Bind;
}

/** What a field is for: its keyboard and its Enter (a `long` one is many lines). */
export type SpecFieldKind = 'search' | 'name' | 'chat' | 'long' | 'url';

/** A real text input. Its typed text is its value; a set from the game replaces it. */
export interface SpecField extends SpecCommon {
  readonly k: 'field';
  readonly id: string;
  readonly kind: SpecFieldKind;
  readonly placeholder?: SpecStr;
  readonly max?: number;
  readonly enabled?: Bind;
  readonly value?: Bind;
}

/** One of n: the options are a model list; each option's words its row's `label`. */
export interface SpecTabs extends SpecCommon {
  readonly k: 'tabs';
  readonly id: string;
  readonly selected: Bind;
  /** Each option's width (with `fill`, the least). */
  readonly optionW: number;
  /** Its options share its width, none under `optionW`. */
  readonly fill?: boolean;
  /** With `fill`, each option's share goes by its words' length. */
  readonly weigh?: boolean;
  readonly enabled?: Bind;
}

/** A slider. */
export interface SpecRange extends SpecCommon {
  readonly k: 'range';
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: Bind;
  readonly enabled?: Bind;
  /** For screen readers: its value in words ("75%"). */
  readonly valueText?: Bind;
}

/** A word. */
export type SpecNode =
  | SpecStack
  | SpecGrid
  | SpecList
  | SpecText
  | SpecSlot
  | SpecMeter
  | SpecIcon
  | SpecButton
  | SpecField
  | SpecTabs
  | SpecRange;

/** A panel: its words. */
export interface PanelSpec {
  readonly id: string;
  readonly body: SpecNode;
  /** Its body's `show` fades it in and out over this many ms (at once while motion is reduced). */
  readonly fade?: number;
  /** It says `held` true as the first press goes down on it, false as the last lets go. */
  readonly held?: boolean;
}

/** What a press on a panel is. */
export type SpecPressKind = 'tap' | 'hold' | 'toggle';

/**
 * What a panel says happened: a press (a held button's `down` and `up`), a field's `input`,
 * `enter`, `focus` or `blur`, a `pick` (tabs), a `change` (range), or the panel `held`.
 */
export interface PanelEvent {
  readonly panel: string;
  /** The word's id ('' for the panel's own `held`). */
  readonly id: string;
  /** The row's key, for a word in a list's row (or a tab's option). */
  readonly row: string | null;
  readonly type:
    | SpecPressKind
    | 'input'
    | 'enter'
    | 'pick'
    | 'change'
    | 'down'
    | 'up'
    | 'focus'
    | 'blur'
    | 'held';
  /** A field's text, a range's value, a toggle's new state, `held`'s state. */
  readonly value: string | number | boolean | null;
  /** A press that asks for one, not all (Shift with a click on screens). */
  readonly one?: boolean;
}

/** An icon's view box: its width and height. */
export function viewOf(icon: SpecIcon): readonly [number, number] {
  const v = icon.view ?? 24;
  return typeof v === 'number' ? [v, v] : v;
}

/** A glyph's parts: a plain glyph is one line. */
export function partsOf(icon: Pick<SpecIcon, 'glyph'>): readonly SpecGlyphPart[] {
  return typeof icon.glyph === 'string' ? [{ d: icon.glyph, line: true }] : icon.glyph;
}
