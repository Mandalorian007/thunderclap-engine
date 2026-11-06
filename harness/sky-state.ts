/**
 * What the sky demo page (harness/sky.html) publishes on `window.__harnessSky` for
 * e2e/sky.spec.ts. Shared by the page (harness/sky.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface SkyProbe {
  x: number;
  y: number;
}

export interface HarnessSkyState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** `?still` parks the sun at noon. */
  still: boolean;
  /** The sun's elevation above the horizon this frame, radians (negative at night). */
  sunElevation: number;
  /**
   * Screen positions (logical px) of four points, recomputed every frame: `zenith`: high in the
   * sky above the scene; `horizon`: the sky just above the horizon line, away from the sun's
   * glow; `sunDisc`: the centre of the sun disc; `ground`: a bare patch of ground.
   */
  probes: {
    zenith: SkyProbe;
    horizon: SkyProbe;
    sunDisc: SkyProbe;
    ground: SkyProbe;
  };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; drawables: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessSkyApi {
  state: HarnessSkyState;
}

declare global {
  interface Window {
    __harnessSky?: HarnessSkyApi;
  }
}
