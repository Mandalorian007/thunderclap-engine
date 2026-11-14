/**
 * What the ui-fit page (harness/ui-fit.html) publishes on `window.__harnessUiFit` for
 * e2e/ui-fit.spec.ts. Shared by the page (harness/ui-fit.ts) and the spec.
 */

/** A word's box, units, from its panel's corner. */
export interface UiFitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiFitState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Frames applied. */
  frames: number;
  /** Every panel event so far, `id:type:value`. */
  events: string[];
  /** The rows each presenter has bound or in view (the list is windowed). */
  domRows: string[];
  worldRows: string[];
  /** The world surface's texture uploads (a bare device: painted and uploaded, never drawn). */
  uploads: number;
  /** The panel has given way. */
  given: boolean;
}

export interface UiFitApi {
  state: UiFitState;
  /** Shows or hides the panel's body (it slides). */
  open(on: boolean): void;
  /** The game's sheet is open, on a small screen or not. */
  giveWay(sheet: boolean, small: boolean): void;
  /** Moves row `key` to the top, sliding. */
  toTop(key: string): void;
  /** Scrolls both presenters to row `key`. */
  reveal(key: string): boolean;
  /** A key to the world presenter. */
  worldKey(key: string, code?: string): boolean;
  /** A press on the world presenter's word `id`: down, then up `after` ms later. */
  worldPress(id: string, after: number): Promise<void>;
  /** Word `id`'s box on the page and on the world surface (units). */
  boxes(id: string): { dom: UiFitBox | null; world: UiFitBox | null };
}

declare global {
  interface Window {
    __harnessUiFit?: UiFitApi;
  }
}
