/**
 * What the createGame harness page (harness/game.ts) publishes on `window.__harnessGame` for
 * e2e/lifecycle.spec.ts, e2e/surface.spec.ts and e2e/client.spec.ts. Shared by the page and the
 * specs.
 */
export interface HarnessGameState {
  /**
   * `full` (default): a probe save, the mixer persisted, the fixed-step sim. `client`
   * (`?mode=client`): no save, no mixer key, `sim: false`.
   */
  mode: 'full' | 'client';
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Rendered frames (counted in `hooks.afterRender`). */
  frames: number;
  /** Fixed steps (counted in `hooks.update`). */
  updates: number;
  /** Per-frame client updates (counted in `hooks.frame`; `client` mode only). */
  clientFrames: number;
  /** Every `host.storage` read, through the harness's wrapped host. */
  storageReads: number;
  /** `ctx.save === null`. */
  saveNull: boolean;
  /** `hooks.hide` calls. */
  hides: number;
  /** The reason `hooks.hide` got last, or null. */
  lastHide: string | null;
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
