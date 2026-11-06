/**
 * What the weather page (harness/weather.html) publishes on `window.__harnessWeather` for
 * e2e/weather.spec.ts. Shared by the page (harness/weather.ts) and the spec.
 */

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface WeatherProbe {
  x: number;
  y: number;
}

export interface HarnessWeatherState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /**
   * Live particles per system (`ParticleSystem.alive`, read back from the GPU a few frames
   * late; -1 before the first readback): `rain` (unlit, streaked) and `motes` (lit: snow and
   * the dust around the lamp).
   */
  alive: { rain: number; motes: number };
  /** Whether the page draws its particle systems this frame. */
  particles: boolean;
  /**
   * Screen position (logical px) of a world point inside the dense rain column, where the
   * background behind the rain is clear sky.
   */
  probes: { rain: WeatherProbe };
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;
}

export interface HarnessWeatherApi {
  state: HarnessWeatherState;
  /** Draw (true) or skip (false) the particle systems; the scene behind stays the same. */
  setParticles(visible: boolean): void;
}

declare global {
  interface Window {
    __harnessWeather?: HarnessWeatherApi;
  }
}
