/**
 * What the cover-fit harness page (harness/cover.ts) publishes on `window.__harnessCover` for
 * e2e/cover.spec.ts. Shared by the page and the spec.
 */
type Rect = { x: number; y: number; width: number; height: number };

export interface HarnessCoverState {
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Rendered frames (counted in `hooks.afterRender`). */
  frames: number;
  /** The band the page passes (`CoverOptions.minVisibleHeight`). */
  band: number;
  /** `surface.rect`, `surface.fitRect` and `surface.visibleRect`. */
  rect: Rect & { scale: number };
  fitRect: Rect & { scale: number };
  visible: Rect;
  /** The container (`surface.root`) size, CSS px. */
  container: { width: number; height: number };
  /** The canvas's and the overlay HUD layer's client rects. */
  canvasBox: Rect;
  hudBox: Rect;
  /**
   * `Camera.fitFreeRect(design, layout.freeRect, surface)`: the design rect's corners mapped back
   * to client px, and the free rect they must fit inside.
   */
  fitCorners: { left: number; top: number; right: number; bottom: number };
  freeRect: Rect;
  /** `data-form-factor` on the overlay root. */
  formFactor: string | null;
  /** Every `tap` action press, in logical px. */
  taps: { x: number; y: number }[];
  /**
   * The select probe on the HUD layer (#3): a game rule `.cover-probe select { padding: 7px }`
   * on a raw select, and the engine's own `select` widget beside a select whose inline padding
   * is the divided token the widget drew before.
   */
  selects: { gamePadding: string; enginePadding: string; engineExpected: string };
}

declare global {
  interface Window {
    __harnessCover?: () => HarnessCoverState;
  }
}
