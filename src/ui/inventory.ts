/**
 * Inventory widgets (ws/ui-inventory): the shared types, the stylesheet and the contract between
 * a drag context and what it drags over. The widgets themselves are `grid` (inventory-grid.ts),
 * `createDragContext` and `slotsTarget` (inventory-drag.ts), `card` and `placeCard`
 * (inventory-card.ts), `radial` (inventory-radial.ts) and `contextList` (inventory-context.ts).
 *
 * Noun-free: the game supplies the data (`CellItem`: an id, an icon, a count, a span) and the
 * rules (`canDrop`); the engine draws, moves focus, animates and announces. Lengths are theme px
 * (`themePx`, ui/hud.ts), so they follow `ui.units`; colours, radii, fonts and timings are the
 * `--tc-*` tokens. `INVENTORY_CSS` is injected once per document by `createOverlay`
 * (`ensureInventoryStyles`, `#tc-ui-inventory`).
 */

import type { Grid } from './inventory-grid';
import type { PanelStack } from './stack';
import { toFrameUnits } from './text-scale';
import type { WidgetTone } from './widgets-2';

/** What the inventory factories need from the overlay (an `Overlay` fits). */
export interface InventoryHost {
  readonly layers: { hud: HTMLElement; toasts?: HTMLElement };
  /** Radials hide under a modal when the host has a stack. */
  readonly stack?: PanelStack;
}

/** A cell address in a grid: column and row, 0-based. */
export interface GridCell {
  col: number;
  row: number;
}

/** A cell of a particular grid: what `canDrop` and `onMove` get for both ends of a move. */
export interface CellRef extends GridCell {
  grid: Grid;
}

/** What a grid cell holds. The game's data; the engine never mutates it. */
export interface CellItem {
  id: string;
  /** Text (a glyph), or an element the cell adopts (an `<img>`, a canvas). */
  icon: string | HTMLElement | HTMLCanvasElement;
  /** Accessible name; default `id`. */
  label?: string;
  /** Stack size; a count over 1 shows the `.tc-cell-count` badge. */
  count?: number;
  /** Cells covered, anchor at the top-left. Default 1×1. */
  span?: { w: number; h: number };
  tone?: WidgetTone;
  /** Cannot be picked up or dragged. */
  locked?: boolean;
}

/** One place a drag can land: a grid cell or a slot. `el` carries `data-over` / `data-reject`. */
export interface DropSpot {
  readonly el: HTMLElement;
  readonly col: number;
  readonly row: number;
}

/** An item in flight: what was picked up, where from, and the target it came from. */
export interface DragPick {
  readonly item: CellItem;
  readonly from: CellRef;
  readonly source: DropTarget;
}

/**
 * Something a drag context can drop onto (and, for grids, pick up from). `grid()` returns one;
 * `slotsTarget()` adapts a `ui.slots` strip. A context sets `link` on `register`.
 */
export interface DropTarget {
  readonly element: HTMLElement;
  /** The grid behind this target, when it is one (a drop into it is a move; into a strip, a copy). */
  readonly grid?: Grid;
  /** Set by the drag context on `register`, cleared on `unregister`. */
  link: DragLink | null;
  /** The spot under client coordinates, or null. Returns a stored object: no allocation. */
  spotAt(clientX: number, clientY: number): DropSpot | null;
  /** Every spot in reading order (the pad walk). */
  spots(): readonly DropSpot[];
  /** Whether `pick` may land on `spot` (the structural rule and the game's `canDrop`). */
  canDrop(spot: DropSpot, pick: DragPick): boolean;
  /** Land `pick` on `spot`: place it and tell the game (`onMove` / `onAssign`). */
  drop(spot: DropSpot, pick: DragPick): void;
  /** The source end of a move into another target: take the item out and tell the game. */
  release?(pick: DragPick, to: CellRef): void;
  /** Show `spot` as hovered (`data-over`, plus `data-reject` when rejected); null clears. */
  hover(spot: DropSpot | null, reject: boolean): void;
  /** What a pointer at client coordinates could pick up, or null (grids only). */
  pickAt?(clientX: number, clientY: number): DragPick | null;
  /** A held item walks in from `side` with the pad or the keyboard: take focus and show it. */
  carryIn?(pick: DragPick, side: 'left' | 'right'): void;
  /** The carry this target showed (as source or as the walked-into target) ended. */
  carryEnd?(): void;
}

/** What a registered target can ask its drag context for. */
export interface DragLink {
  /** A pointer went down on a pickable item: start a pointer drag (touch waits for the long-press). */
  pointerStart(pick: DragPick, e: PointerEvent): void;
  /** A keyboard or pad pick-up began in `pick.source`. */
  carryStart(pick: DragPick): void;
  /** The held item reached `from`'s edge: walk to the next target in reading order. True if it moved. */
  cross(from: DropTarget, dir: 'left' | 'right', pick: DragPick): boolean;
  /** Drop the held item on `spot` of `target`: both ends are told. False when rejected. */
  commit(target: DropTarget, spot: DropSpot, pick: DragPick): boolean;
  /** Cancel the held item (Escape, pad `back`). */
  cancelCarry(): void;
  /** True while a pointer drag runs, and through the click that ends it. */
  pointerActive(): boolean;
}

/** How `aria-label`s and announcements are worded. Overridable per grid. */
export interface InventoryLabels {
  /** `({ label, count }) => "Potion, 3"`. */
  cell?: (label: string, count: number | undefined) => string;
  empty?: string;
  pickedUp?: (label: string) => string;
  dropped?: (label: string) => string;
  rejected?: (label: string) => string;
  cancelled?: (label: string) => string;
}

export const defaultInventoryLabels: Required<InventoryLabels> = {
  cell: (label, count) => (count !== undefined && count > 1 ? `${label}, ${count}` : label),
  empty: 'Empty',
  pickedUp: (label) => `Picked up ${label}`,
  dropped: (label) => `Dropped ${label}`,
  rejected: (label) => `Cannot drop ${label} there`,
  cancelled: (label) => `Put back ${label}`,
};

const STYLE_ID = 'tc-ui-inventory';

/**
 * The inventory stylesheet, under `.tc-overlay`, in `--tc-*` tokens only; the few px literals are
 * design px (`toFrameUnits`). Sizes the game chooses (`cellSize`, `width`, `radius`) arrive as
 * theme px in custom properties on the element.
 */
export const INVENTORY_CSS = toFrameUnits(`
.tc-overlay .tc-grid { display: flex; flex-direction: column; gap: var(--tc-cell-gap); pointer-events: auto;
  font-family: var(--tc-font-ui); color: var(--tc-color-text); outline: none; width: max-content; }
.tc-overlay .tc-grid-row { display: flex; gap: var(--tc-cell-gap); }
.tc-overlay .tc-cell { position: relative; width: var(--tc-cell-size); height: var(--tc-cell-size);
  border-radius: var(--tc-radius-s); background: var(--tc-color-surface);
  border: var(--tc-border-width) solid var(--tc-color-border); cursor: default; }
.tc-overlay .tc-cell:focus-visible { outline-offset: 1px; z-index: 2; }
.tc-overlay .tc-cell[data-covered] { background: var(--tc-color-surface-alt); border-style: dashed; }
.tc-overlay .tc-cell[data-over] { border-color: var(--tc-color-accent); box-shadow: 0 0 0 var(--tc-focus-ring) var(--tc-color-accent); z-index: 1; }
.tc-overlay .tc-cell[data-over][data-reject] { border-color: var(--tc-color-danger); box-shadow: 0 0 0 var(--tc-focus-ring) var(--tc-color-danger); }
.tc-overlay .tc-cell[aria-grabbed="true"] .tc-cell-item { opacity: 0.35; }
.tc-overlay .tc-cell-item { position: absolute; left: calc(-1 * var(--tc-border-width)); top: calc(-1 * var(--tc-border-width));
  width: calc(var(--tc-span-w, 1) * var(--tc-cell-size) + (var(--tc-span-w, 1) - 1) * var(--tc-cell-gap));
  height: calc(var(--tc-span-h, 1) * var(--tc-cell-size) + (var(--tc-span-h, 1) - 1) * var(--tc-cell-gap));
  display: grid; place-items: center; border-radius: var(--tc-radius-s); z-index: 1; overflow: hidden;
  border: var(--tc-border-width) solid var(--tc-cell-tone, transparent); font-size: var(--tc-font-size-l); line-height: 1; }
.tc-overlay .tc-cell-item[data-tone="accent"] { --tc-cell-tone: var(--tc-color-accent); }
.tc-overlay .tc-cell-item[data-tone="info"] { --tc-cell-tone: var(--tc-color-info); }
.tc-overlay .tc-cell-item[data-tone="success"] { --tc-cell-tone: var(--tc-color-success); }
.tc-overlay .tc-cell-item[data-tone="warn"] { --tc-cell-tone: var(--tc-color-warn); }
.tc-overlay .tc-cell-item[data-tone="danger"] { --tc-cell-tone: var(--tc-color-danger); }
.tc-overlay .tc-cell-item[data-locked]::after { content: ''; position: absolute; inset: 0; background: var(--tc-color-backdrop); }
.tc-overlay .tc-cell-item > canvas, .tc-overlay .tc-cell-item > img { max-width: 100%; max-height: 100%; }
.tc-overlay .tc-cell-count { position: absolute; right: var(--tc-space-1); bottom: var(--tc-space-1); padding: 0 var(--tc-space-1);
  border-radius: var(--tc-radius-s); background: var(--tc-color-backdrop); color: var(--tc-color-text);
  font-family: var(--tc-font-mono); font-size: var(--tc-font-size-s); line-height: 1.4; }

.tc-overlay .tc-drag-ghost { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 10; opacity: 0.9;
  will-change: transform; filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.5)); }
.tc-overlay .tc-drag-ghost > .tc-cell-item { position: static; width: 100%; height: 100%; background: var(--tc-color-surface); }
.tc-overlay .tc-drag-ghost[data-return] { transition: transform var(--tc-duration-fast) var(--tc-easing); }
.tc-overlay .tc-slot[data-over] { border-color: var(--tc-color-accent); box-shadow: 0 0 0 var(--tc-focus-ring) var(--tc-color-accent); }
.tc-overlay .tc-slot[data-over][data-reject] { border-color: var(--tc-color-danger); box-shadow: 0 0 0 var(--tc-focus-ring) var(--tc-color-danger); }

.tc-overlay .tc-inv-card { position: absolute; left: 0; top: 0; width: var(--tc-inv-card-width); pointer-events: none; z-index: 20;
  background: var(--tc-color-surface); color: var(--tc-color-text); border: var(--tc-border-width) solid var(--tc-color-border);
  border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow); padding: var(--tc-space-3);
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); line-height: 1.3; will-change: transform; }
.tc-overlay .tc-inv-card[hidden] { display: none; }
.tc-overlay .tc-inv-card[data-tone] { border-color: var(--tc-inv-card-tone); }
.tc-overlay .tc-inv-card[data-tone="accent"] { --tc-inv-card-tone: var(--tc-color-accent); }
.tc-overlay .tc-inv-card[data-tone="info"] { --tc-inv-card-tone: var(--tc-color-info); }
.tc-overlay .tc-inv-card[data-tone="success"] { --tc-inv-card-tone: var(--tc-color-success); }
.tc-overlay .tc-inv-card[data-tone="warn"] { --tc-inv-card-tone: var(--tc-color-warn); }
.tc-overlay .tc-inv-card[data-tone="danger"] { --tc-inv-card-tone: var(--tc-color-danger); }
.tc-overlay .tc-inv-card-title { font-family: var(--tc-font-display); font-size: var(--tc-font-size-m); font-weight: 600; color: var(--tc-inv-card-tone, var(--tc-color-text)); }
.tc-overlay .tc-inv-card-subtitle { opacity: 0.75; margin-bottom: var(--tc-space-2); }
.tc-overlay .tc-inv-card-subtitle:empty { display: none; }
.tc-overlay .tc-inv-card-rows { display: grid; grid-template-columns: 1fr auto; gap: var(--tc-space-1) var(--tc-space-3); margin: var(--tc-space-2) 0 0; }
.tc-overlay .tc-inv-card-rows:empty { display: none; }
.tc-overlay .tc-inv-card-rows > dt { opacity: 0.75; }
.tc-overlay .tc-inv-card-rows > dd { margin: 0; font-family: var(--tc-font-mono); text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: var(--tc-space-1); }
.tc-overlay .tc-inv-card-rows > dd[data-tone="info"] { color: var(--tc-color-info); }
.tc-overlay .tc-inv-card-rows > dd[data-tone="success"] { color: var(--tc-color-success); }
.tc-overlay .tc-inv-card-rows > dd[data-tone="warn"] { color: var(--tc-color-warn); }
.tc-overlay .tc-inv-card-rows > dd[data-tone="danger"] { color: var(--tc-color-danger); }
.tc-overlay .tc-inv-card-rows > dd[data-tone="accent"] { color: var(--tc-color-accent); }
.tc-overlay .tc-inv-card-rows > dd[data-compare]::after { content: ''; display: inline-block; width: 0; height: 0;
  border-left: 5px solid transparent; border-right: 5px solid transparent; }
.tc-overlay .tc-inv-card-rows > dd[data-compare="up"]::after { border-bottom: 7px solid var(--tc-color-success); }
.tc-overlay .tc-inv-card-rows > dd[data-compare="down"]::after { border-top: 7px solid var(--tc-color-danger); }
.tc-overlay .tc-inv-card-rows > dd[data-compare="same"]::after { width: 10px; height: 2px; border: 0; background: currentColor; opacity: 0.6; }
.tc-overlay .tc-inv-card-footer { margin-top: var(--tc-space-2); padding-top: var(--tc-space-2); border-top: var(--tc-border-width) solid var(--tc-color-border); opacity: 0.85; }
.tc-overlay .tc-inv-card-footer:empty { display: none; }

.tc-overlay .tc-radial { position: absolute; left: 50%; top: 50%; width: calc(2 * var(--tc-radial-radius)); height: calc(2 * var(--tc-radial-radius));
  margin: calc(-1 * var(--tc-radial-radius)); pointer-events: auto; outline: none; font-family: var(--tc-font-ui); color: var(--tc-color-text);
  --tc-radial-item: calc(var(--tc-radial-radius) * 0.6); }
.tc-overlay .tc-radial[hidden], .tc-overlay .tc-radial[data-modal] { display: none; }
.tc-overlay .tc-radial-ring { position: absolute; inset: 0; border-radius: 50%; background: var(--tc-color-surface); opacity: 0.85;
  border: var(--tc-border-width) solid var(--tc-color-border);
  -webkit-mask: radial-gradient(circle, transparent calc(var(--tc-radial-radius) * 0.38), #000 calc(var(--tc-radial-radius) * 0.38 + 1px));
  mask: radial-gradient(circle, transparent calc(var(--tc-radial-radius) * 0.38), #000 calc(var(--tc-radial-radius) * 0.38 + 1px)); }
.tc-overlay .tc-radial-sector { position: absolute; inset: 0; border-radius: 50%; opacity: 0;
  background: conic-gradient(from var(--tc-radial-from, 0deg), var(--tc-color-accent) var(--tc-radial-sweep, 90deg), transparent 0);
  -webkit-mask: radial-gradient(circle, transparent calc(var(--tc-radial-radius) * 0.38), #000 calc(var(--tc-radial-radius) * 0.38 + 1px));
  mask: radial-gradient(circle, transparent calc(var(--tc-radial-radius) * 0.38), #000 calc(var(--tc-radial-radius) * 0.38 + 1px));
  transition: opacity var(--tc-duration-fast); }
.tc-overlay .tc-radial[data-active] .tc-radial-sector { opacity: 0.35; }
.tc-overlay .tc-radial-item { position: absolute; left: 50%; top: 50%; width: var(--tc-radial-item); height: var(--tc-radial-item);
  margin: calc(-1 * var(--tc-radial-item) / 2); display: grid; place-items: center; padding: 0; cursor: pointer;
  border-radius: 50%; background: var(--tc-color-surface-alt); border: var(--tc-border-width) solid var(--tc-color-border);
  color: var(--tc-color-text); font: inherit; font-size: var(--tc-font-size-l); line-height: 1;
  transform: rotate(var(--tc-radial-angle)) translate(calc(var(--tc-radial-radius) * 0.69)) rotate(calc(-1 * var(--tc-radial-angle)));
  transition: border-color var(--tc-duration-fast), background var(--tc-duration-fast); }
.tc-overlay .tc-radial-item[data-active] { border-color: var(--tc-color-accent); background: var(--tc-color-surface); }
.tc-overlay .tc-radial-item[aria-disabled="true"] { opacity: 0.4; cursor: default; }
.tc-overlay .tc-radial-item > canvas, .tc-overlay .tc-radial-item > img { max-width: 70%; max-height: 70%; }
.tc-overlay .tc-radial-label { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: calc(var(--tc-radial-radius) * 0.7);
  text-align: center; font-size: var(--tc-font-size-s); pointer-events: none; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }

.tc-overlay .tc-context { position: absolute; left: 0; top: 0; min-width: var(--tc-context-width, ${themePxCss(180)}); pointer-events: auto; z-index: 30;
  display: flex; flex-direction: column; padding: var(--tc-space-1); background: var(--tc-color-surface); color: var(--tc-color-text);
  border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow);
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); outline: none; }
.tc-overlay .tc-context-item { display: flex; justify-content: space-between; gap: var(--tc-space-3); align-items: center; text-align: left;
  padding: var(--tc-space-2) var(--tc-space-3); border: 0; border-radius: var(--tc-radius-s); background: none; color: inherit; font: inherit;
  cursor: pointer; min-height: var(--tc-tap-min, 0); }
.tc-overlay .tc-context-item:hover, .tc-overlay .tc-context-item:focus-visible { background: var(--tc-color-surface-alt); outline-offset: -2px; }
.tc-overlay .tc-context-item[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.tc-overlay .tc-context-item[data-danger] { color: var(--tc-color-danger); }
.tc-overlay .tc-context-hint { opacity: 0.6; font-family: var(--tc-font-mono); }
`);

/** `n` theme px as CSS (the same formula as `themePx` in ui/hud.ts; repeated so this sheet has no runtime import from it). */
function themePxCss(n: number): string {
  return `calc(${n} * var(--tc-space-1) / 4)`;
}

/** Add `INVENTORY_CSS` to `doc` once (`createOverlay` calls it beside `ensureStyles`). */
export function ensureInventoryStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = INVENTORY_CSS;
  doc.head.appendChild(style);
}

/** The icon of a `CellItem` (or a radial item) as a node the widget adopts; a string becomes a span. */
export function iconNode(icon: string | HTMLElement | HTMLCanvasElement, doc: Document): Node {
  if (typeof icon === 'string') {
    const span = doc.createElement('span');
    span.className = 'tc-inv-icon';
    span.textContent = icon;
    return span;
  }
  return icon;
}
