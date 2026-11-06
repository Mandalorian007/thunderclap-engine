/**
 * What the inventory harness page (harness/inventory.html) publishes on `window.__harnessInventory`
 * for e2e/inventory.spec.ts. Shared by the page (harness/inventory.ts) and the spec.
 */
export type HarnessGridName = 'backpack' | 'equipment';

export interface HarnessInventoryState {
  /** True once the page is mounted. */
  ready: boolean;
  /** Frames run. */
  ticks: number;
  /** Overlay scale (CSS px per design px of the frame). */
  scale: number;
  /** Items per grid as `id@col,row`, reading order. */
  items: Record<HarnessGridName, string[]>;
  /** The id in flight (pointer drag or pad carry), or null. */
  dragging: string | null;
  cardVisible: boolean;
  /** The card's side of its anchor, or null while hidden. */
  cardPlacement: string | null;
  /** The radial is open and not hidden by a modal. */
  radialActive: boolean;
  /** The radial's highlighted sector, or -1. */
  radialHighlighted: number;
  contextOpen: boolean;
  /** The grid and cell last focused, or null before any. */
  focused: { grid: HarnessGridName; col: number; row: number } | null;
  /** `onMove` calls as `<grid>:<id>:<c>,<r>><c>,<r>`, in order. */
  moves: string[];
  /** Radial and context picks, in order, as `radial:<id>` and `context:<id>`. */
  picks: string[];
  /** The ids assigned to the slot strip (null for an empty slot). */
  slots: (string | null)[];
  /** The last activated item id. */
  activated: string | null;
}

export interface HarnessInventoryApi {
  state: HarnessInventoryState;
  /** A pad action routed to the focused grid (the drag context carries it across grids). */
  pad(action: 'select' | 'back' | 'secondary' | 'up' | 'down' | 'left' | 'right'): boolean;
  radial: {
    open(): void;
    close(): void;
    aim(x: number, y: number): void;
    pick(): boolean;
  };
  /** Focus a cell. */
  focus(grid: HarnessGridName, col: number, row: number): void;
}

declare global {
  interface Window {
    __harnessInventory?: HarnessInventoryApi;
  }
}
