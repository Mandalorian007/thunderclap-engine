/**
 * What the reversed-Z effects page (harness/fx-reversed.html) publishes on
 * `window.__harnessFxReversed` for e2e/fx-reversed.spec.ts. Shared by the page and the spec.
 */

/** The effects the page can take off the core one at a time. */
export type FxReversedEffect = 'water' | 'particles' | 'boxes' | 'weather' | 'lightning';

export interface HarnessFxReversedState {
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  frames: number;
  gpuErrors: number;
  /** Nothing moves: no update, no emits (the effects keep their last state). */
  paused: boolean;
  /** True: the core runs reversed-Z (`?standard` turns it off, for comparison). */
  reversedZ: boolean;
  show: Record<FxReversedEffect, boolean>;
  /** The sky hook's tint (`SkyPass.params[0]`, rgb). */
  skyTint: [number, number, number];
  /** `SkyPass.horizon` as of the last frame. */
  horizon: [number, number, number];
  /** Sky pass draws so far. */
  skyDraws: number;
  weatherInstances: number;
  drawables: number;
  /**
   * `?fit` (ws/fx-fit): the sky a member of the opaque pass with no `SkyLook` (hook only), the
   * fountain in a game pass (`late`), the debris lit boxes with an emit axis, colour jitter, flutter
   * and flat boxes, the weather eight layers (leaves among them) on a floored occlusion map.
   */
  fit: boolean;
  /** Core render passes in the last frame (`core.stats.passes`). */
  passes: number;
  /** The fountain's and the debris' drawn particles (`ParticleSystem.drawCount`). */
  particleDraws: number;
  boxDraws: number;
  /** Weather layers configured. */
  weatherLayers: number;
  /** The core's pass ids, in order. */
  passOrder: string[];
}

export interface FxReversedSet {
  paused?: boolean;
  show?: Partial<Record<FxReversedEffect, boolean>>;
  skyTint?: [number, number, number];
  /** Clear both particle systems (idle until the next emit). */
  clear?: boolean;
}

export interface HarnessFxReversedApi {
  state: HarnessFxReversedState;
  set(opts: FxReversedSet): void;
}

declare global {
  interface Window {
    __harnessFxReversed?: HarnessFxReversedApi;
  }
}
