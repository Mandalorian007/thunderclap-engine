/**
 * What the input-5 page (harness/input5.html, ws/input-5) publishes on `window.__harnessInput5`
 * for e2e/input5.spec.ts. Shared by the page (harness/input5.ts) and the spec.
 */

export type Input5Mode = 'contexts' | 'buffer' | 'stick' | 'gyro' | 'tap' | 'replay';

export interface HarnessInput5State {
  /** True once the page is running. */
  ready: boolean;
  mode: Input5Mode;
  /** `?still`: the scripted motion is parked. */
  still: boolean;
  /** Animation frames drawn. */
  frames: number;
  /** `input.update()` calls (60 Hz fixed ticks). */
  ticks: number;
  /** `?contexts`: `input.context` (`'menu'` from t = 1 s until Escape pops it). */
  context: string | null;
  /** `?contexts`: `attack` (J) presses seen; the menu (pass `'none'`) silences it. */
  attackFired: number;
  /** `?contexts`: the menu's `confirm` (J or Enter) presses. */
  confirmFired: number;
  /** `?buffer`: `buffered('jump', 100)` 3 ticks after a scripted press. */
  buffered: boolean | null;
  /** `?buffer`: `consume('jump')` right after, then `buffered` again is `bufferedAfter`. */
  consumed: boolean | null;
  bufferedAfter: boolean | null;
  /** `?buffer`: `buffered('jump', 100)` 7 ticks after a second press. */
  bufferedLate: boolean | null;
  /** `?stick`: the fake pad's raw left stick, then each shape's `[x, y]`. */
  raw: [number, number];
  radial: [number, number];
  axial: [number, number];
  scaledRadial: [number, number];
  /** `?gyro`: the camera the fake rotation rate turns, radians (+ right, + up). */
  yaw: number;
  pitch: number;
  /** `?tap`: `look.onTap` reports as `[x, y]` in logical px (the canvas is 960 x 540). */
  taps: [number, number][];
  /** `?replay`: ticks recorded and replayed, and whether every tick's action states matched. */
  recorded: number;
  replayed: number;
  match: boolean | null;
}

export interface HarnessInput5Api {
  state: HarnessInput5State;
  setStill(still: boolean): void;
}

declare global {
  interface Window {
    __harnessInput5?: HarnessInput5Api;
  }
}
