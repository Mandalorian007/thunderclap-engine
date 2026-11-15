/**
 * What the cull page (harness/cull.html) publishes on `window.__harnessCull` for e2e/cull.spec.ts.
 * Shared by the page (harness/cull.ts) and the spec.
 */
export interface HarnessCullState {
  /** True once the readback is done (or boot failed). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Sections streamed into each core, and the frames it took. */
  sections: number;
  frames: number;
  /** Whether the indirect core has a mirror set in a pass that never runs (`?mirror=0` drops it). */
  mirror: boolean;
  /** Section ids found in the readback of the indirect (GPU-culled) and the direct (CPU-culled) core. */
  indirectIds: number;
  directIds: number;
  /** Ids the direct core drew and the indirect one did not, and the reverse (the first few). */
  missing: number[];
  extra: number[];
  /** Pixels that differ between the two readbacks. */
  diffPixels: number;
  /** Sections of each kind the direct core drew (off-axis at the frustum's sides, at the near plane, ahead). */
  drawnOffAxis: number;
  drawnNear: number;
  drawnAhead: number;
  /** The indirect core's `stats.deferredBuilds`, summed over the run. */
  deferredBuilds: number;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessCull?: HarnessCullState;
  }
}
