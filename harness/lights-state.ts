/**
 * What the lights demo page (harness/lights.html) publishes on `window.__harnessLights` for
 * e2e/lights.spec.ts. Shared by the page (harness/lights.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface LightsProbe {
  x: number;
  y: number;
}

export interface HarnessLightsState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /**
   * Screen positions (logical px) of world points, recomputed every frame. `spotIn`: the ground
   * where the sweeping spot aims (inside its inner cone); `spotOut`: ground the same distance
   * from the spot's orbit centre on the far side, outside the cone. `litCube` / `maskedCube`:
   * the tops of two identical cubes either side of a point light masked to the lit cube's layer.
   */
  probes: {
    spotIn: LightsProbe;
    spotOut: LightsProbe;
    litCube: LightsProbe;
    maskedCube: LightsProbe;
  };
  /** The spot's aim point on the ground (world), to prove the sweep moves between frames. */
  spotAim: [number, number, number];
  /** Whether the spot is sweeping (see `HarnessLightsApi.setSweep`). */
  sweeping: boolean;
  /**
   * The lighting block the page hands the renderer: counts of point and spot lights, the
   * masked point light's `layers`, and the layer masks of the two cubes.
   */
  lights: { points: number; spots: number; lampLayers: number; cubeLayers: [number, number] };
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessLightsApi {
  state: HarnessLightsState;
  /** Pause or resume the spot's sweep, so a spec can sample a still frame. */
  setSweep(on: boolean): void;
}

declare global {
  interface Window {
    __harnessLights?: HarnessLightsApi;
  }
}
