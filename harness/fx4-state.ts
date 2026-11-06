/**
 * What the fx-4 page (harness/fx4.html) publishes on `window.__harnessFx4` for
 * e2e/fx4.spec.ts. Shared by the page (harness/fx4.ts) and the spec.
 */

/** `?seed=N` (a seeded effect, frozen after 120 steps) or `?decalLag` (a decal on a moving cube). */
export type Fx4Mode = 'seed' | 'decalLag';

export interface HarnessFx4State {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  mode: Fx4Mode;
  /** Readbacks of the probe target that have arrived. */
  readbacks: number;
  /** `gpuDiagnostics.errorCount` (WGSL compile errors, uncaptured errors). */
  gpuErrors: number;

  // ?seed
  /** The seed (`?seed=N`, default 1). */
  seed: number;
  /** Effect steps taken (fixed 1/60 s each); the page stops stepping at 120. */
  steps: number;
  /**
   * FNV-1a of a 256×144 rgba8 readback of the scene colour, from a frame after the effect
   * froze; null until one arrives.
   */
  hash: string | null;
  /** Probe texels brighter than the clear colour in that readback (the effect is on screen). */
  lit: number;

  // ?decalLag
  /** `Decals.readsDepth` (false with `&copy`, the previous-frame fallback). */
  readsDepth: boolean;
  /** `Decals.activeMode` of the last frame. */
  decalMode: string | null;
  /**
   * Logical px of decal colour outside the cube's front face on the probe row of the last
   * readback: the decal trailing a frame behind the cube it is stamped on.
   */
  lagPx: number;
  /** The largest `lagPx` over every readback while the cube moved. */
  lagMax: number;
  /** Logical px of decal colour inside the cube's front face on that row. */
  decalPx: number;
  /** The smallest `decalPx` over every readback (the decal never vanished). */
  decalMin: number;
}

export interface HarnessFx4Api {
  state: HarnessFx4State;
}

declare global {
  interface Window {
    __harnessFx4?: HarnessFx4Api;
  }
}
