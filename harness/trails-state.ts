/**
 * What the trails page (harness/trails.html) publishes on `window.__harnessTrails` for
 * e2e/trails.spec.ts. Shared by the page (harness/trails.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface TrailProbe {
  x: number;
  y: number;
}

export interface HarnessTrailsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** Points each trail holds (`Trail.count`): the swinging arm's and the orbiting emitter's. */
  counts: { arm: number; orbit: number };
  /** Whether the arm swings and the emitter orbits (pushing points) this frame. */
  swinging: boolean;
  /** Whether the page draws its trails this frame. */
  trails: boolean;
  /**
   * Screen position (logical px) of the arm trail's middle point (`pointAt(count / 2)`), where
   * the ribbon is drawn over the clear colour; the last known position once the trail is empty.
   */
  probes: { arm: TrailProbe };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessTrailsApi {
  state: HarnessTrailsState;
  /** Keep (true) or stop (false) pushing points into the trails; they still age out. */
  setSwinging(on: boolean): void;
  /** Draw (true) or skip (false) the trails; everything else stays the same. */
  setTrails(visible: boolean): void;
  /** `Trail.clear()` on both trails. */
  clear(): void;
}

declare global {
  interface Window {
    __harnessTrails?: HarnessTrailsApi;
  }
}
