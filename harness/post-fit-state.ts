/**
 * What the post cost page (harness/post-fit.html) publishes on `window.__harnessPostFit`: medians
 * of the frame's GPU time, its post passes' GPU time and the CPU time of `endFrame`, with the bind
 * groups created per frame. Shared by the page (harness/post-fit.ts) and whatever reads it.
 */

export interface HarnessPostFitState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** True once the measured frames are in. */
  done: boolean;
  /** Scene size the stack ran at. */
  width: number;
  height: number;
  frames: number;
  /** Median GPU ms of the whole frame (`timestamp-query`), else null. */
  gpuMs: number | null;
  /** Median GPU ms of the passes that are not the scene's (`pre`, `scene`, `shadow`). */
  postGpuMs: number | null;
  /** Median ms of each pass label. */
  passes: Record<string, number>;
  /** Median CPU ms of `beginFrame` to `endFrame`. */
  cpuMs: number;
  /** Bind groups created per measured frame (mean). */
  bindGroupsPerFrame: number;
  gpuErrors: number;
}

export interface HarnessPostFitApi {
  state: HarnessPostFitState;
}

declare global {
  interface Window {
    __harnessPostFit?: HarnessPostFitApi;
  }
}
