/**
 * What the tween page (harness/tween.html) publishes on `window.__harnessTween` for
 * e2e/tween.spec.ts. Shared by the page (harness/tween.ts) and the spec.
 */
export interface HarnessTweenState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The names of the eases on the grid, in grid order (`ease.*` plus `steps`, `bezier`, `spring`). */
  eases: string[];
  /** `Tweens.active`: the running tweens of the current run. */
  active: number;
  /** Seconds since the current run started (`RUN_SECONDS` per tween, no loops). */
  elapsed: number;
  /** Per ease: the eased value the sprite is at now (`x` normalised to the cell), 1 once its tween ended. */
  samples: Record<string, number>;
  /** Tweens of the current run that completed. */
  completed: number;
  /** How many runs started (the first at boot). */
  runs: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessTweenApi {
  state: HarnessTweenState;
  /** Kill the current run and start every ease's sprite from the left again. */
  restart(): void;
}

declare global {
  interface Window {
    __harnessTween?: HarnessTweenApi;
  }
}
