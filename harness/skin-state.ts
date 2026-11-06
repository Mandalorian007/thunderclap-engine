/**
 * What the skinning demo page (harness/skin.html) publishes on `window.__harnessSkin` for
 * e2e/skin.spec.ts. Shared by the page (harness/skin.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface SkinProbe {
  x: number;
  y: number;
}

export interface HarnessSkinState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** Animation time in seconds (the loop's real time), as of the last frame. */
  time: number;
  /**
   * The first tube's x sway, -1..1: `sin(2π · 0.125 Hz · time)`. Near 0 the tube stands
   * upright; one second later it is most of the way (sin π/4) to full bend one way or the other.
   */
  sway: number;
  logical: { width: number; height: number };
  /**
   * Screen positions (logical px), recomputed every frame: `tip`: a point just under the top
   * of the first tube, which the joints swing about (it moves between frames); `base`: the foot
   * of the same tube, which joint 0 holds still; `ground`: a bare patch of ground.
   */
  probes: { tip: SkinProbe; base: SkinProbe; ground: SkinProbe };
  /** World position of the `tip` probe, after skinning. */
  tipWorld: [number, number, number];
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
  /** The palette the tubes read: joints per instance, instances (palette slots), tubes drawn. */
  skin: { joints: number; instances: number; tubes: number };
  /** `frame.lights.sun.shadow`: whether set, and the map size it asks for. */
  shadow: { enabled: boolean; size: number };
}

export interface HarnessSkinApi {
  state: HarnessSkinState;
}

declare global {
  interface Window {
    __harnessSkin?: HarnessSkinApi;
  }
}
