/**
 * What the core-effects page (harness/fx-core.html) publishes on `window.__harnessFxCore` for
 * e2e/fx-core.spec.ts. Shared by the page (harness/fx-core.ts) and the spec.
 */

/** The weather configs the page switches between (`'off'`: the drawable leaves the core). */
export type FxCoreWeather = 'dust' | 'snow' | 'rain' | 'off';

/** A world point on screen: unit-square fractions of the whole canvas. */
export interface FxCoreProbe {
  x: number;
  y: number;
}

export interface FxCoreEye {
  viewIndex: number;
  /** The eye's half, unit-square fractions of the canvas. */
  screen: { x: number; y: number; width: number; height: number };
  /** Bundles this eye executed last frame (`core.stats.bundles` across its `draw`). */
  bundles: number;
  /** Passes this eye encoded last frame. */
  passes: number;
  probes: { water: FxCoreProbe; fountain: FxCoreProbe };
}

export interface HarnessFxCoreState {
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  frames: number;
  gpuErrors: number;
  /** Nothing moves: no update, no emits (the effects keep their last state). */
  paused: boolean;
  show: { water: boolean; particles: boolean };
  weather: { config: FxCoreWeather; instances: number; layers: number };
  /** `ParticleSystem.alive` (counted on the GPU, a few frames late). */
  particlesAlive: number;
  eyes: [FxCoreEye, FxCoreEye];
  /** Render bundles recorded since boot (`core.stats.bundleBuilds`). */
  bundleBuilds: number;
  /** Drawables on the core. */
  drawables: number;
}

export interface FxCoreSet {
  paused?: boolean;
  water?: boolean;
  particles?: boolean;
  weather?: FxCoreWeather;
}

export interface HarnessFxCoreApi {
  state: HarnessFxCoreState;
  set(opts: FxCoreSet): void;
}

declare global {
  interface Window {
    __harnessFxCore?: HarnessFxCoreApi;
  }
}
