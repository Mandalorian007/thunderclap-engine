/**
 * What the save harness page (harness/save.html) publishes on `window.__harnessSave` for
 * e2e/save.spec.ts. Shared by the page (harness/save.ts) and the spec.
 */
import type { SlotInfo } from '@thunderclap/engine/save';

export interface HarnessSaveState {
  /** True once the stores are open and the page rendered. */
  ready: boolean;
  /** `?persist`: real `localStorage` through the host; otherwise a `MemoryStorage`. */
  persist: boolean;
  /** `manager.list()` after the last change. */
  slots: SlotInfo[];
  /** `manager.mostRecent()` after the last change. */
  mostRecent: SlotInfo | null;
  /** The settings store's `volume`, bound to the slider. */
  volume: number;
  canUndo: boolean;
  canRedo: boolean;
  /** FNV-1a over the 64×64 tilemap bytes. */
  tileChecksum: string;
  /** Tiles painted non-zero. */
  painted: number;
  /** Paint operations since load (each pushes a journal step). */
  paints: number;
}

export interface HarnessSaveApi {
  state: HarnessSaveState;
  /** Push a journal step, then set tile `(x, y)` to `value` (default: next in a walk, value 1). */
  paint(x?: number, y?: number, value?: number): void;
  undo(): boolean;
  redo(): boolean;
  /** Copy the working tilemap into slot `n` (1..3) with a label and flush it. */
  save(slot: number): void;
  setVolume(v: number): void;
}

declare global {
  interface Window {
    __harnessSave?: HarnessSaveApi;
  }
}
