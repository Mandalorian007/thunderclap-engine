/**
 * The item card (ws/ui-inventory): a `role="tooltip"` on the `hud` layer with a title, a subtitle,
 * rows of label and value (with a tone and a compare arrow drawn in CSS) and a footer, shown
 * beside an anchor and flipped to stay in the frame by the pure `placeCard`. A grid or a
 * `slotsTarget` shows it on focus and on hover; the game fills it with `set`.
 */
import { h } from './dom';
import { themePx } from './hud';
import { ensureInventoryStyles, type InventoryHost } from './inventory';
import type { Rect } from './overlay';
import type { WidgetTone } from './widgets-2';

export interface CardRow {
  label: string;
  value: string;
  tone?: WidgetTone;
  /** An arrow after the value: better, worse or the same as what the player has. */
  compare?: 'up' | 'down' | 'same';
}

export interface CardOptions {
  title: string;
  subtitle?: string;
  tone?: WidgetTone;
  rows: CardRow[];
  footer?: string;
  /** Width, theme px. Default 280. */
  width?: number;
}

export type CardPlacement = 'auto' | 'right' | 'left' | 'above' | 'below';
export type CardSide = Exclude<CardPlacement, 'auto'>;

export interface Card {
  readonly element: HTMLElement;
  /** Rewrite the content (DOM writes only where a field changed). */
  set(opts: CardOptions): void;
  /**
   * Show beside `anchor` (an element, or a rect in the host's `hud`-layer CSS px), placed by
   * `placeCard`. An element anchor gets `aria-describedby` while the card is visible.
   */
  show(anchor: HTMLElement | Rect, placement?: CardPlacement): void;
  hide(): void;
  readonly visible: boolean;
  /** Where it landed last (`placeCard`'s choice), or null while hidden. */
  readonly placement: CardSide | null;
  remove(): void;
}

const ORDER: readonly CardSide[] = ['right', 'left', 'below', 'above'];
const OPPOSITE: Record<CardSide, CardSide> = {
  right: 'left',
  left: 'right',
  above: 'below',
  below: 'above',
};

/**
 * Where a card of `size` goes beside `anchor` inside `frame` (all in the same units). `auto`
 * tries right, left, below, above and takes the first that fits, else the side with the most
 * room; a named side flips to its opposite when it does not fit and the opposite does. The
 * result is clamped into the frame on both axes. `gap` separates card and anchor.
 */
export function placeCard(
  anchor: Rect,
  size: { width: number; height: number },
  frame: Rect,
  placement: CardPlacement = 'auto',
  gap = 0,
): { x: number; y: number; placement: CardSide } {
  const room: Record<CardSide, number> = {
    right: frame.x + frame.width - (anchor.x + anchor.width) - gap,
    left: anchor.x - frame.x - gap,
    below: frame.y + frame.height - (anchor.y + anchor.height) - gap,
    above: anchor.y - frame.y - gap,
  };
  const fits = (s: CardSide) =>
    room[s] >= (s === 'left' || s === 'right' ? size.width : size.height);
  let side: CardSide;
  if (placement === 'auto') {
    side = ORDER.find(fits) ?? ORDER.reduce((a, b) => (room[b] > room[a] ? b : a));
  } else {
    side = placement;
    if (!fits(side) && fits(OPPOSITE[side])) side = OPPOSITE[side];
  }
  let x: number;
  let y: number;
  switch (side) {
    case 'right':
      x = anchor.x + anchor.width + gap;
      y = anchor.y;
      break;
    case 'left':
      x = anchor.x - gap - size.width;
      y = anchor.y;
      break;
    case 'below':
      x = anchor.x;
      y = anchor.y + anchor.height + gap;
      break;
    case 'above':
      x = anchor.x;
      y = anchor.y - gap - size.height;
      break;
  }
  x = Math.max(frame.x, Math.min(frame.x + frame.width - size.width, x));
  y = Math.max(frame.y, Math.min(frame.y + frame.height - size.height, y));
  return { x, y, placement: side };
}

let cardCounter = 0;

/** An item card on the host's `hud` layer. See the module comment. */
export function card(host: InventoryHost, opts: CardOptions): Card {
  const layer = host.layers.hud;
  const doc = layer.ownerDocument;
  ensureInventoryStyles(doc);
  const id = `tc-inv-card-${++cardCounter}`;
  const title = h('div', { class: 'tc-inv-card-title' });
  const subtitle = h('div', { class: 'tc-inv-card-subtitle' });
  const rows = h('dl', { class: 'tc-inv-card-rows' });
  const footer = h('div', { class: 'tc-inv-card-footer' });
  const element = h(
    'div',
    { class: 'tc-inv-card', role: 'tooltip', id, hidden: true },
    title,
    subtitle,
    rows,
    footer,
  );
  layer.append(element);

  let current: CardOptions | null = null;
  let describedEl: HTMLElement | null = null;
  let placement: CardSide | null = null;

  function set(o: CardOptions): void {
    if (!current || current.title !== o.title) title.textContent = o.title;
    if (!current || current.subtitle !== o.subtitle) subtitle.textContent = o.subtitle ?? '';
    if (!current || current.footer !== o.footer) footer.textContent = o.footer ?? '';
    if (!current || current.tone !== o.tone) {
      if (o.tone) element.dataset.tone = o.tone;
      else delete element.dataset.tone;
    }
    if (!current || current.width !== o.width)
      element.style.setProperty('--tc-inv-card-width', themePx(o.width ?? 280));
    if (!current || current.rows !== o.rows || !sameRows(current.rows, o.rows)) {
      rows.replaceChildren();
      for (const r of o.rows) {
        rows.append(
          h('dt', null, r.label),
          h('dd', { 'data-tone': r.tone, 'data-compare': r.compare }, r.value),
        );
      }
    }
    current = o;
  }

  function sameRows(a: CardRow[], b: CardRow[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      if (
        x.label !== y.label ||
        x.value !== y.value ||
        x.tone !== y.tone ||
        x.compare !== y.compare
      )
        return false;
    }
    return true;
  }

  function show(anchor: HTMLElement | Rect, place: CardPlacement = 'auto'): void {
    const frameRect = layer.getBoundingClientRect();
    let a: Rect;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      a = {
        x: r.left - frameRect.left,
        y: r.top - frameRect.top,
        width: r.width,
        height: r.height,
      };
      if (describedEl !== anchor) {
        describedEl?.removeAttribute('aria-describedby');
        anchor.setAttribute('aria-describedby', id);
        describedEl = anchor;
      }
    } else {
      describedEl?.removeAttribute('aria-describedby');
      describedEl = null;
      a = anchor;
    }
    element.hidden = false;
    const size = { width: element.offsetWidth, height: element.offsetHeight };
    const frame = { x: 0, y: 0, width: frameRect.width, height: frameRect.height };
    const gap = parseFloat(getComputedStyle(element).getPropertyValue('--tc-space-2')) || 0;
    const p = placeCard(a, size, frame, place, gap);
    element.style.transform = `translate(${p.x}px, ${p.y}px)`;
    placement = p.placement;
    element.dataset.placement = p.placement;
  }

  function hide(): void {
    if (element.hidden) return;
    element.hidden = true;
    placement = null;
    describedEl?.removeAttribute('aria-describedby');
    describedEl = null;
  }

  set(opts);
  return {
    element,
    set,
    show,
    hide,
    get visible() {
      return !element.hidden;
    },
    get placement() {
      return placement;
    },
    remove() {
      hide();
      element.remove();
    },
  };
}
