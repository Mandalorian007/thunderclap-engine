/**
 * What the actors page (harness/actors.html) publishes on `window.__harnessActors` for
 * e2e/actors.spec.ts. Shared by the page (harness/actors.ts) and the spec.
 */
export interface HarnessActorsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Actors (`?n=N`, default 1000): half rigid part models, half skinned. */
  actors: number;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /** GPU calls of the last frame: the actor system's `prepare` plus the core's. */
  calls: number;
  /** The most GPU calls of any frame after the first two. */
  maxCalls: number;
  /** The core's bundles executed in the last frame. */
  bundles: number;
  /** Bundles recorded so far. */
  bundleBuilds: number;
  /** Slots the last pose pass covered. */
  dispatched: number;
  /** Pose checks done (`check()`), and the last one's results. */
  checks: number;
  /** Largest difference between the GPU's skin matrices and `poseCpu` over the checked slots. */
  poseError: number;
  /** Slots compared by the last check. */
  checkedSlots: number;
  /** Actors the pose pass drew in view 0 (instance counts read back): robot LOD 0, robot LOD 1, skinned. */
  drawnPerDraw: number[];
  drawn: number;
  /** Median CPU ms of a frame's `prepare` + `draw` over the last 60 frames. */
  cpuMs: number;
}

declare global {
  interface Window {
    __harnessActors?: {
      state: HarnessActorsState;
      /** Read back the next frame's skin matrices and indirect counts and compare (async; bumps `checks`). */
      check(): void;
    };
  }
}
