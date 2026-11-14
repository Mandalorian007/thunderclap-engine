/**
 * What the part-models page (harness/models.html) publishes on `window.__harnessModels` for
 * e2e/models.spec.ts. Shared by the page (harness/models.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface ModelsProbe {
  x: number;
  y: number;
}

export interface HarnessModelsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** Draw calls the model scene recorded last frame (one per unit in use). */
  drawCalls: number;
  /** Units placed (slots in use). */
  instances: number;
  /** Units of every model on the page (what `drawCalls` should equal). */
  units: number;
  /** `ModelScene.stats.instanceBytes`: instance bytes written so far. */
  instanceBytes: number;
  /** Whether the walker walks and the sails turn (`?still` parks them). */
  moving: boolean;
  /** The windmill's held sail angle (radians) when parked. */
  spin: number;
  /**
   * Screen points (logical px): `sail` on the upright sail's cloth at spin 0, `tower` on the
   * tower's face, `walker` on the walker's body, `sky` on the clear colour.
   */
  probes: { sail: ModelsProbe; tower: ModelsProbe; walker: ModelsProbe; sky: ModelsProbe };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessModelsApi {
  state: HarnessModelsState;
  /** Park the sails at `angle` radians (re-places the sail unit with a held channel value). */
  setSpin(angle: number): void;
  /** Walk and turn (true) or park (false). */
  setMoving(on: boolean): void;
}

declare global {
  interface Window {
    __harnessModels?: HarnessModelsApi;
  }
}
