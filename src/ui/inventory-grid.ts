/**
 * The inventory grid (ws/ui-inventory): a `role="grid"` of `gridcell`s with a roving tabindex,
 * items that may span cells, a count badge, keyboard and pad pick-up and drop, a hover and focus
 * card, a context hook and a polite announcer. It is also a `DropTarget`, so `drag.register(grid)`
 * lets pointers drag between grids and onto a `slotsTarget`.
 *
 * Keys (consumed with `preventDefault` and `stopPropagation`, like `segmented`): arrows move the
 * focus, clamped, no wrap; Home and End go to the row's ends; Enter or Space activates the item
 * (`onActivate`); a held Enter or Space (key repeat) picks it up, the next Enter or Space drops it
 * (`aria-grabbed` on the source cell meanwhile); Escape puts it back; Shift+F10 and the
 * ContextMenu key call `onContext`. `act(action)` is the same for a pad: `select` picks up or
 * drops, `back` cancels, `secondary` is the context hook, the directions move the focus. While an
 * item is held and the focus is at the left or right edge, the next left or right walks to the
 * next registered target (`DragLink.cross`).
 */
import { h } from './dom';
import { themePx } from './hud';
import {
  type Cell,
  type CellItem,
  type CellRef,
  type DragPick,
  type DropSpot,
  type DropTarget,
  defaultInventoryLabels,
  ensureInventoryStyles,
  type InventoryLabels,
  iconNode,
} from './inventory';
import type { Card, CardOptions } from './inventory-card';

export type PadAction = 'select' | 'back' | 'secondary' | 'up' | 'down' | 'left' | 'right';

export interface GridOptions {
  cols: number;
  rows: number;
  /** Cell size, theme px. Default 56. */
  cellSize?: number;
  /** Gap between cells, theme px. Default 4. */
  gap?: number;
  /** Accessible name of the grid. */
  label?: string;
  /**
   * The game's rule for a move, asked after the structural one (in bounds, the span's cells
   * free). `to.grid` may be another grid. The refs are scratch objects: do not keep them.
   */
  canDrop?: (from: CellRef, to: CellRef, item: CellItem) => boolean;
  /** An item moved: `from` or `to` is in this grid (both, for a move within it). */
  onMove?: (from: CellRef, to: CellRef, item: CellItem) => void;
  /** Enter, Space or a click on an item. */
  onActivate?: (cell: Cell, item: CellItem) => void;
  /** The focused cell changed. */
  onFocus?: (cell: Cell) => void;
  /**
   * The secondary button, Shift+F10, the ContextMenu key or the pad's `secondary` on a cell with
   * an item. `anchor` is the cell element: open a `ui.contextList(items, { at: anchor, ... })`.
   */
  onContext?: (cell: Cell, item: CellItem, anchor: HTMLElement) => void;
  /** A card to show on focus, and on hover after `hoverMs`; `describe` fills it per item. */
  card?: Card;
  describe?: (item: CellItem, cell: Cell) => CardOptions | null;
  /** Hover delay before the card shows, ms. Default 250. */
  hoverMs?: number;
  labels?: InventoryLabels;
}

export interface GridEntry {
  col: number;
  row: number;
  item: CellItem;
}

export interface Grid extends DropTarget {
  readonly element: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  /** Put `item` at `cell` (clearing what covered it), or clear the cell. False if the span does not fit. */
  set(cell: Cell, item: CellItem | null): boolean;
  /** The item anchored at or covering `cell`. */
  get(cell: Cell): CellItem | null;
  /** The anchor cell of `item` (by identity), or null. */
  find(item: CellItem): Cell | null;
  /** Move the item anchored at `from` to `to` if its span fits there. No `onMove`. */
  move(from: Cell, to: Cell): boolean;
  /** Every anchored item, reading order. A fresh array each call. */
  readonly items: GridEntry[];
  /** Move the roving tabindex and the focus to `cell`. */
  focus(cell: Cell): void;
  readonly focused: Readonly<Cell>;
  /** The item held by a keyboard or pad pick-up, or null. */
  readonly held: CellItem | null;
  /** A pad action (the game maps its input to these); the keyboard arrives as key events. */
  act(action: PadAction): boolean;
  clear(): void;
  remove(): void;
}

const EDGE_LEFT = 'left';
const EDGE_RIGHT = 'right';

/** An inventory grid. See the module comment. */
export function grid(opts: GridOptions): Grid {
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const n = cols * rows;
  const labels = { ...defaultInventoryLabels, ...opts.labels };
  const hoverMs = opts.hoverMs ?? 250;

  // Data: the anchored item per cell, and which anchor covers each cell (-1: none).
  const anchors: (CellItem | null)[] = new Array(n).fill(null);
  const cover = new Int32Array(n).fill(-1);
  const cells: HTMLElement[] = [];
  const spots: DropSpot[] = [];
  const rowEls: HTMLElement[] = [];
  const live = h('span', { class: 'tc-sr-only', 'aria-live': 'polite' });
  ensureInventoryStyles(live.ownerDocument);

  for (let r = 0; r < rows; r++) {
    const row = h('div', { class: 'tc-grid-row', role: 'row' });
    for (let c = 0; c < cols; c++) {
      const cell = h('div', {
        class: 'tc-cell',
        role: 'gridcell',
        tabindex: r === 0 && c === 0 ? '0' : '-1',
        'aria-label': labels.empty,
        dataset: { col: String(c), row: String(r) },
      });
      cells.push(cell);
      spots.push({ el: cell, col: c, row: r });
      row.append(cell);
    }
    rowEls.push(row);
  }
  const element = h(
    'div',
    {
      class: 'tc-grid',
      role: 'grid',
      'aria-label': opts.label,
      'aria-rowcount': String(rows),
      'aria-colcount': String(cols),
      style: {
        '--tc-cell-size': themePx(opts.cellSize ?? 56),
        '--tc-cell-gap': themePx(opts.gap ?? 4),
      },
    },
    ...rowEls,
    live,
  );

  const idx = (c: number, r: number) => r * cols + c;
  const inBounds = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  const spanOf = (item: CellItem) => ({
    w: Math.max(1, Math.floor(item.span?.w ?? 1)),
    h: Math.max(1, Math.floor(item.span?.h ?? 1)),
  });

  /** Whether `item` fits anchored at (c, r), ignoring the cells `ignore` (its own anchor) covers. */
  function fits(c: number, r: number, item: CellItem, ignore: number): boolean {
    const { w, h: hh } = spanOf(item);
    if (!inBounds(c, r) || c + w > cols || r + hh > rows) return false;
    for (let y = r; y < r + hh; y++)
      for (let x = c; x < c + w; x++) {
        const a = cover[idx(x, y)];
        if (a !== -1 && a !== ignore) return false;
      }
    return true;
  }

  function labelOf(item: CellItem): string {
    return item.label ?? item.id;
  }

  function renderCell(i: number): void {
    const cell = cells[i]!;
    const item = anchors[i];
    const prev = cell.querySelector('.tc-cell-item');
    prev?.remove();
    cell.removeAttribute('data-covered');
    cell.style.removeProperty('--tc-span-w');
    cell.style.removeProperty('--tc-span-h');
    if (!item) {
      const a = cover[i];
      if (a !== -1 && a !== i) cell.setAttribute('data-covered', '');
      cell.setAttribute('aria-label', a !== -1 ? labelOf(anchors[a]!) : labels.empty);
      return;
    }
    const { w, h: hh } = spanOf(item);
    if (w > 1) cell.style.setProperty('--tc-span-w', String(w));
    if (hh > 1) cell.style.setProperty('--tc-span-h', String(hh));
    const box = h(
      'div',
      {
        class: 'tc-cell-item',
        'data-tone': item.tone,
        'data-id': item.id,
        'data-locked': item.locked === true,
      },
      iconNode(item.icon, element.ownerDocument),
      item.count !== undefined && item.count > 1
        ? h('span', { class: 'tc-cell-count' }, String(item.count))
        : null,
    );
    cell.append(box);
    cell.setAttribute('aria-label', labels.cell(labelOf(item), item.count));
  }

  function place(c: number, r: number, item: CellItem): void {
    const a = idx(c, r);
    const { w, h: hh } = spanOf(item);
    anchors[a] = item;
    for (let y = r; y < r + hh; y++)
      for (let x = c; x < c + w; x++) {
        cover[idx(x, y)] = a;
        if (idx(x, y) !== a) renderCell(idx(x, y));
      }
    renderCell(a);
  }

  function unplace(a: number): CellItem | null {
    const item = anchors[a];
    if (!item) return null;
    anchors[a] = null;
    for (let i = 0; i < n; i++)
      if (cover[i] === a) {
        cover[i] = -1;
        if (i !== a) renderCell(i);
      }
    renderCell(a);
    return item;
  }

  function set(cell: Cell, item: CellItem | null): boolean {
    if (!inBounds(cell.col, cell.row)) return false;
    const i = idx(cell.col, cell.row);
    const covering = cover[i];
    if (item && !fits(cell.col, cell.row, item, covering === -1 ? -2 : covering)) return false;
    if (covering !== -1) unplace(covering);
    if (item) place(cell.col, cell.row, item);
    return true;
  }

  function get(cell: Cell): CellItem | null {
    if (!inBounds(cell.col, cell.row)) return null;
    const a = cover[idx(cell.col, cell.row)];
    return a === -1 ? null : anchors[a]!;
  }

  function find(item: CellItem): Cell | null {
    const a = anchors.indexOf(item);
    return a < 0 ? null : { col: a % cols, row: Math.floor(a / cols) };
  }

  function move(from: Cell, to: Cell): boolean {
    if (!inBounds(from.col, from.row)) return false;
    const a = cover[idx(from.col, from.row)];
    if (a === -1) return false;
    const item = anchors[a]!;
    if (!fits(to.col, to.row, item, a)) return false;
    unplace(a);
    place(to.col, to.row, item);
    return true;
  }

  // ---------------------------------------------------------------- focus

  const focused: Cell = { col: 0, row: 0 };
  let focusIdx = 0;

  function setFocus(c: number, r: number, moveFocus: boolean): void {
    c = Math.max(0, Math.min(cols - 1, c));
    r = Math.max(0, Math.min(rows - 1, r));
    const i = idx(c, r);
    if (i !== focusIdx) {
      cells[focusIdx]!.tabIndex = -1;
      focusIdx = i;
      cells[i]!.tabIndex = 0;
      focused.col = c;
      focused.row = r;
      opts.onFocus?.(focused);
      if (carry) showCarry();
    }
    if (moveFocus) cells[i]!.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- card

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let cardAnchor: HTMLElement | null = null;

  function showCard(i: number): void {
    const card = opts.card;
    if (!card || !opts.describe) return;
    const a = cover[i];
    const item = a === -1 ? null : anchors[a]!;
    const desc = item ? opts.describe(item, spots[i]!) : null;
    if (!desc) {
      hideCard();
      return;
    }
    card.set(desc);
    cardAnchor = cells[a]!;
    card.show(cardAnchor);
  }

  function hideCard(): void {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (cardAnchor) {
      opts.card?.hide();
      cardAnchor = null;
    }
  }

  function cellIndexOf(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.tc-cell') ?? null;
    if (!el || !element.contains(el)) return -1;
    return idx(Number(el.dataset.col), Number(el.dataset.row));
  }

  // ---------------------------------------------------------------- carry (keyboard and pad)

  let carry: DragPick | null = null;
  const scratchTo: CellRef = { grid: null as unknown as Grid, col: 0, row: 0 };

  function announce(text: string): void {
    live.textContent = '';
    live.textContent = text;
  }

  function clearOver(): void {
    for (const c of cells) {
      c.removeAttribute('data-over');
      c.removeAttribute('data-reject');
    }
  }

  /** The focused cell shows the held item's landing: `data-over`, and `data-reject` when refused. */
  function showCarry(): void {
    clearOver();
    if (!carry) return;
    const cell = cells[focusIdx]!;
    cell.setAttribute('data-over', '');
    if (!canDrop(spots[focusIdx]!, carry)) cell.setAttribute('data-reject', '');
  }

  function pickUp(): boolean {
    const a = cover[focusIdx];
    if (a === -1) return false;
    const item = anchors[a]!;
    if (item.locked) return false;
    carry = { item, from: { grid: self, col: a % cols, row: Math.floor(a / cols) }, source: self };
    cells[a]!.setAttribute('aria-grabbed', 'true');
    hideCard();
    announce(labels.pickedUp(labelOf(item)));
    self.link?.carryStart(carry);
    showCarry();
    return true;
  }

  function dropHeld(): boolean {
    if (!carry) return false;
    const pick = carry;
    const spot = spots[focusIdx]!;
    let ok: boolean;
    if (self.link) ok = self.link.commit(self, spot, pick);
    else if (canDrop(spot, pick)) {
      drop(spot, pick);
      carryEnd();
      ok = true;
    } else ok = false;
    announce(ok ? labels.dropped(labelOf(pick.item)) : labels.rejected(labelOf(pick.item)));
    return true;
  }

  function cancelHeld(): boolean {
    if (!carry) return false;
    const pick = carry;
    if (self.link) self.link.cancelCarry();
    else carryEnd();
    announce(labels.cancelled(labelOf(pick.item)));
    return true;
  }

  function carryEnd(): void {
    carry = null;
    for (const c of cells) c.removeAttribute('aria-grabbed');
    clearOver();
  }

  function carryIn(pick: DragPick, side: 'left' | 'right'): void {
    carry = pick;
    const c = side === EDGE_LEFT ? 0 : cols - 1;
    const r = Math.min(rows - 1, pick.from.row);
    hideCard();
    // Land on the same row where it exists, else the last row; focus moves here.
    if (idx(c, r) === focusIdx) showCarry();
    setFocus(c, r, true);
    if (idx(c, r) === focusIdx) showCarry();
  }

  function stepFocus(dc: number, dr: number): boolean {
    const c = focused.col + dc;
    const r = focused.row + dr;
    if (carry && dr === 0 && (c < 0 || c >= cols)) {
      const dir = c < 0 ? EDGE_LEFT : EDGE_RIGHT;
      if (self.link?.cross(self, dir, carry)) {
        clearOver();
        return true;
      }
    }
    if (!inBounds(c, r)) return true;
    setFocus(c, r, true);
    return true;
  }

  const cellOf = (i: number): Cell => ({ col: i % cols, row: Math.floor(i / cols) });

  function activate(): void {
    const a = cover[focusIdx];
    if (a === -1) return;
    opts.onActivate?.(cellOf(a), anchors[a]!);
  }

  function context(i: number): boolean {
    const a = cover[i];
    if (a === -1 || !opts.onContext) return false;
    setFocus(a % cols, Math.floor(a / cols), true);
    hideCard();
    opts.onContext(cellOf(a), anchors[a]!, cells[a]!);
    return true;
  }

  function act(action: PadAction): boolean {
    switch (action) {
      case 'select':
        return carry ? dropHeld() : pickUp();
      case 'back':
        return cancelHeld();
      case 'secondary':
        return context(focusIdx);
      case 'left':
        return stepFocus(-1, 0);
      case 'right':
        return stepFocus(1, 0);
      case 'up':
        return stepFocus(0, -1);
      case 'down':
        return stepFocus(0, 1);
    }
  }

  // ---------------------------------------------------------------- events

  let holdFired = false;

  element.addEventListener('keydown', (e) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        stepFocus(-1, 0);
        break;
      case 'ArrowRight':
        stepFocus(1, 0);
        break;
      case 'ArrowUp':
        stepFocus(0, -1);
        break;
      case 'ArrowDown':
        stepFocus(0, 1);
        break;
      case 'Home':
        setFocus(0, focused.row, true);
        break;
      case 'End':
        setFocus(cols - 1, focused.row, true);
        break;
      case 'Enter':
      case ' ':
        if (e.repeat) {
          if (!holdFired && !carry) {
            holdFired = true;
            pickUp();
          }
        } else if (carry) dropHeld();
        else if (holdFired) holdFired = false;
        break;
      case 'Escape':
        if (carry) cancelHeld();
        else if (cardAnchor) hideCard();
        else handled = false;
        break;
      case 'F10':
        if (e.shiftKey) context(focusIdx);
        else handled = false;
        break;
      case 'ContextMenu':
        context(focusIdx);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  element.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (!holdFired && !carry && !e.repeat && cells[focusIdx] === e.target) {
        // A tap of Enter or Space activates on release, so a hold never also activates.
        activate();
      }
      holdFired = false;
    }
  });
  element.addEventListener('focusin', (e) => {
    const i = cellIndexOf(e.target);
    if (i < 0) return;
    if (i !== focusIdx) setFocus(i % cols, Math.floor(i / cols), false);
    // Entering from outside (Tab, a carry-in from the neighbour grid) is a focus change too.
    else if (!element.contains(e.relatedTarget as Node | null)) opts.onFocus?.(focused);
    showCard(i);
  });
  element.addEventListener('focusout', (e) => {
    if (e.relatedTarget && element.contains(e.relatedTarget as Node)) return;
    hideCard();
  });
  element.addEventListener('pointerover', (e) => {
    const i = cellIndexOf(e.target);
    if (i < 0 || hoverTimer !== null) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (!isDragging()) showCard(i);
    }, hoverMs);
  });
  element.addEventListener('pointerout', (e) => {
    if (e.relatedTarget && element.contains(e.relatedTarget as Node)) {
      const from = cellIndexOf(e.target);
      const to = cellIndexOf(e.relatedTarget);
      if (from === to) return;
    }
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (cardAnchor && element.ownerDocument.activeElement !== cardAnchor) hideCard();
  });
  element.addEventListener('pointerdown', (e) => {
    const i = cellIndexOf(e.target);
    if (i < 0) return;
    const c = i % cols;
    const r = Math.floor(i / cols);
    if (e.button === 2) return; // contextmenu follows
    if (e.button !== 0) return;
    setFocus(c, r, true);
    const pick = pickFrom(i);
    if (pick && self.link) {
      hideCard();
      self.link.pointerStart(pick, e);
    }
  });
  element.addEventListener('click', (e) => {
    const i = cellIndexOf(e.target);
    if (i < 0 || e.button !== 0) return;
    if (carry) {
      setFocus(i % cols, Math.floor(i / cols), true);
      dropHeld();
    } else if (!isDragging()) activate();
  });
  element.addEventListener('contextmenu', (e) => {
    const i = cellIndexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    context(i);
  });

  const isDragging = () => self.link?.pointerActive() ?? false;

  // ---------------------------------------------------------------- DropTarget

  function spotAt(x: number, y: number): DropSpot | null {
    const r = element.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
    const cell0 = cells[0]!.getBoundingClientRect();
    const pitchX = cols > 1 ? cells[1]!.getBoundingClientRect().left - cell0.left : cell0.width;
    const pitchY = rows > 1 ? cells[cols]!.getBoundingClientRect().top - cell0.top : cell0.height;
    const c = Math.floor((x - cell0.left) / pitchX);
    const rr = Math.floor((y - cell0.top) / pitchY);
    if (!inBounds(c, rr)) return null;
    return spots[idx(c, rr)]!;
  }

  function canDrop(spot: DropSpot, pick: DragPick): boolean {
    const own = pick.source === self;
    const ignore = own ? idx(pick.from.col, pick.from.row) : -2;
    if (!fits(spot.col, spot.row, pick.item, ignore)) return false;
    if (!opts.canDrop) return true;
    scratchTo.grid = self;
    scratchTo.col = spot.col;
    scratchTo.row = spot.row;
    return opts.canDrop(pick.from, scratchTo, pick.item);
  }

  function drop(spot: DropSpot, pick: DragPick): void {
    const to: CellRef = { grid: self, col: spot.col, row: spot.row };
    if (pick.source === self) move(pick.from, spot);
    else set(spot, pick.item);
    opts.onMove?.(pick.from, to, pick.item);
  }

  function release(pick: DragPick, to: CellRef): void {
    set(pick.from, null);
    opts.onMove?.(pick.from, to, pick.item);
  }

  function hover(spot: DropSpot | null, reject: boolean): void {
    clearOver();
    if (!spot) return;
    spot.el.setAttribute('data-over', '');
    if (reject) spot.el.setAttribute('data-reject', '');
  }

  function pickAt(x: number, y: number): DragPick | null {
    const spot = spotAt(x, y);
    return spot ? pickFrom(idx(spot.col, spot.row)) : null;
  }

  function pickFrom(i: number): DragPick | null {
    const a = cover[i]!;
    if (a === -1) return null;
    const item = anchors[a]!;
    if (item.locked) return null;
    return { item, from: { grid: self, col: a % cols, row: Math.floor(a / cols) }, source: self };
  }

  const self: Grid = {
    element,
    cols,
    rows,
    get grid() {
      return self;
    },
    link: null,
    set,
    get,
    find,
    move,
    get items() {
      const out: GridEntry[] = [];
      for (let i = 0; i < n; i++) {
        const item = anchors[i];
        if (item) out.push({ col: i % cols, row: Math.floor(i / cols), item });
      }
      return out;
    },
    focus(cell) {
      setFocus(cell.col, cell.row, true);
    },
    get focused() {
      return focused;
    },
    get held() {
      return carry?.item ?? null;
    },
    act,
    clear() {
      for (let i = 0; i < n; i++) if (anchors[i]) unplace(i);
    },
    remove() {
      hideCard();
      if (carry) cancelHeld();
      element.remove();
    },
    spotAt,
    spots: () => spots,
    canDrop,
    drop,
    release,
    hover,
    pickAt,
    carryIn,
    carryEnd,
  };

  return self;
}
