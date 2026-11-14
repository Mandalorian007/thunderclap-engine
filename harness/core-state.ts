/**
 * What the render-core page (harness/core.html) publishes on `window.__harnessCore` for
 * e2e/core.spec.ts. Shared by the page (harness/core.ts) and the spec.
 */
export interface HarnessCoreState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Meshes in the scene (`?sets=N`, default 1500). */
  sets: number;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /** The core's GPU calls in the last frame (`core.stats.calls`), and the most in any frame after the first. */
  calls: number;
  maxCalls: number;
  /** Bundles executed and compute dispatches in the last frame. */
  bundles: number;
  dispatches: number;
  /** Bundles recorded so far (1 for a held scene seen through one target). */
  bundleBuilds: number;
  /** Meshes inside the view this frame (the CPU twin of the GPU cull, for the record). */
  visible: number;
  /** Median CPU ms of `prepare` + `draw` over the last 60 frames. */
  cpuMs: number;
  /** `multiDrawIndexedIndirect` and `indirect-first-instance` on the device. */
  multiDraw: boolean;
  firstInstance: boolean;
}

declare global {
  interface Window {
    __harnessCore?: { state: HarnessCoreState };
  }
}
