/**
 * What the storm page (harness/storm.html) publishes on `window.__harnessStorm` for
 * e2e/weather.spec.ts. Shared by the page (harness/storm.ts) and the spec.
 */
export interface HarnessStormState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames drawn. */
  frames: number;
  /** The anti-aliasing the post runs (`?aa=`): 'off', 'fxaa' or 'taa'. */
  aa: string;
  /** The quality tier (`?tier=`) and the weather density it gives (`weatherTierDensity`). */
  tier: string;
  density: number;
  /** Instances the weather draws (0 with `?weather=off`). */
  instances: number;
  /** Whether the device has `timestamp-query`. */
  timestamps: boolean;
  /** GPU samples taken. */
  gpuSamples: number;
  /** Median GPU ms of the frame, and of the rain's own pass, over the last 120 samples. */
  gpuMs: number;
  rainMs: number;
  /** Median GPU ms per timed pass label. */
  passMs: Record<string, number>;
  /**
   * The picture's mean luma (0..255, sRGB) over `lumaSamples` reads of the canvas: rain on less
   * rain off is the light the rain adds after post (`?luma=1` only).
   */
  luma: number;
  lumaSamples: number;
  /** The backbuffer's size. */
  width: number;
  height: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessStorm?: { state: HarnessStormState };
  }
}
