/**
 * What the two-views page (harness/views.html) publishes on `window.__harnessViews` for
 * e2e/views.spec.ts. Shared by the page (harness/views.ts) and the spec.
 */

/** A point on the canvas in the unit square (0..1 across the whole surface, y down). */
export interface ViewsProbe {
  x: number;
  y: number;
}

/** One eye: its `view_index`, its world position, and where it sees the probe points. */
export interface ViewsEye {
  viewIndex: number;
  position: [number, number, number];
  /** `camera.screen` of this eye, unit-square fractions of the surface. */
  screen: { x: number; y: number; width: number; height: number };
  /**
   * Screen positions of world points, recomputed every frame: `near`: the front face of the
   * near block; `far`: the front face of the tall far block, above the near one; `ground`: a
   * bare patch of ground; `marker`: the small head-locked block 0.6 m in front of the eyes.
   */
  probes: { near: ViewsProbe; far: ViewsProbe; ground: ViewsProbe; marker: ViewsProbe };
  /** Draw calls of this eye's `render` call in the last frame. */
  drawCalls: number;
}

export interface HarnessViewsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** Interpupillary distance in world units (metres): the eyes sit ±half of it on the right axis. */
  ipd: number;
  eyes: [ViewsEye, ViewsEye];
  /** `renderer.stats` summed over both views in the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessViews?: { state: HarnessViewsState };
  }
}
