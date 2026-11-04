/**
 * What the createGame harness page (harness/game.ts) publishes on `window.__harnessGame` for
 * e2e/lifecycle.spec.ts and e2e/surface.spec.ts. Shared by the page and the specs.
 */
export interface HarnessGameState {
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Rendered frames (counted in `hooks.afterRender`). */
  frames: number;
  /** Fixed steps (counted in `hooks.update`). */
  updates: number;
  /** `hooks.hide` calls. */
  hides: number;
  /** `hooks.deviceLost` calls. */
  lost: number;
  loopRunning: boolean;
  loopHalted: boolean;
  /** `AudioEngine.state`. */
  audio: string;
  /** Surface backbuffer, device px, and the canvas drawing buffer it set. */
  backbuffer: { width: number; height: number; pixelRatio: number };
  canvas: { width: number; height: number };
  devicePixelRatio: number;
  /** Every `tap` action press, in logical px. */
  taps: { x: number; y: number }[];
}

/** `window.__harnessGame`. */
export interface HarnessGameApi {
  state(): HarnessGameState;
  /** Writes `n` to the save in memory (debounced for a minute, so only a flush stores it). */
  write(n: number): void;
  /** What the save slot holds in storage now, or null. */
  stored(): number | null;
}

declare global {
  interface Window {
    __harnessGame?: HarnessGameApi;
  }
}
