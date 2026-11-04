/**
 * Layout regions (D-041 Phase 2): a `LayoutSpec` names regions per form factor, the engine lays
 * them out with one CSS grid inside the safe area of a CSS-px overlay, and widgets register once
 * with a region per form factor. The layout moves them when the form factor changes (a phone
 * turned upright) and reports `freeRect`, the space the UI leaves, for the scene's camera.
 *
 * Everything is in CSS px relative to the overlay root. The geometry is pure (`resolveLayout`)
 * and the DOM grid uses the same resolved track sizes, so the rects the layout reports are the
 * rects the browser draws.
 */
import { h } from './dom';
import type { Overlay, Rect } from './overlay';

export type FormFactor = 'phone-landscape' | 'phone-portrait' | 'tablet' | 'desktop';
export const FORM_FACTORS: readonly FormFactor[] = [
  'phone-landscape',
  'phone-portrait',
  'tablet',
  'desktop',
];

/**
 * - `top`, `bottom`, `left`, `right`: chrome bars and rails.
 * - `cardLane`: a lane for transient cards (beside the world on wide screens, under it upright).
 * - `captionLane`: where a docked caption card sits; it never overlaps another region.
 * - `fill`: what is left. `freeRect` is this region; widgets put here sit over the world.
 * - `modal`: the dialog plane (the safe area less a margin). Panels open inside it; it overlaps
 *   the grid by design and is the one region that may.
 */
export type RegionName =
  | 'top'
  | 'left'
  | 'right'
  | 'bottom'
  | 'cardLane'
  | 'captionLane'
  | 'modal'
  | 'fill';
export const REGIONS: readonly RegionName[] = [
  'top',
  'left',
  'right',
  'bottom',
  'cardLane',
  'captionLane',
  'modal',
  'fill',
];

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export const NO_INSETS: Readonly<Insets> = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * A grid track: a fixed CSS px size, `'fill'` (shares what the other tracks leave), or a
 * fraction of the safe area's length on that axis clamped to `[min, max]`. When the tracks do
 * not fit, fractional tracks shrink toward their `min` before `fill` gives up space.
 */
export type Track = number | 'fill' | { frac: number; min?: number; max?: number };

export interface FormSpec {
  /** One entry per column of `areas`. */
  columns: Track[];
  /** One entry per row of `areas`. */
  rows: Track[];
  /**
   * `grid-template-areas`, one string per row, region names separated by spaces (`.` for an
   * empty cell). Each region must be one rectangle. `modal` is not a grid area.
   */
  areas: string[];
  /** Smallest hit area for base widgets, CSS px (`--tc-tap-min`). */
  tapMin: number;
  /** Smallest text, CSS px (`--tc-text-min`). 0 = no floor. */
  textMin: number;
  /** Padding inside each region and gap between its widgets, CSS px (`--tc-region-pad`). */
  pad: number;
  /** Margin between the safe area and the modal region, CSS px. */
  modalMargin: number;
}

export interface ClassifyInput {
  /** Overlay size, CSS px. */
  width: number;
  height: number;
  /** The primary pointer is coarse (a finger). */
  coarsePointer: boolean;
  /** The screen's shorter side, CSS px (0 if unknown). */
  shortSide: number;
}

export interface LayoutSpec {
  /** Per-form-factor overrides, merged over `defaultForms` field by field. */
  forms?: Partial<Record<FormFactor, Partial<FormSpec>>>;
  /** Pick the form factor. Default `classifyFormFactor`. */
  classify?: (input: ClassifyInput) => FormFactor;
  /**
   * Safe-area insets of the viewport, CSS px. Default: read from `env(safe-area-inset-*)`
   * (overridable per document with `--tc-safe-top/right/bottom/left`, for emulation).
   */
  safeArea?: Insets;
  /** Collapse tracks whose regions hold no registered widget. Default true. */
  collapseEmpty?: boolean;
}

/** A rect in overlay CSS px, for the `'free'` escape hatch. */
export interface FreePlacement {
  region: 'free';
  /** CSS px relative to the overlay root, or computed from the current layout. */
  rect: Rect | ((layout: LayoutState) => Rect);
  /** Why no region fits. Logged once per registration (see `Layout.freeUses`). */
  reason: string;
}

/** Where a widget goes in one form factor. `hidden` takes it out of the layout. */
export type Placement = RegionName | 'hidden' | FreePlacement;

export interface WidgetOptions {
  /** Placement per form factor; `default` covers the ones not named. Unnamed = hidden. */
  place: Partial<Record<FormFactor | 'default', Placement>>;
  /** Order inside its region (CSS `order`). Default 0, then registration order. */
  order?: number;
  /** Name for logs and `freeUses`. Default the element's id or `widget-N`. */
  id?: string;
}

export interface WidgetHandle {
  readonly element: HTMLElement;
  /** Where it is now: a region, `free` or `hidden`. */
  readonly region: RegionName | 'free' | 'hidden';
  /** Change the placement; the layout re-applies at once. */
  setPlace(place: WidgetOptions['place']): void;
  /** Take it out of the layout (the element is removed from its region). */
  remove(): void;
}

/** The pure result of laying out one form factor at one size. */
export interface LayoutState {
  formFactor: FormFactor;
  /** Overlay size, CSS px. */
  width: number;
  height: number;
  /** The effective insets inside the overlay (the viewport insets the overlay rect touches). */
  safeArea: Insets;
  /** Resolved track sizes, CSS px. */
  columns: number[];
  rows: number[];
  /** Region rects in overlay CSS px; `null` when the form has no such area. Collapsed = 0 size. */
  regions: Record<RegionName, Rect | null>;
  /** The `fill` region: the space the UI leaves for the world. */
  freeRect: Rect;
}

/** Largest short side (CSS px) a phone has; tablets start around 744. */
export const PHONE_MAX_SHORT_SIDE = 600;
/** A window whose short side is under this is phone-sized, whatever the pointer. */
export const PHONE_MAX_VIEW_SHORT = 480;

/**
 * Default form-factor choice. A phone is a coarse-pointer screen whose short side is at most
 * `PHONE_MAX_SHORT_SIDE` (the `deviceTraits().handheld` rule), or any window whose short side is
 * under `PHONE_MAX_VIEW_SHORT` (a tiny desktop window gets phone chrome rather than clipped
 * desktop chrome). Phones split by orientation. Other coarse pointers are tablets; the rest are
 * desktops.
 */
export function classifyFormFactor(i: ClassifyInput): FormFactor {
  const viewShort = Math.min(i.width, i.height);
  const handheld = i.coarsePointer && i.shortSide > 0 && i.shortSide <= PHONE_MAX_SHORT_SIDE;
  if (handheld || (viewShort > 0 && viewShort < PHONE_MAX_VIEW_SHORT)) {
    return i.height > i.width ? 'phone-portrait' : 'phone-landscape';
  }
  return i.coarsePointer ? 'tablet' : 'desktop';
}

const WIDE_AREAS = [
  'top    top         top      top',
  'left   fill        cardLane right',
  'left   captionLane cardLane right',
  'bottom bottom      bottom   bottom',
];

/**
 * The default regions. They are deliberately sparse: empty tracks collapse, so a phone shows
 * only the chrome a scene registers, and the world gets the rest.
 *
 * - **desktop / tablet**: full-width top and bottom bars; left and right rails; a card lane
 *   beside the world on the right; the caption lane under the world.
 * - **phone-landscape**: height is the scarce axis, so left and right are full-height rails
 *   (56 px: a 44 px tap target plus padding) and top/bottom sit between them; the card lane is
 *   beside the world; the caption lane is a short strip under it.
 * - **phone-portrait**: width is scarce, so the rails are slim and the card lane and caption lane
 *   are full-width strips stacked under the world, above the bottom bar.
 */
export const defaultForms: Readonly<Record<FormFactor, FormSpec>> = {
  desktop: {
    columns: [
      { frac: 0.16, min: 180, max: 300 },
      'fill',
      { frac: 0.18, min: 200, max: 320 },
      { frac: 0.16, min: 180, max: 300 },
    ],
    rows: [64, 'fill', { frac: 0.16, min: 96, max: 168 }, 72],
    areas: WIDE_AREAS,
    tapMin: 32,
    textMin: 0,
    pad: 12,
    modalMargin: 24,
  },
  tablet: {
    columns: [
      { frac: 0.16, min: 160, max: 280 },
      'fill',
      { frac: 0.2, min: 200, max: 300 },
      { frac: 0.16, min: 160, max: 280 },
    ],
    rows: [68, 'fill', { frac: 0.16, min: 104, max: 168 }, 76],
    areas: WIDE_AREAS,
    tapMin: 44,
    textMin: 0,
    pad: 12,
    modalMargin: 20,
  },
  'phone-landscape': {
    columns: [56, 'fill', { frac: 0.24, min: 140, max: 200 }, 56],
    rows: [52, 'fill', { frac: 0.24, min: 64, max: 96 }, 52],
    areas: [
      'left top         top      right',
      'left fill        cardLane right',
      'left captionLane cardLane right',
      'left bottom      bottom   right',
    ],
    tapMin: 44,
    textMin: 12,
    pad: 4,
    modalMargin: 8,
  },
  'phone-portrait': {
    columns: [56, 'fill', 56],
    rows: [56, 'fill', { frac: 0.16, min: 96, max: 140 }, { frac: 0.14, min: 80, max: 120 }, 60],
    areas: [
      'top         top         top',
      'left        fill        right',
      'cardLane    cardLane    cardLane',
      'captionLane captionLane captionLane',
      'bottom      bottom      bottom',
    ],
    tapMin: 44,
    textMin: 12,
    pad: 4,
    modalMargin: 8,
  },
};

/** The spec for `ff` with `spec.forms[ff]` merged over the default. */
export function formSpec(ff: FormFactor, spec: LayoutSpec = {}): FormSpec {
  return { ...defaultForms[ff], ...spec.forms?.[ff] };
}

/** Parses `areas` into a cell grid; throws on ragged rows, unknown names or non-rectangles. */
export function parseAreas(areas: readonly string[]): string[][] {
  const cells = areas.map((r) => r.trim().split(/\s+/));
  const w = cells[0]?.length ?? 0;
  if (!w || cells.some((r) => r.length !== w)) throw new Error('layout: ragged areas');
  const boxes = new Map<string, { r0: number; r1: number; c0: number; c1: number; n: number }>();
  cells.forEach((row, r) => {
    row.forEach((name, c) => {
      if (name === '.') return;
      if (!REGIONS.includes(name as RegionName) || name === 'modal') {
        throw new Error(`layout: unknown grid area "${name}"`);
      }
      const b = boxes.get(name);
      if (!b) boxes.set(name, { r0: r, r1: r, c0: c, c1: c, n: 1 });
      else {
        b.r0 = Math.min(b.r0, r);
        b.r1 = Math.max(b.r1, r);
        b.c0 = Math.min(b.c0, c);
        b.c1 = Math.max(b.c1, c);
        b.n++;
      }
    });
  });
  for (const [name, b] of boxes) {
    if ((b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1) !== b.n) {
      throw new Error(`layout: area "${name}" is not a rectangle`);
    }
  }
  return cells;
}

/**
 * Resolves track sizes on one axis. `collapsed[i]` forces track i to 0. Fixed and fractional
 * tracks take their size; when they overflow, fractional tracks shrink toward `min`, then the
 * fill tracks get what is left (at least 0), shared equally.
 */
export function resolveTracks(
  tracks: readonly Track[],
  length: number,
  collapsed: readonly boolean[] = [],
): number[] {
  const size = tracks.map((t, i) => {
    if (collapsed[i] || t === 'fill') return 0;
    if (typeof t === 'number') return Math.max(0, t);
    const v = t.frac * length;
    return Math.max(t.min ?? 0, Math.min(t.max ?? Number.POSITIVE_INFINITY, v));
  });
  let over = size.reduce((a, b) => a + b, 0) - length;
  if (over > 0) {
    const slack = tracks.map((t, i) =>
      typeof t === 'object' && !collapsed[i] ? Math.max(0, size[i]! - (t.min ?? 0)) : 0,
    );
    const total = slack.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const k = Math.min(1, over / total);
      for (let i = 0; i < size.length; i++) size[i] = size[i]! - slack[i]! * k;
      over -= Math.min(over, total);
    }
  }
  const fills = tracks.map((t, i) => t === 'fill' && !collapsed[i]);
  const nFill = fills.filter(Boolean).length;
  const left = Math.max(0, length - size.reduce((a, b) => a + b, 0));
  return size.map((s, i) => Math.round((fills[i] ? left / nFill : s) * 100) / 100);
}

/** The insets a rect at `rect` inside a `viewport` of the given size actually touches. */
export function effectiveInsets(
  rect: Rect,
  viewport: { width: number; height: number },
  insets: Insets,
): Insets {
  return {
    top: Math.max(0, insets.top - rect.y),
    left: Math.max(0, insets.left - rect.x),
    bottom: Math.max(0, insets.bottom - (viewport.height - (rect.y + rect.height))),
    right: Math.max(0, insets.right - (viewport.width - (rect.x + rect.width))),
  };
}

/**
 * Lays out one form at one size. `occupied` names the grid regions that hold widgets; with
 * `collapseEmpty`, a track collapses when every region in it is empty or also spans another
 * track on that axis (so a full-width bar never holds a side rail open). `fill` is never empty.
 * Pure.
 */
export function resolveLayout(
  formFactor: FormFactor,
  form: FormSpec,
  width: number,
  height: number,
  safeArea: Insets = NO_INSETS,
  occupied: ReadonlySet<RegionName> | null = null,
): LayoutState {
  const cells = parseAreas(form.areas);
  if (cells.length !== form.rows.length || cells[0]!.length !== form.columns.length) {
    throw new Error('layout: rows/columns do not match areas');
  }
  const innerW = Math.max(0, width - safeArea.left - safeArea.right);
  const innerH = Math.max(0, height - safeArea.top - safeArea.bottom);
  const spans = new Map<string, { r0: number; r1: number; c0: number; c1: number }>();
  cells.forEach((row, r) => {
    row.forEach((n, c) => {
      if (n === '.') return;
      const b = spans.get(n);
      if (!b) spans.set(n, { r0: r, r1: r, c0: c, c1: c });
      else {
        b.r1 = Math.max(b.r1, r);
        b.c1 = Math.max(b.c1, c);
      }
    });
  });
  const empty = (n: string) => n !== 'fill' && occupied !== null && !occupied.has(n as RegionName);
  const collapseAxis = (count: number, axis: 'r' | 'c') =>
    Array.from({ length: count }, (_, i) => {
      if (occupied === null) return false;
      const names = new Set(axis === 'r' ? cells[i]! : cells.map((row) => row[i]!));
      for (const n of names) {
        if (n === '.') continue;
        const s = spans.get(n)!;
        const wide = axis === 'r' ? s.r1 > s.r0 : s.c1 > s.c0;
        if (n === 'fill' || (!empty(n) && !wide)) return false;
      }
      return true;
    });
  const colCollapsed = collapseAxis(form.columns.length, 'c');
  const rowCollapsed = collapseAxis(form.rows.length, 'r');
  // An occupied region never ends up with every track collapsed: reopen its first one.
  for (const [n, s] of spans) {
    if (empty(n)) continue;
    if (colCollapsed.slice(s.c0, s.c1 + 1).every(Boolean)) colCollapsed[s.c0] = false;
    if (rowCollapsed.slice(s.r0, s.r1 + 1).every(Boolean)) rowCollapsed[s.r0] = false;
  }
  const columns = resolveTracks(form.columns, innerW, colCollapsed);
  const rows = resolveTracks(form.rows, innerH, rowCollapsed);
  const offs = (t: number[], i: number) => t.slice(0, i).reduce((a, b) => a + b, 0);
  const regions = Object.fromEntries(REGIONS.map((n) => [n, null])) as Record<
    RegionName,
    Rect | null
  >;
  for (const [n, s] of spans) {
    const x = safeArea.left + offs(columns, s.c0);
    const y = safeArea.top + offs(rows, s.r0);
    regions[n as RegionName] = {
      x,
      y,
      width: offs(columns, s.c1 + 1) - offs(columns, s.c0),
      height: offs(rows, s.r1 + 1) - offs(rows, s.r0),
    };
  }
  const m = form.modalMargin;
  regions.modal = {
    x: safeArea.left + m,
    y: safeArea.top + m,
    width: Math.max(0, innerW - 2 * m),
    height: Math.max(0, innerH - 2 * m),
  };
  const freeRect = regions.fill ?? {
    x: safeArea.left,
    y: safeArea.top,
    width: innerW,
    height: innerH,
  };
  return { formFactor, width, height, safeArea, columns, rows, regions, freeRect: { ...freeRect } };
}

/** Where `place` puts a widget in `ff`. Pure. */
export function placementFor(place: WidgetOptions['place'], ff: FormFactor): Placement {
  return place[ff] ?? place.default ?? 'hidden';
}

/** CSS px safe-area insets of `doc`'s viewport (`env(safe-area-inset-*)`, or the `--tc-safe-*` overrides). */
export function readSafeArea(doc: Document = document): Insets {
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:var(--tc-safe-top,env(safe-area-inset-top,0px)) var(--tc-safe-right,env(safe-area-inset-right,0px)) ' +
    'var(--tc-safe-bottom,env(safe-area-inset-bottom,0px)) var(--tc-safe-left,env(safe-area-inset-left,0px));';
  doc.body.append(probe);
  const cs = doc.defaultView?.getComputedStyle(probe);
  const px = (v: string | undefined) => Number.parseFloat(v ?? '') || 0;
  const out = {
    top: px(cs?.paddingTop),
    right: px(cs?.paddingRight),
    bottom: px(cs?.paddingBottom),
    left: px(cs?.paddingLeft),
  };
  probe.remove();
  return out;
}

export interface Layout {
  /** `.tc-layout`, the grid (in the overlay's `hud` layer). */
  readonly element: HTMLElement;
  readonly formFactor: FormFactor;
  /** The latest resolved layout. */
  readonly state: Readonly<LayoutState>;
  /** The space the UI leaves (the `fill` region), overlay CSS px. Hand it to the scene's camera. */
  readonly freeRect: Readonly<Rect>;
  /** Effective safe-area insets inside the overlay, CSS px. */
  readonly safeArea: Readonly<Insets>;
  /** Every widget currently placed with `region: 'free'`: its id and reason. */
  readonly freeUses: readonly { id: string; reason: string }[];
  /** The element of a region (for styling; register widgets with `add`). */
  region(name: RegionName): HTMLElement;
  /** Register a widget. It is moved into its region now and on every form-factor change. */
  add(element: HTMLElement, opts: WidgetOptions): WidgetHandle;
  /**
   * Dock a caption card (`overlay.caption` by default) in a region, `captionLane` unless
   * `place` says otherwise. Docked, it fills its region and ignores `avoid()`; `hidden` or
   * `free` placements undock it to its legacy corner. Returns the handle.
   */
  dockCaption(
    caption?: { element: HTMLElement; dock(host: HTMLElement | null): void },
    place?: WidgetOptions['place'],
  ): WidgetHandle;
  /** Override the safe-area insets (`null` = read them from the page again). */
  setSafeArea(insets: Insets | null): void;
  /** Recompute now (the layout already follows `overlay.setRect`). */
  refresh(): void;
  /** Called after every re-layout with the new state. Returns unsubscribe. */
  onChange(fn: (state: LayoutState) => void): () => void;
  destroy(): void;
}

interface Entry {
  id: string;
  el: HTMLElement;
  place: WidgetOptions['place'];
  order: number;
  seq: number;
  current: RegionName | 'free' | 'hidden';
  caption?: { element: HTMLElement; dock(host: HTMLElement | null): void };
  home?: { parent: Node | null; next: Node | null };
  loggedFree: boolean;
}

const HIDDEN_ATTR = 'data-tc-layout-hidden';

/**
 * Lays out regions on a CSS-px overlay (`createOverlay({ legacyScale: false })`). Throws on a
 * legacy scaled overlay: its units are design px and its scenes keep their own CSS.
 *
 * The density tokens `--tc-tap-min` and `--tc-text-min` (from the form spec) and
 * `data-form-factor` go on the overlay root, so the base widgets in the panels layer follow them
 * too.
 */
export function createLayout(overlay: Overlay, spec: LayoutSpec = {}): Layout {
  if (overlay.legacyScale) {
    throw new Error('createLayout needs a CSS-px overlay: createOverlay({ legacyScale: false })');
  }
  const root = overlay.root;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const classify = spec.classify ?? classifyFormFactor;
  const collapseEmpty = spec.collapseEmpty !== false;
  let insetOverride: Insets | null = spec.safeArea ?? null;

  const regionEls = Object.fromEntries(
    REGIONS.map((n) => [n, h('div', { class: 'tc-region', dataset: { region: n } })]),
  ) as unknown as Record<RegionName, HTMLElement>;
  const free = h('div', { class: 'tc-layout-free' });
  const element = h(
    'div',
    { class: 'tc-layout' },
    ...REGIONS.filter((n) => n !== 'modal').map((n) => regionEls[n]),
  );
  overlay.layers.hud.append(element, regionEls.modal, free);

  const entries: Entry[] = [];
  const subs = new Set<(s: LayoutState) => void>();
  let seq = 0;
  let state: LayoutState;
  let freeUses: { id: string; reason: string }[] = [];

  const measureInsets = (): Insets => {
    const vp = {
      width: win?.innerWidth ?? overlay.rect.width,
      height: win?.innerHeight ?? overlay.rect.height,
    };
    const raw = insetOverride ?? readSafeArea(doc);
    // The overlay's rect is relative to its parent; place it in the viewport.
    const pb = root.parentElement?.getBoundingClientRect();
    const r = overlay.rect;
    const inView = {
      x: (pb?.left ?? 0) + r.x,
      y: (pb?.top ?? 0) + r.y,
      width: r.width,
      height: r.height,
    };
    return effectiveInsets(inView, vp, raw);
  };

  const classifyNow = (): FormFactor => {
    const mq = (q: string) => typeof win?.matchMedia === 'function' && win.matchMedia(q).matches;
    const s = win?.screen;
    return classify({
      width: overlay.rect.width,
      height: overlay.rect.height,
      coarsePointer: mq('(pointer: coarse)'),
      shortSide: s ? Math.min(s.width, s.height) : 0,
    });
  };

  const apply = () => {
    const ff = classifyNow();
    const form = formSpec(ff, spec);
    // Which grid regions hold a widget in this form factor.
    const occupied = new Set<RegionName>();
    for (const e of entries) {
      const p = placementFor(e.place, ff);
      if (typeof p === 'string' && p !== 'hidden') occupied.add(p);
    }
    const insets = measureInsets();
    state = resolveLayout(
      ff,
      form,
      overlay.rect.width,
      overlay.rect.height,
      insets,
      collapseEmpty ? occupied : null,
    );

    // Tokens and grid.
    root.dataset.formFactor = ff;
    root.style.setProperty('--tc-tap-min', `${form.tapMin}px`);
    root.style.setProperty('--tc-text-min', `${form.textMin}px`);
    root.style.setProperty('--tc-region-pad', `${form.pad}px`);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      root.style.setProperty(`--tc-safe-${side}-px`, `${insets[side]}px`);
    }
    const m = state.regions.modal!;
    root.style.setProperty('--tc-modal-top', `${m.y}px`);
    root.style.setProperty('--tc-modal-left', `${m.x}px`);
    root.style.setProperty('--tc-modal-right', `${state.width - m.x - m.width}px`);
    root.style.setProperty('--tc-modal-bottom', `${state.height - m.y - m.height}px`);
    Object.assign(element.style, {
      padding: `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`,
      gridTemplateColumns: state.columns.map((c) => `${c}px`).join(' '),
      gridTemplateRows: state.rows.map((r) => `${r}px`).join(' '),
      gridTemplateAreas: form.areas.map((a) => `"${a.trim().split(/\s+/).join(' ')}"`).join(' '),
    });
    for (const n of REGIONS) {
      const r = state.regions[n];
      const el = regionEls[n];
      const absent = !r || r.width <= 0 || r.height <= 0;
      el.toggleAttribute('data-empty', absent || (n !== 'fill' && !occupied.has(n)));
      el.hidden = absent;
      if (n === 'modal' && r) {
        Object.assign(el.style, {
          left: `${r.x}px`,
          top: `${r.y}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      }
    }

    // Widgets.
    freeUses = [];
    const sorted = [...entries].sort((a, b) => a.order - b.order || a.seq - b.seq);
    for (const e of sorted) {
      let p = placementFor(e.place, ff);
      if (typeof p === 'string' && p !== 'hidden' && !state.regions[p]) {
        console.warn(`[layout] ${e.id}: no "${p}" region in ${ff}; hidden`);
        p = 'hidden';
      }
      e.el.toggleAttribute(HIDDEN_ATTR, p === 'hidden');
      e.el.style.order = e.order ? String(e.order) : '';
      if (typeof p === 'object') {
        const r = typeof p.rect === 'function' ? p.rect(state) : p.rect;
        if (!e.loggedFree) {
          console.info(`[layout] free placement: ${e.id} (${p.reason})`);
          e.loggedFree = true;
        }
        freeUses.push({ id: e.id, reason: p.reason });
        if (e.caption) e.caption.dock(null);
        if (e.el.parentNode !== free) free.append(e.el);
        Object.assign(e.el.style, {
          position: 'absolute',
          left: `${r.x}px`,
          top: `${r.y}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        e.current = 'free';
        continue;
      }
      if (e.current === 'free') {
        for (const k of ['position', 'left', 'top', 'width', 'height'] as const) e.el.style[k] = '';
      }
      if (p === 'hidden') {
        if (e.caption) e.caption.dock(null);
        e.current = 'hidden';
        continue;
      }
      if (e.caption) e.caption.dock(regionEls[p]);
      else regionEls[p].append(e.el);
      e.current = p;
    }
    for (const f of subs) f(state);
  };

  const unwatch = overlay.onRect(() => apply());

  const layout: Layout = {
    element,
    get formFactor() {
      return state.formFactor;
    },
    get state() {
      return state;
    },
    get freeRect() {
      return state.freeRect;
    },
    get safeArea() {
      return state.safeArea;
    },
    get freeUses() {
      return freeUses;
    },
    region(name) {
      return regionEls[name];
    },
    add(el, opts) {
      const e: Entry = {
        id: opts.id ?? (el.id || `widget-${seq + 1}`),
        el,
        place: { ...opts.place },
        order: opts.order ?? 0,
        seq: seq++,
        current: 'hidden',
        loggedFree: false,
      };
      entries.push(e);
      apply();
      return handle(e);
    },
    dockCaption(caption = overlay.caption, place = { default: 'captionLane' }) {
      const e: Entry = {
        id: 'caption',
        el: caption.element,
        place: { ...place },
        order: 0,
        seq: seq++,
        current: 'hidden',
        caption,
        loggedFree: false,
      };
      entries.push(e);
      apply();
      return handle(e);
    },
    setSafeArea(insets) {
      insetOverride = insets ? { ...insets } : null;
      apply();
    },
    refresh: () => apply(),
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    destroy() {
      unwatch();
      subs.clear();
      for (const e of entries.splice(0)) {
        e.caption?.dock(null);
        e.el.removeAttribute(HIDDEN_ATTR);
      }
      element.remove();
      regionEls.modal.remove();
      free.remove();
      delete root.dataset.formFactor;
    },
  };

  function handle(e: Entry): WidgetHandle {
    return {
      element: e.el,
      get region() {
        return e.current;
      },
      setPlace(place) {
        e.place = { ...place };
        e.loggedFree = false;
        apply();
      },
      remove() {
        const i = entries.indexOf(e);
        if (i < 0) return;
        entries.splice(i, 1);
        if (e.caption) e.caption.dock(null);
        else e.el.remove();
        e.el.removeAttribute(HIDDEN_ATTR);
        apply();
      },
    };
  }

  apply();
  return layout;
}
