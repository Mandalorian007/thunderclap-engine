/**
 * What the pass-cost page (harness/pass-cost.html) publishes on `window.__harnessPassCost` for
 * e2e/pass-cost.spec.ts. Shared by the page (harness/pass-cost.ts) and the spec.
 */
export interface HarnessPassCostState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames drawn. */
  frames: number;
  /** Render passes begun in the last frame (core and post). */
  passes: number;
  /** Colour attachments over the last frame's render passes. */
  attachments: number;
  /** Labels of the last frame's render passes, in order. */
  labels: string[];
  /** Whether the device has `timestamp-query`. */
  timestamps: boolean;
  /** GPU samples taken. */
  gpuSamples: number;
  /** Median and p95 GPU ms (first to last timestamp) over the last 120 samples. */
  gpuMs: number;
  gpuP95: number;
  /** Median GPU ms per timed pass label over the last 120 samples. */
  passMs: Record<string, number>;
  /** The backbuffer's size. */
  width: number;
  height: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessPassCost?: { state: HarnessPassCostState };
  }
}
