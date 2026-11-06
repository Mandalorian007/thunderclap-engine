/**
 * What the water demo page (harness/water.html) publishes on `window.__harnessWater` for
 * e2e/water.spec.ts. Shared by the page (harness/water.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface WaterProbe {
  x: number;
  y: number;
}

export interface HarnessWaterState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `?still` parks the sun where its highlight lands on the specular probe. */
  still: boolean;
  /** Seconds the water has advanced (`water.time`). */
  t: number;
  /** `waterHeight(water, HEIGHT_X, HEIGHT_Z)` this frame. */
  height: number;
  /**
   * Screen positions (logical px), recomputed every frame: `shorelinePixel` on the ramp just
   * below the surface (shallow water over it); `deepPixel` over the basin floor, away from
   * geometry; `foamPixel` on the ramp at the waterline; `specularPixel` where the sun's
   * reflection lands on a flat surface.
   */
  probes: {
    shorelinePixel: WaterProbe;
    deepPixel: WaterProbe;
    foamPixel: WaterProbe;
    specularPixel: WaterProbe;
  };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; drawables: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessWaterApi {
  state: HarnessWaterState;
}

/** Where `height` is read. */
export const HEIGHT_X = 2;
export const HEIGHT_Z = 2;

declare global {
  interface Window {
    __harnessWater?: HarnessWaterApi;
  }
}
