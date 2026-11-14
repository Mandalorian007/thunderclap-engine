/**
 * What the merged-runs page (harness/runs.html) publishes on `window.__harnessRuns` for
 * e2e/runs.spec.ts. Shared by the page (harness/runs.ts) and the spec.
 */
export interface HarnessRunsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Distinct meshes in the scene (`?n=N`, default 1500). */
  meshes: number;
  /** `?split`: one material per mesh, so nothing merges (the per-mesh path, for comparison). */
  split: boolean;
  /** Frames presented. */
  frames: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
  /** Last frame's `renderer.stats`: merged runs, draws (one per mesh drawn), culled meshes. */
  runs: number;
  drawCalls: number;
  culled: number;
  /** `indirect-first-instance` and Chromium's multi-draw on the device. */
  firstInstance: boolean;
  multiDraw: boolean;
}

declare global {
  interface Window {
    __harnessRuns?: { state: HarnessRunsState };
  }
}
